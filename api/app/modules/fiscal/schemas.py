"""Contratos da NFC-e. Nada aqui carrega custo, lucro ou credencial."""

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

from app.modules.fiscal.models import Ambiente, StatusNota


class EmissorOut(BaseModel):
    """Se dá para emitir, e o que falta se não der. O token nunca: só se ele existe."""

    nome: str
    ambiente: Ambiente | None
    configurado: bool
    faltando: list[str] = Field(default_factory=list)
    emitir_automatico: bool = False


class NotaOut(BaseModel):
    model_config = ConfigDict(from_attributes=True, populate_by_name=True)

    id: int
    venda_id: int = Field(validation_alias="sale_id")
    status: StatusNota
    ambiente: Ambiente
    emissor: str
    referencia: str
    numero: int | None = None
    serie: int | None = None
    chave: str | None = None
    protocolo: str | None = None
    url_danfe: str | None = None
    url_xml: str | None = None
    mensagem: str | None = None
    tentativas: int
    autorizada_em: datetime | None = None
    cancelada_em: datetime | None = None
    criada_em: datetime = Field(validation_alias="created_at")
    atualizada_em: datetime = Field(validation_alias="updated_at")


class NfceOut(BaseModel):
    """A situação fiscal de UMA venda: a nota (se já houve tentativa) e o emissor."""

    venda_id: int
    emissor: EmissorOut
    nota: NotaOut | None = None
