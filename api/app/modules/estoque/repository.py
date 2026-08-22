import uuid
from datetime import datetime

from sqlalchemy import Select, func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.pagination import Paginacao
from app.modules.catalogo.models import Category, Product, ProductVariant
from app.modules.estoque.models import StockBalance, StockEntry, StockMovement
from app.modules.usuarios.models import User


class EstoqueRepository:
    """Leituras do estoque.

    As consultas juntam catálogo e usuário porque a tela de saldo/extrato mostra nome do
    produto e de quem mexeu — é leitura de read model, não escrita em domínio alheio.
    """

    def __init__(self, session: AsyncSession):
        self.session = session

    async def entrada_por_client_uuid(self, client_uuid: uuid.UUID) -> StockEntry | None:
        stmt = select(StockEntry).where(StockEntry.client_uuid == client_uuid)
        return (await self.session.execute(stmt)).scalar_one_or_none()

    async def entrada_por_id(self, entrada_id: int) -> StockEntry | None:
        return await self.session.get(StockEntry, entrada_id)

    async def variantes_por_ids(self, ids: list[int]) -> dict[int, ProductVariant]:
        if not ids:
            return {}
        stmt = (
            select(ProductVariant)
            # O produto vem junto: em async, tocar a relação depois estoura MissingGreenlet.
            .options(selectinload(ProductVariant.product))
            .where(ProductVariant.id.in_(ids), ProductVariant.deleted_at.is_(None))
        )
        return {v.id: v for v in (await self.session.execute(stmt)).scalars().all()}

    def _saldo_base(self) -> Select:
        return (
            select(ProductVariant, Product, Category, StockBalance.quantity)
            .join(Product, Product.id == ProductVariant.product_id)
            .join(Category, Category.id == Product.category_id)
            .outerjoin(StockBalance, StockBalance.variant_id == ProductVariant.id)
            .where(ProductVariant.deleted_at.is_(None), Product.deleted_at.is_(None))
        )

    async def listar_saldos(
        self,
        p: Paginacao,
        q: str | None,
        categoria_id: int | None,
        somente_baixo: bool,
    ) -> tuple[list[tuple], int]:
        stmt = self._saldo_base()
        if categoria_id:
            stmt = stmt.where(Product.category_id == categoria_id)
        if q:
            termo = f"%{q.strip().lower()}%"
            stmt = stmt.where(
                func.lower(Product.name).like(termo)
                | ProductVariant.barcode.like(f"%{q.strip()}%")
            )
        if somente_baixo:
            # COALESCE porque peça nunca movimentada não tem linha de saldo.
            stmt = stmt.where(
                func.coalesce(StockBalance.quantity, 0) <= ProductVariant.min_stock
            )
        total = await self.session.scalar(select(func.count()).select_from(stmt.subquery()))
        stmt = stmt.order_by(Product.name, ProductVariant.size, ProductVariant.color)
        stmt = stmt.offset(p.offset).limit(p.limit)
        return list((await self.session.execute(stmt)).all()), int(total or 0)

    async def listar_movimentos(
        self,
        p: Paginacao,
        variante_id: int | None,
        tipo: str | None,
        inicio: datetime | None,
        fim: datetime | None,
    ) -> tuple[list[tuple], int]:
        stmt = (
            select(StockMovement, ProductVariant, Product, User)
            .join(ProductVariant, ProductVariant.id == StockMovement.variant_id)
            .join(Product, Product.id == ProductVariant.product_id)
            .join(User, User.id == StockMovement.user_id)
        )
        if variante_id:
            stmt = stmt.where(StockMovement.variant_id == variante_id)
        if tipo:
            stmt = stmt.where(StockMovement.movement_type == tipo)
        if inicio:
            stmt = stmt.where(StockMovement.created_at >= inicio)
        if fim:
            stmt = stmt.where(StockMovement.created_at <= fim)
        total = await self.session.scalar(select(func.count()).select_from(stmt.subquery()))
        stmt = stmt.order_by(StockMovement.id.desc()).offset(p.offset).limit(p.limit)
        return list((await self.session.execute(stmt)).all()), int(total or 0)

    async def movimentos_da_entrada(self, entrada_id: int) -> list[StockMovement]:
        stmt = (
            select(StockMovement)
            .where(StockMovement.entry_id == entrada_id)
            .order_by(StockMovement.id)
        )
        return list((await self.session.execute(stmt)).scalars().all())
