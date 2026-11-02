"""O cartão nos relatórios: quanto a maquininha ficou, e quando o dinheiro cai na conta.

Mesmo estatuto do resto de `relatorios`: só lê, por SQL próprio (a exceção documentada).
Mora num arquivo à parte porque as duas contas compartilham as mesmas regras — e regra de
dinheiro repetida em dois lugares é regra que um dia diverge.

As regras (ADR-35):

- A taxa de cada pagamento é `round(valor × taxa_percentual / 100, 2)`, com a taxa
  FOTOGRAFADA na venda — nunca a da tabela de hoje.
- Devolução é evento do dia em que acontece (ADR-19): a taxa da parte que voltou pelo
  cartão sai das taxas do período da DEVOLUÇÃO, na proporção da taxa que aquela forma
  pagou naquela venda (a devolução diz por qual forma voltou, não por qual dos
  pagamentos) — e de forma ACUMULADA, para a soma das devoluções nunca passar da taxa paga.
- Na agenda, débito cai em D+prazo; crédito em N parcelas, a 1ª em D+prazo e as outras de
  30 em 30 dias. O centavo que sobra da divisão vai na 1ª parcela, como faz a credenciadora.
  O estorno no cartão é debitado da agenda no dia da devolução.
"""

from datetime import date, timedelta
from decimal import Decimal

from sqlalchemy import Date, case, cast, func, literal, select, true, union_all
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.core.datas import dia_da_loja
from app.core.pagination import Paginacao
from app.modules.taxas.models import MAX_PARCELAS, MAX_PRAZO_DIAS
from app.modules.vendas.models import (
    FormaPagamento,
    Sale,
    SalePayment,
    SaleReturn,
    SaleReturnPayment,
    StatusVenda,
)

CARTAO = (FormaPagamento.DEBITO, FormaPagamento.CREDITO)
#: Da 2ª parcela em diante, uma a cada 30 dias depois da primeira.
INTERVALO_PARCELAS_DIAS = 30
#: A venda mais antiga cuja última parcela ainda pode cair dentro do período pedido.
JANELA_MAXIMA = timedelta(days=MAX_PRAZO_DIAS + INTERVALO_PARCELAS_DIAS * (MAX_PARCELAS - 1))


def _taxa_do_pagamento():
    return func.round(SalePayment.amount * SalePayment.taxa_percentual / 100, 2)


def _taxa_devolvida():
    """A taxa da parte que voltou, ACUMULADA por venda e forma.

    Arredondar cada devolução sozinha devolvia mais do que a venda pagou: R$ 10,00 no
    crédito a 2,5% pagam R$ 0,25, e duas devoluções de R$ 5,00 devolviam 0,13 + 0,13. Aqui
    a conta é a taxa que a forma PAGOU naquela venda × a fração dela que já voltou
    (devoluções anteriores e esta, em ordem de gravação), arredondada uma vez só, menos a
    mesma conta sem esta devolução. A soma telescopa: o que voltou de taxa é sempre o
    arredondamento da fração devolvida da taxa paga, e tudo devolvido devolve exatamente a
    taxa paga — nunca um centavo a mais. O teto (`LEAST`) é a rede, como o CHECK do saldo.
    """
    sp = aliased(SalePayment)
    da_forma = (sp.sale_id == SaleReturn.sale_id, sp.method == SaleReturnPayment.method)
    recebido = select(func.sum(sp.amount)).where(*da_forma).scalar_subquery()
    paga = (
        select(func.sum(func.round(sp.amount * sp.taxa_percentual / 100, 2)))
        .where(*da_forma)
        .scalar_subquery()
    )
    srp = aliased(SaleReturnPayment)
    sr = aliased(SaleReturn)
    devolvido_ate_esta = (
        select(func.sum(srp.amount))
        .join(sr, sr.id == srp.return_id)
        .where(
            sr.sale_id == SaleReturn.sale_id,
            srp.method == SaleReturnPayment.method,
            srp.id <= SaleReturnPayment.id,
        )
        .scalar_subquery()
    )

    def acumulada(devolvido):
        return func.least(func.round(paga * devolvido / func.nullif(recebido, 0), 2), paga)

    return func.coalesce(
        acumulada(devolvido_ate_esta)
        - acumulada(devolvido_ate_esta - SaleReturnPayment.amount),
        0,
    )


async def taxas_do_periodo(session: AsyncSession, inicio: date, fim: date) -> Decimal:
    """Σ taxa das vendas concluídas do período − Σ taxa da parte devolvida no período."""
    das_vendas = await session.scalar(
        select(func.coalesce(func.sum(_taxa_do_pagamento()), 0))
        .join(Sale, Sale.id == SalePayment.sale_id)
        .where(
            dia_da_loja(Sale.sold_at).between(inicio, fim),
            Sale.status == StatusVenda.CONCLUIDA,
            SalePayment.method.in_(CARTAO),
        )
    )
    devolvida = await session.scalar(
        select(func.coalesce(func.sum(_taxa_devolvida()), 0))
        .select_from(SaleReturnPayment)
        .join(SaleReturn, SaleReturn.id == SaleReturnPayment.return_id)
        .where(
            dia_da_loja(SaleReturn.returned_at).between(inicio, fim),
            SaleReturnPayment.method.in_(CARTAO),
        )
    )
    return Decimal(das_vendas or 0) - Decimal(devolvida or 0)


def _parcelas_a_receber(inicio: date, fim: date):
    """Uma linha por parcela de cada pagamento no cartão de venda concluída."""
    parcela = (
        func.generate_series(1, SalePayment.parcelas)
        .table_valued("n")
        .render_derived(name="parcela")
    )
    n = parcela.c.n
    dia_venda = dia_da_loja(Sale.sold_at)
    taxa_total = _taxa_do_pagamento()
    base = func.trunc(SalePayment.amount / SalePayment.parcelas, 2)
    taxa_base = func.trunc(taxa_total / SalePayment.parcelas, 2)
    return (
        select(
            (
                cast(dia_venda, Date)
                + SalePayment.prazo_dias
                + literal(INTERVALO_PARCELAS_DIAS) * (n - 1)
            ).label("data"),
            case(
                (n == 1, SalePayment.amount - base * (SalePayment.parcelas - 1)), else_=base
            ).label("bruto"),
            case(
                (n == 1, taxa_total - taxa_base * (SalePayment.parcelas - 1)),
                else_=taxa_base,
            ).label("taxa"),
        )
        .select_from(SalePayment)
        .join(Sale, Sale.id == SalePayment.sale_id)
        .join(parcela, true())
        .where(
            Sale.status == StatusVenda.CONCLUIDA,
            SalePayment.method.in_(CARTAO),
            # Só as vendas que PODEM ter parcela no período: o índice do dia da venda
            # corta os anos de histórico antes de gerar parcela nenhuma.
            dia_venda.between(inicio - JANELA_MAXIMA, fim),
        )
    )


def _estornos(inicio: date, fim: date):
    """O que voltou pelo cartão sai da agenda no dia da devolução, com a taxa dele."""
    dia = dia_da_loja(SaleReturn.returned_at)
    return (
        select(
            cast(dia, Date).label("data"),
            (-SaleReturnPayment.amount).label("bruto"),
            (-_taxa_devolvida()).label("taxa"),
        )
        .select_from(SaleReturnPayment)
        .join(SaleReturn, SaleReturn.id == SaleReturnPayment.return_id)
        .where(dia.between(inicio, fim), SaleReturnPayment.method.in_(CARTAO))
    )


async def agenda_de_recebiveis(
    session: AsyncSession, inicio: date, fim: date, p: Paginacao
) -> tuple[list[tuple[date, Decimal, Decimal]], int]:
    """(data, bruto, taxa) por dia previsto de crédito em [inicio, fim], e quantos dias há."""
    linhas = union_all(_parcelas_a_receber(inicio, fim), _estornos(inicio, fim)).subquery()
    por_dia = (
        select(
            linhas.c.data,
            func.sum(linhas.c.bruto).label("bruto"),
            func.sum(linhas.c.taxa).label("taxa"),
        )
        .where(linhas.c.data.between(inicio, fim))
        .group_by(linhas.c.data)
    )
    total = await session.scalar(select(func.count()).select_from(por_dia.subquery()))
    pagina = (
        await session.execute(
            por_dia.order_by(linhas.c.data).offset(p.offset).limit(p.limit)
        )
    ).all()
    return [(d, Decimal(b or 0), Decimal(t or 0)) for d, b, t in pagina], int(total or 0)
