from datetime import date, datetime
from decimal import Decimal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.core.datas import hoje_na_loja
from app.core.pagination import Pagina
from app.modules.vendas.models import FORMAS_DE_GAVETA, FormaPagamento


def _so_digitos(valor: str | None) -> str | None:
    """"(11) 99999-8888" e "11999998888" são a mesma pessoa — e o UNIQUE precisa saber."""
    if valor is None:
        return None
    limpo = "".join(c for c in valor if c.isdigit())
    return limpo or None


def _conferir_nascimento(v: date | None) -> date | None:
    """Data de nascimento no futuro (ou em 1825) é erro de digitação, não cliente."""
    if v is not None and (v > hoje_na_loja() or v.year < 1900):
        raise ValueError("Data de nascimento fora do possível.")
    return v


def _limpar_texto(v: str | None) -> str | None:
    return (v or "").strip() or None


class ClienteIn(BaseModel):
    nome: str = Field(min_length=2, max_length=120)
    telefone: str | None = Field(default=None, max_length=20)
    documento: str | None = Field(default=None, max_length=20)
    limite: Decimal | None = Field(default=None, ge=0, decimal_places=2)
    observacao: str | None = Field(default=None, max_length=2000)
    nascimento: date | None = None
    preferencias: str | None = Field(default=None, max_length=200)

    _limpar_telefone = field_validator("telefone")(lambda v: _so_digitos(v))
    _limpar_documento = field_validator("documento")(lambda v: _so_digitos(v))
    _conferir_nascimento = field_validator("nascimento")(lambda v: _conferir_nascimento(v))
    _limpar_preferencias = field_validator("preferencias")(lambda v: _limpar_texto(v))

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
    nascimento: date | None = None
    preferencias: str | None = Field(default=None, max_length=200)

    _limpar_telefone = field_validator("telefone")(lambda v: _so_digitos(v))
    _limpar_documento = field_validator("documento")(lambda v: _so_digitos(v))
    _conferir_nascimento = field_validator("nascimento")(lambda v: _conferir_nascimento(v))
    # Aqui vazio NÃO vira nulo: nulo é "não mexe", e "" é como a tela apaga a preferência.
    _aparar_preferencias = field_validator("preferencias")(
        lambda v: v.strip() if v is not None else None
    )


class ClienteOut(BaseModel):
    model_config = ConfigDict(from_attributes=True, populate_by_name=True)

    id: int
    nome: str = Field(validation_alias="name")
    telefone: str | None = Field(default=None, validation_alias="phone")
    documento: str | None = Field(default=None, validation_alias="document")
    limite: Decimal | None = Field(default=None, validation_alias="credit_limit")
    observacao: str | None = Field(default=None, validation_alias="note")
    nascimento: date | None = None
    preferencias: str | None = None
    ativo: bool = True
    #: Quanto está devendo agora. Vem calculado; não existe coluna guardando isto, porque
    #: saldo guardado é saldo que sai do lugar quando alguém esquece de atualizar.
    deve: Decimal = Decimal("0.00")
    #: Deve mais do que o combinado. Avisa, não bloqueia (ADR-20).
    acima_do_limite: bool = False


class ClienteBalcaoIn(BaseModel):
    """O cadastro de balcão: quem é a cliente, nada do crediário (ADR-36).

    Sem limite, sem CPF, sem observação: limite é decisão de crédito, e a observação do
    crediário guarda combinados de pagamento ("paga todo dia 10") que não são do balcão.
    """

    nome: str = Field(min_length=2, max_length=120)
    telefone: str | None = Field(default=None, max_length=20)
    nascimento: date | None = None
    preferencias: str | None = Field(default=None, max_length=200)
    #: A vendedora tocou "cadastrar", a rede caiu depois de gravar, e ela tocou de novo:
    #: a mesma chave devolve o mesmo cadastro, em vez de a cliente nascer duas vezes.
    client_uuid: UUID

    _limpar_telefone = field_validator("telefone")(lambda v: _so_digitos(v))
    _conferir_nascimento = field_validator("nascimento")(lambda v: _conferir_nascimento(v))
    _limpar_preferencias = field_validator("preferencias")(lambda v: _limpar_texto(v))

    @field_validator("nome")
    @classmethod
    def _limpar_nome(cls, v: str) -> str:
        return v.strip()


class ClienteBalcaoOut(BaseModel):
    """O que o balcão enxerga da cliente: quem ela é e do que gosta.

    Schema próprio, sem herdar de `ClienteOut`, de propósito: herdar traria `deve`,
    `limite` e `acima_do_limite` para a tela da vendedora no primeiro campo novo que
    alguém pusesse lá. O corte é no servidor, não na tela (ADR-5).
    """

    model_config = ConfigDict(from_attributes=True, populate_by_name=True)

    id: int
    nome: str = Field(validation_alias="name")
    telefone: str | None = Field(default=None, validation_alias="phone")
    nascimento: date | None = None
    preferencias: str | None = None


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
    #: As duas listas são paginadas pelo MESMO `?page=&size=` — "carregar mais" traz a
    #: próxima leva das duas. Os totais abaixo são da conta inteira, nunca da página.
    vendas: Pagina[VendaEmAbertoOut]
    pagamentos: Pagina[PagamentoClienteOut]
    total_fiado: Decimal
    total_pago: Decimal
    total_devolvido: Decimal
    deve: Decimal
