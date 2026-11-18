"""A URL do banco como o asyncpg entende — venha ela do `.env` da loja ou do Neon da Vercel.

Na loja (Docker, `.env`) a URL já nasce no formato certo: `postgresql+asyncpg://...`, sem
nada na query. O Neon que a Vercel liga ao projeto (ADR-42) injeta outra coisa:

    postgres://usuario:senha@ep-xxx.sa-east-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require

e o asyncpg tropeça em três pontos dela. O esquema `postgres://` não diz ao SQLAlchemy qual
driver usar. `sslmode` e `channel_binding` são parâmetros da libpq: o SQLAlchemy repassa a
query inteira ao `asyncpg.connect()`, que não conhece nenhum dos dois — e o que ele não
conhece vira configuração do SERVIDOR na partida da conexão (`unrecognized configuration
parameter "sslmode"`). Por isso o `sslmode` sai da URL e vira o argumento `ssl` do asyncpg
(que aceita os mesmos valores), e o `channel_binding` sai sem substituto: o asyncpg não faz
channel binding, e o Neon aceita a conexão sem ele.

**Pooler.** O Neon dá duas URLs: a direta (`DATABASE_URL_UNPOOLED`) e a que passa pelo
PgBouncer em modo transação (`DATABASE_URL`, host com `-pooler`). A config prefere a direta;
quando só existe a outra, o PgBouncer pode entregar cada transação a uma conexão diferente do
Postgres, então o cache de prepared statements do asyncpg precisa ser desligado e cada
statement precisa de nome único — e o `statement_timeout` na partida não vai (o PgBouncer
recusa parâmetro de partida que não conhece).

Função pura, sem I/O: testada com URLs de exemplo em `tests/test_url_do_banco.py`.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any
from uuid import uuid4

from sqlalchemy.engine import make_url

#: Esquemas que significam "Postgres, driver à escolha": viram asyncpg.
_ESQUEMAS_GENERICOS = {"postgres", "postgresql"}
#: Parâmetros só da libpq: o asyncpg os mandaria ao servidor como configuração e cairia.
_SO_DA_LIBPQ = ("sslmode", "channel_binding")
#: O que o asyncpg aceita em `ssl=` (são os mesmos nomes do `sslmode` da libpq).
_MODOS_SSL = {"disable", "allow", "prefer", "require", "verify-ca", "verify-full"}


@dataclass(frozen=True)
class ConexaoDoBanco:
    """A URL pronta para o SQLAlchemy e o que saiu dela para ir por `connect_args`."""

    #: `postgresql+asyncpg://...` sem `sslmode`/`channel_binding` na query.
    url: str
    #: Valor para `ssl=` do asyncpg (`require`, `verify-full`...), ou "" se a URL não pediu.
    ssl: str
    #: A URL aponta para um PgBouncer em modo transação (o host do Neon tem `-pooler`).
    pooler: bool


def preparar_url(bruta: str) -> ConexaoDoBanco:
    """Normaliza a URL. A da loja (já `postgresql+asyncpg://`, sem query) sai IDÊNTICA."""
    url = make_url(bruta)
    mudou = False

    if url.drivername in _ESQUEMAS_GENERICOS:
        url = url.set(drivername="postgresql+asyncpg")
        mudou = True

    ssl = ""
    modo = url.query.get("sslmode")
    if isinstance(modo, tuple):  # `?sslmode=a&sslmode=b`: vale o último, como na libpq
        modo = modo[-1]
    if modo:
        modo = modo.strip().lower()
        if modo not in _MODOS_SSL:
            raise ValueError(f"sslmode desconhecido na URL do banco: {modo!r}")
        ssl = modo

    if any(chave in url.query for chave in _SO_DA_LIBPQ):
        url = url.difference_update_query(_SO_DA_LIBPQ)
        mudou = True

    pooler = "-pooler." in (url.host or "")
    # Sem mudança, devolve a string de entrada como veio: nenhuma reescrita de URL (escape
    # de senha, ordem da query) para a instalação da loja, que já estava certa.
    final = url.render_as_string(hide_password=False) if mudou else bruta
    return ConexaoDoBanco(url=final, ssl=ssl, pooler=pooler)


def argumentos_de_conexao(
    *, ssl: str, pooler: bool, statement_timeout_ms: int | None
) -> dict[str, Any]:
    """`connect_args` do engine do SQLAlchemy (dialeto asyncpg).

    `statement_timeout_ms=None` deixa a conexão sem teto — é o caso da migration, que pode
    levar o tempo que precisar (ver `db_statement_timeout_ms` em config.py).
    """
    argumentos: dict[str, Any] = {}
    if statement_timeout_ms is not None and not pooler:
        argumentos["server_settings"] = {"statement_timeout": str(statement_timeout_ms)}
    if ssl:
        argumentos["ssl"] = ssl
    if pooler:
        # PgBouncer em modo transação: prepared statement não sobrevive à troca de conexão
        # do servidor. Sem cache e com nome único, como manda a doc do SQLAlchemy.
        argumentos["statement_cache_size"] = 0
        argumentos["prepared_statement_cache_size"] = 0
        argumentos["prepared_statement_name_func"] = lambda: f"__asyncpg_{uuid4()}__"
    return argumentos


def argumentos_asyncpg(*, ssl: str, pooler: bool) -> dict[str, Any]:
    """Para quem chama `asyncpg.connect()` direto (sem SQLAlchemy), como o seed_demo."""
    argumentos: dict[str, Any] = {}
    if ssl:
        argumentos["ssl"] = ssl
    if pooler:
        argumentos["statement_cache_size"] = 0
    return argumentos
