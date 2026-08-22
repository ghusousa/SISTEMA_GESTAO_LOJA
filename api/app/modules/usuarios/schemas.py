from datetime import datetime

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


class UsuarioCreate(BaseModel):
    nome: str = Field(min_length=2, max_length=120)
    email: EmailStr
    senha: str = Field(min_length=SENHA_MIN, max_length=72)
    papel: Papel = Papel.VENDEDOR

    @field_validator("nome")
    @classmethod
    def _limpar(cls, v: str) -> str:
        return v.strip()


class UsuarioUpdate(BaseModel):
    nome: str | None = Field(default=None, min_length=2, max_length=120)
    papel: Papel | None = None
    ativo: bool | None = None


class SenhaReset(BaseModel):
    """Admin redefinindo a senha de outro usuário."""

    nova_senha: str = Field(min_length=SENHA_MIN, max_length=72)


class SenhaTroca(BaseModel):
    """Usuário trocando a própria senha: exige a senha atual."""

    senha_atual: str = Field(min_length=1, max_length=72)
    nova_senha: str = Field(min_length=SENHA_MIN, max_length=72)
