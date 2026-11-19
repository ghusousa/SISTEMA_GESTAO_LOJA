"""O push da Expo para o chamado do leitor (ADR-47), no molde do emissor fiscal (ADR-41).

Quem manda é o servidor da loja, pela API pública da Expo — que entrega pelo APNs da Apple e
pelo FCM do Google com as credenciais de quem publica o app (por isso o servidor da loja não
guarda segredo nenhum). O que sai: o token do aparelho, um título e um texto FIXOS com o
sinal de 3 caracteres, e `data = {"tipo": "leitor-chamado", "sinal": ...}`. Nenhum id,
endereço de servidor, nome de pessoa ou dado da loja vai para a Expo nem para a Apple: o app
pergunta ao servidor em que está ligado quais chamados são dele.

Três regras do adaptador:

- **Teto TOTAL de 4 s** (`asyncio.timeout`), não por fase: o POST do chamado espera o envio,
  e o `httpx.Timeout` vale por fase (conectar, escrever, cada leitura) — uma resposta que
  chega aos pedaços renovaria o prazo a cada pedaço. Passou do teto, é erro.
- **Nunca levanta**: rede caída, 5xx, JSON estranho, tudo vira recibo "erro", como o
  `_sem_rede` da NFC-e. O chamado já foi gravado antes do envio e vale do mesmo jeito.
- **O token não sai**: nem em `repr` (os dataclasses o escondem), nem em log. O `message` de
  erro da Expo repete o token por extenso, então dele só se lê o código (`details.error`).
"""

import asyncio
import logging
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Literal

import httpx

logger = logging.getLogger(__name__)

URL_DO_ENVIO = "https://exp.host/--/api/v2/push/send"
#: Por fase; quem segura o total é o `TETO_DO_ENVIO_S`.
TIMEOUT_POR_FASE = httpx.Timeout(4.0, connect=3.0)
#: O POST do chamado espera até isto pelo envio (os testes baixam).
TETO_DO_ENVIO_S = 4.0
#: O canal do Android em que o app põe o chamado.
CANAL_DO_ANDROID = "leitor"

SituacaoDoRecibo = Literal["ok", "token_morto", "sem_credencial", "erro"]


@dataclass(frozen=True)
class Mensagem:
    #: Credencial ao portador: fora do `repr`, e por isso de todo log e traceback.
    token: str = field(repr=False)
    titulo: str
    texto: str
    dados: dict[str, str]
    #: Depois disto a Expo e a Apple desistem de entregar (o chamado vale 5 min).
    validade_s: int
    #: Só volta no recibo: a SEM_CHAVE_DA_APPLE é a falta da credencial num iPhone.
    plataforma: str = ""


@dataclass(frozen=True)
class Recibo:
    token: str = field(repr=False)
    plataforma: str
    situacao: SituacaoDoRecibo


def corpo_da_mensagem(m: Mensagem) -> dict[str, Any]:
    """O item da lista que vai à Expo. Só isto: nada além destas oito chaves."""
    return {
        "to": m.token,
        "title": m.titulo,
        "body": m.texto,
        "data": dict(m.dados),
        "sound": "default",
        # Alta: o chamado é para agora (no Android, acorda o aparelho em repouso).
        "priority": "high",
        "ttl": m.validade_s,
        "channelId": CANAL_DO_ANDROID,
    }


def _situacao(item: object) -> SituacaoDoRecibo:
    """O recibo (ticket) de UMA mensagem. Só o código do erro é lido — nunca o `message`."""
    if not isinstance(item, dict):
        return "erro"
    if item.get("status") == "ok":
        return "ok"
    detalhes = item.get("details")
    codigo = detalhes.get("error") if isinstance(detalhes, dict) else None
    if codigo == "DeviceNotRegistered":
        return "token_morto"
    if codigo == "InvalidCredentials":
        return "sem_credencial"
    return "erro"


def _todos(mensagens: list[Mensagem], situacao: SituacaoDoRecibo) -> list[Recibo]:
    return [Recibo(token=m.token, plataforma=m.plataforma, situacao=situacao) for m in mensagens]


class ExpoPush:
    nome = "expo"

    def __init__(self, transport: httpx.AsyncBaseTransport | None = None):
        #: Os testes passam um `httpx.MockTransport`; em produção é a rede de verdade.
        self._transport = transport

    async def enviar(self, mensagens: list[Mensagem]) -> list[Recibo]:
        """Um POST só, com a lista inteira (o login tem no máximo 10 aparelhos). Os recibos
        voltam na ordem das mensagens, como a Expo devolve o `data`."""
        if not mensagens:
            return []
        try:
            # O teto é lido aqui, na hora, e não no import: os testes o baixam.
            async with asyncio.timeout(TETO_DO_ENVIO_S):
                async with httpx.AsyncClient(
                    timeout=TIMEOUT_POR_FASE, transport=self._transport
                ) as cliente:
                    resposta = await cliente.post(
                        URL_DO_ENVIO,
                        json=[corpo_da_mensagem(m) for m in mensagens],
                        headers={
                            "Accept": "application/json",
                            "Content-Type": "application/json",
                        },
                    )
        except Exception as exc:  # noqa: BLE001 - nunca levanta; ver o topo do módulo
            # Só o tipo do erro: a mensagem de alguns traz a requisição inteira.
            logger.warning(
                "push da Expo sem resposta (%s): %d aparelho(s) sem aviso",
                type(exc).__name__,
                len(mensagens),
            )
            return _todos(mensagens, "erro")

        if resposta.status_code != 200:
            logger.warning(
                "push da Expo recusado: HTTP %d, %d aparelho(s) sem aviso",
                resposta.status_code,
                len(mensagens),
            )
            return _todos(mensagens, "erro")
        try:
            itens = resposta.json()["data"]
        except (ValueError, KeyError, TypeError):
            itens = None
        if not isinstance(itens, list) or len(itens) != len(mensagens):
            logger.warning("push da Expo: resposta fora do formato, %d aparelho(s)", len(mensagens))
            return _todos(mensagens, "erro")
        return [
            Recibo(token=m.token, plataforma=m.plataforma, situacao=_situacao(item))
            for m, item in zip(mensagens, itens, strict=True)
        ]


def _fabricar(nome: str) -> ExpoPush:
    if nome == "expo":
        return ExpoPush()
    raise ValueError(f"NOTIFICACOES_PUSH desconhecido: {nome!r}")


#: Ponto de troca para os testes: a fábrica que monta o adaptador a partir do `.env`. O teste
#: põe aqui um `ExpoPush(transport=httpx.MockTransport(...))` — e nada vai para a internet.
fabrica: Callable[[str], ExpoPush] = _fabricar
