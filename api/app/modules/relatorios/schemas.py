from datetime import date, datetime
from decimal import Decimal

from pydantic import BaseModel

from app.core.pagination import Pagina


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
    #: O que a maquininha ficou das vendas no cartão do período, já abatida a taxa da parte
    #: devolvida no período (ADR-35). Sai do resultado: é custo de receber, não de vender.
    taxas_cartao: Decimal = Decimal("0.00")
    #: `lucro_bruto - despesas - taxas_cartao`.
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


class RecebivelOut(BaseModel):
    """Quanto cai na conta num dia: o bruto das parcelas, a taxa e o que sobra (ADR-35).

    Estorno no cartão aparece no dia da devolução, com valores negativos.
    """

    data: date
    bruto: Decimal
    taxa: Decimal
    liquido: Decimal


# ------------------------------------------------------------------ equipe (ADR-37)


class VendedoraOut(BaseModel):
    """O período de uma pessoa da equipe, já com as devoluções abatidas.

    A devolução entra no dia em que ACONTECEU (ADR-19) e pesa para quem fez a venda
    original, não para quem atendeu a troca: a comissão paga sobre a blusa que voltou é
    estornada no mês em que ela voltou. Por isso o líquido pode ficar negativo num período
    só de devoluções — e a comissão, também: é o estorno.
    """

    usuario_id: int
    nome: str
    #: A % de HOJE (a que o dono configurou), que vale para as vendas novas. Não é,
    #: necessariamente, a da `comissao` abaixo: cada venda guarda a sua (ADR-37).
    comissao_percentual: Decimal
    quantidade_vendas: int
    #: Vendas concluídas no período, com desconto. Cancelada não conta.
    faturamento: Decimal
    #: O que voltou no período, das vendas dela (de qualquer época).
    devolucoes: Decimal
    #: `faturamento - devolucoes`: a base da comissão.
    faturamento_liquido: Decimal
    #: Peças vendidas menos as que voltaram no período.
    pecas: int
    #: Faturamento ÷ número de vendas — a mesma conta do resumo da loja.
    ticket_medio: Decimal
    #: Σ (total da venda × % DA VENDA) − Σ (devolvido × % da venda ORIGINAL), ÷ 100,
    #: arredondado uma vez no centavo. Com a % mudada no período, não é
    #: `faturamento_liquido × comissao_percentual` — a venda de antes leva a % de antes.
    comissao: Decimal


class PaginaVendedoras(Pagina[VendedoraOut]):
    """A página e os totais do PERÍODO INTEIRO — a folha soma a equipe toda, não a página."""

    faturamento_liquido_total: Decimal
    comissao_total: Decimal


class MeuDiaOut(BaseModel):
    """O dia de quem está logado, sem custo nem lucro: é o que a vendedora vê no PDV."""

    data: date
    #: Vendido hoje menos o que voltou hoje das vendas dela — a mesma base da comissão.
    vendido: Decimal
    quantidade_vendas: int
    pecas: int
    #: `null` quando o dono não definiu meta: o PDV não mostra a régua.
    meta: Decimal | None = None
    #: Quanto falta para a meta (zero quando já bateu). `null` sem meta.
    falta: Decimal | None = None


# ------------------------------------------------------- giro do estoque (ADR-38)


class EstoqueParadoOut(BaseModel):
    variante_id: int
    produto_id: int
    produto: str
    tamanho: str
    cor: str
    codigo_barras: str
    saldo: int
    #: Última venda desta peça (movimento VENDA). `null` = nunca vendeu.
    ultima_venda: datetime | None
    #: Última entrada de mercadoria. `null` = o saldo veio de outro caminho (cadastro
    #: antigo, ajuste, inventário) — aí a conta começa no cadastro da peça.
    ultima_entrada: datetime | None
    #: Dias no calendário da loja desde a última venda (ou, sem venda, desde a última
    #: entrada; sem as duas, desde o cadastro).
    dias_parada: int
    preco_custo: Decimal
    preco_venda: Decimal
    #: `saldo × custo`: o dinheiro da loja que está parado nesta arara.
    valor_em_custo: Decimal
    #: `saldo × preço de venda`: quanto entraria se tudo vendesse pelo preço cheio.
    valor_em_venda: Decimal


class PaginaEstoqueParado(Pagina[EstoqueParadoOut]):
    """A página e os totais de TODAS as peças paradas, não só das desta página."""

    dias: int
    pecas_total: int
    valor_em_custo_total: Decimal
    valor_em_venda_total: Decimal


class CurvaAbcOut(BaseModel):
    produto_id: int
    produto: str
    pecas: int
    #: Vendido no período (com o desconto da venda rateado) menos o devolvido no período.
    faturamento_liquido: Decimal
    #: Fatia deste produto no faturamento líquido do período.
    percentual: Decimal
    #: Soma das fatias até este produto, inclusive.
    percentual_acumulado: Decimal
    #: A: os que juntos fazem os primeiros 80% · B: até 95% · C: o resto.
    classe: str


class ValorEstoqueOut(BaseModel):
    """A loja inteira, agora — não a página de uma listagem."""

    pecas: int
    #: Quantas variantes (tamanho × cor) têm ao menos uma peça.
    variantes: int
    valor_em_custo: Decimal
    valor_em_venda: Decimal
