"""Relatórios: leitura analítica sobre as tabelas de venda, estoque e despesa.

Como `caixa`, este módulo é a exceção documentada à regra de não olhar tabela alheia:
ele só lê, nunca escreve, e agregação em SQL é ordens de grandeza mais barata do que
carregar objetos para somar em Python.
"""

from datetime import date, timedelta
from decimal import ROUND_HALF_UP, Decimal

from sqlalchemy import case, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import Validacao
from app.core.datas import dia_da_loja
from app.core.pagination import Pagina, Paginacao
from app.modules.catalogo.models import Product, ProductVariant
from app.modules.despesas.models import Expense, ExpenseCategory
from app.modules.estoque.models import StockBalance
from app.modules.relatorios.cartao import agenda_de_recebiveis, taxas_do_periodo
from app.modules.relatorios.schemas import (
    DespesaCategoriaOut,
    DiaVendaOut,
    EstoqueBaixoOut,
    MaisVendidoOut,
    RecebivelOut,
    ResumoOut,
)
from app.modules.clientes.models import CustomerPayment
from app.modules.vendas.models import (
    FormaPagamento,
    Sale,
    SaleItem,
    SalePayment,
    SaleReturn,
    SaleReturnItem,
    StatusVenda,
)

ZERO = Decimal("0.00")
MAX_DIAS = 366


def _centavos(valor: Decimal) -> Decimal:
    return Decimal(valor or 0).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


class RelatorioService:
    def __init__(self, session: AsyncSession):
        self.session = session

    @staticmethod
    def validar_periodo(inicio: date, fim: date) -> None:
        if inicio > fim:
            raise Validacao("A data inicial é depois da final.")
        if (fim - inicio) > timedelta(days=MAX_DIAS):
            raise Validacao(
                f"O período não pode passar de {MAX_DIAS} dias.",
                {"dias_pedidos": (fim - inicio).days},
            )

    def _vendas_do_periodo(self, inicio: date, fim: date):
        """Só vendas concluídas: cancelada não fatura nem consome mercadoria."""
        return (
            dia_da_loja(Sale.sold_at).between(inicio, fim),
            Sale.status == StatusVenda.CONCLUIDA,
        )

    async def resumo(self, inicio: date, fim: date) -> ResumoOut:
        self.validar_periodo(inicio, fim)
        filtros = self._vendas_do_periodo(inicio, fim)

        # Faturamento sai do total da venda (já com desconto); o CMV, do custo congelado
        # dos itens. Somar line_total daria o bruto e inflaria a margem.
        faturamento, qtd_vendas = (
            await self.session.execute(
                select(func.coalesce(func.sum(Sale.total), 0), func.count()).where(*filtros)
            )
        ).one()

        cmv, qtd_pecas = (
            await self.session.execute(
                select(
                    func.coalesce(func.sum(SaleItem.unit_cost * SaleItem.quantity), 0),
                    func.coalesce(func.sum(SaleItem.quantity), 0),
                )
                .join(Sale, Sale.id == SaleItem.sale_id)
                .where(*filtros)
            )
        ).one()

        despesas = await self.session.scalar(
            select(func.coalesce(func.sum(Expense.amount), 0)).where(
                Expense.expense_date.between(inicio, fim), Expense.deleted_at.is_(None)
            )
        )

        canceladas = await self.session.scalar(
            select(func.count()).where(
                dia_da_loja(Sale.sold_at).between(inicio, fim),
                Sale.status == StatusVenda.CANCELADA,
            )
        )

        # Devoluções entram pelo dia em que ACONTECERAM (ADR-19). Amarrar pelo dia da venda
        # reescreveria um mês já fechado — e a dona olharia dois números diferentes para o
        # mesmo agosto, dependendo de quando abriu a tela.
        devolvido, pecas_devolvidas, cmv_devolvido = (
            await self.session.execute(
                select(
                    func.coalesce(func.sum(SaleReturnItem.refund_amount), 0),
                    func.coalesce(func.sum(SaleReturnItem.quantity), 0),
                    func.coalesce(
                        func.sum(
                            case(
                                (
                                    SaleReturnItem.restock.is_(True),
                                    SaleItem.unit_cost * SaleReturnItem.quantity,
                                ),
                                else_=0,
                            )
                        ),
                        0,
                    ),
                )
                .join(SaleReturn, SaleReturn.id == SaleReturnItem.return_id)
                .join(SaleItem, SaleItem.id == SaleReturnItem.sale_item_id)
                .where(dia_da_loja(SaleReturn.returned_at).between(inicio, fim))
            )
        ).one()

        a_prazo = await self.session.scalar(
            select(func.coalesce(func.sum(SalePayment.amount), 0))
            .join(Sale, Sale.id == SalePayment.sale_id)
            .where(*filtros, SalePayment.method == FormaPagamento.FIADO)
        )
        recebido = await self.session.scalar(
            select(func.coalesce(func.sum(CustomerPayment.amount), 0)).where(
                dia_da_loja(CustomerPayment.paid_at).between(inicio, fim)
            )
        )

        # A maquininha fica com 2 a 5% do que entrou no cartão: sem abater, o resultado sai
        # inflado todo mês (ADR-35).
        taxas_cartao = _centavos(await taxas_do_periodo(self.session, inicio, fim))

        faturamento = _centavos(faturamento)
        devolvido = _centavos(devolvido)
        cmv = _centavos(cmv)
        cmv_devolvido = _centavos(cmv_devolvido)
        despesas = _centavos(despesas)
        faturamento_liquido = faturamento - devolvido
        # O lucro sai do líquido dos dois lados: a peça que voltou não faturou e também
        # não consumiu mercadoria (quando voltou vendável).
        lucro_bruto = faturamento_liquido - (cmv - cmv_devolvido)
        # Margem na MESMA base do lucro: líquido sobre líquido. Dividir pelo bruto encolhia
        # a margem na proporção da devolução — vendeu duas blusas, uma voltou, e a margem
        # de 50% aparecia como 25%.
        margem = (
            (lucro_bruto / faturamento_liquido * 100).quantize(
                Decimal("0.01"), rounding=ROUND_HALF_UP
            )
            if faturamento_liquido > 0
            else ZERO
        )
        ticket = _centavos(faturamento / qtd_vendas) if qtd_vendas else ZERO

        return ResumoOut(
            inicio=inicio,
            fim=fim,
            faturamento=faturamento,
            devolucoes=devolvido,
            faturamento_liquido=faturamento_liquido,
            custo_mercadoria_vendida=cmv,
            cmv_devolvido=cmv_devolvido,
            pecas_devolvidas=int(pecas_devolvidas),
            vendas_a_prazo=_centavos(a_prazo),
            recebimentos_de_fiado=_centavos(recebido),
            lucro_bruto=lucro_bruto,
            despesas=despesas,
            taxas_cartao=taxas_cartao,
            resultado=lucro_bruto - despesas - taxas_cartao,
            margem_bruta_pct=margem,
            quantidade_vendas=int(qtd_vendas),
            quantidade_pecas=int(qtd_pecas),
            ticket_medio=ticket,
            vendas_canceladas=int(canceladas or 0),
        )

    async def vendas_por_dia(self, inicio: date, fim: date) -> list[DiaVendaOut]:
        """Série diária sem buracos: dia sem venda aparece zerado, senão o gráfico mente."""
        self.validar_periodo(inicio, fim)
        filtros = self._vendas_do_periodo(inicio, fim)
        dia = dia_da_loja(Sale.sold_at).label("dia")

        linhas = (
            await self.session.execute(
                select(dia, func.sum(Sale.total), func.count()).where(*filtros).group_by(dia)
            )
        ).all()
        totais = {data: (faturado, qtd) for data, faturado, qtd in linhas}
        pecas = dict(
            (
                await self.session.execute(
                    select(dia, func.sum(SaleItem.quantity))
                    .join(Sale, Sale.id == SaleItem.sale_id)
                    .where(*filtros)
                    .group_by(dia)
                )
            ).all()
        )

        serie: list[DiaVendaOut] = []
        atual = inicio
        while atual <= fim:
            faturamento, quantidade = totais.get(atual, (0, 0))
            serie.append(
                DiaVendaOut(
                    data=atual,
                    faturamento=_centavos(faturamento),
                    quantidade_vendas=int(quantidade),
                    quantidade_pecas=int(pecas.get(atual, 0)),
                )
            )
            atual += timedelta(days=1)
        return serie

    async def mais_vendidos(self, inicio: date, fim: date, limite: int) -> list[MaisVendidoOut]:
        """Ranking por quantidade. Faturamento aqui é o bruto do item, sem rateio do desconto."""
        self.validar_periodo(inicio, fim)
        filtros = self._vendas_do_periodo(inicio, fim)
        linhas = (
            await self.session.execute(
                select(
                    SaleItem.variant_id,
                    Product.name,
                    ProductVariant.size,
                    ProductVariant.color,
                    ProductVariant.barcode,
                    func.sum(SaleItem.quantity),
                    func.sum(SaleItem.unit_price * SaleItem.quantity),
                    func.sum(
                        (SaleItem.unit_price - SaleItem.unit_cost) * SaleItem.quantity
                    ),
                )
                .join(Sale, Sale.id == SaleItem.sale_id)
                .join(ProductVariant, ProductVariant.id == SaleItem.variant_id)
                .join(Product, Product.id == ProductVariant.product_id)
                .where(*filtros)
                .group_by(
                    SaleItem.variant_id,
                    Product.name,
                    ProductVariant.size,
                    ProductVariant.color,
                    ProductVariant.barcode,
                )
                .order_by(func.sum(SaleItem.quantity).desc())
                .limit(limite)
            )
        ).all()
        return [
            MaisVendidoOut(
                variante_id=variante_id,
                produto=produto,
                tamanho=tamanho,
                cor=cor,
                codigo_barras=codigo,
                quantidade=int(quantidade),
                faturamento=_centavos(faturamento),
                lucro_bruto=_centavos(lucro),
            )
            for variante_id, produto, tamanho, cor, codigo, quantidade, faturamento, lucro in linhas
        ]

    async def despesas_por_categoria(
        self, inicio: date, fim: date
    ) -> list[DespesaCategoriaOut]:
        self.validar_periodo(inicio, fim)
        linhas = (
            await self.session.execute(
                select(
                    ExpenseCategory.id,
                    ExpenseCategory.name,
                    func.sum(Expense.amount),
                    func.count(),
                )
                .join(Expense, Expense.category_id == ExpenseCategory.id)
                .where(
                    Expense.expense_date.between(inicio, fim), Expense.deleted_at.is_(None)
                )
                .group_by(ExpenseCategory.id, ExpenseCategory.name)
                .order_by(func.sum(Expense.amount).desc())
            )
        ).all()
        total_geral = sum((Decimal(linha[2]) for linha in linhas), ZERO)
        return [
            DespesaCategoriaOut(
                categoria_id=categoria_id,
                categoria=nome,
                total=_centavos(total),
                percentual=(
                    (Decimal(total) / total_geral * 100).quantize(
                        Decimal("0.01"), rounding=ROUND_HALF_UP
                    )
                    if total_geral > 0
                    else ZERO
                ),
                quantidade=int(quantidade),
            )
            for categoria_id, nome, total, quantidade in linhas
        ]

    async def estoque_baixo(self, p: Paginacao) -> Pagina[EstoqueBaixoOut]:
        """Fotografia do agora: peças no mínimo ou abaixo. Não tem período por natureza.

        Paginada como toda listagem: numa loja com milhares de peças esgotadas (mínimo 0 e
        saldo 0 entram) eram 7 mil linhas e 1,5 MB a cada venda, só para a aba Financeiro
        mostrar "N peças no mínimo". O total sai contado pelo banco; quem só quer o número
        pede `size=1` e lê `total`.
        """
        saldo = func.coalesce(StockBalance.quantity, 0)
        filtros = (
            ProductVariant.deleted_at.is_(None),
            Product.deleted_at.is_(None),
            saldo <= ProductVariant.min_stock,
        )
        total = await self.session.scalar(
            select(func.count())
            .select_from(ProductVariant)
            .join(Product, Product.id == ProductVariant.product_id)
            .outerjoin(StockBalance, StockBalance.variant_id == ProductVariant.id)
            .where(*filtros)
        )
        linhas = (
            await self.session.execute(
                select(
                    ProductVariant.id,
                    Product.name,
                    ProductVariant.size,
                    ProductVariant.color,
                    ProductVariant.barcode,
                    saldo,
                    ProductVariant.min_stock,
                    ProductVariant.cost_price,
                )
                .join(Product, Product.id == ProductVariant.product_id)
                .outerjoin(StockBalance, StockBalance.variant_id == ProductVariant.id)
                .where(*filtros)
                # Mais urgente primeiro: quem tem mínimo definido e está mais abaixo dele.
                # O id desempata — sem ele, duas peças empatadas podiam trocar de lugar
                # entre uma página e outra, e uma aparecia duas vezes enquanto a outra sumia.
                .order_by(
                    case((ProductVariant.min_stock == 0, 1), else_=0),
                    saldo - ProductVariant.min_stock,
                    Product.name,
                    ProductVariant.id,
                )
                .offset(p.offset)
                .limit(p.limit)
            )
        ).all()
        itens = [
            EstoqueBaixoOut(
                variante_id=variante_id,
                produto=produto,
                tamanho=tamanho,
                cor=cor,
                codigo_barras=codigo,
                saldo=int(quantidade),
                estoque_minimo=int(minimo),
                faltam=max(int(minimo) - int(quantidade), 0),
                preco_custo=custo,
            )
            for variante_id, produto, tamanho, cor, codigo, quantidade, minimo, custo in linhas
        ]
        return Pagina.montar(itens, int(total or 0), p)

    async def recebiveis(self, inicio: date, fim: date, p: Paginacao) -> Pagina[RecebivelOut]:
        """Agenda do cartão: quanto cai na conta em cada dia do período (ADR-35)."""
        self.validar_periodo(inicio, fim)
        dias, total = await agenda_de_recebiveis(self.session, inicio, fim, p)
        itens = [
            RecebivelOut(
                data=dia,
                bruto=_centavos(bruto),
                taxa=_centavos(taxa),
                liquido=_centavos(bruto) - _centavos(taxa),
            )
            for dia, bruto, taxa in dias
        ]
        return Pagina.montar(itens, total, p)
