import unicodedata
from datetime import datetime
from enum import StrEnum
from uuid import UUID

from pydantic import BaseModel, Field, field_validator

from app.modules.leitor.models import MotivoEncerramento

#: O maior código de barras que a loja lê (EAN-13 tem 13; Code 128 de etiqueta de fornecedor
#: passa de 30). Mais que isto não é etiqueta, é a câmera lendo outra coisa.
MAX_CODIGO_LIDO = 64


class StatusPareamento(StrEnum):
    AGUARDANDO = "AGUARDANDO"
    """Código na tela do computador, esperando um celular aceitar (5 min)."""

    ATIVO = "ATIVO"
    """Celular ligado: o que ele bipa chega ao computador (até 12 h do aceite)."""

    EXPIRADO = "EXPIRADO"
    """Passou o prazo: do código (ninguém aceitou) ou das 12 h."""

    ENCERRADO = "ENCERRADO"
    """Alguém desligou, o celular foi para outro computador ou o código foi trocado."""


class PareamentoIn(BaseModel):
    #: O pareamento que este novo substitui (o computador gerou outro código): o antigo
    #: é encerrado, para não sobrar código válido de uma tela que já não o mostra.
    substitui_id: int | None = None


class AceiteIn(BaseModel):
    #: Do jeito que a pessoa digitou ("abc-234", "ABC 234"): quem normaliza é o servidor.
    codigo: str = Field(max_length=32)


class PareamentoOut(BaseModel):
    id: int
    codigo: str
    status: StatusPareamento
    computador_nome: str
    aparelho_nome: str | None
    criado_em: datetime
    codigo_expira_em: datetime
    aceito_em: datetime | None
    expira_em: datetime | None
    encerrado_em: datetime | None
    motivo_encerramento: MotivoEncerramento | None


class BipeIn(BaseModel):
    client_uuid: UUID
    pareamento_id: int
    codigo: str

    @field_validator("codigo")
    @classmethod
    def _codigo_lido(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("O código lido está vazio.")
        if len(v) > MAX_CODIGO_LIDO:
            raise ValueError(f"O código lido passa de {MAX_CODIGO_LIDO} caracteres.")
        # Caractere de controle (Enter, Tab, ESC...) viraria tecla no campo do computador.
        if any(unicodedata.category(c) == "Cc" for c in v):
            raise ValueError("O código lido tem caractere de controle.")
        return v


class BipeOut(BaseModel):
    id: int
    client_uuid: UUID
    pareamento_id: int
    codigo: str
    criado_em: datetime


class BipeRetiradoOut(BaseModel):
    id: int
    codigo: str
    criado_em: datetime


class RetiradaOut(BaseModel):
    """O lote que o computador retirou. Não é listagem paginada: é uma fila, entregue uma
    vez, com teto de `LOTE_DA_RETIRADA` por chamada (ADR-43)."""

    items: list[BipeRetiradoOut]
    #: Bipes que estavam na fila mas não foram entregues: velhos demais (código lido há
    #: mais de 2 min não pode cair no carrinho de surpresa) ou o pareamento já não está ATIVO.
    descartados: int
    pareamento: PareamentoOut
