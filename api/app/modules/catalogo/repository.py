from sqlalchemy import Select, case, delete, func, select, union, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.pagination import Paginacao
from app.modules.catalogo.busca import achatar as _achatar
from app.modules.catalogo.busca import achatar_termo
from app.modules.catalogo.models import Category, Product, ProductVariant
from app.modules.estoque.models import StockBalance

# O achatamento sem acento mora em `catalogo/busca.py` (o estoque busca o mesmo nome de
# produto); fica importado aqui com o nome de sempre para quem já o usava daqui.
__all__ = ["CatalogoRepository", "_achatar", "achatar_termo"]


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
            # Sem acento, como `/variantes?q=`: "calca" acha a "Calça Jeans".
            termo = f"%{achatar_termo(q)}%"
            # Busca pelo nome do produto ou por um código de barras da grade — no balcão
            # o vendedor tanto digita o nome quanto tem o código na mão. UNION de ids, e
            # não OR: cada ramo sozinho usa o seu índice (o trigram do nome achatado);
            # no OR o banco achatava o nome de todo o catálogo a cada tecla.
            stmt = stmt.where(
                Product.id.in_(
                    union(
                        select(Product.id).where(_achatar(Product.name).like(termo)),
                        select(ProductVariant.product_id).where(
                            ProductVariant.barcode.like(f"%{q.strip()}%"),
                            ProductVariant.deleted_at.is_(None),
                        ),
                    )
                )
            )
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

    async def dados_fiscais_das_pecas(
        self, variante_ids: list[int]
    ) -> list[tuple[ProductVariant, Product]]:
        """Peça e produto, INCLUSIVE excluídos: a nota é da venda, que aconteceu antes."""
        if not variante_ids:
            return []
        stmt = (
            select(ProductVariant, Product)
            .join(Product, Product.id == ProductVariant.product_id)
            .where(ProductVariant.id.in_(variante_ids))
            .execution_options(populate_existing=True)
        )
        return [(v, p) for v, p in (await self.session.execute(stmt)).all()]

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
        filtros = [ProductVariant.deleted_at.is_(None), Product.deleted_at.is_(None)]
        if produto_id:
            filtros.append(ProductVariant.product_id == produto_id)

        ordem = [Product.name, ProductVariant.size, ProductVariant.id]
        if q:
            termo = q.strip()
            achatado = f"%{achatar_termo(termo)}%"
            # O produto é filtrado ANTES de encostar nas peças: cada ramo do UNION olha
            # uma tabela só e usa o seu índice (trigram do nome e da cor achatados,
            # ADR-31). O OR sobre o JOIN achatava nome e cor das 15 mil peças a cada
            # tecla digitada — duas vezes, com a contagem.
            filtros.append(
                ProductVariant.id.in_(
                    union(
                        select(ProductVariant.id).where(
                            ProductVariant.barcode.like(f"%{termo}%")
                        ),
                        select(ProductVariant.id).where(
                            _achatar(ProductVariant.color).like(achatado)
                        ),
                        select(ProductVariant.id).where(
                            ProductVariant.product_id.in_(
                                select(Product.id).where(_achatar(Product.name).like(achatado))
                            )
                        ),
                    )
                )
            )
            # Código exato primeiro: quem digitou os 13 dígitos inteiros quer AQUELA peça
            # no topo, não a que vem antes no alfabeto.
            ordem = [case((ProductVariant.barcode == termo, 0), else_=1), *ordem]

        # A contagem é só peça + produto (o produto filtra excluídos e nome); sem as
        # colunas e o carregamento da página.
        total = await self.session.scalar(
            select(func.count())
            .select_from(ProductVariant)
            .join(Product, Product.id == ProductVariant.product_id)
            .where(*filtros)
        )
        stmt = (
            select(ProductVariant)
            # `selectinload` e não lazy: quem lê a lista precisa do NOME do produto, e no
            # async um relacionamento preguiçoso estoura em MissingGreenlet.
            .options(selectinload(ProductVariant.product))
            .join(Product, Product.id == ProductVariant.product_id)
            .where(*filtros)
            .order_by(*ordem)
            .offset(p.offset)
            .limit(p.limit)
        )
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

    # ------------------------------------------------------------ travas (ADR-30)
    # Quem decide "esta peça existe?" e depois escreve no saldo dela trava a LINHA DA PEÇA
    # primeiro, e só então o saldo — sempre nessa ordem e por id, como o saldo (ADR-1).
    # `FOR NO KEY UPDATE` (e não `FOR UPDATE`): não briga com o `FOR KEY SHARE` que a FK
    # de cada venda tira da peça, então vender continua sem esperar ninguém.
    #
    # Consulta de COLUNAS, não de objeto: a sessão roda com `autoflush=False`, e recarregar
    # o objeto apagaria o custo que a Entrada acabou de pôr nele e ainda não gravou.

    async def travar_peca(self, variante_id: int, *, travar: bool = True):
        """Trava a peça (ativa ou excluída) e devolve o que se decide com ela, ou None.

        `travar=False` é para quem só MOSTRA o que a regra decidiria (a condicional aberta,
        `pecas_que_receberiam`): a mesma consulta, sem esperar ninguém."""
        stmt = select(
            ProductVariant.id,
            ProductVariant.product_id,
            ProductVariant.size,
            ProductVariant.color,
            ProductVariant.barcode,
            ProductVariant.deleted_at,
        ).where(ProductVariant.id == variante_id)
        if travar:
            stmt = stmt.with_for_update(key_share=True)
        return (await self.session.execute(stmt)).one_or_none()

    async def travar_grade(self, produto_id: int) -> None:
        """Trava TODAS as peças do produto, inclusive as já excluídas.

        As excluídas também: uma devolução pode estar reativando uma delas agora mesmo, e a
        exclusão do produto precisa esperar para enxergá-la de volta com estoque.
        """
        await self.session.execute(
            select(ProductVariant.id)
            .where(ProductVariant.product_id == produto_id)
            .order_by(ProductVariant.id)
            .with_for_update(key_share=True)
        )

    async def travar_ativa_por_codigo(self, codigo: str, *, travar: bool = True) -> int | None:
        """Id da peça ATIVA com este código, travada. O filtro é reconferido depois da espera:
        se ela foi excluída enquanto esperávamos, volta None."""
        stmt = select(ProductVariant.id).where(
            ProductVariant.barcode == codigo, ProductVariant.deleted_at.is_(None)
        )
        if travar:
            stmt = stmt.with_for_update(key_share=True)
        return await self.session.scalar(stmt)

    async def travar_ativa_da_grade(
        self, produto_id: int, tamanho: str, cor: str, *, travar: bool = True
    ) -> int | None:
        """Id da peça ATIVA com o mesmo produto, tamanho e cor (o UNIQUE da grade), travada."""
        stmt = select(ProductVariant.id).where(
            ProductVariant.product_id == produto_id,
            ProductVariant.size == tamanho,
            ProductVariant.color == cor,
            ProductVariant.deleted_at.is_(None),
        )
        if travar:
            stmt = stmt.with_for_update(key_share=True)
        return await self.session.scalar(stmt)

    async def reativar_peca(self, variante_id: int, produto_id: int) -> None:
        """Desfaz a exclusão da peça e, se o produto também saiu, a dele."""
        await self.session.execute(
            update(ProductVariant).where(ProductVariant.id == variante_id).values(deleted_at=None)
        )
        await self.session.execute(
            update(Product)
            .where(Product.id == produto_id, Product.deleted_at.is_not(None))
            .values(deleted_at=None)
        )
