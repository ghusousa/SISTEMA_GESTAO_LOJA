from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class AuditoriaOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    #: Ponte para a tela; pode ser nulo se o usuário foi removido um dia.
    usuario_id: int | None = Field(default=None, validation_alias="user_id")
    #: Congelados no momento do ato — não mudam se a pessoa for renomeada depois.
    usuario: str = Field(validation_alias="user_nome")
    papel: str | None = Field(default=None, validation_alias="user_papel")
    acao: str
    descricao: str
    entidade: str | None = None
    entidade_id: int | None = None
    ip: str | None = None
    quando: datetime = Field(validation_alias="created_at")
