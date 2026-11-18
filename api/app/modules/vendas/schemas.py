import uuid
from datetime import datetime
from decimal import Decimal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.modules.taxas.models import MAX_PARCELAS
from app.modules.vendas.models import FormaPagamento, StatusVenda


class ItemVendaIn(BaseModel):
    """Só a peça e a quantidade: o preço quem decide é o servidor (ADR-4)."""

    variante_id: int
    quantidade: int = Field(gt=0, le=999)


class PagamentoIn(BaseModel):
    forma: FormaPagamento
    valor: Decimal = Field(gt=0, decimal_places=2)
    #: Obrigatório quando a forma é VALE. Quem decide quanto o vale cobre é o servidor
    #: (ADR-4) — o app manda o código, não o crédito.
    codigo_vale: str | None = Field(default=None, max_length=16)
    #: Em quantas vezes no crédito. Toda outra forma é 1 — e o banco também recusa (ADR-35).
    parcelas: int = Field(default=1, ge=1, le=MAX_PARCELAS)
    #: Visa, Mastercard, Elo… Opcional, só no cartão. Não muda a taxa: serve para conferir o
    #: extrato da credenciadora.
    bandeira: str | None = Field(default=None, max_length=20)

    @field_validator("bandeira")
    @classmethod
    def _limpar_bandeira(cls, v: str | None) -> str | None:
        return (v or "").strip() or None

    @model_validator(mode="after")
    def _vale_tem_codigo(self) -> "PagamentoIn":
        if self.forma == FormaPagamento.VALE and not self.codigo_vale:
            raise ValueError("Pagamento em vale precisa do código do vale.")
        if self.forma != FormaPagamento.VALE and self.codigo_vale:
            raise ValueError("Código de vale só faz sentido em pagamento com vale.")
        if self.parcelas > 1 and self.forma != FormaPagamento.CREDITO:
            raise ValueError("Só o crédito parcela.")
        if self.bandeira and self.forma not in (FormaPagamento.DEBITO, FormaPagamento.CREDITO):
            raise ValueError("Bandeira só existe em pagamento no cartão.")
        return self


class VendaIn(BaseModel):
    client_uuid: uuid.UUID = Field(
        description="UUID gerado no app ao abrir a venda. Reenvio não duplica."
    )
    desconto: Decimal = Field(default=Decimal("0"), ge=0, decimal_places=2)
    observacao: str | None = Field(default=None, max_length=500)
    itens: list[ItemVendaIn] = Field(min_length=1, max_length=200)
    pagamentos: list[PagamentoIn] = Field(min_length=1, max_length=4)
    #: Obrigatório quando algum pagamento é FIADO. Dívida sem nome não se cobra — e o
    #: banco também recusa (CHECK `fiado_tem_cliente`).
    cliente_id: int | None = None

    @model_validator(mode="after")
    def _fiado_tem_cliente(self) -> "VendaIn":
        tem_fiado = any(p.forma == FormaPagamento.FIADO for p in self.pagamentos)
        if tem_fiado and self.cliente_id is None:
            raise ValueError("Venda no fiado precisa dizer de quem é a dívida.")
        return self

    @field_validator("itens")
    @classmethod
    def _agrupar_repetidos(cls, v: list[ItemVendaIn]) -> list[ItemVendaIn]:
        ids = [i.variante_id for i in v]
        if len(ids) != len(set(ids)):
            raise ValueError("A mesma peça aparece duas vezes: some as quantidades.")
        return v


class CancelamentoIn(BaseModel):
    motivo: str = Field(min_length=3, max_length=300)


class ItemVendaOut(BaseModel):
    id: int
    variante_id: int
    produto: str
    tamanho: str
    cor: str
    codigo_barras: str
    quantidade: int
    #: Quanto desta linha já voltou. É o que a tela de devolução usa para não oferecer de
    #: novo uma peça que já foi devolvida.
    quantidade_devolvida: int = 0
    preco_unitario: Decimal
    total_item: Decimal


class ItemVendaAdminOut(ItemVendaOut):
    custo_unitario: Decimal


class PagamentoOut(BaseModel):
    forma: FormaPagamento
    valor: Decimal
    parcelas: int = 1
    bandeira: str | None = None


class PagamentoAdminOut(PagamentoOut):
    """Quem vê dinheiro vê também quanto a maquininha ficou deste pagamento (ADR-35)."""

    #: A taxa do dia da venda, fotografada — não a da tabela de hoje.
    taxa_percentual: Decimal = Decimal("0.00")
    #: `valor × taxa_percentual`, em centavos arredondados.
    taxa: Decimal = Decimal("0.00")


class VendaOut(BaseModel):
    id: int
    status: StatusVenda
    vendedor_id: int
    vendedor: str
    subtotal: Decimal
    desconto: Decimal
    total: Decimal
    quantidade_pecas: int
    vendida_em: datetime
    cancelada_em: datetime | None = None
    motivo_cancelamento: str | None = None
    observacao: str | None = None
    itens: list[ItemVendaOut]
    pagamentos: list[PagamentoOut]
    #: Nome de quem comprou, quando a venda tem fiado ou foi nominal.
    cliente: str | None = None
    cliente_id: int | None = None


class VendaAdminOut(VendaOut):
    """O admin enxerga o custo congelado e, com ele, o lucro daquela venda."""

    itens: list[ItemVendaAdminOut]
    pagamentos: list[PagamentoAdminOut]
    custo_total: Decimal
    lucro_bruto: Decimal
    #: Soma das taxas da maquininha dos pagamentos desta venda. O `lucro_bruto` NÃO a
    #: desconta (é preço menos custo, como no resumo); quem desconta é o Resultado.
    taxas_cartao: Decimal = Decimal("0.00")


class VendaResumoOut(BaseModel):
    """Linha da lista de vendas — leve, sem carregar itens."""

    id: int
    status: StatusVenda
    vendedor: str
    total: Decimal
    quantidade_pecas: int
    vendida_em: datetime
    formas_pagamento: list[FormaPagamento]


# ---------------------------------------------------------------- devolução
class ItemDevolucaoIn(BaseModel):
    #: `id` da LINHA da venda, não da variante: a mesma peça pode aparecer duas vezes numa
    #: venda (com preços diferentes, se o preço mudou entre um bipe e outro).
    item_id: int
    quantidade: int = Field(gt=0)
    #: Peça com defeito não volta para a arara — e o custo dela continua sendo custo.
    voltar_ao_estoque: bool = True


class DevolucaoIn(BaseModel):
    itens: list[ItemDevolucaoIn] = Field(min_length=1)
    motivo: str | None = Field(default=None, max_length=500)
    client_uuid: UUID

    @field_validator("itens")
    @classmethod
    def _sem_repetir(cls, v: list[ItemDevolucaoIn]) -> list[ItemDevolucaoIn]:
        vistos = {i.item_id for i in v}
        if len(vistos) != len(v):
            raise ValueError("A mesma peça aparece duas vezes na devolução.")
        return v


class ItemDevolvidoOut(BaseModel):
    item_id: int
    variante_id: int
    produto: str
    tamanho: str
    cor: str
    codigo_barras: str
    quantidade: int
    preco_unitario: Decimal
    valor_devolvido: Decimal
    voltou_ao_estoque: bool


class PagamentoDevolucaoOut(BaseModel):
    forma: FormaPagamento
    valor: Decimal
    #: Preenchido quando a devolução virou vale — é o código que a cliente leva no papel.
    codigo_vale: str | None = None


class DevolucaoOut(BaseModel):
    id: int
    venda_id: int
    devolvida_em: datetime
    motivo: str | None
    total: Decimal
    itens: list[ItemDevolvidoOut]
    pagamentos: list[PagamentoDevolucaoOut]


class ValeOut(BaseModel):
    model_config = ConfigDict(from_attributes=True, populate_by_name=True)

    id: int
    codigo: str = Field(validation_alias="code")
    valor: Decimal = Field(validation_alias="value")
    usado: Decimal = Field(validation_alias="used_value")
    saldo: Decimal = Decimal("0.00")
    vence_em: datetime | None = Field(default=None, validation_alias="expires_at")
