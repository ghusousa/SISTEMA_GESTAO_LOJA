"""A demonstração no mesmo domínio da loja, em `/demo` (ADR-46): a API montada sob o prefixo.

O proxy manda `/demo/...` à api-demo SEM tirar o prefixo, e as duas moram na MESMA origem do
navegador. O que se prende:

- sob `/demo` tudo responde (health, configuração, o web), e o `/demo/` leva ao sistema DA
  DEMO — um "/app/" seco levaria quem testa à loja de verdade;
- fora do prefixo é 404: a api-demo nunca responde pelo endereço da loja;
- o cookie do refresh tem o mesmo nome nas duas e vale só no caminho de cada uma: o navegador
  não manda o da loja à demo nem o contrário, e sair de uma não derruba a outra;
- as mutações da demo entram no diário com o caminho de sempre (sem o `/demo`);
- `GET /configuracao` diz se é a demonstração (a faixa "dados fictícios" das telas);
- um token assinado com OUTRO segredo — o da demo — não abre a loja, nem com os mesmos dados.
"""

import os
import subprocess
import sys
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient
from httpx import ASGITransport, AsyncClient
from jose import jwt
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.applications import Starlette
from starlette.routing import Mount

from app.core.config import PASTA_API, settings
from app.main import api, montar_no_prefixo
from app.modules.usuarios.models import User

SENHA = "senha1234"


@pytest.fixture
async def demo() -> AsyncIterator[AsyncClient]:
    """A api-demo como o proxy a vê: tudo sob /demo, sem tirar o prefixo."""
    async with AsyncClient(
        transport=ASGITransport(app=montar_no_prefixo(api, "/demo")), base_url="http://test"
    ) as c:
        yield c


def _cracha(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def test_sob_o_prefixo_responde_e_leva_ao_sistema_da_demo(demo: AsyncClient) -> None:
    saude = await demo.get("/demo/health")
    assert saude.status_code == 200 and saude.json()["status"] == "ok"

    raiz = await demo.get("/demo/", follow_redirects=False)
    assert raiz.status_code in (302, 307)
    assert raiz.headers["location"] == "/demo/app/", "o / da demo levaria à loja de verdade"

    pagina = await demo.get("/demo/app/")
    assert pagina.status_code == 200 and "text/html" in pagina.headers["content-type"]
    assert (await demo.get("/demo/privacidade")).status_code == 200
    # As barreiras de sempre também valem sob o prefixo.
    assert pagina.headers["x-frame-options"] == "DENY"


async def test_fora_do_prefixo_e_404(demo: AsyncClient) -> None:
    for caminho in (
        "/",
        "/health",
        "/app/",
        "/api/v1/configuracao",
        "/demonstracao/health",
        "/demo-x/health",
    ):
        resposta = await demo.get(caminho, follow_redirects=False)
        assert resposta.status_code == 404, caminho
        assert resposta.json()["code"] == "NAO_ENCONTRADO", caminho
    # Sem a barra, o próprio Starlette leva para dentro (o Caddy também faz isso).
    sem_barra = await demo.get("/demo", follow_redirects=False)
    assert sem_barra.status_code in (307, 308)
    assert sem_barra.headers["location"].endswith("/demo/")


def test_com_prefixo_o_app_da_imagem_e_o_envoltorio(tmp_path: Path) -> None:
    """O CMD da imagem não muda (`uvicorn app.main:app`): com PREFIXO=/demo, o mesmo nome é a
    API sob o prefixo — subindo e descendo inteira, como o uvicorn a sobe."""
    programa = (
        "from fastapi.testclient import TestClient\n"
        "from app.main import app\n"
        "with TestClient(app) as c:\n"
        "    print(c.get('/demo/health').json()['status'])\n"
        "    print(c.get('/demo/', follow_redirects=False).headers['location'])\n"
        "    print(c.get('/health').status_code)\n"
    )
    feito = subprocess.run(
        [sys.executable, "-c", programa],
        cwd=PASTA_API, capture_output=True, text=True, timeout=120,
        env={**os.environ, "PREFIXO": "/demo", "MEDIA_DIR": str(tmp_path / "media")},
    )
    assert feito.returncode == 0, feito.stderr[-2000:]
    assert feito.stdout.split() == ["ok", "/demo/app/", "404"]


def test_o_envoltorio_repassa_o_lifespan_e_o_root_path() -> None:
    """O `Mount` sozinho não roda a subida da API montada; o envoltório roda."""
    eventos: list[str] = []

    @asynccontextmanager
    async def vida(_: FastAPI) -> AsyncIterator[None]:
        eventos.append("subiu")
        yield
        eventos.append("desceu")

    pequena = FastAPI(lifespan=vida)

    @pequena.get("/onde")
    async def onde(request: Request) -> dict[str, str]:
        return {"raiz": request.scope["root_path"]}

    with TestClient(montar_no_prefixo(pequena, "/demo")) as cliente:
        assert eventos == ["subiu"]
        assert cliente.get("/demo/onde").json() == {"raiz": "/demo"}
        assert cliente.get("/onde").status_code == 404
    assert eventos == ["subiu", "desceu"]


async def test_configuracao_diz_se_e_a_demonstracao(
    demo: AsyncClient, client: AsyncClient, auth_admin: dict[str, str], monkeypatch
) -> None:
    # Na loja (e na Vercel), falso: nenhuma faixa.
    assert (await client.get("/configuracao")).json()["demonstracao"] is False
    assert (await demo.get("/demo/api/v1/configuracao")).json()["demonstracao"] is False

    monkeypatch.setattr(settings, "demonstracao", True)
    publica = await demo.get("/demo/api/v1/configuracao")
    assert publica.status_code == 200 and publica.json()["demonstracao"] is True
    completa = await demo.get("/demo/api/v1/configuracao/completa", headers=auth_admin)
    assert completa.status_code == 200 and completa.json()["demonstracao"] is True


async def test_login_sob_o_prefixo_guarda_o_refresh_no_caminho_da_demo(
    demo: AsyncClient, admin: User
) -> None:
    entrou = await demo.post(
        "/demo/api/v1/auth/login", json={"email": admin.email, "senha": SENHA}
    )
    assert entrou.status_code == 200, entrou.text
    cookie = entrou.headers["set-cookie"]
    assert cookie.startswith("loja_refresh=") and "HttpOnly" in cookie
    assert "Path=/demo/api/v1/auth" in cookie, cookie

    # O navegador manda o cookie de volta sozinho, no caminho dele: renova sem corpo.
    renovou = await demo.post("/demo/api/v1/auth/refresh")
    assert renovou.status_code == 200, renovou.text
    assert "Path=/demo/api/v1/auth" in renovou.headers["set-cookie"]

    saiu = await demo.post(
        "/demo/api/v1/auth/logout", headers=_cracha(renovou.json()["access_token"])
    )
    assert saiu.status_code == 204, saiu.text
    apagado = saiu.headers["set-cookie"]
    assert apagado.startswith("loja_refresh=") and "Path=/demo/api/v1/auth" in apagado
    assert "Max-Age=0" in apagado or "expires=" in apagado.lower()
    assert not list(demo.cookies.jar), "o cookie da demo ficou no navegador depois de sair"


async def test_excluir_a_propria_conta_na_demo_apaga_o_cookie_no_caminho_dela(
    demo: AsyncClient, admin: User, vendedor: User
) -> None:
    entrou = await demo.post(
        "/demo/api/v1/auth/login", json={"email": vendedor.email, "senha": SENHA}
    )
    assert entrou.status_code == 200, entrou.text
    saiu = await demo.request(
        "DELETE",
        "/demo/api/v1/usuarios/me",
        headers=_cracha(entrou.json()["access_token"]),
        json={"senha": SENHA},
    )
    assert saiu.status_code == 204, saiu.text
    assert "Path=/demo/api/v1/auth" in saiu.headers["set-cookie"]
    assert not list(demo.cookies.jar)


async def test_um_navegador_nas_duas_o_refresh_de_uma_nao_vai_para_a_outra(
    admin: User,
) -> None:
    """O domínio como o Caddy o monta: `/demo/*` para a demo, o resto para a loja — e UM
    navegador, com um pote de cookies só, entrando nas duas."""
    dominio = Starlette(routes=[Mount("/demo", app=api), Mount("", app=api)])
    async with AsyncClient(
        transport=ASGITransport(app=dominio), base_url="http://test"
    ) as navegador:
        loja = await navegador.post(
            "/api/v1/auth/login", json={"email": admin.email, "senha": SENHA}
        )
        assert loja.status_code == 200 and "Path=/api/v1/auth" in loja.headers["set-cookie"]
        # O cookie da loja não acompanha o pedido à demo: lá não há sessão nenhuma.
        sem_sessao = await navegador.post("/demo/api/v1/auth/refresh")
        assert sem_sessao.status_code == 401, "o refresh da loja foi parar na demo"

        demo = await navegador.post(
            "/demo/api/v1/auth/login", json={"email": admin.email, "senha": SENHA}
        )
        assert demo.status_code == 200
        caminhos = sorted((c.name, c.path) for c in navegador.cookies.jar)
        assert caminhos == [
            ("loja_refresh", "/api/v1/auth"),
            ("loja_refresh", "/demo/api/v1/auth"),
        ]

        # Sair da demo apaga só o dela; a sessão da loja segue renovando.
        saiu = await navegador.post(
            "/demo/api/v1/auth/logout", headers=_cracha(demo.json()["access_token"])
        )
        assert saiu.status_code == 204
        assert [(c.name, c.path) for c in navegador.cookies.jar] == [
            ("loja_refresh", "/api/v1/auth")
        ]
        assert (await navegador.post("/api/v1/auth/refresh")).status_code == 200


async def test_mutacao_sob_o_prefixo_entra_no_diario_com_o_caminho_de_sempre(
    demo: AsyncClient, auth_admin: dict[str, str], session: AsyncSession
) -> None:
    mudou = await demo.patch(
        "/demo/api/v1/configuracao", headers=auth_admin, json={"telefone": "(11) 4444-5555"}
    )
    assert mudou.status_code == 200, mudou.text
    linhas = (
        await session.execute(
            text("SELECT acao, metodo, caminho FROM audit_log WHERE metodo = 'PATCH'")
        )
    ).all()
    assert [tuple(linha) for linha in linhas] == [("LOJA_CONFIGURADA", "PATCH", "/configuracao")]


async def test_token_assinado_com_outro_segredo_nao_abre_a_loja(
    client: AsyncClient, admin: User
) -> None:
    """A demo assina com o segredo dela (DEMO_JWT_SECRET). O token só leva o id do usuário,
    e o id 1 da demo é o id 1 da loja: com o mesmo segredo, o crachá da demo — cuja senha
    está nas notas da Apple — abriria a loja de verdade. Aqui, os MESMOS dados com a
    assinatura de outro segredo: recusados, no acesso e na renovação."""
    entrou = await client.post("/auth/login", json={"email": admin.email, "senha": SENHA})
    assert entrou.status_code == 200
    tokens = entrou.json()
    outro_segredo = "segredo-da-demonstracao-" + "d" * 40
    assert outro_segredo != settings.jwt_secret

    def assinado_pela_demo(token: str) -> str:
        dados = jwt.get_unverified_claims(token)
        return jwt.encode(dados, outro_segredo, algorithm=settings.jwt_algorithm)

    # Controle: o original abre.
    original = await client.get("/auth/me", headers=_cracha(tokens["access_token"]))
    assert original.status_code == 200

    acesso = await client.get(
        "/auth/me", headers=_cracha(assinado_pela_demo(tokens["access_token"]))
    )
    assert acesso.status_code == 401 and acesso.json()["code"] == "TOKEN_INVALIDO"

    renovacao = await client.post(
        "/auth/refresh",
        json={"refresh_token": assinado_pela_demo(tokens["refresh_token"])},
    )
    assert renovacao.status_code == 401 and renovacao.json()["code"] == "TOKEN_INVALIDO"
    # E o refresh verdadeiro, que a tentativa não queimou, continua valendo.
    certo = await client.post("/auth/refresh", json={"refresh_token": tokens["refresh_token"]})
    assert certo.status_code == 200, certo.text
