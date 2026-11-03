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

**"conectado" é uma promessa.** Só sai depois de a escuta do banco desta instância estar
de pé (`app/core/escuta.py`): daí em diante nada que outra instância grave escapa desta
tela, e o cliente refaz o que tem aberto ao receber "conectado" — o que mudou antes está
na consulta. Na Vercel o socket cai no `maxDuration` da função; o cliente religa e o
mesmo "conectado" fecha o buraco.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from starlette.websockets import WebSocketState

from app.core.db import SessionLocal
from app.core.escuta import escuta
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

#: Quanto a tela espera a escuta do banco antes de receber "conectado" mesmo assim. Banco
#: local responde em milissegundos; o Neon acordando leva alguns segundos. Passou disso,
#: a tela segue com os avisos desta instância e a escuta, quando voltar, manda refazer.
ESPERA_ESCUTA = 5.0

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

    logger.info("tempo-real: %s entrou (%d ouvintes)", usuario.email, central.ouvintes + 1)

    # Inscrita ANTES de esperar a escuta: o que esta instância gravar nesse meio-tempo fica
    # na fila e sai logo depois do "conectado".
    async with central.inscrever() as fila, escuta.tela():
        vigia: asyncio.Task[None] | None = None
        proximo: asyncio.Task[Evento] | None = None
        try:
            await escuta.aguardar_pronta(ESPERA_ESCUTA)
            await websocket.send_json({"assunto": "conectado", "dados": {"usuario_id": usuario.id}})
            vigia = asyncio.create_task(_escutar_ate_cair(websocket))
            while True:
                if proximo is None:
                    proximo = asyncio.create_task(fila.get())
                # Espera o aviso OU a queda do cliente. Esperar só o aviso deixava a tela
                # que saiu pendurada até o próximo ping (25 s), segurando a escuta do
                # banco e, na Vercel, a instância da função.
                prontas, _ = await asyncio.wait(
                    {proximo, vigia}, timeout=INTERVALO_PING, return_when=asyncio.FIRST_COMPLETED
                )
                if vigia in prontas:
                    break  # o cliente sumiu
                if proximo in prontas:
                    evento: Evento = proximo.result()
                    proximo = None
                    await websocket.send_json(evento.como_json())
                    continue
                # Nada aconteceu na loja: manda o ping para a conexão não morrer calada
                # num NAT de operadora.
                await websocket.send_json({"assunto": "ping", "dados": {}})
        except (WebSocketDisconnect, RuntimeError):
            pass  # desligar no meio de um envio é rotina, não erro
        finally:
            if proximo is not None:
                proximo.cancel()
            if vigia is not None:
                vigia.cancel()
                # `await` numa task que MORREU relança a exceção dela — e a queda do
                # cliente chega aqui justamente como WebSocketDisconnect. Escapando daqui,
                # ela sobe até o uvicorn, que escreve um traceback inteiro (~2 KB) no log
                # A CADA celular que fecha o app. O log do Docker não tem limite de tamanho
                # por padrão: numa loja com meia dúzia de aparelhos isso enche o disco
                # sozinho, e disco cheio derruba o Postgres. Cair é rotina; não é erro.
                with contextlib.suppress(asyncio.CancelledError, WebSocketDisconnect, RuntimeError):
                    await vigia
            await _fechar(websocket, 1000, "Até logo.")
            logger.info("tempo-real: %s saiu", usuario.email)
