"""A Vercel como segunda forma de rodar (ADR-42): a estrutura e o build.

Nada daqui roda na loja. O que se prende:

- o `vercel.json` manda ao navegador as MESMAS barreiras que o Caddy manda na loja (a CSP é a
  segunda linha contra XSS, e o token mora em memória);
- a função, o build e o Python declarados batem entre si (pyproject, vercel.json,
  .python-version) — erro de digitação aqui só apareceria no deploy;
- a instalação é a da trava (requirements.lock), conferida versão por versão;
- o build de produção migra e semeia UMA vez, sem imprimir segredo; o de preview não toca no
  banco; fora da Vercel o script se recusa.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tomllib
from collections.abc import AsyncIterator
from pathlib import Path

import asyncpg
import pytest
from sqlalchemy.engine import make_url

from app.core.config import PASTA_API, settings
from app.core.security import verificar_senha
from scripts import vercel_build, vercel_instalar

RAIZ = PASTA_API.parent
VERCEL_JSON = json.loads((PASTA_API / "vercel.json").read_text(encoding="utf-8"))
PYPROJECT = tomllib.loads((PASTA_API / "pyproject.toml").read_text(encoding="utf-8"))
CADDYFILE = (RAIZ / "docker" / "Caddyfile").read_text(encoding="utf-8")


def _diretivas(csp: str) -> dict[str, set[str]]:
    diretivas = {}
    for parte in csp.split(";"):
        nome, *valores = parte.split()
        diretivas[nome] = set(valores)
    return diretivas


def _cabecalho_vercel(nome: str) -> str:
    for regra in VERCEL_JSON["headers"]:
        for cabecalho in regra["headers"]:
            if cabecalho["key"] == nome:
                return cabecalho["value"]
    raise AssertionError(f"vercel.json não manda {nome}")


def _cabecalho_caddy(nome: str) -> str:
    achou = re.search(rf'{nome}\s+"([^"]+)"', CADDYFILE)
    assert achou, f"Caddyfile não manda {nome}"
    return achou.group(1)


# ------------------------------------------------------------ vercel.json


def test_csp_da_vercel_e_a_do_caddy() -> None:
    """Mesma CSP da loja; muda só o que o Caddy escreve com {hostport} e a origem das fotos."""
    vercel = _diretivas(_cabecalho_vercel("Content-Security-Policy"))
    caddy = _diretivas(_cabecalho_caddy("Content-Security-Policy"))

    assert vercel["script-src"] == {"'self'"}, "script inline/de fora reabre o XSS"
    for nome in caddy.keys() - {"connect-src", "img-src"}:
        assert vercel[nome] == caddy[nome], nome
    # `'self'` cobre ws/wss da mesma origem (CSP 3); {hostport} não existe no vercel.json.
    assert vercel["connect-src"] == {"'self'"}
    # As fotos de produto, na Vercel, moram no Vercel Blob.
    assert vercel["img-src"] == caddy["img-src"] | {"https://*.public.blob.vercel-storage.com"}


def test_hsts_e_permissions_policy_da_vercel_sao_os_do_caddy() -> None:
    for nome in ("Strict-Transport-Security", "Permissions-Policy"):
        assert _cabecalho_vercel(nome) == _cabecalho_caddy(nome)


def test_cabecalhos_que_a_api_ja_poe_nao_se_repetem() -> None:
    """X-Frame-Options em dobro ("DENY, DENY") é valor inválido para alguns navegadores."""
    chaves = {c["key"] for regra in VERCEL_JSON["headers"] for c in regra["headers"]}
    assert not chaves & {"X-Content-Type-Options", "X-Frame-Options", "Referrer-Policy"}


def test_funcao_build_e_python_declarados_batem() -> None:
    entrypoint = PYPROJECT["tool"]["vercel"]["entrypoint"]
    modulo, variavel = entrypoint.split(":")
    arquivo = modulo.replace(".", "/") + ".py"
    assert (PASTA_API / arquivo).is_file() and variavel == "app"
    # A chave de `functions` é o ARQUIVO do entrypoint resolvido (doc da Vercel, FastAPI).
    assert list(VERCEL_JSON["functions"]) == [arquivo]
    funcao = VERCEL_JSON["functions"][arquivo]
    assert 0 < funcao["maxDuration"] <= 300, "300 s é o teto do plano Hobby"
    assert VERCEL_JSON["regions"] == ["gru1"], "Hobby: uma região só, a de São Paulo"

    build = PYPROJECT["tool"]["vercel"]["scripts"]["build"]
    assert build == "python scripts/vercel_build.py"
    assert VERCEL_JSON["installCommand"] == "python scripts/vercel_instalar.py"
    assert PYPROJECT["tool"]["vercel"]["fastapi"]["static"]["cdn"] is False

    versao = (PASTA_API / ".python-version").read_text().strip()
    assert versao in {"3.12", "3.13", "3.14"}, "versões que a Vercel oferece"
    assert PYPROJECT["project"]["requires-python"] == ">=3.11"


def test_o_que_sai_do_pacote_da_funcao_nao_leva_o_que_ela_usa() -> None:
    excluidos = VERCEL_JSON["functions"]["app/main.py"]["excludeFiles"]
    for necessario in ("app/", "web_vercel"):
        assert necessario not in excluidos
    assert "tests/**" in excluidos


# ------------------------------------------------------------ instalação


def test_trava_lida_inteira() -> None:
    travadas = vercel_instalar.ler_trava()
    assert travadas["fastapi"] and travadas["asyncpg"] and travadas["bcrypt"]
    assert all(re.fullmatch(r"[\w.+!-]+", v) for v in travadas.values())
    linhas = (PASTA_API / "requirements.lock").read_text().splitlines()
    pinadas = [linha for linha in linhas if "==" in linha and not linha.startswith("#")]
    assert len(travadas) == len(pinadas)


def test_divergencia_de_versao_e_falta_aparecem() -> None:
    instaladas = {"fastapi": "0.1.0", "asyncpg": "0.32.0"}
    erradas = vercel_instalar.divergencias(
        {"fastapi": "0.120.0", "asyncpg": "0.32.0", "bcrypt": "5.0.0"}, instaladas.get
    )
    assert erradas == [
        "bcrypt: trava 5.0.0, instalado nada",
        "fastapi: trava 0.120.0, instalado 0.1.0",
    ]


def test_instala_sem_dependencias_com_uv_ou_pip() -> None:
    com_uv = vercel_instalar.comando_de_instalacao("/usr/bin/uv")
    assert com_uv == [[
        "/usr/bin/uv", "pip", "install", "--python", sys.executable, "--no-deps",
        "-r", str(vercel_instalar.TRAVA),
    ]]
    sem_uv = vercel_instalar.comando_de_instalacao(None)
    assert sem_uv[0][1:] == ["-m", "ensurepip", "--default-pip"]
    assert "--no-deps" in sem_uv[1] and str(vercel_instalar.TRAVA) in sem_uv[1]


def test_build_sem_o_web_por_perto_explica_o_que_ligar(tmp_path: Path) -> None:
    with pytest.raises(SystemExit, match="Include files outside the root directory"):
        vercel_build.copiar_web(tmp_path / "nao-existe", tmp_path / "destino")
    assert not (tmp_path / "destino").exists()


def test_erro_de_config_no_build_nao_vaza_a_url_do_banco() -> None:
    from pydantic import ValidationError

    from app.core.config import Settings

    with pytest.raises(ValidationError) as erro:
        Settings(
            _env_file=None,
            ambiente="producao",
            jwt_secret="curto",
            database_url="postgres://dono:SENHA-DO-BANCO@ep-x.neon.tech/db?sslmode=require",
        )
    # O pydantic repete os valores lidos (`input_value`) na mensagem — por isso o filtro.
    texto = vercel_build._sem_segredos(erro.value)
    assert "JWT_SECRET" in texto
    assert "SENHA-DO-BANCO" not in texto


# ------------------------------------------------------------ o build de verdade

SENHA_DO_DONO = "Senha-Do-Dono-123"


async def _admin_postgres() -> asyncpg.Connection:
    url = make_url(settings.database_url)
    return await asyncpg.connect(
        host=url.host, port=url.port or 5432, user=url.username, password=url.password,
        database="postgres",
    )


@pytest.fixture
async def banco_da_vercel() -> AsyncIterator[str]:
    """Um banco vazio, como o Neon recém-criado. Devolve a URL no formato do Neon."""
    nome = f"{make_url(settings.database_url).database}_vercel"
    conexao = await _admin_postgres()
    try:
        await conexao.execute(f'DROP DATABASE IF EXISTS "{nome}" WITH (FORCE)')
        await conexao.execute(f'CREATE DATABASE "{nome}"')
    finally:
        await conexao.close()
    url = make_url(settings.database_url).set(
        drivername="postgres",
        database=nome,
        query={"sslmode": "disable", "channel_binding": "disable"},
    )
    try:
        yield url.render_as_string(hide_password=False)
    finally:
        conexao = await _admin_postgres()
        try:
            await conexao.execute(f'DROP DATABASE IF EXISTS "{nome}" WITH (FORCE)')
        finally:
            await conexao.close()


def _rodar_build(tmp_path: Path, **env: str) -> subprocess.CompletedProcess[str]:
    limpo = {
        chave: valor
        for chave, valor in os.environ.items()
        if not chave.startswith(("VERCEL", "DATABASE_URL", "DEMO_", "SEED_"))
        and chave not in {"AMBIENTE", "CORS_ORIGINS", "DEBUG", "MEDIA_DIR", "WEB_DIR", "JWT_SECRET"}
    }
    limpo.update(
        JWT_SECRET="j" * 48,
        WEB_DIR=str(tmp_path / "web"),
        MEDIA_DIR=str(tmp_path / "media"),
        VERCEL_PROJECT_PRODUCTION_URL="loja-tria.vercel.app",
        **env,
    )
    return subprocess.run(
        [sys.executable, "scripts/vercel_build.py"],
        cwd=PASTA_API, env=limpo, capture_output=True, text=True, timeout=600,
    )


async def _consultar(url_neon: str, sql: str):
    url = make_url(url_neon)
    conexao = await asyncpg.connect(
        host=url.host, port=url.port or 5432, user=url.username, password=url.password,
        database=url.database,
    )
    try:
        return await conexao.fetch(sql)
    finally:
        await conexao.close()


async def test_build_de_producao_migra_e_semeia_uma_vez_so(
    banco_da_vercel: str, tmp_path: Path
) -> None:
    # A URL do pooler é falsa de propósito: se o build usasse ela em vez da UNPOOLED, nem
    # conectaria.
    pooler = "postgres://x:y@ep-nao-existe-pooler.invalid/neondb?sslmode=require"
    env = dict(
        VERCEL="1",
        VERCEL_ENV="production",
        DATABASE_URL=pooler,
        DATABASE_URL_UNPOOLED=banco_da_vercel,
        DEMO_ADMIN_EMAIL="dono@demo.com",
        DEMO_ADMIN_SENHA=SENHA_DO_DONO,
    )
    feito = _rodar_build(tmp_path, **env)
    saida = feito.stdout + feito.stderr
    assert feito.returncode == 0, saida[-3000:]

    # Nunca imprime senha nem URL do banco.
    assert SENHA_DO_DONO not in saida
    assert banco_da_vercel not in saida and pooler not in saida

    # O web e as páginas legais foram para dentro do projeto.
    assert (tmp_path / "web" / "index.html").is_file()
    assert (tmp_path / "web" / "legal" / "privacidade.html").is_file()

    versao_teste = (await _consultar(
        settings.database_url.replace("+asyncpg", ""), "SELECT version_num FROM alembic_version"
    ))[0][0]
    assert (await _consultar(banco_da_vercel, "SELECT version_num FROM alembic_version"))[0][
        0
    ] == versao_teste

    usuarios = await _consultar(banco_da_vercel, "SELECT email, role, password_hash FROM users")
    papeis = {linha["email"]: linha["role"] for linha in usuarios}
    assert papeis == {"dono@demo.com": "ADMIN", "ana@loja.com": "VENDEDOR"}
    ana = next(linha for linha in usuarios if linha["email"] == "ana@loja.com")
    assert not verificar_senha("senha12345", ana["password_hash"]), (
        "senha conhecida numa demonstração pública é balcão aberto"
    )

    async def _contagens() -> tuple[int, int, int]:
        linha = (await _consultar(
            banco_da_vercel,
            "SELECT (SELECT count(*) FROM products), (SELECT count(*) FROM sales), "
            "(SELECT count(*) FROM users)",
        ))[0]
        return tuple(linha)

    antes = await _contagens()
    assert antes[0] == 10 and antes[1] > 100

    # Build de novo (redeploy): nada duplicado.
    de_novo = _rodar_build(tmp_path, **env)
    assert de_novo.returncode == 0, (de_novo.stdout + de_novo.stderr)[-3000:]
    assert "já tem usuário" in de_novo.stdout
    assert await _contagens() == antes


async def test_build_de_preview_nao_toca_no_banco(banco_da_vercel: str, tmp_path: Path) -> None:
    feito = _rodar_build(
        tmp_path,
        VERCEL="1",
        VERCEL_ENV="preview",
        DATABASE_URL=banco_da_vercel,
        DEMO_ADMIN_EMAIL="dono@demo.com",
        DEMO_ADMIN_SENHA=SENHA_DO_DONO,
    )
    assert feito.returncode == 0, (feito.stdout + feito.stderr)[-3000:]
    assert "não é tocado" in feito.stdout
    assert (tmp_path / "web" / "index.html").is_file()
    tabela = await _consultar(banco_da_vercel, "SELECT to_regclass('public.users')")
    assert tabela[0][0] is None


def test_fora_da_vercel_o_build_se_recusa(tmp_path: Path) -> None:
    feito = _rodar_build(tmp_path, DATABASE_URL=settings.database_url, VERCEL_ENV="production")
    assert feito.returncode == 1
    assert "atualizar.sh" in feito.stdout
    assert not (tmp_path / "web").exists()


# ------------------------------------------------------------ o web servido pela função


async def test_na_loja_o_web_continua_saindo_de_onde_saia(client) -> None:
    """`web/` ao lado de `api/`: /app, as páginas legais e o / que leva ao sistema.

    (URLs absolutas: o `client` dos testes tem base em /api/v1.)
    """
    assert settings.web_dir == str(RAIZ / "web")
    pagina = await client.get("http://test/app/")
    assert pagina.status_code == 200 and "text/html" in pagina.headers["content-type"]
    raiz = await client.get("http://test/", follow_redirects=False)
    assert raiz.status_code in (302, 307) and raiz.headers["location"] == "/app/"
    assert (await client.get("http://test/privacidade")).status_code == 200
    assert (await client.get("http://test/legal/exclusao-de-dados.html")).status_code == 200


def test_web_dir_aponta_a_pasta_que_a_funcao_serve(tmp_path: Path) -> None:
    """Na Vercel o web é a cópia do build; o main.py serve a pasta que a config disser."""
    (tmp_path / "legal").mkdir()
    (tmp_path / "index.html").write_text("<p>copia-do-build</p>", encoding="utf-8")
    (tmp_path / "legal" / "privacidade.html").write_text("<p>privacidade</p>", encoding="utf-8")
    programa = (
        "from fastapi.testclient import TestClient\n"
        "from app.main import app\n"
        "c = TestClient(app)\n"
        "print(c.get('/app/').text)\n"
        "print(c.get('/privacidade').status_code)\n"
    )
    feito = subprocess.run(
        [sys.executable, "-c", programa],
        cwd=PASTA_API, capture_output=True, text=True, timeout=120,
        env={**os.environ, "WEB_DIR": str(tmp_path), "MEDIA_DIR": str(tmp_path / "media")},
    )
    assert feito.returncode == 0, feito.stderr[-2000:]
    assert "copia-do-build" in feito.stdout and "200" in feito.stdout


async def test_ip_do_login_atras_da_vercel_e_o_do_cliente(client, session) -> None:
    """A Vercel SOBRESCREVE o X-Forwarded-For com o IP de quem chamou (não anexa ao que o
    cliente mandou): o primeiro da lista, que é o que a trava de força bruta lê, é o real.
    Nada a configurar — o mesmo código serve atrás do Caddy e atrás da Vercel."""
    from sqlalchemy import text

    resposta = await client.post(
        "/auth/login",
        json={"email": "ninguem@demo.com", "senha": "errada123"},
        headers={"x-forwarded-for": "203.0.113.9"},
    )
    assert resposta.status_code == 401
    ip = (await session.execute(text("SELECT ip FROM login_attempts"))).scalar_one()
    assert ip == "203.0.113.9"
