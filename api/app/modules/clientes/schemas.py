from datetime import datetime
from decimal import Decimal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.modules.vendas.models import FORMAS_DE_GAVETA, FormaPagamento


def _so_digitos(valor: str | None) -> str | None:
    """"(11) 99999-8888" e "11999998888" são a mesma pessoa — e o UNIQUE precisa saber."""
    if valor is None:
        return None
    limpo = "".join(c for c in valor if c.isdigit())
    return limpo or None


class ClienteIn(BaseModel):
    nome: str = Field(min_length=2, max_length=120)
    telefone: str | None = Field(default=None, max_length=20)
    documento: str | None = Field(default=None, max_length=20)
    limite: Decimal | None = Field(default=None, ge=0, decimal_places=2)
    observacao: str | None = Field(default=None, max_length=2000)

    _limpar_telefone = field_validator("telefone")(lambda v: _so_digitos(v))
    _limpar_documento = field_validator("documento")(lambda v: _so_digitos(v))

    @field_validator("nome")
    @classmethod
    def _limpar_nome(cls, v: str) -> str:
        return v.strip()


class ClienteUpdate(BaseModel):
    nome: str | None = Field(default=None, min_length=2, max_length=120)
    telefone: str | None = Field(default=None, max_length=20)
    documento: str | None = Field(default=None, max_length=20)
    limite: Decimal | None = Field(default=None, ge=0, decimal_places=2)
    observacao: str | None = Field(default=None, max_length=2000)

    _limpar_telefone = field_validator("telefone")(lambda v: _so_digitos(v))
    _limpar_documento = field_validator("documento")(lambda v: _so_digitos(v))


class ClienteOut(BaseModel):
    model_config = ConfigDict(from_attributes=True, populate_by_name=True)

    id: int
    nome: str = Field(validation_alias="name")
    telefone: str | None = Field(default=None, validation_alias="phone")
    documento: str | None = Field(default=None, validation_alias="document")
    limite: Decimal | None = Field(default=None, validation_alias="credit_limit")
    observacao: str | None = Field(default=None, validation_alias="note")
    ativo: bool = True
    #: Quanto está devendo agora. Vem calculado; não existe coluna guardando isto, porque
    #: saldo guardado é saldo que sai do lugar quando alguém esquece de atualizar.
    deve: Decimal = Decimal("0.00")
    #: Deve mais do que o combinado. Avisa, não bloqueia (ADR-20).
    acima_do_limite: bool = False


class PagamentoClienteIn(BaseModel):
    forma: FormaPagamento
    valor: Decimal = Field(gt=0, decimal_places=2)
    observacao: str | None = Field(default=None, max_length=500)
    #: Receber com o sinal caindo é exatamente onde o retry duplica — e aqui duplicar
    #: significa perdoar uma dívida que ninguém pagou.
    client_uuid: UUID

    @field_validator("forma")
    @classmethod
    def _so_gaveta(cls, v: FormaPagamento) -> FormaPagamento:
        # Receber fiado "com fiado" seria mover a dívida de lugar, não quitá-la; receber
        # "com vale" seria a loja pagando a própria dívida a receber.
        if v not in FORMAS_DE_GAVETA:
            raise ValueError("Pagamento de fiado entra em dinheiro, PIX, débito ou crédito.")
        return v


class PagamentoClienteOut(BaseModel):
    model_config = ConfigDict(from_attributes=True, populate_by_name=True)

    id: int
    cliente_id: int = Field(validation_alias="customer_id")
    forma: FormaPagamento = Field(validation_alias="method")
    valor: Decimal = Field(validation_alias="amount")
    pago_em: datetime = Field(validation_alias="paid_at")
    observacao: str | None = Field(default=None, validation_alias="note")


class VendaEmAbertoOut(BaseModel):
    """Uma venda que ficou (parcialmente) no fiado, na conta do cliente."""

    venda_id: int
    vendida_em: datetime
    total_da_venda: Decimal
    no_fiado: Decimal


class ExtratoClienteOut(BaseModel):
    cliente: ClienteOut
    vendas: list[VendaEmAbertoOut]
    pagamentos: list[PagamentoClienteOut]
    total_fiado: Decimal
    total_pago: Decimal
    total_devolvido: Decimal
    deve: Decimal
