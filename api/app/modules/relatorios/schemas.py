from datetime import date
from decimal import Decimal

from pydantic import BaseModel


class ResumoOut(BaseModel):
    """O resultado do período: quanto entrou, quanto custou e quanto sobrou."""

    inicio: date
    fim: date
    #: O que foi vendido no período, antes de descontar o que voltou.
    faturamento: Decimal
    #: O que voltou pela porta — reconhecido no dia da DEVOLUÇÃO, não no da venda.
    #: Aparece separado de propósito: taxa de devolução é sinal de gestão (fornecedor
    #: ruim, grade errada, foto que engana), e somada em silêncio ao faturamento ela fica
    #: invisível exatamente para quem precisaria agir.
    devolucoes: Decimal = Decimal("0.00")
    #: `faturamento - devolucoes`. É este que fecha com o dinheiro.
    faturamento_liquido: Decimal = Decimal("0.00")
    custo_mercadoria_vendida: Decimal
    #: Custo das peças que voltaram E foram para a arara de novo. Peça com defeito não
    #: entra aqui: ela continua sendo custo da loja, porque de fato foi perdida.
    cmv_devolvido: Decimal = Decimal("0.00")
    lucro_bruto: Decimal
    despesas: Decimal
    resultado: Decimal
    #: Sobre o faturamento BRUTO, com o denominador bruto — misturar numerador líquido com
    #: denominador bruto é o erro que faz a margem parecer o que não é.
    margem_bruta_pct: Decimal
    quantidade_vendas: int
    quantidade_pecas: int
    pecas_devolvidas: int = 0
    ticket_medio: Decimal
    vendas_canceladas: int
    #: Quanto saiu no fiado no período (é faturamento, mas ainda não é dinheiro).
    vendas_a_prazo: Decimal = Decimal("0.00")
    #: Fiado recebido no período (é dinheiro, mas não é venda deste período).
    recebimentos_de_fiado: Decimal = Decimal("0.00")


class DiaVendaOut(BaseModel):
    data: date
    faturamento: Decimal
    quantidade_vendas: int
    quantidade_pecas: int


class MaisVendidoOut(BaseModel):
    variante_id: int
    produto: str
    tamanho: str
    cor: str
    codigo_barras: str
    quantidade: int
    faturamento: Decimal
    lucro_bruto: Decimal


class DespesaCategoriaOut(BaseModel):
    categoria_id: int
    categoria: str
    total: Decimal
    percentual: Decimal
    quantidade: int


class EstoqueBaixoOut(BaseModel):
    variante_id: int
    produto: str
    tamanho: str
    cor: str
    codigo_barras: str
    saldo: int
    estoque_minimo: int
    faltam: int
    preco_custo: Decimal
