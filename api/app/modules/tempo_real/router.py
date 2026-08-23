"""O canal que mantém as telas em dia: `WS /api/v1/tempo-real`.

**Autenticação pelo primeiro quadro, não pela URL.** O navegador não deixa mandar
cabeçalho no handshake de WebSocket, então a saída comum é `?token=...` — e aí o token
entra no log de acesso do servidor, no log do proxy e no histórico de qualquer
intermediário. Aqui a conexão abre sem crachá e a primeira mensagem tem de ser
`{"tipo": "entrar", "token": "..."}`; quem não se identificar em poucos segundos é
desligado. Token não trafega em URL nenhuma.

O que sai daqui é sempre um AVISO ("estoque mudou"), nunca o dado. Ver
`app/core/eventos.py` para o porquê — em resumo: o filtro por papel continua inteiro na
rota REST, e assim nenhuma vendedora recebe custo por este caminho.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from starlette.websockets import WebSocketState

from app.core.db import SessionLocal
from app.core.eventos import Evento, central
from app.core.exceptions import AppError
from app.core.security import decodificar_token
from app.modules.usuarios.models import User

logger = logging.getLogger(__name__)

router = APIRouter(tags=["tempo-real"])

#: Tempo para o primeiro quadro chegar com o token. Curto de propósito: conexão anônima
#: pendurada é recurso do servidor da loja parado à toa.
ESPERA_ENTRAR = 10.0

#: De quanto em quanto tempo o servidor manda um "ping" de aplicação. Celular em 4G passa
#: por NAT que derruba conexão parada em silêncio, e o app só descobriria na hora de usar.
INTERVALO_PING = 25.0

CODIGO_NAO_AUTENTICADO = 4401


async def _autenticar(websocket: WebSocket) -> User | None:
    """Lê o primeiro quadro e devolve o usuário, ou fecha a conexão."""
    try:
        primeiro = await asyncio.wait_for(websocket.receive_json(), timeout=ESPERA_ENTRAR)
    except (TimeoutError, WebSocketDisconnect, ValueError):
        await _fechar(websocket, CODIGO_NAO_AUTENTICADO, "Sem identificação.")
        return None

    if not isinstance(primeiro, dict) or primeiro.get("tipo") != "entrar":
        await _fechar(websocket, CODIGO_NAO_AUTENTICADO, "Primeira mensagem deve ser 'entrar'.")
        return None

    token = primeiro.get("token")
    if not isinstance(token, str) or not token:
        await _fechar(websocket, CODIGO_NAO_AUTENTICADO, "Token ausente.")
        return None

    try:
        payload = decodificar_token(token, "access")
    except AppError:
        await _fechar(websocket, CODIGO_NAO_AUTENTICADO, "Token inválido ou vencido.")
        return None

    # Sessão própria e curta: a conexão vive horas, e segurar uma sessão de banco aberta
    # todo esse tempo esgotaria o pool com meia dúzia de celulares conectados.
    async with SessionLocal() as sessao:
        user = await sessao.get(User, int(payload["sub"]))
        if user is None or not user.is_active:
            await _fechar(websocket, CODIGO_NAO_AUTENTICADO, "Usuário inativo.")
            return None
        # Desanexa: depois daqui a sessão fecha e o objeto não pode mais tocar no banco.
        sessao.expunge(user)
        return user


async def _fechar(websocket: WebSocket, codigo: int, motivo: str) -> None:
    with contextlib.suppress(RuntimeError, WebSocketDisconnect):
        if websocket.client_state is WebSocketState.CONNECTED:
            await websocket.close(code=codigo, reason=motivo)


async def _escutar_ate_cair(websocket: WebSocket) -> None:
    """Consome o que o cliente manda. Serve para PERCEBER a queda, não para obedecer.

    Sem alguém lendo, uma desconexão só apareceria na próxima escrita — que pode demorar
    minutos numa loja parada, e até lá o ouvinte fica na lista consumindo memória.
    """
    while True:
        await websocket.receive_text()


@router.websocket("/tempo-real")
async def tempo_real(websocket: WebSocket) -> None:
    await websocket.accept()

    usuario = await _autenticar(websocket)
    if usuario is None:
        return

    await websocket.send_json({"assunto": "conectado", "dados": {"usuario_id": usuario.id}})
    logger.info("tempo-real: %s entrou (%d ouvintes)", usuario.email, central.ouvintes + 1)

    async with central.inscrever() as fila:
        vigia = asyncio.create_task(_escutar_ate_cair(websocket))
        try:
            while True:
                if vigia.done():
                    break  # o cliente sumiu
                try:
                    evento: Evento = await asyncio.wait_for(fila.get(), timeout=INTERVALO_PING)
                except TimeoutError:
                    # Nada aconteceu na loja: manda o ping para a conexão não morrer
                    # calada num NAT de operadora.
                    await websocket.send_json({"assunto": "ping", "dados": {}})
                    continue
                await websocket.send_json(evento.como_json())
        except (WebSocketDisconnect, RuntimeError):
            pass  # desligar no meio de um envio é rotina, não erro
        finally:
            vigia.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await vigia
            await _fechar(websocket, 1000, "Até logo.")
            logger.info("tempo-real: %s saiu", usuario.email)
