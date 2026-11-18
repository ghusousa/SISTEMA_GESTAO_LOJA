import uuid
from datetime import UTC, datetime

from sqlalchemy import exists, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.pagination import Paginacao
from app.modules.catalogo.models import Product, ProductVariant
from app.modules.usuarios.models import User
from app.modules.vendas.models import (
    Sale,
    SaleItem,
    SalePayment,
    SaleReturn,
    StatusVenda,
    Voucher,
)


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

    async def marcar_cancelada(
        self, venda_id: int, *, cancelada_por: int, motivo: str
    ) -> bool:
        """Troca CONCLUIDA por CANCELADA em uma instrução, e diz se foi ela quem trocou.

        O `WHERE status = 'CONCLUIDA'` é o que serializa dois cancelamentos simultâneos:
        o segundo atualiza zero linhas e o chamador sabe que não pode estornar de novo.

        O `NOT EXISTS` sobre devoluções é a mesma ideia contra outro erro: cancelar uma
        venda que já teve peça devolvida estornaria o estoque inteiro DE NOVO, incluindo o
        que já voltou — e o dinheiro ficaria sem caminho, porque a devolução já pagou parte
        e o cancelamento não sabe quanto nem por qual forma. Quem quer desfazer o resto
        devolve o resto.

        A trava vem ANTES, numa instrução separada, e é ela que faz o `NOT EXISTS` valer
        contra uma devolução em andamento. Sem ela, o `UPDATE` tira a foto do banco ao
        começar — quando a devolução ainda não tinha feito commit —, para na trava que a
        devolução segura (`_venda_travada`) e, quando ela solta, segue com a foto velha: a
        devolução só TRAVOU a linha, não a alterou, então o Postgres não reavalia o WHERE.
        A venda saía CANCELADA e com devolução, a peça voltava duas vezes à arara e o
        dinheiro dela saía duas vezes. Travando primeiro, o `UPDATE` só começa depois do
        commit da devolução, com foto nova, e enxerga a linha em `sale_returns`.
        """
        await self.session.execute(
            select(Sale.id).where(Sale.id == venda_id).with_for_update()
        )
        resultado = await self.session.execute(
            update(Sale)
            .where(
                Sale.id == venda_id,
                Sale.status == StatusVenda.CONCLUIDA,
                ~exists().where(SaleReturn.sale_id == venda_id),
            )
            .values(
                status=StatusVenda.CANCELADA,
                cancelled_at=datetime.now(UTC),
                cancelled_by_id=cancelada_por,
                cancel_reason=motivo,
            )
        )
        return (resultado.rowcount or 0) == 1

    async def nome_do_cliente(self, cliente_id: int | None) -> str | None:
        """Sem filtrar por `deleted_at`: venda antiga de cliente desativado continua tendo
        dono. Esconder o nome não protege ninguém e some com a explicação do fiado."""
        if cliente_id is None:
            return None
        from app.modules.clientes.models import Customer

        return await self.session.scalar(select(Customer.name).where(Customer.id == cliente_id))

    async def por_client_uuid(self, client_uuid: uuid.UUID) -> Sale | None:
        stmt = (
            select(Sale)
            .options(selectinload(Sale.items), selectinload(Sale.payments))
            .where(Sale.client_uuid == client_uuid)
        )
        return (await self.session.execute(stmt)).unique().scalar_one_or_none()

    async def codigos_dos_vales(self, ids: list[int]) -> dict[int, str]:
        """O código impresso de cada vale, para comparar com o que a tela mandou."""
        if not ids:
            return {}
        stmt = select(Voucher.id, Voucher.code).where(Voucher.id.in_(ids))
        return {vid: codigo for vid, codigo in (await self.session.execute(stmt)).all()}

    async def variantes_para_venda(self, ids: list[int]) -> dict[int, tuple]:
        """Peça + produto ATIVOS, com preço e custo atuais — o que será congelado na venda."""
        if not ids:
            return {}
        stmt = (
            select(ProductVariant, Product)
            .join(Product, Product.id == ProductVariant.product_id)
            .where(ProductVariant.id.in_(ids), ProductVariant.deleted_at.is_(None))
        )
        return {v.id: (v, p) for v, p in (await self.session.execute(stmt)).all()}

    async def variantes_historicas(self, ids: list[int]) -> dict[int, tuple]:
        """Peça + produto SEM filtrar exclusão, para renderizar vendas antigas.

        Produto excluído é soft delete justamente para continuar explicando o passado; usar
        o filtro de ativos aqui faria um recibo de julho virar "(peça removida)" só porque a
        peça saiu do catálogo em agosto.
        """
        if not ids:
            return {}
        stmt = (
            select(ProductVariant, Product)
            .join(Product, Product.id == ProductVariant.product_id)
            .where(ProductVariant.id.in_(ids))
        )
        return {v.id: (v, p) for v, p in (await self.session.execute(stmt)).all()}

    async def usuario(self, user_id: int) -> User | None:
        return await self.session.get(User, user_id)

    async def listar(
        self,
        p: Paginacao,
        inicio: datetime | None,
        fim: datetime | None,
        status: str | None,
        vendedor_id: int | None,
        variante_id: int | None = None,
        cliente_id: int | None = None,
    ) -> tuple[list[tuple], int]:
        filtros = []
        if variante_id:
            # É este filtro que torna a devolução possível no balcão: a cliente chega com
            # a blusa na mão e sem nota, e sem ele a vendedora teria que abrir venda por
            # venda de um sábado de quarenta. Sem isso, a devolução não acontece pelo
            # sistema — acontece um AJUSTE de estoque e dinheiro saindo da gaveta.
            filtros.append(
                exists().where(
                    SaleItem.sale_id == Sale.id, SaleItem.variant_id == variante_id
                )
            )
        if cliente_id:
            filtros.append(Sale.customer_id == cliente_id)
        if inicio is not None:
            filtros.append(Sale.sold_at >= inicio)
        if fim is not None:
            # `<` porque `fim` é 00:00 do dia SEGUINTE (app/core/datas.py). Intervalo
            # meio-aberto: o último instante do dia entra, o primeiro de amanhã não.
            filtros.append(Sale.sold_at < fim)
        if status:
            filtros.append(Sale.status == status)
        if vendedor_id:
            filtros.append(Sale.seller_id == vendedor_id)
        # A contagem só olha `sales`: o JOIN com o vendedor é 1:1 por FK obrigatória e não
        # muda o total — contar o JOIN fazia o banco montá-lo para o histórico inteiro a
        # cada página.
        total = await self.session.scalar(
            select(func.count()).select_from(Sale).where(*filtros)
        )
        # Mais recente primeiro pelo INSTANTE da venda, e o id só desempata. Ordenar por id
        # com o filtro em `sold_at` fazia o banco descer o índice da chave desde a venda
        # mais nova e descartar tudo até chegar ao período: "março do ano passado"
        # descartava 170 mil vendas para mostrar 20. Assim desce `ix_sales_sold_at` direto
        # do fim do período — e a ordem é a do relógio, que é a que a tela promete.
        stmt = (
            select(Sale, User)
            .join(User, User.id == Sale.seller_id)
            .where(*filtros)
            .order_by(Sale.sold_at.desc(), Sale.id.desc())
            .offset(p.offset)
            .limit(p.limit)
        )
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
