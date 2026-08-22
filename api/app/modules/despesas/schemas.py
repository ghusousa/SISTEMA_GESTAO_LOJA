import re
from datetime import date, datetime
from decimal import Decimal

from pydantic import BaseModel, ConfigDict, Field, field_validator

COMPETENCIA = re.compile(r"^\d{4}-(0[1-9]|1[0-2])$")


class CategoriaDespesaIn(BaseModel):
    nome: str = Field(min_length=2, max_length=80)

    @field_validator("nome")
    @classmethod
    def _limpar(cls, v: str) -> str:
        return v.strip()


class CategoriaDespesaOut(BaseModel):
    model_config = ConfigDict(from_attributes=True, populate_by_name=True)

    id: int
    nome: str = Field(validation_alias="name")
    criada_em: datetime = Field(validation_alias="created_at")


class DespesaIn(BaseModel):
    categoria_id: int
    descricao: str = Field(min_length=2, max_length=160)
    valor: Decimal = Field(gt=0, decimal_places=2)
    data: date
    recorrente: bool = Field(
        default=False, description="Marque contas que se repetem todo mês (aluguel, internet)."
    )
    observacao: str | None = Field(default=None, max_length=2000)

    @field_validator("descricao")
    @classmethod
    def _limpar(cls, v: str) -> str:
        return v.strip()


class DespesaUpdate(BaseModel):
    categoria_id: int | None = None
    descricao: str | None = Field(default=None, min_length=2, max_length=160)
    valor: Decimal | None = Field(default=None, gt=0, decimal_places=2)
    data: date | None = None
    recorrente: bool | None = None
    observacao: str | None = Field(default=None, max_length=2000)


class DespesaOut(BaseModel):
    id: int
    categoria_id: int
    categoria: str
    descricao: str
    valor: Decimal
    data: date
    competencia: str
    recorrente: bool
    observacao: str | None = None
    origem_recorrente_id: int | None = None


class ReplicacaoOut(BaseModel):
    competencia: str
    criadas: int
    ja_existentes: int
    valor_total: Decimal
    despesas: list[DespesaOut]


def validar_competencia(valor: str) -> str:
    if not COMPETENCIA.match(valor):
        from app.core.exceptions import Validacao

        raise Validacao("Competência deve estar no formato AAAA-MM.", {"recebido": valor})
    return valor
