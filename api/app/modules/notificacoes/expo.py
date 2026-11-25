"""O push da Expo para o chamado do leitor (ADR-47), no molde do emissor fiscal (ADR-41).

Quem manda é o servidor da loja, pela API pública da Expo — que entrega pelo APNs da Apple e
pelo FCM do Google com as credenciais de quem publica o app (por isso o servidor da loja não
guarda segredo nenhum). O que sai: o token do aparelho, um título e um texto FIXOS com o
sinal de 3 caracteres, e `data = {"tipo": "leitor-chamado", "sinal": ...}`. Nenhum id,
endereço de servidor, nome de pessoa ou dado da loja vai para a Expo nem para a Apple: o app
pergunta ao servidor em que está ligado quais chamados são dele.

Quatro regras do adaptador:

- **Um POST por aparelho**, todos ao mesmo tempo. A Expo recusa o PEDIDO inteiro por causa de
  um item só — tokens de projetos diferentes juntos (`PUSH_TOO_MANY_EXPERIENCE_IDS`), um
  token que ela não aceita —, e um registro de outro projeto no login (um build de
  desenvolvimento de outra conta da Expo, alguém com a senha da conta compartilhada da demo)
  deixaria sem aviso o iPhone certo. São no máximo 10 por login.
- **Teto TOTAL de 4 s** (`asyncio.timeout`), não por fase, e o mesmo para os aparelhos todos:
  o POST do chamado espera o envio, e o `httpx.Timeout` vale por fase (conectar, escrever,
  cada leitura) — uma resposta que chega aos pedaços renovaria o prazo a cada pedaço. O que
  a Expo aceitou dentro do teto conta; o que passou dele é erro.
- **Nunca levanta**: rede caída, 5xx, JSON estranho, tudo vira recibo "erro", como o
  `_sem_rede` da NFC-e. O chamado já foi gravado antes do envio e vale do mesmo jeito.
- **O token não sai**: nem em `repr` (os dataclasses o escondem), nem em log. O `message` de
  erro da Expo repete o token por extenso, então dele só se lê o CÓDIGO — e só o que tem cara
  de código (`_CODIGO`) vai para o log, que é onde o dono descobre por que o aviso não chegou.
"""

import asyncio
import logging
import re
from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Literal

import httpx

logger = logging.getLogger(__name__)

URL_DO_ENVIO = "https://exp.host/--/api/v2/push/send"
#: Os recibos da ENTREGA (o que a Apple e o Google responderam à Expo), pelos ids que o envio
#: devolveu. Só o diagnóstico do dono pergunta (`python -m app.cli testar-push`): o chamado
#: não espera por eles — não há tarefa em segundo plano, e na Vercel nada roda depois da
#: resposta.
URL_DAS_ENTREGAS = "https://exp.host/--/api/v2/push/getReceipts"
#: Por fase; quem segura o total é o `TETO_DO_ENVIO_S`.
TIMEOUT_POR_FASE = httpx.Timeout(4.0, connect=3.0)
#: O POST do chamado espera até isto pelo envio (os testes baixam).
TETO_DO_ENVIO_S = 4.0
#: O canal do Android em que o app põe o chamado.
CANAL_DO_ANDROID = "leitor"
_CABECALHOS = {"Accept": "application/json", "Content-Type": "application/json"}

SituacaoDoRecibo = Literal["ok", "token_morto", "sem_credencial", "erro"]

#: O que tem cara de código de erro da Expo (`DeviceNotRegistered`,
#: `PUSH_TOO_MANY_EXPERIENCE_IDS`): só letras e "_". É o único pedaço da resposta de erro que
#: vai para o log — um token, uma frase ou qualquer outra coisa no lugar dele, não.
_CODIGO = re.compile(r"[A-Za-z_]{1,40}")
#: O id do recibo que a Expo devolve no "ok" (um UUID).
_ID_DO_RECIBO = re.compile(r"[A-Za-z0-9-]{1,64}")
#: O código que não tem cara de código: no log sai isto no lugar dele.
SEM_CODIGO = "sem código"


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
    """O que a Expo respondeu ao envio de UM aviso (o "push ticket" dela)."""

    token: str = field(repr=False)
    plataforma: str
    situacao: SituacaoDoRecibo
    #: Por que não foi "ok", só com pedaços seguros para o log: o código da Expo
    #: (`DeviceNotRegistered`), o do pedido com o HTTP (`HTTP 400 PUSH_TOO_MANY_EXPERIENCE_IDS`)
    #: ou o nome do erro de rede (`ConnectError`, `TimeoutError`). Nunca o `message`.
    motivo: str | None = None
    #: No "ok": o id com que se pergunta depois pela entrega (`getReceipts`).
    id_na_expo: str | None = None
    #: Nenhuma resposta da Expo chegou a este servidor (rede, DNS, proxy, o teto de 4 s): a
    #: Expo não recusou nada. É o que separa "a rede DESTE servidor" de "a Expo disse não" —
    #: o nome do erro de rede e o código da Expo têm a mesma cara (`ConnectError`,
    #: `DeviceNotRegistered`), então quem lê não adivinha pelo `motivo`.
    sem_resposta: bool = False


@dataclass(frozen=True)
class Entrega:
    """O que a Apple ou o Google responderam à Expo sobre UM aviso (o "push receipt")."""

    situacao: SituacaoDoRecibo
    motivo: str | None = None


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


def codigo_seguro(valor: object) -> str:
    """O código de erro da Expo, se tiver cara de código; senão, `SEM_CODIGO`."""
    if isinstance(valor, str) and _CODIGO.fullmatch(valor):
        return valor
    return SEM_CODIGO


def situacao_do_codigo(codigo: str) -> SituacaoDoRecibo:
    """O que um código de erro da Expo quer dizer para o chamado."""
    if codigo == "DeviceNotRegistered":
        return "token_morto"
    # `InvalidCredentials` (no recibo do envio ou no da entrega) é a credencial de push de quem
    # publica o app. A Expo documenta também que "um projeto sem credenciais de push dá erro",
    # sem dizer o código nem se ele vem num aviso ou no PEDIDO inteiro: qualquer código que
    # fale de credencial é a mesma falta — não um FALHOU mudo.
    if "credential" in codigo.lower():
        return "sem_credencial"
    return "erro"


def _recibo(
    m: Mensagem,
    situacao: SituacaoDoRecibo,
    motivo: str | None,
    id_na_expo: str | None = None,
    *,
    sem_resposta: bool = False,
) -> Recibo:
    return Recibo(
        token=m.token,
        plataforma=m.plataforma,
        situacao=situacao,
        motivo=motivo,
        id_na_expo=id_na_expo,
        sem_resposta=sem_resposta,
    )


def _detalhe(item: dict) -> object:
    detalhes = item.get("details")
    return detalhes.get("error") if isinstance(detalhes, dict) else None


def _do_aviso(m: Mensagem, item: object) -> Recibo:
    """O recibo (ticket) de UMA mensagem. Só o código do erro é lido — nunca o `message`."""
    if not isinstance(item, dict):
        return _recibo(m, "erro", "resposta fora do formato")
    if item.get("status") == "ok":
        ident = item.get("id")
        valido = isinstance(ident, str) and _ID_DO_RECIBO.fullmatch(ident)
        return _recibo(m, "ok", None, ident if valido else None)
    codigo = codigo_seguro(_detalhe(item))
    return _recibo(m, situacao_do_codigo(codigo), codigo)


def _codigos_do_pedido(resposta: httpx.Response) -> list[str]:
    """Os códigos do erro do PEDIDO inteiro (`{"errors": [{"code": ...}]}`), já seguros."""
    try:
        erros = resposta.json().get("errors")
    except (ValueError, AttributeError):
        return []
    if not isinstance(erros, list):
        return []
    return [codigo_seguro(e.get("code")) for e in erros if isinstance(e, dict)][:3]


def _do_pedido_recusado(m: Mensagem, resposta: httpx.Response) -> Recibo:
    codigos = _codigos_do_pedido(resposta)
    situacoes = {situacao_do_codigo(c) for c in codigos}
    situacao: SituacaoDoRecibo = "sem_credencial" if "sem_credencial" in situacoes else "erro"
    motivo = " ".join([f"HTTP {resposta.status_code}", *codigos])
    return _recibo(m, situacao, motivo)


class ExpoPush:
    nome = "expo"

    def __init__(self, transport: httpx.AsyncBaseTransport | None = None):
        #: Os testes passam um `httpx.MockTransport`; em produção é a rede de verdade.
        self._transport = transport

    def _cliente(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(timeout=TIMEOUT_POR_FASE, transport=self._transport)

    async def enviar(self, mensagens: list[Mensagem]) -> list[Recibo]:
        """Um POST por aparelho, todos juntos e dentro do MESMO teto total. Os recibos voltam
        na ordem das mensagens."""
        if not mensagens:
            return []
        prontos: list[Recibo | None] = [None] * len(mensagens)
        motivo_do_resto = "sem resposta"
        try:
            # O teto é lido aqui, na hora, e não no import: os testes o baixam.
            async with asyncio.timeout(TETO_DO_ENVIO_S), self._cliente() as cliente:

                async def um(i: int, m: Mensagem) -> None:
                    prontos[i] = await self._enviar_um(cliente, m)

                await asyncio.gather(*(um(i, m) for i, m in enumerate(mensagens)))
        except Exception as exc:  # noqa: BLE001 - nunca levanta; ver o topo do módulo
            # Passou do teto (ou caiu fora dos POSTs): o que já tinha resposta vale.
            motivo_do_resto = type(exc).__name__
        recibos = [
            r if r is not None else _recibo(m, "erro", motivo_do_resto, sem_resposta=True)
            for r, m in zip(prontos, mensagens, strict=True)
        ]
        _logar_recusas(recibos)
        return recibos

    async def _enviar_um(self, cliente: httpx.AsyncClient, m: Mensagem) -> Recibo:
        try:
            resposta = await cliente.post(
                URL_DO_ENVIO, json=[corpo_da_mensagem(m)], headers=_CABECALHOS
            )
        except Exception as exc:  # noqa: BLE001 - nunca levanta
            # Só o tipo do erro: a mensagem de alguns traz a requisição inteira.
            return _recibo(m, "erro", type(exc).__name__, sem_resposta=True)
        if resposta.status_code != 200:
            return _do_pedido_recusado(m, resposta)
        try:
            itens = resposta.json()["data"]
        except (ValueError, KeyError, TypeError):
            itens = None
        if not isinstance(itens, list) or len(itens) != 1:
            return _recibo(m, "erro", "resposta fora do formato")
        return _do_aviso(m, itens[0])

    async def entregas(self, ids: list[str]) -> dict[str, Entrega] | None:
        """Pergunta à Expo o que a Apple e o Google responderam (`getReceipts`). Os ids sem
        resposta ainda ficam de fora; `None` é a Expo que não respondeu. Nunca levanta."""
        if not ids:
            return {}
        try:
            async with asyncio.timeout(TETO_DO_ENVIO_S), self._cliente() as cliente:
                resposta = await cliente.post(
                    URL_DAS_ENTREGAS, json={"ids": ids}, headers=_CABECALHOS
                )
        except Exception as exc:  # noqa: BLE001 - nunca levanta
            logger.warning("recibos da Expo sem resposta (%s)", type(exc).__name__)
            return None
        if resposta.status_code != 200:
            logger.warning(
                "recibos da Expo recusados: %s",
                " ".join([f"HTTP {resposta.status_code}", *_codigos_do_pedido(resposta)]),
            )
            return None
        try:
            dados = resposta.json()["data"]
        except (ValueError, KeyError, TypeError):
            dados = None
        if not isinstance(dados, dict):
            logger.warning("recibos da Expo: resposta fora do formato")
            return None
        return {i: _entrega(dados[i]) for i in ids if i in dados}


def _entrega(item: object) -> Entrega:
    if not isinstance(item, dict):
        return Entrega("erro", "resposta fora do formato")
    if item.get("status") == "ok":
        return Entrega("ok")
    codigo = codigo_seguro(_detalhe(item))
    return Entrega(situacao_do_codigo(codigo), codigo)


def _logar_recusas(recibos: list[Recibo]) -> None:
    """Uma linha por envio, com quantos ficaram sem aviso e por quê — só códigos."""
    motivos = Counter(r.motivo or SEM_CODIGO for r in recibos if r.situacao != "ok")
    if motivos:
        logger.warning(
            "push da Expo: %d de %d aparelho(s) sem aviso (%s)",
            sum(motivos.values()),
            len(recibos),
            ", ".join(f"{motivo}: {n}" for motivo, n in sorted(motivos.items())),
        )


def _fabricar(nome: str) -> ExpoPush:
    if nome == "expo":
        return ExpoPush()
    raise ValueError(f"NOTIFICACOES_PUSH desconhecido: {nome!r}")


#: Ponto de troca para os testes: a fábrica que monta o adaptador a partir do `.env`. O teste
#: põe aqui um `ExpoPush(transport=httpx.MockTransport(...))` — e nada vai para a internet.
fabrica: Callable[[str], ExpoPush] = _fabricar
