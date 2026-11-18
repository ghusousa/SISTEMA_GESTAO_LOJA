"""Excluir a própria conta de dentro do app — Apple 5.1.1(v) (ADR-45).

A promessa, em três partes: (1) qualquer pessoa exclui a própria conta, confirmando com a
senha, e a conta deixa de existir de verdade — sessões, leitor, e-mail no diário; (2) a
senha errada é 422, nunca 401, e não derruba ninguém; (3) a loja nunca fica sem dono — o
único dono passa o papel antes. E o que a pessoa fez na loja (venda, diário) fica, com o
nome congelado, inclusive para quem já vendeu, cuja linha não pode sair.
"""

import asyncio
import uuid

from httpx import ASGITransport, AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import hash_senha
from app.main import app
from app.modules.usuarios.models import Papel, User
from app.modules.usuarios.service import DONO_UNICO
from tests.conftest import criar_produto

SENHA = "senha1234"


async def _entrar(client: AsyncClient, email: str) -> tuple[dict[str, str], str]:
    """Crachá (access) e refresh de um login de verdade."""
    resp = await client.post("/auth/login", json={"email": email, "senha": SENHA})
    assert resp.status_code == 200, resp.text
    dados = resp.json()
    return {"Authorization": f"Bearer {dados['access_token']}"}, dados["refresh_token"]


async def _excluir_a_minha(client: AsyncClient, auth: dict[str, str], senha: str = SENHA):
    # httpx não põe corpo no `.delete()`; o app e o web mandam a senha no corpo do DELETE.
    return await client.request("DELETE", "/usuarios/me", headers=auth, json={"senha": senha})


async def _renovar(client: AsyncClient, refresh: str):
    return await client.post("/auth/refresh", json={"refresh_token": refresh})


async def _contar(session: AsyncSession, sql: str, **params: object) -> int:
    return int(await session.scalar(text(sql).bindparams(**params)) or 0)


async def _outro_dono(session: AsyncSession, *, ativo: bool = True) -> User:
    dono = User(
        name="Seu Joaquim",
        email="joaquim@loja.com",
        password_hash=hash_senha(SENHA),
        role=Papel.ADMIN,
        is_active=ativo,
    )
    session.add(dono)
    await session.commit()
    await session.refresh(dono)
    return dono


async def _vender(client: AsyncClient, auth_dono: dict, auth_quem_vende: dict) -> int:
    """Uma venda de verdade, registrada por quem vai excluir a conta depois."""
    categoria = await client.post("/categorias", headers=auth_dono, json={"nome": "Blusas"})
    produto = await criar_produto(client, auth_dono, {
        "categoria_id": categoria.json()["id"],
        "nome": "Blusa de Linho",
        "variantes": [{
            "tamanho": "M", "cor": "Azul", "codigo_barras": "7891111111111",
            "preco_custo": "10.00", "preco_venda": "39.90", "estoque_inicial": 3,
        }],
    })
    venda = await client.post("/vendas", headers=auth_quem_vende, json={
        "client_uuid": str(uuid.uuid4()),
        "itens": [{"variante_id": produto["variantes"][0]["id"], "quantidade": 1}],
        "pagamentos": [{"forma": "DINHEIRO", "valor": "39.90"}],
    })
    assert venda.status_code == 201, venda.text
    return venda.json()["id"]


# ------------------------------------------------------------------ o caminho feliz


async def test_vendedora_exclui_a_propria_conta_e_a_linha_some(
    client: AsyncClient, vendedor: User, session: AsyncSession
) -> None:
    auth, refresh = await _entrar(client, vendedor.email)

    resp = await _excluir_a_minha(client, auth)
    assert resp.status_code == 204, resp.text

    assert await _contar(session, "SELECT count(*) FROM users WHERE id = :i", i=vendedor.id) == 0
    # As sessões caíram: o crachá não abre mais nada e o refresh não renova.
    assert (await client.get("/auth/me", headers=auth)).status_code == 401
    assert (await _renovar(client, refresh)).status_code == 401
    # E não se entra de novo com o mesmo e-mail e senha.
    entrar = await client.post("/auth/login", json={"email": vendedor.email, "senha": SENHA})
    assert entrar.status_code == 401


async def test_a_resposta_apaga_o_cookie_do_navegador(
    client: AsyncClient, vendedor: User
) -> None:
    """No web o refresh mora num cookie httpOnly: a exclusão o apaga, como o logout."""
    auth, _ = await _entrar(client, vendedor.email)
    resp = await _excluir_a_minha(client, auth)
    assert resp.status_code == 204
    cookie = resp.headers.get("set-cookie", "")
    assert "loja_refresh=" in cookie and "Path=/api/v1/auth" in cookie
    assert "Max-Age=0" in cookie or "expires=" in cookie.lower()


async def test_gerente_e_supervisora_tambem_excluem(
    client: AsyncClient, gerente: User, supervisora: User, session: AsyncSession
) -> None:
    for pessoa in (gerente, supervisora):
        auth, _ = await _entrar(client, pessoa.email)
        assert (await _excluir_a_minha(client, auth)).status_code == 204
    assert await _contar(session, "SELECT count(*) FROM users") == 0


async def test_dono_com_outro_dono_ativo_exclui_a_propria(
    client: AsyncClient, admin: User, session: AsyncSession
) -> None:
    joaquim = await _outro_dono(session)
    auth, _ = await _entrar(client, admin.email)

    assert (await _excluir_a_minha(client, auth)).status_code == 204
    restantes = (await session.execute(text("SELECT id FROM users"))).scalars().all()
    assert restantes == [joaquim.id]


# ------------------------------------------------------------------ as recusas


async def test_senha_errada_e_422_e_a_sessao_continua(
    client: AsyncClient, vendedor: User, session: AsyncSession
) -> None:
    """401 faria o app renovar e, recusado, deslogar: errar a senha não pode derrubar ninguém."""
    auth, refresh = await _entrar(client, vendedor.email)

    resp = await _excluir_a_minha(client, auth, senha="nao-e-esta")
    assert resp.status_code == 422, resp.text
    assert resp.json()["code"] == "SENHA_INCORRETA"

    assert await _contar(session, "SELECT count(*) FROM users WHERE id = :i", i=vendedor.id) == 1
    assert (await client.get("/auth/me", headers=auth)).status_code == 200
    assert (await _renovar(client, refresh)).status_code == 200


async def test_sem_senha_e_422_de_validacao(client: AsyncClient, vendedor: User) -> None:
    auth, _ = await _entrar(client, vendedor.email)
    sem_corpo = await client.delete("/usuarios/me", headers=auth)
    assert sem_corpo.status_code == 422
    vazia = await _excluir_a_minha(client, auth, senha="")
    assert vazia.status_code == 422
    assert vazia.json()["code"] == "VALIDACAO"


async def test_sem_login_nao_exclui_nada(client: AsyncClient, vendedor: User) -> None:
    resp = await client.request("DELETE", "/usuarios/me", json={"senha": SENHA})
    assert resp.status_code == 401


async def test_unico_dono_nao_se_exclui(
    client: AsyncClient, admin: User, vendedor: User, session: AsyncSession
) -> None:
    auth, refresh = await _entrar(client, admin.email)

    resp = await _excluir_a_minha(client, auth)
    assert resp.status_code == 409, resp.text
    assert resp.json()["code"] == "OPERACAO_INVALIDA"
    assert resp.json()["message"] == (
        "Você é o único dono da loja. Passe o papel de dono a outra pessoa em Usuários antes "
        "de excluir a sua conta."
    )
    assert resp.json()["message"] == DONO_UNICO
    assert await _contar(session, "SELECT count(*) FROM users WHERE id = :i", i=admin.id) == 1
    assert (await _renovar(client, refresh)).status_code == 200


async def test_dono_desativado_nao_conta_como_outro_dono(
    client: AsyncClient, admin: User, session: AsyncSession
) -> None:
    """Quem administra a loja é dono ATIVO: um dono desligado não segura a loja."""
    await _outro_dono(session, ativo=False)
    auth, _ = await _entrar(client, admin.email)
    resp = await _excluir_a_minha(client, auth)
    assert resp.status_code == 409
    assert resp.json()["message"] == DONO_UNICO


async def test_dois_donos_saindo_juntos_sobra_um(
    admin: User, session: AsyncSession
) -> None:
    """Cada um contava o outro: sem trava, os dois saíam e a loja ficava sem dono."""
    await _outro_dono(session)

    async def sair(email: str) -> int:
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test/api/v1"
        ) as cliente:
            auth, _ = await _entrar(cliente, email)
            return (await _excluir_a_minha(cliente, auth)).status_code

    resultados = sorted(await asyncio.gather(sair(admin.email), sair("joaquim@loja.com")))
    assert resultados == [204, 409]
    donos = await _contar(
        session, "SELECT count(*) FROM users WHERE role = 'ADMIN' AND is_active"
    )
    assert donos == 1


async def test_dois_aparelhos_excluindo_a_mesma_conta_juntos(
    vendedor: User, session: AsyncSession
) -> None:
    """O celular e o computador da Ana confirmam ao mesmo tempo: uma exclusão só, e nada de
    500 na segunda (ela encontra a conta já excluída)."""
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test/api/v1") as c1:
        auth_celular, _ = await _entrar(c1, vendedor.email)
        auth_computador, _ = await _entrar(c1, vendedor.email)

    async def excluir(auth: dict[str, str]) -> int:
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test/api/v1"
        ) as cliente:
            return (await _excluir_a_minha(cliente, auth)).status_code

    resultados = sorted(await asyncio.gather(excluir(auth_celular), excluir(auth_computador)))
    assert resultados[0] == 204
    assert resultados[1] in (401, 404)  # a sessão já caiu, ou a conta já não existe
    assert await _contar(session, "SELECT count(*) FROM users") == 0
    assert await _contar(
        session, "SELECT count(*) FROM audit_log WHERE acao = 'USUARIO_EXCLUIU_PROPRIA_CONTA'"
    ) == 1


async def test_rota_do_dono_continua_recusando_a_propria_conta(
    client: AsyncClient, admin: User, session: AsyncSession
) -> None:
    """Pela rota da equipe não se exclui a si mesmo: o caminho é Minha conta, com a senha."""
    await _outro_dono(session)  # nem com outro dono: a recusa é por ser a própria
    auth, _ = await _entrar(client, admin.email)
    resp = await client.delete(f"/usuarios/{admin.id}", headers=auth)
    assert resp.status_code == 409
    assert resp.json()["code"] == "OPERACAO_INVALIDA"
    assert "Minha conta" in resp.json()["message"]


# ------------------------------------------------------------------ o que vai e o que fica


async def test_diario_ganha_a_linha_com_nome_congelado_e_sem_vinculo(
    client: AsyncClient, vendedor: User, session: AsyncSession
) -> None:
    """A borda grava depois do commit, com a conta já apagada: sem `user_id` (o FK
    derrubaria a linha) e com o nome e o papel de antes de sair."""
    auth, _ = await _entrar(client, vendedor.email)
    assert (await _excluir_a_minha(client, auth)).status_code == 204

    linha = (
        await session.execute(
            text(
                "SELECT user_id, user_nome, user_papel, descricao, entidade FROM audit_log "
                "WHERE acao = 'USUARIO_EXCLUIU_PROPRIA_CONTA'"
            )
        )
    ).one()
    assert linha.user_id is None
    assert linha.user_nome == "Ana Vendedora"
    assert linha.user_papel == "VENDEDOR"
    assert linha.descricao == "Excluiu a própria conta"
    assert linha.entidade == "usuario"


async def test_senha_errada_nao_entra_no_diario(
    client: AsyncClient, vendedor: User, session: AsyncSession
) -> None:
    auth, _ = await _entrar(client, vendedor.email)
    await _excluir_a_minha(client, auth, senha="nao-e-esta")
    assert await _contar(
        session, "SELECT count(*) FROM audit_log WHERE acao = 'USUARIO_EXCLUIU_PROPRIA_CONTA'"
    ) == 0


async def test_email_some_das_linhas_antigas_do_diario(
    client: AsyncClient, vendedor: User, session: AsyncSession
) -> None:
    """Linha do formato antigo (`LOGIN_FALHOU` com o e-mail por extenso): vira máscara."""
    await session.execute(
        text(
            "INSERT INTO audit_log (user_nome, acao, descricao) VALUES (:e, 'LOGIN_FALHOU', :d)"
        ).bindparams(e=vendedor.email, d=f"Tentou entrar e errou a senha ({vendedor.email})")
    )
    await session.commit()
    auth, _ = await _entrar(client, vendedor.email)

    assert (await _excluir_a_minha(client, auth)).status_code == 204

    com_email = await _contar(
        session,
        "SELECT count(*) FROM audit_log WHERE user_nome ILIKE :p OR descricao ILIKE :p",
        p=f"%{vendedor.email}%",
    )
    assert com_email == 0
    assert await _contar(
        session, "SELECT count(*) FROM audit_log WHERE user_nome = 'an***@l***.com'"
    ) == 1


async def test_pareamento_do_leitor_some_junto(
    client: AsyncClient, admin: User, vendedor: User, session: AsyncSession
) -> None:
    """O celular dela lia para o computador do dono: o pareamento não sobra órfão."""
    auth_dono, _ = await _entrar(client, admin.email)
    auth, _ = await _entrar(client, vendedor.email)
    criado = await client.post("/leitor/pareamentos", headers=auth_dono, json=None)
    assert criado.status_code == 201, criado.text
    aceito = await client.post(
        "/leitor/pareamentos/aceitar", headers=auth, json={"codigo": criado.json()["codigo"]}
    )
    assert aceito.status_code == 200, aceito.text

    assert (await _excluir_a_minha(client, auth)).status_code == 204
    assert await _contar(session, "SELECT count(*) FROM leitor_pareamentos") == 0


# ------------------------------------------------------------------ quem já vendeu


async def test_quem_ja_vendeu_tambem_exclui_e_a_venda_fica_com_o_nome(
    client: AsyncClient, admin: User, vendedor: User, session: AsyncSession
) -> None:
    """A venda prende a linha (FK RESTRICT, é contabilidade): apagar dava 500. A conta sai
    do mesmo jeito — e-mail, senha, sessões, leitor —, e a linha fica só com o nome de quem
    vendeu, fora da equipe."""
    auth_dono, _ = await _entrar(client, admin.email)
    auth, refresh = await _entrar(client, vendedor.email)
    venda_id = await _vender(client, auth_dono, auth)
    pc = await client.post("/leitor/pareamentos", headers=auth, json=None)
    assert pc.status_code == 201, pc.text

    resp = await _excluir_a_minha(client, auth)
    assert resp.status_code == 204, resp.text

    # Ninguém entra: nem com o crachá, nem com o refresh, nem com e-mail e senha.
    assert (await client.get("/auth/me", headers=auth)).status_code == 401
    assert (await _renovar(client, refresh)).status_code == 401
    entrar = await client.post("/auth/login", json={"email": vendedor.email, "senha": SENHA})
    assert entrar.status_code == 401
    # O que era da conta foi embora; a linha guarda só quem fez a venda.
    linha = (
        await session.execute(
            text(
                "SELECT name, email, is_active, deleted_at FROM users WHERE id = :i"
            ).bindparams(i=vendedor.id)
        )
    ).one()
    assert linha.name == "Ana Vendedora"
    assert linha.email != vendedor.email and linha.email.endswith("@excluida.example")
    assert linha.is_active is False and linha.deleted_at is not None
    assert await _contar(session, "SELECT count(*) FROM leitor_pareamentos") == 0
    assert await _contar(
        session, "SELECT count(*) FROM refresh_tokens WHERE user_id = :i AND NOT revoked",
        i=vendedor.id,
    ) == 0
    # A venda continua de pé, com o nome de quem vendeu.
    venda = await client.get(f"/vendas/{venda_id}", headers=auth_dono)
    assert venda.status_code == 200
    assert "Ana Vendedora" in venda.text
    # Fora da equipe, e não se reativa nem ganha senha nova.
    equipe = (await client.get("/usuarios", headers=auth_dono)).json()
    assert [u["id"] for u in equipe["items"]] == [admin.id]
    reativar = await client.patch(
        f"/usuarios/{vendedor.id}", headers=auth_dono, json={"ativo": True}
    )
    assert reativar.status_code == 404
    senha = await client.patch(
        f"/usuarios/{vendedor.id}/senha", headers=auth_dono, json={"nova_senha": "outra-1234"}
    )
    assert senha.status_code == 404
    # O diário tem a linha dela, sem vínculo e com o nome congelado.
    diario = (
        await session.execute(
            text(
                "SELECT user_id, user_nome FROM audit_log "
                "WHERE acao = 'USUARIO_EXCLUIU_PROPRIA_CONTA'"
            )
        )
    ).one()
    assert diario.user_id is None and diario.user_nome == "Ana Vendedora"


async def test_o_email_de_quem_saiu_fica_livre_para_uma_conta_nova(
    client: AsyncClient, admin: User, vendedor: User
) -> None:
    """A Ana saiu e voltou meses depois: o dono cria a conta nova com o mesmo e-mail."""
    auth_dono, _ = await _entrar(client, admin.email)
    auth, _ = await _entrar(client, vendedor.email)
    await _vender(client, auth_dono, auth)  # a linha antiga fica, presa à venda
    assert (await _excluir_a_minha(client, auth)).status_code == 204

    nova = await client.post("/usuarios", headers=auth_dono, json={
        "nome": "Ana Vendedora",
        "email": vendedor.email,
        "senha": "nova-senha-1",
        "papel": "VENDEDOR",
    })
    assert nova.status_code == 201, nova.text
    assert nova.json()["id"] != vendedor.id
