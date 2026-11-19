"""Contratos das notificações do chamado do leitor (ADR-47)."""

import unicodedata
from enum import StrEnum
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, field_validator

#: O tamanho da coluna. O token da Expo tem uns 40 caracteres; o teto só barra lixo.
MAX_TOKEN = 200
#: Espelho do `isExpoPushToken` do SDK da Expo (as duas grafias que ela já usou).
PREFIXOS_DO_TOKEN = ("ExponentPushToken[", "ExpoPushToken[")


class SituacaoDaNotificacao(StrEnum):
    """O que aconteceu com o aviso do chamado. A tela do computador diz isso com palavras;
    em todos os casos o chamado vale os 5 min para um app ABERTO com o mesmo login."""

    ENVIADA = "ENVIADA"
    """A Expo aceitou o push para pelo menos um celular do login."""

    SEM_CELULAR = "SEM_CELULAR"
    """Nenhum app atualizado com este login se registrou neste servidor."""

    SEM_NOTIFICACAO = "SEM_NOTIFICACAO"
    """Há app com este login, mas nenhum recebe push (sem permissão, Android sem FCM, Expo Go,
    ou a Expo disse que o token morreu)."""

    DESLIGADA = "DESLIGADA"
    """Este servidor não manda push (`NOTIFICACOES_PUSH=desligado`, o padrão)."""

    SEM_CHAVE_DA_APPLE = "SEM_CHAVE_DA_APPLE"
    """A Expo recusou o iPhone por falta da credencial de push de quem publica o app."""

    FALHOU = "FALHOU"
    """Rede, Expo fora do ar ou resposta que não se entende."""


def validar_token(texto: str) -> str:
    """O token aparado, ou ValueError. A mensagem nunca repete o token (vai no 422)."""
    token = texto.strip()
    if not 1 <= len(token) <= MAX_TOKEN:
        raise ValueError(f"O token de notificação tem de 1 a {MAX_TOKEN} caracteres.")
    if not (token.startswith(PREFIXOS_DO_TOKEN) and token.endswith("]")):
        raise ValueError("Não é um token de notificação da Expo.")
    # Espaço ou caractere de controle não existe num token de verdade: é lixo, ou alguém
    # tentando quebrar o corpo que vai para a Expo.
    if any(c.isspace() or unicodedata.category(c) == "Cc" for c in token):
        raise ValueError("O token de notificação tem espaço ou caractere de controle.")
    return token


class AparelhoIn(BaseModel):
    """O app registra esta instalação para o login da sessão (`PUT /notificacoes/aparelho`)."""

    instalacao: UUID
    plataforma: Literal["ios", "android"]
    #: Três estados, separados por `model_fields_set`:
    #: - AUSENTE: o app não conseguiu falar com a Expo agora — o servidor mantém o que tem;
    #: - `null`: este aparelho não recebe push (sem permissão, Android sem FCM, Expo Go) e o
    #:   token guardado é apagado;
    #: - texto: é o token.
    token: str | None = None

    @field_validator("token")
    @classmethod
    def _token(cls, v: str | None) -> str | None:
        return None if v is None else validar_token(v)


class AparelhoFora(BaseModel):
    """O app esquece esta instalação (`DELETE /notificacoes/aparelho`), sem sessão."""

    instalacao: UUID
