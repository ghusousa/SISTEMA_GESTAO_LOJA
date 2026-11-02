"""Leitura e escrita de `notas_fiscais`. Só o módulo fiscal mexe aqui."""

import secrets

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.fiscal.models import Ambiente, NotaFiscal, StatusNota


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
            # Serializa tudo que mexe na nota de UMA venda: dois "Emitir" (duplo clique,
            # retry, emissão automática + botão) e a emissão contra o cancelamento da venda.
            stmt = stmt.with_for_update()
        return (await self.session.execute(stmt)).scalar_one_or_none()

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
