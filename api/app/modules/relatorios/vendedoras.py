"""Vendas e comissão por pessoa da equipe (ADR-37).

Mesma exceção documentada do resto de `relatorios`: só lê, por SQL próprio, as tabelas de
venda e devolução. As regras que a folha depende delas:

- **Líquido** = vendas concluídas no período − devoluções no período. A devolução entra no
  dia em que aconteceu (ADR-19), na conta de quem fez a venda ORIGINAL — quem só atendeu a
  troca não perde comissão por isso. Assim a soma da equipe fecha com o
  `faturamento_liquido` do resumo da loja, centavo por centavo.
- **Comissão** = líquido × % da pessoa, arredondada no centavo. Período só de devolução dá
  líquido e comissão negativos: é o estorno da comissão paga no mês da venda.
- Cancelada não conta: cancelar desfaz a venda inteira (estoque e caixa), e a comissão vai
  junto.
"""

from datetime import date
from decimal import ROUND_HALF_UP, Decimal

from sqlalchemy import func, literal_column, select, union_all
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.datas import dia_da_loja, hoje_na_loja
from app.core.pagination import Paginacao
from app.modules.relatorios.schemas import MeuDiaOut, PaginaVendedoras, VendedoraOut
from app.modules.relatorios.service import RelatorioService, _centavos
from app.modules.usuarios.models import User
from app.modules.vendas.models import Sale, SaleItem, SaleReturn, SaleReturnItem, StatusVenda

ZERO = Decimal("0.00")
_ZERO_SQL = literal_column("0")


def comissao_de(liquido: Decimal, percentual: Decimal) -> Decimal:
    """A conta da folha, num lugar só: líquido × % ÷ 100, meio-centavo para cima."""
    return (Decimal(liquido) * Decimal(percentual) / 100).quantize(
        Decimal("0.01"), rounding=ROUND_HALF_UP
    )


class VendedorasService:
    def __init__(self, session: AsyncSession):
        self.session = session

    async def _por_vendedora(self, inicio: date, fim: date, vendedora_id: int | None = None):
        """Uma linha por pessoa com movimento no período: (id, bruto, vendas, peças,
        devolvido, peças devolvidas).

        Cada fonte é somada por vendedora ANTES de juntar — dezenas de linhas, não as
        centenas de milhares de itens de um ano. Vendas e itens caem no índice do dia da
        loja (`ix_sales_business_date`), devoluções no `ix_sale_returns_business_date`.
        """
        vendas = (
            dia_da_loja(Sale.sold_at).between(inicio, fim),
            Sale.status == StatusVenda.CONCLUIDA,
        )
        devolucoes = (dia_da_loja(SaleReturn.returned_at).between(inicio, fim),)
        if vendedora_id is not None:
            vendas = (*vendas, Sale.seller_id == vendedora_id)
            devolucoes = (*devolucoes, Sale.seller_id == vendedora_id)

        fontes = union_all(
            select(
                Sale.seller_id.label("uid"),
                func.sum(Sale.total).label("bruto"),
                func.count().label("vendas"),
                _ZERO_SQL.label("pecas"),
                _ZERO_SQL.label("devolvido"),
                _ZERO_SQL.label("pecas_devolvidas"),
            )
            .where(*vendas)
            .group_by(Sale.seller_id),
            select(
                Sale.seller_id,
                _ZERO_SQL,
                _ZERO_SQL,
                func.sum(SaleItem.quantity),
                _ZERO_SQL,
                _ZERO_SQL,
            )
            .join(Sale, Sale.id == SaleItem.sale_id)
            .where(*vendas)
            .group_by(Sale.seller_id),
            select(
                Sale.seller_id,
                _ZERO_SQL,
                _ZERO_SQL,
                _ZERO_SQL,
                func.sum(SaleReturnItem.refund_amount),
                func.sum(SaleReturnItem.quantity),
            )
            .select_from(SaleReturnItem)
            .join(SaleReturn, SaleReturn.id == SaleReturnItem.return_id)
            .join(Sale, Sale.id == SaleReturnItem.sale_id)
            .where(*devolucoes)
            .group_by(Sale.seller_id),
        ).subquery()

        return (
            await self.session.execute(
                select(
                    fontes.c.uid,
                    func.sum(fontes.c.bruto),
                    func.sum(fontes.c.vendas),
                    func.sum(fontes.c.pecas),
                    func.sum(fontes.c.devolvido),
                    func.sum(fontes.c.pecas_devolvidas),
                ).group_by(fontes.c.uid)
            )
        ).all()

    async def relatorio(self, inicio: date, fim: date, p: Paginacao) -> PaginaVendedoras:
        RelatorioService.validar_periodo(inicio, fim)
        linhas = await self._por_vendedora(inicio, fim)

        # A equipe de uma loja cabe numa consulta: dezenas de pessoas, não milhares. Somar
        # tudo aqui e só depois recortar a página é o que deixa os totais valerem para o
        # período inteiro — a folha paga a equipe toda, não a página que está na tela.
        pessoas: dict[int, User] = {}
        if linhas:
            ids = [linha[0] for linha in linhas]
            consulta = await self.session.execute(select(User).where(User.id.in_(ids)))
            pessoas = {u.id: u for u in consulta.scalars()}

        itens: list[VendedoraOut] = []
        for uid, bruto, vendas, pecas, devolvido, pecas_dev in linhas:
            pessoa = pessoas[uid]
            bruto = _centavos(bruto)
            devolvido = _centavos(devolvido)
            liquido = bruto - devolvido
            percentual = Decimal(pessoa.comissao_percentual or 0)
            itens.append(
                VendedoraOut(
                    usuario_id=uid,
                    nome=pessoa.name,
                    comissao_percentual=percentual,
                    quantidade_vendas=int(vendas or 0),
                    faturamento=bruto,
                    devolucoes=devolvido,
                    faturamento_liquido=liquido,
                    pecas=int(pecas or 0) - int(pecas_dev or 0),
                    ticket_medio=_centavos(bruto / vendas) if vendas else ZERO,
                    comissao=comissao_de(liquido, percentual),
                )
            )
        # Quem mais trouxe primeiro; o id desempata para a página não trocar de ordem.
        itens.sort(key=lambda v: (-v.faturamento_liquido, v.nome.lower(), v.usuario_id))

        return PaginaVendedoras(
            items=itens[p.offset : p.offset + p.limit],
            total=len(itens),
            page=p.page,
            size=p.size,
            faturamento_liquido_total=sum((v.faturamento_liquido for v in itens), ZERO),
            comissao_total=sum((v.comissao for v in itens), ZERO),
        )

    async def meu_dia(self, usuario: User) -> MeuDiaOut:
        """O placar de hoje de quem está logado. Sem custo, sem lucro, sem a % — é o que a
        vendedora vê no PDV, e a conta é a MESMA do relatório do dono para aquele dia."""
        hoje = hoje_na_loja()
        linhas = await self._por_vendedora(hoje, hoje, vendedora_id=usuario.id)
        bruto = devolvido = ZERO
        vendas = pecas = 0
        for _uid, b, v, pc, d, pd in linhas:
            bruto, devolvido = _centavos(b), _centavos(d)
            vendas, pecas = int(v or 0), int(pc or 0) - int(pd or 0)
        vendido = bruto - devolvido
        meta = usuario.meta_diaria
        return MeuDiaOut(
            data=hoje,
            vendido=vendido,
            quantidade_vendas=vendas,
            pecas=pecas,
            meta=meta,
            falta=max(meta - vendido, ZERO) if meta is not None else None,
        )
