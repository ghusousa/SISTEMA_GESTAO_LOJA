from datetime import datetime
from decimal import Decimal

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator

from app.modules.usuarios.models import Papel

SENHA_MIN = 8


class UsuarioOut(BaseModel):
    model_config = ConfigDict(from_attributes=True, populate_by_name=True)

    id: int
    nome: str = Field(validation_alias="name")
    email: EmailStr
    papel: Papel = Field(validation_alias="role")
    ativo: bool = Field(validation_alias="is_active")
    criado_em: datetime = Field(validation_alias="created_at")
    #: % sobre o faturamento líquido (ADR-37). Sai para quem administra a equipe e, no
    #: `/auth/me`, para a própria pessoa — nunca a comissão de uma para a outra.
    comissao_percentual: Decimal = Decimal("0.00")
    #: Meta de venda do dia; `null` = sem meta.
    meta_diaria: Decimal | None = None


class UsuarioCreate(BaseModel):
    nome: str = Field(min_length=2, max_length=120)
    email: EmailStr
    senha: str = Field(min_length=SENHA_MIN, max_length=72)
    papel: Papel = Papel.VENDEDOR
    #: Só o dono define (DEFINIR_COMISSAO). Mandar estes campos sem a capacidade é 403.
    comissao_percentual: Decimal | None = Field(default=None, ge=0, le=100, decimal_places=2)
    meta_diaria: Decimal | None = Field(default=None, gt=0, max_digits=14, decimal_places=2)

    @field_validator("nome")
    @classmethod
    def _limpar(cls, v: str) -> str:
        return v.strip()


class UsuarioUpdate(BaseModel):
    nome: str | None = Field(default=None, min_length=2, max_length=120)
    papel: Papel | None = None
    ativo: bool | None = None
    #: Ausente = não mexe. Só o dono define (DEFINIR_COMISSAO).
    comissao_percentual: Decimal | None = Field(default=None, ge=0, le=100, decimal_places=2)
    #: Ausente = não mexe; `null` = tira a meta. Só o dono define.
    meta_diaria: Decimal | None = Field(default=None, gt=0, max_digits=14, decimal_places=2)


class SenhaReset(BaseModel):
    """Admin redefinindo a senha de outro usuário."""

    nova_senha: str = Field(min_length=SENHA_MIN, max_length=72)


class SenhaTroca(BaseModel):
    """Usuário trocando a própria senha: exige a senha atual."""

    senha_atual: str = Field(min_length=1, max_length=72)
    nova_senha: str = Field(min_length=SENHA_MIN, max_length=72)


class ExclusaoDaPropriaConta(BaseModel):
    """Excluir a própria conta: a senha confirma que é a própria pessoa, e não um celular
    destravado na mão de outra. Errada, é 422 `SENHA_INCORRETA` — nunca 401 (ADR-45)."""

    senha: str = Field(min_length=1, max_length=72)
