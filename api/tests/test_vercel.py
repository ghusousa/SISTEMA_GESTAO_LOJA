"""A Vercel como segunda forma de rodar (ADR-42): a estrutura e o build.

Nada daqui roda na loja. O que se prende:

- o `vercel.json` manda ao navegador as MESMAS barreiras que o Caddy manda na loja (a CSP é a
  segunda linha contra XSS, e o token mora em memória);
- a função, o build e o Python declarados batem entre si (pyproject, vercel.json,
  .python-version) — erro de digitação aqui só apareceria no deploy;
- a instalação é a da trava (requirements.lock), conferida versão por versão;
- o build de produção migra e semeia UMA vez, sem imprimir segredo (nem a senha do banco, nem
  a URL normalizada); o de preview não toca no banco; fora da Vercel o script se recusa;
- conta inválida para o build ANTES de gravar, e a carga que cai no meio é RETOMADA pelo
  Redeploy, terminando igual a uma carga que nunca caiu;
- sem o Neon conectado, o build diz o que ligar em vez de cair num erro de localhost.
"""

from __future__ import annotations

import fnmatch
import json
import os
import re
import secrets
import subprocess
import sys
import tomllib
from collections.abc import AsyncIterator, Awaitable, Callable
from pathlib import Path

import asyncpg
import pytest
from sqlalchemy.engine import make_url

from app.core.config import PASTA_API, settings
from app.core.security import verificar_senha
from app.core.url_do_banco import preparar_url
from scripts import vercel_build, vercel_instalar

RAIZ = PASTA_API.parent
VERCEL_JSON = json.loads((PASTA_API / "vercel.json").read_text(encoding="utf-8"))
PYPROJECT = tomllib.loads((PASTA_API / "pyproject.toml").read_text(encoding="utf-8"))
CADDYFILE = (RAIZ / "docker" / "caddy" / "Caddyfile").read_text(encoding="utf-8")


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


def _expandir_chaves(padrao: str) -> list[str]:
    """`{a,b}/x` → `a/x`, `b/x` (o que o vercel.json usa; sem aninhar)."""
    achou = re.fullmatch(r"(.*?)\{([^{}]*)\}(.*)", padrao)
    if not achou:
        return [padrao]
    antes, opcoes, depois = achou.groups()
    return [p for opcao in opcoes.split(",") for p in _expandir_chaves(antes + opcao + depois)]


def _excluido(caminho: str, padroes: list[str]) -> bool:
    # fnmatch deixa `*` atravessar `/` — casa MAIS que o glob da Vercel. Para "o que a função
    # usa não sai", é o lado seguro: se aqui não casa, lá também não.
    return any(fnmatch.fnmatchcase(caminho, padrao) for padrao in padroes)


def test_o_que_sai_do_pacote_da_funcao_nao_leva_o_que_ela_usa() -> None:
    padroes = _expandir_chaves(VERCEL_JSON["functions"]["app/main.py"]["excludeFiles"])

    codigo = [
        p.relative_to(PASTA_API).as_posix()
        for p in (PASTA_API / "app").rglob("*")
        if p.is_file() and "__pycache__" not in p.parts
    ]
    # O web na função é a cópia do build: `web_vercel/` com o MESMO conteúdo de `web/`.
    web = [
        "web_vercel/" + p.relative_to(RAIZ / "web").as_posix()
        for p in (RAIZ / "web").rglob("*")
        if p.is_file()
    ]
    assert "app/main.py" in codigo and "web_vercel/index.html" in web
    assert "web_vercel/legal/privacidade.html" in web
    levados_embora = [c for c in codigo + web if _excluido(c, padroes)]
    assert levados_embora == [], "a função ficaria sem estes arquivos"

    # E o que se diz excluído sai de fato.
    for fora in ("tests/test_vercel.py", "scripts/vercel_build.py", "alembic/env.py",
                 "alembic.ini", "requirements.lock", ".env.example"):
        assert _excluido(fora, padroes), fora


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


def test_conta_invalida_da_demonstracao_para_antes_de_gravar() -> None:
    """A régua é a da API (UsuarioCreate): o que ela recusaria no meio da carga, o build
    recusa antes de criar o dono — e diz a VARIÁVEL, nunca o valor."""
    certo = {"DEMO_ADMIN_EMAIL": "dono@demo.com", "DEMO_ADMIN_SENHA": "Senha-Do-Dono-123"}
    assert vercel_build.contas_da_demonstracao({}) is None
    assert vercel_build.contas_da_demonstracao({"DEMO_ADMIN_EMAIL": "dono@demo.com"}) is None

    admin, vendedora = vercel_build.contas_da_demonstracao(
        {**certo, "DEMO_VENDEDORA_SENHA": "Senha-Da-Ana-9"}
    )
    assert admin == {"nome": "Dona Maria", "email": "dono@demo.com", "senha": "Senha-Do-Dono-123"}
    assert vendedora["senha"] == "Senha-Da-Ana-9" and vendedora["papel"] == "VENDEDOR"
    sorteada = vercel_build.contas_da_demonstracao(certo)[1]["senha"]
    assert len(sorteada) >= 8 and sorteada != vercel_build.contas_da_demonstracao(certo)[1]["senha"]

    for errado, variavel in (
        ({**certo, "DEMO_VENDEDORA_SENHA": "Zq7!x"}, "DEMO_VENDEDORA_SENHA"),
        ({**certo, "DEMO_ADMIN_SENHA": "Zq7!x"}, "DEMO_ADMIN_SENHA"),
        ({**certo, "DEMO_ADMIN_EMAIL": "Zq7!x-sem-arroba"}, "DEMO_ADMIN_EMAIL"),
    ):
        with pytest.raises(SystemExit) as parou:
            vercel_build.contas_da_demonstracao(errado)
        mensagem = str(parou.value)
        assert variavel in mensagem and "nada foi gravado" in mensagem
        assert "Zq7!x" not in mensagem


def test_estado_da_demonstracao_vem_dos_marcos_e_do_movimento() -> None:
    estado = vercel_build.decidir_estado
    Estado = vercel_build.Estado
    assert estado(inicio=False, fim=False, tem_movimento=False) is Estado.VAZIA
    # Começou e não terminou: retoma, mesmo com metade do catálogo já gravada.
    assert estado(inicio=True, fim=False, tem_movimento=True) is Estado.PELA_METADE
    assert estado(inicio=True, fim=True, tem_movimento=True) is Estado.SEMEADA
    # Produto ou venda sem marco nenhum: loja de alguém. Não se semeia por cima.
    assert estado(inicio=False, fim=False, tem_movimento=True) is Estado.EM_USO
    # A faxina da auditoria apaga o mais velho primeiro: some o início, fica o fim.
    assert estado(inicio=False, fim=True, tem_movimento=True) is Estado.SEMEADA


def test_build_de_producao_sem_banco_conectado_diz_o_que_ligar(monkeypatch) -> None:
    """Sem DATABASE_URL a config cai no localhost da loja; o build para antes de migrar."""
    assert vercel_build.falta_o_banco({"DATABASE_URL": "postgres://x"}) is None
    assert vercel_build.falta_o_banco({"DATABASE_URL_UNPOOLED": "postgres://x"}) is None
    motivo = vercel_build.falta_o_banco({"VERCEL": "1"})
    assert "Storage" in motivo and "Production" in motivo and "Redeploy" in motivo
    # Conectado COM prefixo (o campo da integração), as variáveis têm outro nome.
    com_prefixo = vercel_build.falta_o_banco({"NEON_DATABASE_URL": "postgres://x"})
    assert "NEON_DATABASE_URL" in com_prefixo and "prefixo" in com_prefixo

    def nao_pode(*_a, **_k):
        raise AssertionError("tocou no banco sem banco conectado")

    for nome in ("DATABASE_URL", "DATABASE_URL_UNPOOLED"):
        monkeypatch.delenv(nome, raising=False)
    monkeypatch.setattr(settings, "vercel", True)
    monkeypatch.setattr(settings, "vercel_env", "production")
    monkeypatch.setattr(vercel_build, "migrar", nao_pode)
    monkeypatch.setattr(vercel_build, "preparar_demonstracao", nao_pode)
    with pytest.raises(SystemExit, match="Nenhum banco conectado"):
        vercel_build.main()


# ------------------------------------------------------------ o build de verdade

SENHA_DO_DONO = "Senha-Do-Dono-123"


#: O banco da Vercel tem dono próprio (como o `neondb_owner` do Neon), com uma senha que só
#: existe aqui: é ela que o teste procura no log. A do banco de teste ("postgres") aparece em
#: todo lugar e não provaria nada.
PAPEL_DO_BANCO = "loja_vercel_teste"
SENHA_DO_BANCO = f"Senha-Do-Banco-{secrets.token_hex(6)}"


async def _admin_postgres() -> asyncpg.Connection:
    url = make_url(settings.database_url)
    return await asyncpg.connect(
        host=url.host, port=url.port or 5432, user=url.username, password=url.password,
        database="postgres",
    )


async def _apagar_bancos_do_papel(conexao: asyncpg.Connection) -> None:
    donos = await conexao.fetch(
        "SELECT datname FROM pg_database d JOIN pg_roles r ON r.oid = d.datdba "
        "WHERE r.rolname = $1",
        PAPEL_DO_BANCO,
    )
    for linha in donos:
        await conexao.execute(f'DROP DATABASE IF EXISTS "{linha["datname"]}" WITH (FORCE)')
    await conexao.execute(f'DROP ROLE IF EXISTS "{PAPEL_DO_BANCO}"')


@pytest.fixture
async def bancos_da_vercel() -> AsyncIterator[Callable[[], Awaitable[str]]]:
    """Fábrica de bancos vazios, como o Neon recém-criado. Cada um devolve a URL no formato
    do Neon (`postgres://...?sslmode=...&channel_binding=...`)."""
    base = make_url(settings.database_url)
    conexao = await _admin_postgres()
    try:
        await _apagar_bancos_do_papel(conexao)
        await conexao.execute(
            f"CREATE ROLE \"{PAPEL_DO_BANCO}\" LOGIN PASSWORD '{SENHA_DO_BANCO}'"
        )
    finally:
        await conexao.close()
    criados: list[str] = []

    async def criar() -> str:
        nome = f"{base.database}_vercel{len(criados) or ''}"
        conexao = await _admin_postgres()
        try:
            await conexao.execute(f'DROP DATABASE IF EXISTS "{nome}" WITH (FORCE)')
            await conexao.execute(f'CREATE DATABASE "{nome}" OWNER "{PAPEL_DO_BANCO}"')
        finally:
            await conexao.close()
        criados.append(nome)
        return base.set(
            drivername="postgres",
            username=PAPEL_DO_BANCO,
            password=SENHA_DO_BANCO,
            database=nome,
            query={"sslmode": "disable", "channel_binding": "disable"},
        ).render_as_string(hide_password=False)

    try:
        yield criar
    finally:
        conexao = await _admin_postgres()
        try:
            await _apagar_bancos_do_papel(conexao)
        finally:
            await conexao.close()


@pytest.fixture
async def banco_da_vercel(bancos_da_vercel: Callable[[], Awaitable[str]]) -> str:
    return await bancos_da_vercel()


def _segredos_do_banco(url_neon: str) -> list[str]:
    """Tudo do banco que não pode ir para o log: a senha, a URL como veio, a URL normalizada
    (a que a config usa, com a senha dentro) e o endereço."""
    url = make_url(url_neon)
    return [
        SENHA_DO_BANCO,
        url_neon,
        preparar_url(url_neon).url,
        f"{url.host}:{url.port}/{url.database}",
    ]


def _rodar_build(
    tmp_path: Path, *antes: str, **env: str
) -> subprocess.CompletedProcess[str]:
    """O build num processo à parte, com o ambiente da Vercel. `antes`: um programa que
    prepara o processo e então roda o build (a queda simulada)."""
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
        [sys.executable, *antes, "scripts/vercel_build.py"],
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

    # Nunca imprime senha nem URL do banco — nem a crua, nem a normalizada, nem o endereço.
    assert SENHA_DO_DONO not in saida and pooler not in saida
    for segredo in _segredos_do_banco(banco_da_vercel):
        assert segredo not in saida, "o log do build levou o banco"

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
    assert "já semeada" in de_novo.stdout
    assert await _contagens() == antes

    # A conta do dono da demo excluída numa demo de antes da trava (a linha fica, presa às
    # vendas, com o e-mail de marca): o redeploy a recria, e o revisor volta a entrar.
    await _consultar(
        banco_da_vercel,
        "UPDATE users SET email = 'conta-excluida-' || id || '@excluida.example', "
        "is_active = false, deleted_at = now() WHERE email = 'dono@demo.com'",
    )
    recriou = _rodar_build(tmp_path, **env)
    assert recriou.returncode == 0, (recriou.stdout + recriou.stderr)[-3000:]
    assert SENHA_DO_DONO not in recriou.stdout + recriou.stderr
    dono = await _consultar(
        banco_da_vercel,
        "SELECT role, is_active, password_hash FROM users "
        "WHERE email = 'dono@demo.com' AND deleted_at IS NULL",
    )
    assert len(dono) == 1 and dono[0]["role"] == "ADMIN" and dono[0]["is_active"]
    assert verificar_senha(SENHA_DO_DONO, dono[0]["password_hash"])
    assert (await _contagens())[:2] == antes[:2]


def _ambiente_de_producao(url_neon: str, **extra: str) -> dict[str, str]:
    return dict(
        VERCEL="1",
        VERCEL_ENV="production",
        DATABASE_URL_UNPOOLED=url_neon,
        DEMO_ADMIN_EMAIL="dono@demo.com",
        DEMO_ADMIN_SENHA=SENHA_DO_DONO,
        **extra,
    )


async def test_senha_curta_da_vendedora_para_o_build_antes_de_gravar(
    banco_da_vercel: str, tmp_path: Path
) -> None:
    """Antes: o dono nascia, a vendedora caía no 422 e o build seguinte via "já tem usuário"
    e nunca mais semeava — demonstração vazia para sempre."""
    curta = _rodar_build(
        tmp_path, **_ambiente_de_producao(banco_da_vercel, DEMO_VENDEDORA_SENHA="Zq7!x")
    )
    saida = curta.stdout + curta.stderr
    assert curta.returncode != 0
    assert "DEMO_VENDEDORA_SENHA" in saida and "Zq7!x" not in saida
    nada = (await _consultar(
        banco_da_vercel,
        "SELECT (SELECT count(*) FROM users), (SELECT count(*) FROM audit_log)",
    ))[0]
    assert tuple(nada) == (0, 0), "conta inválida não pode gravar nada"

    # Corrigida a variável, o Redeploy faz a demonstração inteira.
    certa = _rodar_build(
        tmp_path,
        **_ambiente_de_producao(banco_da_vercel, DEMO_VENDEDORA_SENHA="Senha-Da-Ana-9"),
    )
    assert certa.returncode == 0, (certa.stdout + certa.stderr)[-3000:]
    ana = (await _consultar(
        banco_da_vercel, "SELECT password_hash FROM users WHERE email = 'ana@loja.com'"
    ))[0][0]
    assert verificar_senha("Senha-Da-Ana-9", ana)
    produtos = await _consultar(banco_da_vercel, "SELECT count(*) FROM products")
    assert produtos[0][0] == 10


#: A queda que mais dói: o pedido GRAVOU, e a resposta não chegou — o processo do build perde
#: a conexão (o Neon caiu, a rede do build piscou) logo depois do N-ésimo POST que termina em
#: QUEDA_ROTA.
QUEDA_NO_MEIO = """
import os, runpy, sys
from fastapi.testclient import TestClient

original = TestClient.request
rota, vez = os.environ["QUEDA_ROTA"], int(os.environ["QUEDA_VEZ"])
contadas = 0


def request(self, method, url, *args, **kwargs):
    global contadas
    resposta = original(self, method, url, *args, **kwargs)
    if method.upper() == "POST" and str(url).rstrip("/").endswith(rota):
        contadas += 1
        if contadas == vez:
            raise ConnectionResetError("queda simulada: o banco fechou a conexão")
    return resposta


TestClient.request = request
sys.argv = sys.argv[1:]
runpy.run_path(sys.argv[0], run_name="__main__")
"""

#: O retrato da loja: o que a carga gravou, tabela por tabela, e os números que somam.
RETRATO = """
SELECT (SELECT count(*) FROM users), (SELECT count(*) FROM products),
       (SELECT count(*) FROM product_variants), (SELECT count(*) FROM sales),
       (SELECT count(*) FROM sales WHERE status = 'CANCELADA'), (SELECT sum(total) FROM sales),
       (SELECT count(*) FROM sale_payments), (SELECT count(*) FROM stock_entries),
       (SELECT sum(quantity) FROM stock_balances), (SELECT count(*) FROM stock_movements),
       (SELECT count(*) FROM expenses), (SELECT count(*) FROM customers),
       (SELECT count(*) FROM customer_payments), (SELECT count(*) FROM sale_returns),
       (SELECT count(*) FROM vouchers), (SELECT count(*) FROM cash_closings),
       (SELECT count(*) FROM payables),
       (SELECT count(*) FROM audit_log WHERE acao LIKE 'DEMONSTRACAO%')
"""


async def test_carga_que_cai_no_meio_e_retomada_sem_duplicar(
    bancos_da_vercel: Callable[[], Awaitable[str]], tmp_path: Path
) -> None:
    # A régua: a carga que nunca caiu.
    inteira = await bancos_da_vercel()
    feito = _rodar_build(tmp_path, **_ambiente_de_producao(inteira))
    assert feito.returncode == 0, (feito.stdout + feito.stderr)[-3000:]
    esperado = tuple((await _consultar(inteira, RETRATO))[0])
    assert esperado[1] == 10 and esperado[3] > 100 and esperado[4] == 1

    programa = tmp_path / "queda.py"
    programa.write_text(QUEDA_NO_MEIO, encoding="utf-8")
    # Cedo: no meio das vendas sorteadas. Tarde: no fechamento do caixa, a última gravação —
    # a retomada reenvia TUDO, inclusive a venda já cancelada e a devolução já feita.
    for rota, vez in (("/vendas", 60), ("/fechamentos", 1)):
        retomada = await bancos_da_vercel()
        caiu = _rodar_build(
            tmp_path, str(programa),
            QUEDA_ROTA=rota, QUEDA_VEZ=str(vez), **_ambiente_de_producao(retomada),
        )
        saida = caiu.stdout + caiu.stderr
        assert caiu.returncode != 0 and "queda simulada" in saida, saida[-3000:]
        assert "Redeploy" in saida and "retoma" in saida
        pela_metade = tuple((await _consultar(retomada, RETRATO))[0])
        assert pela_metade != esperado and pela_metade[3] > 0, "a queda tem de ser NO MEIO"

        # O Redeploy retoma — com a vendedora já criada e OUTRA senha sorteada — e termina
        # exatamente como a carga que nunca caiu: nada a mais, nada a menos.
        redeploy = _rodar_build(tmp_path, **_ambiente_de_producao(retomada))
        assert redeploy.returncode == 0, (redeploy.stdout + redeploy.stderr)[-3000:]
        assert "retomando" in redeploy.stdout
        assert tuple((await _consultar(retomada, RETRATO))[0]) == esperado, rota

    # E o próximo não faz mais nada.
    de_novo = _rodar_build(tmp_path, **_ambiente_de_producao(retomada))
    assert de_novo.returncode == 0 and "já semeada" in de_novo.stdout
    assert tuple((await _consultar(retomada, RETRATO))[0]) == esperado


async def test_loja_em_uso_sem_os_marcos_da_carga_nao_e_semeada(
    banco_da_vercel: str, tmp_path: Path
) -> None:
    """Produto que não veio da carga é de alguém: o build não semeia por cima."""
    feito = _rodar_build(tmp_path, VERCEL="1", VERCEL_ENV="production",
                         DATABASE_URL_UNPOOLED=banco_da_vercel)
    assert feito.returncode == 0, (feito.stdout + feito.stderr)[-3000:]
    url = make_url(banco_da_vercel)
    conexao = await asyncpg.connect(
        host=url.host, port=url.port or 5432, user=url.username, password=url.password,
        database=url.database,
    )
    try:
        categoria = await conexao.fetchval(
            "INSERT INTO categories (name) VALUES ('Da loja') RETURNING id"
        )
        await conexao.execute(
            "INSERT INTO products (category_id, name) VALUES ($1, 'Peça da dona')", categoria
        )
    finally:
        await conexao.close()

    em_uso = _rodar_build(tmp_path, **_ambiente_de_producao(banco_da_vercel))
    assert em_uso.returncode == 0, (em_uso.stdout + em_uso.stderr)[-3000:]
    assert "nada a semear" in em_uso.stdout
    contagem = (await _consultar(
        banco_da_vercel, "SELECT (SELECT count(*) FROM products), (SELECT count(*) FROM users)"
    ))[0]
    assert tuple(contagem) == (1, 0)


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
