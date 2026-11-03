"""A URL do banco que a Vercel/Neon injeta vira uma que o asyncpg aceita — e a da loja não muda.

O Neon entrega `postgres://...?sslmode=require&channel_binding=require`. O SQLAlchemy repassa
a query inteira ao `asyncpg.connect()`, que não conhece `sslmode` nem `channel_binding` e os
manda ao servidor como configuração: a API não conectaria. Estes testes prendem a tradução
(e, no fim, conectam de verdade com os argumentos traduzidos).
"""

from urllib.parse import quote

import pytest
from pydantic import ValidationError
from sqlalchemy import text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy.pool import NullPool

from app.core.config import PASTA_API, PASTA_WEB_NA_VERCEL, Settings, settings
from app.core.url_do_banco import argumentos_de_conexao, preparar_url

LOJA = "postgresql+asyncpg://postgres:postgres@localhost:5432/loja"
NEON_DIRETA = (
    "postgres://neondb_owner:npg_Ab12Cd34@ep-cool-rain-a5b6c7d8.sa-east-1.aws.neon.tech"
    "/neondb?sslmode=require&channel_binding=require"
)
NEON_POOLER = (
    "postgres://neondb_owner:npg_Ab12Cd34@ep-cool-rain-a5b6c7d8-pooler.sa-east-1.aws.neon.tech"
    "/neondb?sslmode=require&channel_binding=require"
)
SEGREDO = "x" * 48


def test_url_da_loja_sai_identica() -> None:
    conexao = preparar_url(LOJA)
    assert conexao.url == LOJA
    assert conexao.ssl == ""
    assert conexao.pooler is False


def test_url_direta_do_neon_vira_asyncpg_sem_parametros_da_libpq() -> None:
    conexao = preparar_url(NEON_DIRETA)
    assert conexao.url == (
        "postgresql+asyncpg://neondb_owner:npg_Ab12Cd34@"
        "ep-cool-rain-a5b6c7d8.sa-east-1.aws.neon.tech/neondb"
    )
    assert conexao.ssl == "require"
    assert conexao.pooler is False


def test_url_do_pooler_do_neon_e_reconhecida() -> None:
    conexao = preparar_url(NEON_POOLER)
    assert conexao.url.startswith("postgresql+asyncpg://")
    assert "sslmode" not in conexao.url and "channel_binding" not in conexao.url
    assert conexao.pooler is True


@pytest.mark.parametrize(
    ("bruta", "ssl"),
    [
        ("postgresql://u:p@db.exemplo.com/loja?sslmode=verify-full", "verify-full"),
        ("postgres://u:p@db.exemplo.com:6543/loja?sslmode=REQUIRE", "require"),
        ("postgresql://u:p@db.exemplo.com/loja", ""),
        ("postgresql+asyncpg://u:p@db.exemplo.com/loja?sslmode=disable", "disable"),
    ],
)
def test_sslmode_vira_o_ssl_do_asyncpg(bruta: str, ssl: str) -> None:
    conexao = preparar_url(bruta)
    assert conexao.ssl == ssl
    url = make_url(conexao.url)
    assert url.drivername == "postgresql+asyncpg"
    assert "sslmode" not in url.query


def test_outros_parametros_e_a_porta_ficam() -> None:
    url = make_url(
        preparar_url(
            "postgres://u:p@db.exemplo.com:6543/loja?sslmode=require&application_name=loja"
        ).url
    )
    assert url.port == 6543
    assert url.query == {"application_name": "loja"}


def test_senha_com_caractere_especial_sobrevive() -> None:
    senha = "p@ss/w:rd%#"
    bruta = f"postgres://dono:{quote(senha, safe='')}@h.neon.tech/db?sslmode=require"
    conexao = preparar_url(bruta)
    assert make_url(conexao.url).password == senha


def test_sslmode_desconhecido_derruba_em_vez_de_conectar_sem_ssl() -> None:
    with pytest.raises(ValueError, match="sslmode"):
        preparar_url("postgres://u:p@h/db?sslmode=talvez")


def test_connect_args_da_loja_sao_os_de_sempre() -> None:
    assert argumentos_de_conexao(ssl="", pooler=False, statement_timeout_ms=30_000) == {
        "server_settings": {"statement_timeout": "30000"}
    }
    # A migration (sem teto) não manda nada.
    assert argumentos_de_conexao(ssl="", pooler=False, statement_timeout_ms=None) == {}


def test_pooler_desliga_cache_e_nao_manda_parametro_de_partida() -> None:
    argumentos = argumentos_de_conexao(ssl="require", pooler=True, statement_timeout_ms=30_000)
    assert "server_settings" not in argumentos
    assert argumentos["ssl"] == "require"
    assert argumentos["statement_cache_size"] == 0
    assert argumentos["prepared_statement_cache_size"] == 0
    nome = argumentos["prepared_statement_name_func"]
    assert nome() != nome()


# ----------------------------------------------------------------- Settings


def _settings(monkeypatch: pytest.MonkeyPatch, **env: str) -> Settings:
    """Settings lidas SÓ do ambiente dado (sem o .env da máquina nem o do conftest)."""
    for chave in (
        "DATABASE_URL", "DATABASE_URL_UNPOOLED", "JWT_SECRET", "AMBIENTE", "CORS_ORIGINS",
        "MEDIA_DIR", "WEB_DIR", "DB_POOL_SIZE", "DB_MAX_OVERFLOW", "DB_SSL", "DEBUG",
        "VERCEL", "VERCEL_ENV", "VERCEL_URL", "VERCEL_BRANCH_URL",
        "VERCEL_PROJECT_PRODUCTION_URL", "FISCAL_EMITIR_AUTOMATICO",
    ):
        monkeypatch.delenv(chave, raising=False)
    for chave, valor in env.items():
        monkeypatch.setenv(chave, valor)
    return Settings(_env_file=None)


def test_sem_vercel_a_config_da_loja_nao_muda(monkeypatch: pytest.MonkeyPatch) -> None:
    s = _settings(monkeypatch, DATABASE_URL=LOJA)
    assert s.database_url == LOJA
    assert s.ambiente == "dev"
    assert (s.db_pool_size, s.db_max_overflow) == (10, 20)
    assert s.media_dir == "media"
    assert s.connect_args() == {"server_settings": {"statement_timeout": "30000"}}
    # O mesmo lugar que o main.py sempre usou: `web/` ao lado de `api/`.
    assert s.web_dir == str(PASTA_API.parent / "web")


def test_unpooled_ganha_da_url_do_pooler(monkeypatch: pytest.MonkeyPatch) -> None:
    s = _settings(monkeypatch, DATABASE_URL=NEON_POOLER, DATABASE_URL_UNPOOLED=NEON_DIRETA)
    assert "-pooler" not in s.database_url
    assert s.database_url.startswith("postgresql+asyncpg://")
    assert s.db_ssl == "require"
    assert s.db_pooler is False
    assert s.connect_args()["server_settings"] == {"statement_timeout": "30000"}


def test_so_a_url_do_pooler_liga_o_modo_pgbouncer(monkeypatch: pytest.MonkeyPatch) -> None:
    s = _settings(monkeypatch, DATABASE_URL=NEON_POOLER)
    assert s.db_pooler is True
    assert s.connect_args()["statement_cache_size"] == 0


def test_pool_configuravel(monkeypatch: pytest.MonkeyPatch) -> None:
    s = _settings(monkeypatch, DATABASE_URL=LOJA, DB_POOL_SIZE="4", DB_MAX_OVERFLOW="0")
    assert (s.db_pool_size, s.db_max_overflow) == (4, 0)


def test_na_vercel_os_padroes_sao_os_de_la(monkeypatch: pytest.MonkeyPatch) -> None:
    s = _settings(
        monkeypatch,
        VERCEL="1",
        JWT_SECRET=SEGREDO,
        DATABASE_URL=NEON_POOLER,
        DATABASE_URL_UNPOOLED=NEON_DIRETA,
        VERCEL_PROJECT_PRODUCTION_URL="loja-tria.vercel.app",
        VERCEL_URL="loja-tria-abc123-trion.vercel.app",
        VERCEL_BRANCH_URL="loja-tria-git-main-trion.vercel.app",
        FISCAL_EMITIR_AUTOMATICO="1",
    )
    assert s.ambiente == "producao" and s.producao
    assert s.cors_origins == [
        "https://loja-tria.vercel.app",
        "https://loja-tria-abc123-trion.vercel.app",
        "https://loja-tria-git-main-trion.vercel.app",
    ]
    assert s.media_dir == "/tmp/media"
    assert (s.db_pool_size, s.db_max_overflow) == (2, 3)
    assert s.web_dir == str(PASTA_WEB_NA_VERCEL)
    assert s.fiscal_emitir_automatico is False


def test_na_vercel_sem_jwt_secret_nao_sobe(monkeypatch: pytest.MonkeyPatch) -> None:
    """Esquecer o AMBIENTE não pode subir a demonstração aceitando o segredo de exemplo."""
    with pytest.raises(ValidationError, match="JWT_SECRET"):
        _settings(
            monkeypatch,
            VERCEL="1",
            DATABASE_URL=NEON_DIRETA,
            VERCEL_PROJECT_PRODUCTION_URL="loja-tria.vercel.app",
        )


def test_na_vercel_o_que_o_dono_escreveu_ganha(monkeypatch: pytest.MonkeyPatch) -> None:
    s = _settings(
        monkeypatch,
        VERCEL="1",
        JWT_SECRET=SEGREDO,
        DATABASE_URL=NEON_DIRETA,
        AMBIENTE="demonstracao",
        CORS_ORIGINS="https://loja.exemplo.com.br",
        DB_POOL_SIZE="5",
        MEDIA_DIR="/tmp/fotos",
    )
    assert s.ambiente == "demonstracao"
    assert s.cors_origins == ["https://loja.exemplo.com.br"]
    assert s.db_pool_size == 5
    assert s.media_dir == "/tmp/fotos"


# ------------------------------------------------- conectando de verdade


def _local(**query: str) -> str:
    """A URL do banco de teste no formato do Neon (`postgres://` + parâmetros da libpq)."""
    url = make_url(settings.database_url).set(drivername="postgres", query=query)
    return url.render_as_string(hide_password=False)


@pytest.mark.parametrize(
    "query",
    [
        {"sslmode": "disable", "channel_binding": "disable"},
        # `prefer`: tenta SSL e cai para sem SSL — o Postgres dos testes não tem certificado.
        {"sslmode": "prefer"},
    ],
)
async def test_url_traduzida_conecta_de_verdade(query: dict[str, str]) -> None:
    conexao = preparar_url(_local(**query))
    engine = create_async_engine(
        conexao.url,
        poolclass=NullPool,
        connect_args=argumentos_de_conexao(
            ssl=conexao.ssl, pooler=conexao.pooler, statement_timeout_ms=1234
        ),
    )
    try:
        async with engine.connect() as conn:
            assert (await conn.execute(text("SHOW statement_timeout"))).scalar() == "1234ms"
    finally:
        await engine.dispose()


async def test_modo_pgbouncer_tambem_conversa_com_postgres_direto() -> None:
    """Os argumentos do modo pooler (sem cache, nome único) não quebram consulta nenhuma."""
    conexao = preparar_url(_local(sslmode="disable"))
    engine = create_async_engine(
        conexao.url,
        poolclass=NullPool,
        connect_args=argumentos_de_conexao(ssl=conexao.ssl, pooler=True, statement_timeout_ms=None),
    )
    try:
        async with engine.connect() as conn:
            for _ in range(3):  # a mesma consulta de novo: sem cache, prepara outra vez
                assert (await conn.execute(text("SELECT :n + 1"), {"n": 1})).scalar() == 2
    finally:
        await engine.dispose()
