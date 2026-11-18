import uuid
from datetime import date, timedelta
from decimal import Decimal

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.pagination import Paginacao
from app.modules.contas_pagar.models import Payable
from app.modules.contas_pagar.schemas import FiltroContas

ZERO = Decimal("0.00")


class ContaPagarRepository:
    def __init__(self, session: AsyncSession):
        self.session = session

    async def por_id(self, conta_id: int, *, travar: bool = False) -> Payable | None:
        stmt = (
            select(Payable).where(Payable.id == conta_id).execution_options(populate_existing=True)
        )
        if travar:
            stmt = stmt.with_for_update()
        return (await self.session.execute(stmt)).scalar_one_or_none()

    async def da_entrada(self, entrada_id: int) -> list[Payable]:
        stmt = (
            select(Payable)
            .where(Payable.entry_id == entrada_id)
            .order_by(Payable.installment_number)
        )
        return list((await self.session.execute(stmt)).scalars().all())

    async def contar_da_entrada(self, entrada_id: int) -> int:
        return int(
            await self.session.scalar(
                select(func.count())
                .select_from(Payable)
                .where(Payable.entry_id == entrada_id, Payable.deleted_at.is_(None))
            )
            or 0
        )

    async def do_lancamento(self, client_uuid: uuid.UUID) -> list[Payable]:
        stmt = (
            select(Payable)
            .where(Payable.client_uuid == client_uuid)
            .order_by(Payable.installment_number)
        )
        return list((await self.session.execute(stmt)).scalars().all())

    def _filtros(
        self, filtro: FiltroContas, hoje: date, fornecedor: str | None, entrada_id: int | None
    ) -> list:
        filtros = [Payable.deleted_at.is_(None)]
        aberta = Payable.paid_on.is_(None)
        if filtro == FiltroContas.ABERTAS:
            filtros.append(aberta)
        elif filtro == FiltroContas.VENCIDAS:
            filtros += [aberta, Payable.due_date < hoje]
        elif filtro == FiltroContas.PROXIMOS_7_DIAS:
            filtros += [aberta, Payable.due_date >= hoje, Payable.due_date <= hoje + timedelta(7)]
        elif filtro == FiltroContas.PAGAS:
            filtros.append(Payable.paid_on.is_not(None))
        if fornecedor:
            filtros.append(Payable.supplier.ilike(f"%{fornecedor.strip()}%"))
        if entrada_id is not None:
            filtros.append(Payable.entry_id == entrada_id)
        return filtros

    async def listar(
        self,
        p: Paginacao,
        filtro: FiltroContas,
        hoje: date,
        fornecedor: str | None,
        entrada_id: int | None,
    ) -> tuple[list[Payable], int]:
        filtros = self._filtros(filtro, hoje, fornecedor, entrada_id)
        total = await self.session.scalar(select(func.count()).select_from(Payable).where(*filtros))
        # Aberta se lê pelo vencimento (a mais urgente em cima); paga, pela data em que saiu.
        ordem = (
            (Payable.paid_on.desc(), Payable.id.desc())
            if filtro == FiltroContas.PAGAS
            else (Payable.due_date, Payable.id)
        )
        stmt = select(Payable).where(*filtros).order_by(*ordem).offset(p.offset).limit(p.limit)
        return list((await self.session.execute(stmt)).scalars().all()), int(total or 0)

    async def faixa(self, *condicoes) -> tuple[int, Decimal]:
        linha = (
            await self.session.execute(
                select(func.count(), func.coalesce(func.sum(Payable.amount), ZERO)).where(
                    Payable.deleted_at.is_(None), Payable.paid_on.is_(None), *condicoes
                )
            )
        ).one()
        return int(linha[0]), Decimal(linha[1])

    async def marcar_paga(
        self, conta_id: int, *, pago_em: date, forma: str, usuario_id: int
    ) -> bool:
        """Aberta vira paga numa instrução só. Dois cliques não pagam duas vezes: o segundo
        não acha a linha aberta e cai na conferência de reenvio do service."""
        resultado = await self.session.execute(
            update(Payable)
            .where(
                Payable.id == conta_id,
                Payable.paid_on.is_(None),
                Payable.deleted_at.is_(None),
            )
            .values(paid_on=pago_em, payment_method=forma, paid_by_id=usuario_id)
        )
        return (resultado.rowcount or 0) == 1

    async def reabrir(self, conta_id: int) -> bool:
        resultado = await self.session.execute(
            update(Payable)
            .where(
                Payable.id == conta_id,
                Payable.paid_on.is_not(None),
                Payable.deleted_at.is_(None),
            )
            .values(paid_on=None, payment_method=None, paid_by_id=None)
        )
        return (resultado.rowcount or 0) == 1
