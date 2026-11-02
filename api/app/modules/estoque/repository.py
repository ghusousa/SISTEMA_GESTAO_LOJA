import uuid
from datetime import datetime

from sqlalchemy import Select, func, select, union
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.pagination import Paginacao
from app.modules.catalogo.busca import achatar, achatar_termo
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

    async def variantes_por_ids(
        self, ids: list[int], *, travar: bool = False
    ) -> dict[int, ProductVariant]:
        """Peças ativas por id. `travar=True` trava as linhas, em ordem de id (ADR-30).

        A trava vem antes da do saldo, sempre: é a ordem de todo mundo que mexe em peça e
        saldo juntos, e quem trava em outra ordem se abraça com eles. `FOR NO KEY UPDATE`
        não espera a FK das vendas (que só tira `FOR KEY SHARE` da peça).
        """
        if not ids:
            return {}
        stmt = (
            select(ProductVariant)
            # O produto vem junto: em async, tocar a relação depois estoura MissingGreenlet.
            .options(selectinload(ProductVariant.product))
            .where(ProductVariant.id.in_(ids), ProductVariant.deleted_at.is_(None))
        )
        if travar:
            stmt = stmt.order_by(ProductVariant.id).with_for_update(key_share=True)
        return {v.id: v for v in (await self.session.execute(stmt)).scalars().all()}

    def _saldo_base(self) -> Select:
        # Sem WHERE: os filtros (inclusive o de excluídas) moram em `listar_saldos`, que os
        # aplica igual na página e na contagem.
        return (
            select(ProductVariant, Product, Category, StockBalance.quantity)
            .join(Product, Product.id == ProductVariant.product_id)
            .join(Category, Category.id == Product.category_id)
            .outerjoin(StockBalance, StockBalance.variant_id == ProductVariant.id)
        )

    async def listar_saldos(
        self,
        p: Paginacao,
        q: str | None,
        categoria_id: int | None,
        somente_baixo: bool,
    ) -> tuple[list[tuple], int]:
        filtros = [ProductVariant.deleted_at.is_(None), Product.deleted_at.is_(None)]
        if categoria_id:
            filtros.append(Product.category_id == categoria_id)
        if q:
            # O mesmo achatamento de `/variantes?q=` (catalogo/busca.py): "calca" acha a
            # "Calça". Sem ele, a tela de Estoque dizia que a peça não existia.
            termo = f"%{achatar_termo(q)}%"
            # Cada ramo olha UMA tabela, e por isso cada um usa o seu índice: o nome cai
            # no trigram de `products` antes de encostar nas peças. O OR direto sobre o
            # JOIN obrigava o banco a montar o JOIN inteiro e achatar o nome linha a linha.
            filtros.append(
                ProductVariant.id.in_(
                    union(
                        select(ProductVariant.id).where(
                            ProductVariant.barcode.like(f"%{q.strip()}%")
                        ),
                        select(ProductVariant.id).where(
                            ProductVariant.product_id.in_(
                                select(Product.id).where(achatar(Product.name).like(termo))
                            )
                        ),
                    )
                )
            )
        if somente_baixo:
            # COALESCE porque peça nunca movimentada não tem linha de saldo.
            filtros.append(
                func.coalesce(StockBalance.quantity, 0) <= ProductVariant.min_stock
            )
        # A contagem não junta a categoria: é 1:1 por FK obrigatória e não filtra nada.
        # O saldo é 0..1 por peça, então só entra quando o filtro de "baixo" o lê.
        contagem = (
            select(func.count())
            .select_from(ProductVariant)
            .join(Product, Product.id == ProductVariant.product_id)
        )
        if somente_baixo:
            contagem = contagem.outerjoin(
                StockBalance, StockBalance.variant_id == ProductVariant.id
            )
        total = await self.session.scalar(contagem.where(*filtros))
        stmt = (
            self._saldo_base()
            .where(*filtros)
            .order_by(Product.name, ProductVariant.size, ProductVariant.color, ProductVariant.id)
            .offset(p.offset)
            .limit(p.limit)
        )
        return list((await self.session.execute(stmt)).all()), int(total or 0)

    async def listar_movimentos(
        self,
        p: Paginacao,
        variante_id: int | None,
        tipo: str | None,
        inicio: datetime | None,
        fim: datetime | None,
    ) -> tuple[list[tuple], int]:
        filtros = []
        if variante_id:
            filtros.append(StockMovement.variant_id == variante_id)
        if tipo:
            filtros.append(StockMovement.movement_type == tipo)
        if inicio is not None:
            filtros.append(StockMovement.created_at >= inicio)
        if fim is not None:
            # `<`: `fim` é 00:00 do dia seguinte no fuso da loja (app/core/datas.py).
            filtros.append(StockMovement.created_at < fim)
        # Conta só `stock_movements`: peça, produto e usuário entram por FK obrigatória,
        # um para um, e não mudam o total. Contar o JOIN era 99% do tempo do extrato —
        # o banco montava o JOIN do histórico inteiro para devolver um número.
        total = await self.session.scalar(
            select(func.count()).select_from(StockMovement).where(*filtros)
        )
        stmt = (
            select(StockMovement, ProductVariant, Product, User)
            .join(ProductVariant, ProductVariant.id == StockMovement.variant_id)
            .join(Product, Product.id == ProductVariant.product_id)
            .join(User, User.id == StockMovement.user_id)
            .where(*filtros)
            .order_by(StockMovement.id.desc())
            .offset(p.offset)
            .limit(p.limit)
        )
        return list((await self.session.execute(stmt)).all()), int(total or 0)

    async def movimentos_da_entrada(self, entrada_id: int) -> list[StockMovement]:
        stmt = (
            select(StockMovement)
            .where(StockMovement.entry_id == entrada_id)
            .order_by(StockMovement.id)
        )
        return list((await self.session.execute(stmt)).scalars().all())
