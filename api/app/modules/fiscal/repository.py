"""Leitura e escrita de `notas_fiscais`. Só o módulo fiscal mexe aqui."""

import secrets
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from sqlalchemy import select, text
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import engine
from app.modules.fiscal.models import Ambiente, NotaFiscal, StatusNota

#: Espaço das travas `pg_advisory_*` da NFC-e (o número lembra o ADR-41).
_ESPACO_TRAVA_NFCE = 41


class FiscalRepository:
    def __init__(self, session: AsyncSession):
        self.session = session

    async def por_venda(self, venda_id: int, *, travar: bool = False) -> NotaFiscal | None:
        stmt = (
            select(NotaFiscal)
            .where(NotaFiscal.sale_id == venda_id)
            .execution_options(populate_existing=True)
        )
        if travar:
            # Serializa tudo que mexe na nota de UMA venda — a emissão contra o cancelamento
            # da venda, principalmente. Some a cada commit: entre dois "Emitir" quem segura
            # é `uma_emissao_por_vez`.
            stmt = stmt.with_for_update()
        return (await self.session.execute(stmt)).scalar_one_or_none()

    @asynccontextmanager
    async def uma_emissao_por_vez(self, venda_id: int) -> AsyncIterator[None]:
        """Fila de "Emitir" por venda (duplo clique, emissão automática + botão) que
        atravessa os commits do meio. A emissão commita ANTES de falar com o emissor (a
        referência nova, a tentativa anotada), e cada commit solta a trava da linha: sem esta
        fila, o segundo clique entraria nesse vão, perguntaria ao emissor por uma nota que o
        primeiro ainda nem mandou e mandaria também. A trava mora numa conexão à parte, numa
        transação que só termina com a emissão; `pg_advisory_xact_lock` some sozinha no
        commit ou no rollback dela — nem uma exceção no meio deixa a venda trancada."""
        async with engine.begin() as conn:
            await conn.execute(
                text("SELECT pg_advisory_xact_lock(:espaco, :venda)"),
                {"espaco": _ESPACO_TRAVA_NFCE, "venda": venda_id},
            )
            yield

    async def garantir(self, venda_id: int, *, emissor: str, ambiente: Ambiente) -> None:
        """Cria a linha PENDENTE da venda, se ainda não existe. Corrida resolvida pelo
        UNIQUE de `sale_id`: quem chega depois não insere nada e usa a do primeiro."""
        stmt = (
            insert(NotaFiscal)
            .values(
                sale_id=venda_id,
                status=StatusNota.PENDENTE.value,
                ambiente=ambiente.value,
                emissor=emissor,
                referencia=nova_referencia(venda_id),
                tentativas=0,
            )
            .on_conflict_do_nothing(index_elements=[NotaFiscal.sale_id])
        )
        await self.session.execute(stmt)


def nova_referencia(venda_id: int) -> str:
    """O id da venda (o humano acha a nota no painel do emissor) e um sufixo aleatório:
    uma reinstalação do sistema recomeça os ids do 1, e "venda-1" já autorizada no emissor
    responderia por uma venda que não é esta. Gravada uma vez; nunca recalculada."""
    return f"venda-{venda_id}-{secrets.token_hex(4)}"
