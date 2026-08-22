import uuid
from datetime import datetime
from decimal import Decimal

from pydantic import BaseModel, Field, field_validator

from app.modules.vendas.models import FormaPagamento, StatusVenda


class ItemVendaIn(BaseModel):
    """Só a peça e a quantidade: o preço quem decide é o servidor (ADR-4)."""

    variante_id: int
    quantidade: int = Field(gt=0, le=999)


class PagamentoIn(BaseModel):
    forma: FormaPagamento
    valor: Decimal = Field(gt=0, decimal_places=2)


class VendaIn(BaseModel):
    client_uuid: uuid.UUID = Field(
        description="UUID gerado no app ao abrir a venda. Reenvio não duplica."
    )
    desconto: Decimal = Field(default=Decimal("0"), ge=0, decimal_places=2)
    observacao: str | None = Field(default=None, max_length=500)
    itens: list[ItemVendaIn] = Field(min_length=1, max_length=200)
    pagamentos: list[PagamentoIn] = Field(min_length=1, max_length=4)

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
    preco_unitario: Decimal
    total_item: Decimal


class ItemVendaAdminOut(ItemVendaOut):
    custo_unitario: Decimal


class PagamentoOut(BaseModel):
    forma: FormaPagamento
    valor: Decimal


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


class VendaAdminOut(VendaOut):
    """O admin enxerga o custo congelado e, com ele, o lucro daquela venda."""

    itens: list[ItemVendaAdminOut]
    custo_total: Decimal
    lucro_bruto: Decimal


class VendaResumoOut(BaseModel):
    """Linha da lista de vendas — leve, sem carregar itens."""

    id: int
    status: StatusVenda
    vendedor: str
    total: Decimal
    quantidade_pecas: int
    vendida_em: datetime
    formas_pagamento: list[FormaPagamento]
