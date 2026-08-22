import uuid
from datetime import datetime
from decimal import Decimal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.modules.estoque.models import TipoMovimento


# ---------------------------------------------------------------- entrada
class ItemEntradaIn(BaseModel):
    variante_id: int
    quantidade: int = Field(gt=0)
    # Informar o custo aqui atualiza o custo da peça: reposição costuma vir mais cara.
    custo_unitario: Decimal | None = Field(default=None, ge=0, decimal_places=2)


class EntradaIn(BaseModel):
    client_uuid: uuid.UUID = Field(
        description="UUID gerado no app. Reenvio da mesma entrada não duplica estoque."
    )
    fornecedor: str | None = Field(default=None, max_length=120)
    observacao: str | None = Field(default=None, max_length=2000)
    itens: list[ItemEntradaIn] = Field(min_length=1)

    @field_validator("itens")
    @classmethod
    def _sem_variante_repetida(cls, v: list[ItemEntradaIn]) -> list[ItemEntradaIn]:
        ids = [i.variante_id for i in v]
        if len(ids) != len(set(ids)):
            raise ValueError("A mesma peça aparece duas vezes: some as quantidades.")
        return v


class EntradaOut(BaseModel):
    id: int
    fornecedor: str | None
    observacao: str | None
    criada_em: datetime
    itens: list["MovimentoOut"]
    total_pecas: int


# ---------------------------------------------------------------- ajuste
class AjusteIn(BaseModel):
    variante_id: int
    quantidade: int = Field(description="Com sinal: positivo entra, negativo sai. Zero é inválido.")
    motivo: str = Field(min_length=3, max_length=300)

    @field_validator("quantidade")
    @classmethod
    def _nao_zero(cls, v: int) -> int:
        if v == 0:
            raise ValueError("Ajuste de zero peça não altera nada.")
        return v


# ---------------------------------------------------------------- inventário
class ContagemIn(BaseModel):
    variante_id: int
    quantidade_contada: int = Field(ge=0)


class InventarioIn(BaseModel):
    observacao: str | None = Field(default=None, max_length=2000)
    contagens: list[ContagemIn] = Field(min_length=1)

    @field_validator("contagens")
    @classmethod
    def _sem_repeticao(cls, v: list[ContagemIn]) -> list[ContagemIn]:
        ids = [c.variante_id for c in v]
        if len(ids) != len(set(ids)):
            raise ValueError("A mesma peça foi contada duas vezes.")
        return v


class DiferencaInventario(BaseModel):
    variante_id: int
    codigo_barras: str
    produto: str
    tamanho: str
    cor: str
    saldo_sistema: int
    quantidade_contada: int
    diferenca: int


class InventarioOut(BaseModel):
    conferidas: int
    ajustadas: int
    diferenca_total: int
    diferencas: list[DiferencaInventario]


# ---------------------------------------------------------------- leitura
class MovimentoOut(BaseModel):
    model_config = ConfigDict(from_attributes=True, populate_by_name=True)

    id: int
    variante_id: int = Field(validation_alias="variant_id")
    tipo: TipoMovimento = Field(validation_alias="movement_type")
    quantidade: int = Field(validation_alias="quantity")
    saldo_apos: int = Field(validation_alias="balance_after")
    venda_id: int | None = Field(default=None, validation_alias="sale_id")
    entrada_id: int | None = Field(default=None, validation_alias="entry_id")
    usuario_id: int = Field(validation_alias="user_id")
    observacao: str | None = Field(default=None, validation_alias="note")
    criado_em: datetime = Field(validation_alias="created_at")
    # Preenchidos na listagem para a tela não precisar de outra chamada.
    produto: str | None = None
    tamanho: str | None = None
    cor: str | None = None
    codigo_barras: str | None = None
    usuario: str | None = None


class SaldoOut(BaseModel):
    variante_id: int
    produto_id: int
    produto: str
    categoria: str
    tamanho: str
    cor: str
    codigo_barras: str
    preco_venda: Decimal
    saldo: int
    estoque_minimo: int
    estoque_baixo: bool


class SaldoAdminOut(SaldoOut):
    preco_custo: Decimal
    valor_em_custo: Decimal


EntradaOut.model_rebuild()
