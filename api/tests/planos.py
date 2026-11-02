"""O plano de execução das consultas REAIS de um service ou repository.

Teste de índice que monta o SQL à mão prova pouco: o que importa é a consulta que o código
manda. Aqui o código roda de verdade, o SQL que ele mandou é capturado e o Postgres devolve
o plano GENÉRICO dela — o que o asyncpg passa a reaproveitar depois da quinta execução, e
onde um índice de expressão só casa se a expressão estiver escrita igual, sem parâmetro no
meio. A varredura sequencial vai desligada: numa tabela de teste com três linhas o banco
leria tudo de qualquer jeito, e o que se quer saber é se existe índice que SIRVA à consulta.
"""

from collections.abc import Awaitable, Callable
from datetime import date, datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import engine


def _literal(valor: Any) -> str:
    if valor is None:
        return "NULL"
    if isinstance(valor, bool):
        return "true" if valor else "false"
    if isinstance(valor, int | Decimal):
        return str(valor)
    if isinstance(valor, datetime | date):
        return f"'{valor.isoformat()}'"
    return "'" + str(valor).replace("'", "''") + "'"


async def capturar_sql(chamada: Callable[[], Awaitable[Any]]) -> list[tuple[str, tuple]]:
    """Roda `chamada` e devolve os (sql, parâmetros) que ela mandou ao banco."""
    capturadas: list[tuple[str, tuple]] = []

    def _anotar(conn, cursor, statement, parameters, context, executemany):  # noqa: ANN001
        capturadas.append((statement, tuple(parameters or ())))

    event.listen(engine.sync_engine, "before_cursor_execute", _anotar)
    try:
        await chamada()
    finally:
        event.remove(engine.sync_engine, "before_cursor_execute", _anotar)
    return capturadas


async def planos(
    session: AsyncSession, chamada: Callable[[], Awaitable[Any]], *, generico: bool = True
) -> list[tuple[str, str]]:
    """(sql, plano) de cada SELECT que `chamada` mandou, na ordem em que mandou.

    `generico=False` pede o plano com os valores já colocados (o das cinco primeiras
    execuções): é o que vale para `dia_da_loja`, que manda o fuso como parâmetro.
    `chamada` tem de usar `session`: os `SET LOCAL` valem só para a transação dela, e
    somem no rollback do fim do teste.
    """
    capturadas = await capturar_sql(chamada)
    pg = (await (await session.connection()).get_raw_connection()).driver_connection
    await pg.execute("SET LOCAL enable_seqscan = off")
    modo = "force_generic_plan" if generico else "force_custom_plan"
    await pg.execute(f"SET LOCAL plan_cache_mode = {modo}")
    resultado = []
    for i, (sql, params) in enumerate(capturadas):
        if not sql.lstrip().upper().startswith("SELECT"):
            continue
        nome = f"plano_do_teste_{i}"
        await pg.execute(f"PREPARE {nome} AS {sql}")
        args = ", ".join(_literal(p) for p in params)
        linhas = await pg.fetch(f"EXPLAIN EXECUTE {nome}" + (f"({args})" if args else ""))
        await pg.execute(f"DEALLOCATE {nome}")
        resultado.append((sql, "\n".join(linha[0] for linha in linhas)))
    return resultado
