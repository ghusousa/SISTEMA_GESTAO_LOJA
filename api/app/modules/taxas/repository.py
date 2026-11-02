"""Leitura e escrita da tabela de taxas da maquininha."""

from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.pagination import Paginacao
from app.modules.taxas.models import CardFee

#: Espaço da trava consultiva das taxas (o número lembra o ADR-35). Separa estas chaves da
#: trava de login (24) e de qualquer outra que um dia apareça.
_ESPACO_TRAVA_TAXAS = 35


class TaxaRepository:
    def __init__(self, session: AsyncSession):
        self.session = session

    async def travar_forma(self, forma: str) -> None:
        """Um por vez mexe nas faixas desta forma, até o commit.

        Conferir sobreposição e depois gravar é ler-para-escrever: dois cadastros
        simultâneos ("3x a 6x" e "5x a 12x") passariam os dois pela conferência e a venda de
        5x ficaria com duas taxas. A trava é `pg_advisory_xact_lock` — some sozinha no
        commit ou no rollback.
        """
        await self.session.execute(
            text("SELECT pg_advisory_xact_lock(:espaco, hashtext(:forma))"),
            {"espaco": _ESPACO_TRAVA_TAXAS, "forma": forma},
        )

    async def obter(self, taxa_id: int) -> CardFee | None:
        return await self.session.get(CardFee, taxa_id)

    async def listar(self, p: Paginacao) -> tuple[list[CardFee], int]:
        total = await self.session.scalar(select(func.count()).select_from(CardFee))
        linhas = (
            await self.session.execute(
                select(CardFee)
                .order_by(CardFee.forma.desc(), CardFee.parcelas_de, CardFee.id)
                .offset(p.offset)
                .limit(p.limit)
            )
        ).scalars()
        return list(linhas), int(total or 0)

    async def sobreposta(
        self, forma: str, de: int, ate: int, exceto: int | None = None
    ) -> CardFee | None:
        """A primeira faixa da mesma forma que encosta em [de, ate], se houver."""
        stmt = select(CardFee).where(
            CardFee.forma == forma, CardFee.parcelas_de <= ate, CardFee.parcelas_ate >= de
        )
        if exceto is not None:
            stmt = stmt.where(CardFee.id != exceto)
        return (await self.session.execute(stmt.limit(1))).scalar_one_or_none()

    async def para(self, forma: str, parcelas: int) -> CardFee | None:
        """A taxa que cobre esta forma neste número de parcelas — ou nenhuma."""
        return (
            await self.session.execute(
                select(CardFee)
                .where(
                    CardFee.forma == forma,
                    CardFee.parcelas_de <= parcelas,
                    CardFee.parcelas_ate >= parcelas,
                )
                .limit(1)
            )
        ).scalar_one_or_none()
