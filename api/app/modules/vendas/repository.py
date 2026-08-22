import uuid
from datetime import datetime

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.pagination import Paginacao
from app.modules.catalogo.models import Product, ProductVariant
from app.modules.usuarios.models import User
from app.modules.vendas.models import Sale, SaleItem, SalePayment


class VendaRepository:
    def __init__(self, session: AsyncSession):
        self.session = session

    async def por_id(self, venda_id: int) -> Sale | None:
        stmt = (
            select(Sale)
            .options(selectinload(Sale.items), selectinload(Sale.payments))
            .where(Sale.id == venda_id)
            .execution_options(populate_existing=True)
        )
        return (await self.session.execute(stmt)).unique().scalar_one_or_none()

    async def por_client_uuid(self, client_uuid: uuid.UUID) -> Sale | None:
        stmt = (
            select(Sale)
            .options(selectinload(Sale.items), selectinload(Sale.payments))
            .where(Sale.client_uuid == client_uuid)
        )
        return (await self.session.execute(stmt)).unique().scalar_one_or_none()

    async def variantes_para_venda(self, ids: list[int]) -> dict[int, tuple]:
        """Peça + produto, com preço e custo atuais — o que vai ser congelado na venda."""
        if not ids:
            return {}
        stmt = (
            select(ProductVariant, Product)
            .join(Product, Product.id == ProductVariant.product_id)
            .where(ProductVariant.id.in_(ids), ProductVariant.deleted_at.is_(None))
        )
        return {v.id: (v, p) for v, p in (await self.session.execute(stmt)).all()}

    async def nomes_de_variantes(self, ids: list[int]) -> dict[int, tuple]:
        return await self.variantes_para_venda(ids)

    async def usuario(self, user_id: int) -> User | None:
        return await self.session.get(User, user_id)

    async def listar(
        self,
        p: Paginacao,
        inicio: datetime | None,
        fim: datetime | None,
        status: str | None,
        vendedor_id: int | None,
    ) -> tuple[list[tuple], int]:
        stmt = select(Sale, User).join(User, User.id == Sale.seller_id)
        if inicio:
            stmt = stmt.where(Sale.sold_at >= inicio)
        if fim:
            stmt = stmt.where(Sale.sold_at <= fim)
        if status:
            stmt = stmt.where(Sale.status == status)
        if vendedor_id:
            stmt = stmt.where(Sale.seller_id == vendedor_id)
        total = await self.session.scalar(select(func.count()).select_from(stmt.subquery()))
        stmt = stmt.order_by(Sale.id.desc()).offset(p.offset).limit(p.limit)
        return list((await self.session.execute(stmt)).all()), int(total or 0)

    async def resumo_de_vendas(self, venda_ids: list[int]) -> dict[int, tuple[int, list[str]]]:
        """Peças e formas de pagamento por venda, em duas consultas (sem N+1)."""
        if not venda_ids:
            return {}
        pecas = dict(
            (
                await self.session.execute(
                    select(SaleItem.sale_id, func.sum(SaleItem.quantity))
                    .where(SaleItem.sale_id.in_(venda_ids))
                    .group_by(SaleItem.sale_id)
                )
            ).all()
        )
        formas: dict[int, list[str]] = {}
        linhas = await self.session.execute(
            select(SalePayment.sale_id, SalePayment.method)
            .where(SalePayment.sale_id.in_(venda_ids))
            .order_by(SalePayment.id)
        )
        for sale_id, method in linhas.all():
            formas.setdefault(sale_id, []).append(method)
        return {vid: (int(pecas.get(vid, 0)), formas.get(vid, [])) for vid in venda_ids}
