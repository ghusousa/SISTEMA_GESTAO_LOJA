from datetime import date
from decimal import Decimal

from pydantic import BaseModel


class ResumoOut(BaseModel):
    """O resultado do período: quanto entrou, quanto custou e quanto sobrou."""

    inicio: date
    fim: date
    faturamento: Decimal
    custo_mercadoria_vendida: Decimal
    lucro_bruto: Decimal
    despesas: Decimal
    resultado: Decimal
    margem_bruta_pct: Decimal
    quantidade_vendas: int
    quantidade_pecas: int
    ticket_medio: Decimal
    vendas_canceladas: int


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
