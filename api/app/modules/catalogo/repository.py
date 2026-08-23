from sqlalchemy import Select, case, delete, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.pagination import Paginacao
from app.modules.catalogo.models import Category, Product, ProductVariant
from app.modules.estoque.models import StockBalance


#: Acentos que o teclado da loja produz e o dedo apressado não digita. Quem procura a
#: peça escreve "calca jeans", não "calça jeans" — e sem isto a busca não acha nada, o que
#: na prática significa cadastrar a mesma peça duas vezes.
#:
#: `translate()` do Postgres em vez da extensão `unaccent`: a extensão precisa de
#: `CREATE EXTENSION` (mais uma migration, mais um privilégio, mais uma coisa para faltar
#: num servidor novo), e para o alfabeto do português esta tabela resolve igual.
_COM_ACENTO = "áàâãäéèêëíìîïóòôõöúùûüçñ"
_SEM_ACENTO = "aaaaaeeeeiiiiooooouuuucn"
assert len(_COM_ACENTO) == len(_SEM_ACENTO)


def _achatar(coluna):
    """Minúsculas e sem acento, do lado do banco."""
    return func.translate(func.lower(coluna), _COM_ACENTO, _SEM_ACENTO)


def achatar_termo(termo: str) -> str:
    """O mesmo achatamento do lado de cá, para os dois lados baterem."""
    tabela = str.maketrans(_COM_ACENTO, _SEM_ACENTO)
    return termo.strip().lower().translate(tabela)


class CatalogoRepository:
    def __init__(self, session: AsyncSession):
        self.session = session

    # ------------------------------------------------------------ categorias
    async def categoria_por_id(self, categoria_id: int) -> Category | None:
        cat = await self.session.get(Category, categoria_id)
        return cat if cat is not None and cat.deleted_at is None else None

    async def categoria_por_nome(self, nome: str) -> Category | None:
        stmt = select(Category).where(
            func.lower(Category.name) == nome.strip().lower(), Category.deleted_at.is_(None)
        )
        return (await self.session.execute(stmt)).scalar_one_or_none()

    async def listar_categorias(self, p: Paginacao, q: str | None) -> tuple[list[Category], int]:
        stmt = select(Category).where(Category.deleted_at.is_(None))
        if q:
            stmt = stmt.where(func.lower(Category.name).like(f"%{q.strip().lower()}%"))
        total = await self.session.scalar(select(func.count()).select_from(stmt.subquery()))
        stmt = stmt.order_by(Category.name, Category.id).offset(p.offset).limit(p.limit)
        return list((await self.session.execute(stmt)).scalars().all()), int(total or 0)

    async def categoria_tem_produtos(self, categoria_id: int) -> bool:
        stmt = select(func.count()).select_from(Product).where(
            Product.category_id == categoria_id, Product.deleted_at.is_(None)
        )
        return bool(await self.session.scalar(stmt))

    # ------------------------------------------------------------ produtos
    def _produto_base(self) -> Select:
        # O filtro das variantes ativas vai no LOADER, não em cima da coleção já carregada:
        # reatribuir `produto.variants` seria uma alteração de relacionamento e, no flush,
        # o SQLAlchemy tentaria orfanar as variantes removidas da lista.
        return (
            select(Product)
            .options(
                selectinload(Product.variants.and_(ProductVariant.deleted_at.is_(None)))
            )
            .where(Product.deleted_at.is_(None))
            # Sem populate_existing, um produto já presente na sessão volta com a coleção
            # antiga — a peça recém-adicionada à grade não apareceria na resposta.
            .execution_options(populate_existing=True)
        )

    async def produto_por_id(self, produto_id: int) -> Product | None:
        stmt = self._produto_base().where(Product.id == produto_id)
        return (await self.session.execute(stmt)).unique().scalar_one_or_none()

    async def listar_produtos(
        self, p: Paginacao, q: str | None, categoria_id: int | None
    ) -> tuple[list[Product], int]:
        stmt = self._produto_base()
        if categoria_id:
            stmt = stmt.where(Product.category_id == categoria_id)
        if q:
            termo = f"%{q.strip().lower()}%"
            # Busca pelo nome do produto ou por um código de barras da grade — no balcão
            # o vendedor tanto digita o nome quanto tem o código na mão.
            sub = select(ProductVariant.product_id).where(
                ProductVariant.barcode.like(f"%{q.strip()}%"),
                ProductVariant.deleted_at.is_(None),
            )
            stmt = stmt.where(or_(func.lower(Product.name).like(termo), Product.id.in_(sub)))
        total = await self.session.scalar(select(func.count()).select_from(stmt.subquery()))
        # Product.id como desempate: nome não é único e o OFFSET repetiria registros.
        stmt = stmt.order_by(Product.name, Product.id).offset(p.offset).limit(p.limit)
        produtos = list((await self.session.execute(stmt)).unique().scalars().all())
        return produtos, int(total or 0)

    # ------------------------------------------------------------ variantes
    async def variante_por_id(self, variante_id: int) -> ProductVariant | None:
        v = await self.session.get(ProductVariant, variante_id)
        return v if v is not None and v.deleted_at is None else None

    async def variante_por_codigo(self, codigo: str) -> ProductVariant | None:
        stmt = select(ProductVariant).where(
            ProductVariant.barcode == codigo.strip(), ProductVariant.deleted_at.is_(None)
        )
        return (await self.session.execute(stmt)).scalar_one_or_none()

    async def codigos_existentes(self, codigos: list[str]) -> set[str]:
        if not codigos:
            return set()
        stmt = select(ProductVariant.barcode).where(
            ProductVariant.barcode.in_(codigos), ProductVariant.deleted_at.is_(None)
        )
        return set((await self.session.execute(stmt)).scalars().all())

    async def listar_variantes(
        self, p: Paginacao, produto_id: int | None, q: str | None
    ) -> tuple[list[ProductVariant], int]:
        """Peças, com busca por NOME ou por código.

        Procurar só por código servia para o bipe e para mais nada. Na entrada de
        mercadoria a peça que chega ainda não tem a nossa etiqueta colada — o código foi
        gerado aqui — então não existe o que bipar, e sem busca por nome a tela não tinha
        como registrar a reposição.
        """
        stmt = (
            select(ProductVariant)
            # `selectinload` e não lazy: quem lê a lista precisa do NOME do produto, e no
            # async um relacionamento preguiçoso estoura em MissingGreenlet.
            .options(selectinload(ProductVariant.product))
            .join(Product, Product.id == ProductVariant.product_id)
            .where(ProductVariant.deleted_at.is_(None), Product.deleted_at.is_(None))
        )
        if produto_id:
            stmt = stmt.where(ProductVariant.product_id == produto_id)

        ordem = [Product.name, ProductVariant.size, ProductVariant.id]
        if q:
            termo = q.strip()
            achatado = f"%{achatar_termo(termo)}%"
            stmt = stmt.where(
                or_(
                    ProductVariant.barcode.like(f"%{termo}%"),
                    _achatar(Product.name).like(achatado),
                    _achatar(ProductVariant.color).like(achatado),
                )
            )
            # Código exato primeiro: quem digitou os 13 dígitos inteiros quer AQUELA peça
            # no topo, não a que vem antes no alfabeto.
            ordem = [case((ProductVariant.barcode == termo, 0), else_=1), *ordem]

        total = await self.session.scalar(select(func.count()).select_from(stmt.subquery()))
        stmt = stmt.order_by(*ordem).offset(p.offset).limit(p.limit)
        return list((await self.session.execute(stmt)).scalars().all()), int(total or 0)

    async def proxima_sequencia_interna(self) -> int:
        return int(await self.session.scalar(select(func.nextval("internal_barcode_seq"))))

    # ------------------------------------------------------------ saldos
    async def saldos_de(self, variante_ids: list[int]) -> dict[int, int]:
        if not variante_ids:
            return {}
        stmt = select(StockBalance.variant_id, StockBalance.quantity).where(
            StockBalance.variant_id.in_(variante_ids)
        )
        return {vid: qtd for vid, qtd in (await self.session.execute(stmt)).all()}

    async def variante_tem_movimento(self, variante_id: int) -> bool:
        from app.modules.estoque.models import StockMovement

        stmt = select(func.count()).select_from(StockMovement).where(
            StockMovement.variant_id == variante_id
        )
        return bool(await self.session.scalar(stmt))

    async def remover_saldo_zerado(self, variante_id: int) -> None:
        await self.session.execute(
            delete(StockBalance).where(StockBalance.variant_id == variante_id)
        )
