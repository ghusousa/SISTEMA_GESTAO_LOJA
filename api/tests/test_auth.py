import asyncio
import threading
import time
import uuid
from datetime import UTC, datetime, timedelta

import bcrypt
from httpx import AsyncClient
from sqlalchemy import func, select, text

from app.core.db import SessionLocal, engine
from app.core.security import decodificar_token
from app.modules.auth.models import LoginAttempt, RefreshToken
from app.modules.auth.repository import MAX_FALHAS_EMAIL, AuthRepository
from app.modules.usuarios.models import User


async def _esperar_alguem_na_fila(tarefa: asyncio.Task, limite: float = 10.0) -> None:
    """Espera a requisição ficar PARADA numa trava do banco (ou terminar sem parar).

    A ordem dos testes de concorrência é forçada pela trava, não por relógio: a primeira
    sessão segura a trava, e só a solta depois de ver a segunda esperando por ela. Cada
    consulta abre conexão nova porque `pg_stat_activity` fica congelado dentro de uma
    transação. Se a tarefa terminar antes, é o defeito: ela não esperou ninguém.
    """
    prazo = time.monotonic() + limite
    while not tarefa.done():
        async with engine.connect() as observador:
            esperando = (
                await observador.execute(
                    text(
                        "SELECT count(*) FROM pg_stat_activity "
                        "WHERE datname = current_database() AND wait_event_type = 'Lock'"
                    )
                )
            ).scalar_one()
        if esperando:
            return
        assert time.monotonic() < prazo, "a requisição nunca chegou à trava"
        await asyncio.sleep(0.01)  # intervalo da consulta, não da ordem


async def test_login_com_credenciais_validas_devolve_par_de_tokens(
    client: AsyncClient, admin: User
) -> None:
    resp = await client.post(
        "/auth/login", json={"email": admin.email, "senha": "senha1234"}
    )
    assert resp.status_code == 200
    corpo = resp.json()
    assert corpo["access_token"] and corpo["refresh_token"]
    assert corpo["usuario"]["papel"] == "ADMIN"
    assert corpo["usuario"]["email"] == admin.email
    assert "password_hash" not in corpo["usuario"]


async def test_login_com_senha_errada_retorna_401(client: AsyncClient, admin: User) -> None:
    resp = await client.post("/auth/login", json={"email": admin.email, "senha": "errada12"})
    assert resp.status_code == 401
    assert resp.json()["code"] == "CREDENCIAIS_INVALIDAS"


async def test_login_de_usuario_desativado_e_recusado(
    client: AsyncClient, session, admin: User
) -> None:
    admin.is_active = False
    await session.commit()
    resp = await client.post("/auth/login", json={"email": admin.email, "senha": "senha1234"})
    assert resp.status_code == 401


async def test_refresh_rotaciona_e_invalida_o_token_anterior(
    client: AsyncClient, admin: User
) -> None:
    login = (
        await client.post("/auth/login", json={"email": admin.email, "senha": "senha1234"})
    ).json()
    primeiro_refresh = login["refresh_token"]

    novo = await client.post("/auth/refresh", json={"refresh_token": primeiro_refresh})
    assert novo.status_code == 200
    assert novo.json()["refresh_token"] != primeiro_refresh

    reuso = await client.post("/auth/refresh", json={"refresh_token": primeiro_refresh})
    assert reuso.status_code == 401
    assert reuso.json()["code"] == "TOKEN_INVALIDO"


async def test_reuso_de_refresh_derruba_a_familia_inteira(
    client: AsyncClient, admin: User
) -> None:
    """Token rotacionado reaparecendo é assinatura de cópia roubada: tudo cai."""
    login = (
        await client.post("/auth/login", json={"email": admin.email, "senha": "senha1234"})
    ).json()
    antigo = login["refresh_token"]
    atual = (
        await client.post("/auth/refresh", json={"refresh_token": antigo})
    ).json()["refresh_token"]

    await client.post("/auth/refresh", json={"refresh_token": antigo})  # dispara o alarme

    resp = await client.post("/auth/refresh", json={"refresh_token": atual})
    assert resp.status_code == 401


async def test_access_token_nao_serve_como_refresh(client: AsyncClient, admin: User) -> None:
    login = (
        await client.post("/auth/login", json={"email": admin.email, "senha": "senha1234"})
    ).json()
    resp = await client.post("/auth/refresh", json={"refresh_token": login["access_token"]})
    assert resp.status_code == 401


async def test_logout_revoga_a_sessao(client: AsyncClient, admin: User) -> None:
    login = (
        await client.post("/auth/login", json={"email": admin.email, "senha": "senha1234"})
    ).json()
    headers = {"Authorization": f"Bearer {login['access_token']}"}

    saida = await client.post(
        "/auth/logout", json={"refresh_token": login["refresh_token"]}, headers=headers
    )
    assert saida.status_code == 204

    resp = await client.post("/auth/refresh", json={"refresh_token": login["refresh_token"]})
    assert resp.status_code == 401


async def test_me_exige_token(client: AsyncClient) -> None:
    assert (await client.get("/auth/me")).status_code == 401


async def test_me_devolve_usuario_da_sessao(
    client: AsyncClient, auth_admin: dict[str, str], admin: User
) -> None:
    resp = await client.get("/auth/me", headers=auth_admin)
    assert resp.status_code == 200
    assert resp.json()["id"] == admin.id


async def test_login_devolve_o_refresh_em_cookie_httponly(
    client: AsyncClient, admin: User
) -> None:
    """No navegador não há cofre: o refresh precisa ficar fora do alcance do JavaScript."""
    resp = await client.post(
        "/auth/login", json={"email": admin.email, "senha": "senha1234"}
    )
    assert resp.status_code == 200
    bruto = resp.headers.get("set-cookie", "")
    assert "loja_refresh=" in bruto
    assert "HttpOnly" in bruto
    assert "SameSite=strict" in bruto


async def test_navegador_renova_a_sessao_so_com_o_cookie(
    client: AsyncClient, admin: User
) -> None:
    await client.post("/auth/login", json={"email": admin.email, "senha": "senha1234"})
    # Sem corpo nenhum: é assim que a página web renova, com o cookie indo sozinho.
    resp = await client.post("/auth/refresh")
    assert resp.status_code == 200, resp.text
    assert resp.json()["access_token"]


async def test_refresh_sem_corpo_e_sem_cookie_e_recusado(client: AsyncClient) -> None:
    resp = await client.post("/auth/refresh")
    assert resp.status_code == 401
    assert resp.json()["code"] == "TOKEN_INVALIDO"


async def test_logout_pelo_navegador_apaga_o_cookie(
    client: AsyncClient, admin: User
) -> None:
    login = (
        await client.post("/auth/login", json={"email": admin.email, "senha": "senha1234"})
    ).json()
    headers = {"Authorization": f"Bearer {login['access_token']}"}

    saida = await client.post("/auth/logout", headers=headers)
    assert saida.status_code == 204

    # Cookie apagado e família revogada: nem o navegador nem uma cópia do token renovam.
    assert (await client.post("/auth/refresh")).status_code == 401


# ───────────────────────────────────────────────── concorrência
async def test_refresh_concorrente_com_o_mesmo_token_so_rotaciona_uma_vez(
    client: AsyncClient, admin: User
) -> None:
    """Duas renovações com o mesmo token ao mesmo tempo: a segunda tem de cair no reuso.

    Antes, as duas liam `revoked=False` e as duas rotacionavam — uma cópia roubada que
    ganhasse a corrida do dono saía com sessão própria, sem disparar alarme (ADR-12).
    """
    login = (
        await client.post("/auth/login", json={"email": admin.email, "senha": "senha1234"})
    ).json()
    refresh = login["refresh_token"]
    jti = uuid.UUID(decodificar_token(refresh, "refresh")["jti"])

    async with SessionLocal() as primeira:
        # A primeira renovação no meio do caminho: já marcou o token como usado (e segura a
        # linha), mas ainda não confirmou.
        await primeira.execute(
            text("UPDATE refresh_tokens SET revoked = true WHERE jti = :jti"), {"jti": jti}
        )
        segunda = asyncio.create_task(
            client.post("/auth/refresh", json={"refresh_token": refresh})
        )
        await _esperar_alguem_na_fila(segunda)
        await primeira.commit()

    resp = await segunda
    assert resp.status_code == 401, f"o mesmo refresh rotacionou duas vezes: {resp.status_code}"
    assert resp.json()["code"] == "TOKEN_INVALIDO"


async def test_rajada_de_login_espera_a_vez_e_nao_passa_do_teto_por_email(
    client: AsyncClient, admin: User
) -> None:
    """Teto de 10 falhas por e-mail (ADR-24) valendo sob concorrência.

    30 chutes simultâneos passavam todos pela contagem antes de a primeira falha ser
    gravada: 30 senhas conferidas numa janela cujo teto é 10. Aqui, 9 falhas já gravadas e
    a 10ª em andamento: a tentativa seguinte tem de esperar a 10ª terminar e levar 429.
    """
    async with SessionLocal() as s:
        for _ in range(MAX_FALHAS_EMAIL - 1):
            AuthRepository(s).registrar_tentativa(admin.email, "10.0.0.9", sucesso=False)
        await s.commit()

    async with SessionLocal() as decima:
        repo = AuthRepository(decima)
        await repo.travar_email(admin.email)  # a 10ª pegou a vez e está conferindo a senha
        repo.registrar_tentativa(admin.email, "10.0.0.9", sucesso=False)
        await decima.flush()
        seguinte = asyncio.create_task(
            client.post("/auth/login", json={"email": admin.email, "senha": "chute-11"})
        )
        await _esperar_alguem_na_fila(seguinte)
        await decima.commit()

    resp = await seguinte
    assert resp.status_code == 429, (
        f"a 11ª senha foi conferida ({resp.status_code}) sem esperar a 10ª ser contada"
    )


async def test_conferir_a_senha_nao_congela_o_servidor(
    client: AsyncClient, admin: User, monkeypatch
) -> None:
    """bcrypt leva ~0,3 s de CPU. Rodando no event loop, nesse tempo nada mais anda.

    O bcrypt falso fica preso até o teste soltá-lo. Se ele rodar no loop, o teste só volta a
    andar depois que ele saiu — e é isso que a asserção pega. Numa thread, o teste anda com
    a conferência ainda em curso, que é o que o PDV precisa enquanto alguém faz login.
    """
    entrou, liberar, saiu = threading.Event(), threading.Event(), threading.Event()
    original = bcrypt.checkpw

    def checkpw_preso(senha: bytes, hash_: bytes) -> bool:
        entrou.set()
        liberar.wait(timeout=3)  # rodando no loop, ninguém solta: espera o prazo inteiro
        saiu.set()
        return original(senha, hash_)

    monkeypatch.setattr(bcrypt, "checkpw", checkpw_preso)

    login = asyncio.create_task(
        client.post("/auth/login", json={"email": admin.email, "senha": "senha1234"})
    )
    assert await asyncio.to_thread(entrou.wait, 10), "o login não chegou a conferir a senha"
    loop_livre = not saiu.is_set()
    liberar.set()

    assert (await login).status_code == 200
    assert loop_livre, "o bcrypt rodou dentro do event loop: o servidor inteiro parou esperando"


# ───────────────────────────────────────────────── faxina
async def test_login_certo_faz_a_faxina_sem_apagar_o_que_denuncia_reuso(
    client: AsyncClient, session, admin: User
) -> None:
    """Tentativas e refresh tokens viravam linha para sempre — e iam em cada dump ao Drive.

    O login certo limpa o que já não serve: tentativa com mais de um dia e refresh VENCIDO.
    O revogado ainda dentro da validade fica: é ele que denuncia uma cópia roubada (ADR-12).
    """
    agora = datetime.now(UTC)
    revogado_vivo = uuid.uuid4()
    session.add_all(
        [
            LoginAttempt(email="velho@x.com", ip="1.2.3.4", sucesso=False,
                         created_at=agora - timedelta(days=2)),
            LoginAttempt(email="recente@x.com", ip="1.2.3.4", sucesso=False,
                         created_at=agora - timedelta(minutes=5)),
            RefreshToken(jti=uuid.uuid4(), user_id=admin.id, family_id=uuid.uuid4(),
                         expires_at=agora - timedelta(days=3), revoked=True),
            RefreshToken(jti=revogado_vivo, user_id=admin.id, family_id=uuid.uuid4(),
                         expires_at=agora + timedelta(days=5), revoked=True),
        ]
    )
    await session.commit()

    resp = await client.post("/auth/login", json={"email": admin.email, "senha": "senha1234"})
    assert resp.status_code == 200

    async with SessionLocal() as s:
        emails = set(
            (await s.execute(select(LoginAttempt.email))).scalars().all()
        )
        vencidos = (
            await s.execute(
                select(func.count()).select_from(RefreshToken)
                .where(RefreshToken.expires_at < agora)
            )
        ).scalar_one()
        assert await s.get(RefreshToken, revogado_vivo) is not None, (
            "a faxina apagou um token revogado ainda válido: o reuso dele não seria detectado"
        )
    assert "velho@x.com" not in emails, "tentativa de dois dias atrás continua guardada"
    assert "recente@x.com" in emails, "a faxina apagou tentativa que ainda conta para a trava"
    assert vencidos == 0, "refresh token vencido há dias continua guardado"
