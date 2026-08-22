from datetime import date, datetime
from decimal import Decimal

from pydantic import BaseModel, Field

from app.modules.vendas.models import FormaPagamento


class ContagemIn(BaseModel):
    forma: FormaPagamento
    valor_contado: Decimal = Field(ge=0, decimal_places=2)


class FechamentoIn(BaseModel):
    data: date
    contagens: list[ContagemIn] = Field(min_length=1)
    observacao: str | None = Field(default=None, max_length=2000)


class LinhaCaixa(BaseModel):
    forma: FormaPagamento
    esperado: Decimal
    contado: Decimal | None = None
    diferenca: Decimal | None = None


class DiaCaixaOut(BaseModel):
    """O que o sistema esperava receber no dia, por forma de pagamento."""

    data: date
    linhas: list[LinhaCaixa]
    total_esperado: Decimal
    quantidade_vendas: int
    quantidade_canceladas: int
    fechado: bool
    fechamento_id: int | None = None


class FechamentoOut(BaseModel):
    id: int
    data: date
    fechado_por: str
    fechado_em: datetime
    linhas: list[LinhaCaixa]
    total_esperado: Decimal
    total_contado: Decimal
    diferenca: Decimal
    observacao: str | None = None
