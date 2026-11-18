from datetime import date, datetime
from decimal import Decimal
from enum import StrEnum
from uuid import UUID

from pydantic import BaseModel, Field, field_validator

from app.modules.condicionais.models import StatusCondicional
from app.modules.vendas.schemas import PagamentoIn


class ItemCondicionalIn(BaseModel):
    variante_id: int
    #: O mesmo teto do item de venda: o que ficar com a cliente vira item de venda.
    quantidade: int = Field(gt=0, le=999)


class CondicionalIn(BaseModel):
    client_uuid: UUID = Field(description="Reenvio com a mesma chave não tira a peça duas vezes.")
    cliente_id: int
    prazo: date = Field(description="Último dia para a cliente devolver ou ficar com as peças.")
    observacao: str | None = Field(default=None, max_length=500)
    itens: list[ItemCondicionalIn] = Field(min_length=1, max_length=100)

    @field_validator("itens")
    @classmethod
    def _sem_repetir(cls, v: list[ItemCondicionalIn]) -> list[ItemCondicionalIn]:
        ids = [i.variante_id for i in v]
        if len(ids) != len(set(ids)):
            raise ValueError("A mesma peça aparece duas vezes: some as quantidades.")
        return v


class ItemFechamentoIn(BaseModel):
    variante_id: int
    #: Quantas peças desta voltaram. O resto ficou com a cliente — e vira venda.
    devolvida: int = Field(ge=0)


class FechamentoIn(BaseModel):
    """O que voltou de cada peça e, se algo ficou, como a cliente pagou.

    Toda peça da condicional vem na lista, mesmo a que voltou inteira: fechar é conferir a
    sacola peça por peça, e uma peça esquecida na lista seria cobrada ou devolvida sem
    ninguém ter olhado.
    """

    client_uuid: UUID = Field(
        description="Chave do fechamento — e da venda dele. Reenvio não cobra duas vezes."
    )
    itens: list[ItemFechamentoIn] = Field(min_length=1, max_length=100)
    desconto: Decimal = Field(default=Decimal("0"), ge=0, decimal_places=2)
    #: Os pagamentos do PDV, com as mesmas regras (vale, fiado só para o crediário...).
    pagamentos: list[PagamentoIn] = Field(default_factory=list, max_length=4)
    observacao: str | None = Field(default=None, max_length=300)

    @field_validator("itens")
    @classmethod
    def _sem_repetir(cls, v: list[ItemFechamentoIn]) -> list[ItemFechamentoIn]:
        ids = [i.variante_id for i in v]
        if len(ids) != len(set(ids)):
            raise ValueError("A mesma peça aparece duas vezes no fechamento.")
        return v


class FiltroCondicionais(StrEnum):
    ABERTAS = "abertas"
    VENCIDAS = "vencidas"
    FECHADAS = "fechadas"
    TODAS = "todas"


class ItemCondicionalOut(BaseModel):
    variante_id: int
    produto: str
    tamanho: str
    cor: str
    codigo_barras: str
    #: Preço de venda de HOJE: é por ele que o que ficar será cobrado (ADR-4).
    preco_venda: Decimal
    quantidade: int
    devolvida: int | None = None
    ficou: int | None = None


class CondicionalOut(BaseModel):
    """Sem custo nem margem: a condicional é do balcão, e o balcão não vê dinheiro da loja."""

    id: int
    status: StatusCondicional
    cliente_id: int
    cliente: str
    #: Para ligar e lembrar a cliente do prazo — é o trabalho da lista de vencidas.
    cliente_telefone: str | None = None
    vendedora_id: int
    vendedora: str
    prazo: date
    vencida: bool
    #: Dias até o prazo, no dia da loja (negativo = atrasada). Só faz sentido aberta.
    dias_para_vencer: int
    observacao: str | None = None
    criada_em: datetime
    fechada_em: datetime | None = None
    fechada_por: str | None = None
    venda_id: int | None = None
    itens: list[ItemCondicionalOut]
    total_pecas: int
    #: Quanto valem as peças pelo preço de venda de hoje.
    valor_pecas: Decimal
