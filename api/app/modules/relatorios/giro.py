"""Giro do estoque: o que está parado, o que sustenta a loja e quanto vale a arara (ADR-38).

Mesma exceção documentada do resto de `relatorios`: só lê, por SQL próprio. Os dados já
existiam — a última venda de cada peça mora em `stock_movements` e o valor é saldo × preço;
faltava a pergunta.
"""

from datetime import date, timedelta
from decimal import ROUND_HALF_UP, Decimal

from sqlalchemy import case, func, select, union_all
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.datas import dia_da_loja, hoje_na_loja
from app.core.pagination import Pagina, Paginacao
from app.modules.catalogo.models import Product, ProductVariant
from app.modules.estoque.models import StockBalance, StockMovement, TipoMovimento
from app.modules.relatorios.schemas import (
    CurvaAbcOut,
    EstoqueParadoOut,
    PaginaEstoqueParado,
    ValorEstoqueOut,
)
from app.modules.relatorios.service import RelatorioService, _centavos
from app.modules.vendas.models import Sale, SaleItem, SaleReturn, SaleReturnItem, StatusVenda

ZERO = Decimal("0.00")
#: Curva ABC: até onde vai cada classe, em % acumulado do faturamento líquido.
LIMITE_A = Decimal("80")
LIMITE_B = Decimal("95")


def classe_abc(acumulado_antes: Decimal, total: Decimal) -> str:
    """A classe pelo acumulado ANTES do produto: quem cruza a linha dos 80% ainda é A.

    Pelo acumulado "inclusive", um campeão que sozinho faz 90% da loja seria B — e a loja
    ficaria sem nenhum A. A pergunta da curva é "quais produtos fazem os primeiros 80%", e
    o que atravessa a linha faz parte deles.
    """
    if total <= 0:
        return "C"
    antes = acumulado_antes / total * 100
    if antes < LIMITE_A:
        return "A"
    if antes < LIMITE_B:
        return "B"
    return "C"


def _pct(parte: Decimal, total: Decimal) -> Decimal:
    if total <= 0:
        return ZERO
    return (Decimal(parte) / total * 100).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


class GiroService:
    def __init__(self, session: AsyncSession):
        self.session = session

    # ------------------------------------------------------------ estoque parado
    def _paradas(self, dias: int):
        """Peças com saldo cuja última VENDA tem mais de `dias` dias — ou que nunca venderam
        desde a última ENTRADA, que tem mais de `dias` dias.

        "Parada desde" = última venda; sem venda, última entrada; sem as duas (saldo que
        veio do cadastro antigo, de ajuste ou de inventário), o cadastro da peça. Os dias
        contam no calendário da loja, como todo o resto dos relatórios.

        As duas datas saem de subconsultas correlacionadas pela peça: cada uma é um
        `max()` que o Postgres resolve descendo o índice
        `ix_stock_movements_variant_id_created_at` de trás para frente — uma leitura curta
        por peça com saldo, sem agrupar os anos de movimento da loja.
        """

        def ultimo(tipo: TipoMovimento):
            return (
                select(func.max(StockMovement.created_at))
                .where(
                    StockMovement.variant_id == ProductVariant.id,
                    StockMovement.movement_type == tipo,
                )
                .correlate(ProductVariant)
                .scalar_subquery()
            )

        base = (
            select(
                ProductVariant.id.label("variante_id"),
                Product.id.label("produto_id"),
                Product.name.label("produto"),
                ProductVariant.size.label("tamanho"),
                ProductVariant.color.label("cor"),
                ProductVariant.barcode.label("codigo_barras"),
                StockBalance.quantity.label("saldo"),
                ProductVariant.cost_price.label("custo"),
                ProductVariant.sale_price.label("preco"),
                ProductVariant.created_at.label("cadastro"),
                ultimo(TipoMovimento.VENDA).label("ultima_venda"),
                ultimo(TipoMovimento.ENTRADA).label("ultima_entrada"),
            )
            .join(Product, Product.id == ProductVariant.product_id)
            .join(StockBalance, StockBalance.variant_id == ProductVariant.id)
            .where(
                StockBalance.quantity > 0,
                ProductVariant.deleted_at.is_(None),
                Product.deleted_at.is_(None),
            )
        ).subquery()

        desde = dia_da_loja(
            func.coalesce(base.c.ultima_venda, base.c.ultima_entrada, base.c.cadastro)
        )
        corte = hoje_na_loja() - timedelta(days=dias)
        return base, desde, desde < corte

    async def estoque_parado(self, dias: int, p: Paginacao) -> PaginaEstoqueParado:
        base, desde, parada = self._paradas(dias)
        total, pecas, custo, venda = (
            await self.session.execute(
                select(
                    func.count(),
                    func.coalesce(func.sum(base.c.saldo), 0),
                    func.coalesce(func.sum(base.c.saldo * base.c.custo), 0),
                    func.coalesce(func.sum(base.c.saldo * base.c.preco), 0),
                ).where(parada)
            )
        ).one()

        hoje = hoje_na_loja()
        linhas = (
            await self.session.execute(
                select(base, desde.label("desde"))
                .where(parada)
                # Mais antiga primeiro; o id desempata para a página não trocar de ordem.
                .order_by(desde, base.c.variante_id)
                .offset(p.offset)
                .limit(p.limit)
            )
        ).all()
        itens = [
            EstoqueParadoOut(
                variante_id=linha.variante_id,
                produto_id=linha.produto_id,
                produto=linha.produto,
                tamanho=linha.tamanho,
                cor=linha.cor,
                codigo_barras=linha.codigo_barras,
                saldo=linha.saldo,
                ultima_venda=linha.ultima_venda,
                ultima_entrada=linha.ultima_entrada,
                dias_parada=(hoje - linha.desde).days,
                preco_custo=linha.custo,
                preco_venda=linha.preco,
                valor_em_custo=_centavos(linha.custo * linha.saldo),
                valor_em_venda=_centavos(linha.preco * linha.saldo),
            )
            for linha in linhas
        ]
        return PaginaEstoqueParado(
            items=itens,
            total=int(total or 0),
            page=p.page,
            size=p.size,
            dias=dias,
            pecas_total=int(pecas or 0),
            valor_em_custo_total=_centavos(custo),
            valor_em_venda_total=_centavos(venda),
        )

    # ---------------------------------------------------------------- curva ABC
    def _liquido_por_produto(self, inicio: date, fim: date):
        """(produto, peças, líquido) do período: vendido − devolvido, por produto.

        O valor vendido de cada item leva o desconto da venda rateado (preço × qtd × total
        ÷ subtotal) — a mesma conta do `refund_amount` da devolução (ADR-19). Somar o preço
        cheio contra uma devolução já rateada inflaria quem vende com desconto.
        """
        rateado = case(
            (
                Sale.subtotal > 0,
                SaleItem.unit_price * SaleItem.quantity * Sale.total / Sale.subtotal,
            ),
            else_=0,
        )
        fontes = union_all(
            select(
                ProductVariant.product_id.label("produto_id"),
                func.sum(SaleItem.quantity).label("pecas"),
                func.sum(rateado).label("valor"),
            )
            .select_from(SaleItem)
            .join(Sale, Sale.id == SaleItem.sale_id)
            .join(ProductVariant, ProductVariant.id == SaleItem.variant_id)
            .where(
                dia_da_loja(Sale.sold_at).between(inicio, fim),
                Sale.status == StatusVenda.CONCLUIDA,
            )
            .group_by(ProductVariant.product_id),
            select(
                ProductVariant.product_id,
                -func.sum(SaleReturnItem.quantity),
                -func.sum(SaleReturnItem.refund_amount),
            )
            .select_from(SaleReturnItem)
            .join(SaleReturn, SaleReturn.id == SaleReturnItem.return_id)
            .join(ProductVariant, ProductVariant.id == SaleReturnItem.variant_id)
            .where(dia_da_loja(SaleReturn.returned_at).between(inicio, fim))
            .group_by(ProductVariant.product_id),
        ).subquery()
        liquido = func.sum(fontes.c.valor)
        return (
            select(
                fontes.c.produto_id,
                func.sum(fontes.c.pecas).label("pecas"),
                liquido.label("liquido"),
            )
            .group_by(fontes.c.produto_id)
            # Só quem trouxe dinheiro entra na curva: produto só com devolução no período
            # puxaria o acumulado para trás (passaria de 100% e voltaria).
            .having(liquido > 0)
        ).subquery()

    async def curva_abc(self, inicio: date, fim: date, p: Paginacao) -> Pagina[CurvaAbcOut]:
        RelatorioService.validar_periodo(inicio, fim)
        por_produto = self._liquido_por_produto(inicio, fim)
        ordem = (por_produto.c.liquido.desc(), por_produto.c.produto_id)
        ranqueado = select(
            por_produto.c.produto_id,
            por_produto.c.pecas,
            por_produto.c.liquido,
            func.sum(por_produto.c.liquido).over(order_by=ordem).label("acumulado"),
            func.sum(por_produto.c.liquido).over().label("total_liquido"),
            func.count().over().label("total_linhas"),
        ).subquery()

        linhas = (
            await self.session.execute(
                select(ranqueado, Product.name)
                .join(Product, Product.id == ranqueado.c.produto_id)
                .order_by(ranqueado.c.liquido.desc(), ranqueado.c.produto_id)
                .offset(p.offset)
                .limit(p.limit)
            )
        ).all()
        if linhas:
            total = int(linhas[0].total_linhas)
        else:
            total = int(
                await self.session.scalar(select(func.count()).select_from(por_produto)) or 0
            )

        itens = []
        for linha in linhas:
            liquido, acumulado, base = (
                Decimal(linha.liquido),
                Decimal(linha.acumulado),
                Decimal(linha.total_liquido),
            )
            itens.append(
                CurvaAbcOut(
                    produto_id=linha.produto_id,
                    produto=linha.name,
                    pecas=int(linha.pecas or 0),
                    faturamento_liquido=_centavos(liquido),
                    percentual=_pct(liquido, base),
                    percentual_acumulado=_pct(acumulado, base),
                    classe=classe_abc(acumulado - liquido, base),
                )
            )
        return Pagina.montar(itens, total, p)

    # ------------------------------------------------------------ valor do estoque
    async def valor_do_estoque(self) -> ValorEstoqueOut:
        """A arara inteira a preço de custo e a preço de venda, numa conta só do banco.

        Peça excluída do catálogo fica de fora, como em toda tela de estoque: o saldo dela
        não é oferecido a ninguém.
        """
        pecas, variantes, custo, venda = (
            await self.session.execute(
                select(
                    func.coalesce(func.sum(StockBalance.quantity), 0),
                    func.count(),
                    func.coalesce(func.sum(StockBalance.quantity * ProductVariant.cost_price), 0),
                    func.coalesce(func.sum(StockBalance.quantity * ProductVariant.sale_price), 0),
                )
                .select_from(StockBalance)
                .join(ProductVariant, ProductVariant.id == StockBalance.variant_id)
                .join(Product, Product.id == ProductVariant.product_id)
                .where(
                    StockBalance.quantity > 0,
                    ProductVariant.deleted_at.is_(None),
                    Product.deleted_at.is_(None),
                )
            )
        ).one()
        return ValorEstoqueOut(
            pecas=int(pecas),
            variantes=int(variantes),
            valor_em_custo=_centavos(custo),
            valor_em_venda=_centavos(venda),
        )
