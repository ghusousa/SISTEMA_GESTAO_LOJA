from datetime import date, datetime
from decimal import Decimal

from pydantic import BaseModel, Field, field_validator

from app.modules.vendas.models import FORMAS_DE_GAVETA, FormaPagamento


class ContagemIn(BaseModel):
    forma: FormaPagamento
    valor_contado: Decimal = Field(ge=0, decimal_places=2)

    @field_validator("forma")
    @classmethod
    def _so_gaveta(cls, v: FormaPagamento) -> FormaPagamento:
        """Contar VALE ou FIADO é contar o que não está na gaveta.

        A validação vive aqui para o erro sair 422 com recado legível, em vez de 500 pelo
        CHECK de `cash_closing_lines` — que é a rede, não a porta.
        """
        if v not in FORMAS_DE_GAVETA:
            raise ValueError("Só dinheiro, PIX, débito e crédito entram na conferência do caixa.")
        return v


class FechamentoIn(BaseModel):
    data: date
    contagens: list[ContagemIn] = Field(min_length=1)
    observacao: str | None = Field(default=None, max_length=2000)


class LinhaCaixa(BaseModel):
    """O esperado do dia, aberto nas três coisas que o compõem.

    Um número só não explica nada a quem está com a gaveta aberta: "esperado R$ 1.240" com
    R$ 1.400 contados vira briga. Aberto — vendeu 1.500, devolveu 300, recebeu 40 de fiado
    — a conferência é uma conversa de dez segundos.
    """

    forma: FormaPagamento
    #: O que as vendas do dia trouxeram nesta forma.
    vendas: Decimal = Decimal("0.00")
    #: O que saiu de volta em devolução nesta forma, HOJE (dia da devolução, não da venda).
    devolucoes: Decimal = Decimal("0.00")
    #: Fiado que a cliente veio pagar hoje. Não é venda de hoje, mas é dinheiro de hoje.
    recebimentos_de_fiado: Decimal = Decimal("0.00")
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
