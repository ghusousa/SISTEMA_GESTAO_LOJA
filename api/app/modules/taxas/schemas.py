from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.modules.taxas.models import MAX_PARCELAS, MAX_PRAZO_DIAS

FormaCartao = Literal["DEBITO", "CREDITO"]


def conferir_faixa(forma: str | None, de: int | None, ate: int | None) -> None:
    if de is not None and ate is not None and ate < de:
        raise ValueError("A faixa de parcelas termina antes de começar.")
    if forma == "DEBITO" and ((de or 1) != 1 or (ate or 1) != 1):
        raise ValueError("Débito não parcela: a taxa do débito é sempre de 1x.")


class TaxaIn(BaseModel):
    forma: FormaCartao
    parcelas_de: int = Field(default=1, ge=1, le=MAX_PARCELAS)
    parcelas_ate: int = Field(default=1, ge=1, le=MAX_PARCELAS)
    percentual: Decimal = Field(ge=0, lt=100, max_digits=5, decimal_places=2)
    prazo_dias: int = Field(ge=0, le=MAX_PRAZO_DIAS)

    @model_validator(mode="after")
    def _faixa(self) -> "TaxaIn":
        conferir_faixa(self.forma, self.parcelas_de, self.parcelas_ate)
        return self


class TaxaUpdate(BaseModel):
    """Só o que veio muda. A forma não troca: taxa de débito virar de crédito é outra linha."""

    parcelas_de: int | None = Field(default=None, ge=1, le=MAX_PARCELAS)
    parcelas_ate: int | None = Field(default=None, ge=1, le=MAX_PARCELAS)
    percentual: Decimal | None = Field(default=None, ge=0, lt=100, max_digits=5, decimal_places=2)
    prazo_dias: int | None = Field(default=None, ge=0, le=MAX_PRAZO_DIAS)


class TaxaOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    forma: FormaCartao
    parcelas_de: int
    parcelas_ate: int
    percentual: Decimal
    prazo_dias: int
