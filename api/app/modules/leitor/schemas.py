import unicodedata
from datetime import datetime
from enum import StrEnum
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field, field_validator

from app.modules.leitor.models import MotivoEncerramento
from app.modules.notificacoes.schemas import SituacaoDaNotificacao

#: O maior código de barras que a loja lê (EAN-13 tem 13; Code 128 de etiqueta de fornecedor
#: passa de 30). Mais que isto não é etiqueta, é a câmera lendo outra coisa.
MAX_CODIGO_LIDO = 64

#: De que lado está quem desliga, quando o MESMO login está nas duas pontas (ADR-47).
PontaDoLeitor = Literal["computador", "celular"]


class StatusPareamento(StrEnum):
    AGUARDANDO = "AGUARDANDO"
    """Código na tela do computador (ou chamado no celular), esperando o aceite (5 min)."""

    ATIVO = "ATIVO"
    """Celular ligado: o que ele bipa chega ao computador (até 12 h do aceite)."""

    EXPIRADO = "EXPIRADO"
    """Passou o prazo: do código (ninguém aceitou) ou das 12 h."""

    ENCERRADO = "ENCERRADO"
    """Alguém desligou, o celular foi para outro computador ou o código foi trocado."""


class PareamentoIn(BaseModel):
    #: O pareamento AGUARDANDO que este novo substitui (o computador gerou outro código): o
    #: antigo é encerrado, para não sobrar código válido de uma tela que já não o mostra. Se
    #: ele já estiver ATIVO, 409 LEITOR_JA_LIGADO: trocar desligaria um celular sem diário.
    substitui_id: int | None = None


class AceiteIn(BaseModel):
    #: Do jeito que a pessoa digitou ("abc-234", "ABC 234"): quem normaliza é o servidor.
    codigo: str = Field(max_length=32)
    #: A instalação do app (ADR-47). O app antigo não manda: aí vale por login, como antes.
    instalacao: UUID | None = None


class ChamadoIn(BaseModel):
    """O computador chama o celular do próprio login (ADR-47)."""

    #: Idempotência: a tela grava a chave antes do POST, e o F5 no meio retoma o MESMO
    #: chamado em vez de deixar um órfão que o celular poderia atender.
    client_uuid: UUID
    #: O pareamento AGUARDANDO desta aba (de QR ou de chamado) que sai de circulação.
    substitui_id: int | None = None


class AtendimentoIn(BaseModel):
    #: A instalação do app que atende: o reenvio e os bipes valem só para ela.
    instalacao: UUID


class PareamentoOut(BaseModel):
    id: int
    #: `null` no chamado: o código dele só existe porque a coluna pede, e nunca sai.
    codigo: str | None
    status: StatusPareamento
    #: Nasceu do botão "Abrir no app o leitor de código" (ADR-47), não do QR.
    chamado: bool
    #: O que a pessoa confere nas duas telas (ex.: "7K3"). Só no chamado.
    sinal: str | None
    computador_nome: str
    aparelho_nome: str | None
    criado_em: datetime
    codigo_expira_em: datetime
    aceito_em: datetime | None
    expira_em: datetime | None
    encerrado_em: datetime | None
    motivo_encerramento: MotivoEncerramento | None


class ChamadoOut(BaseModel):
    pareamento: PareamentoOut
    #: O que aconteceu com o aviso ao celular. `null` no reenvio da mesma chave (sem push de
    #: novo): a tela não sabe, e diz "toque na notificação — ou abra o app".
    notificacao: SituacaoDaNotificacao | None
    #: Em ENVIADA, quantos aparelhos a Expo aceitou; em SEM_NOTIFICACAO e DESLIGADA, quantos
    #: têm o app com este login (veem o chamado com ele aberto); nos outros casos, 0.
    celulares: int


class ChamadoAbertoOut(BaseModel):
    """Um chamado que o celular do login pode atender. Nunca o código nem nomes."""

    id: int
    sinal: str
    criado_em: datetime
    vence_em: datetime


class BipeIn(BaseModel):
    client_uuid: UUID
    pareamento_id: int
    codigo: str
    #: A instalação do app que bipa (ADR-47). Pareamento ligado por uma instalação só aceita
    #: bipe dela; o app antigo não manda, e o pareamento que ele ligou também não tem.
    instalacao: UUID | None = None

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
