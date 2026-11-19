"""Notificações do chamado do leitor (ADR-47): o registro do aparelho e o push.

O push é ligado SÓ pelo `.env` (`NOTIFICACOES_PUSH=expo|desligado`, padrão desligado), como o
emissor fiscal (ADR-41) — e sem segredo: a credencial da Apple é de quem publica o app e
mora na Expo, não em cada loja. Desligado, o chamado chega ao app ABERTO pela faixa (tempo
real) e o QR continua; o app nem pede a permissão de notificação, porque o `GET
/configuracao` diz `notificacoes_push: false`.

O registro do aparelho não depende do push: o app novo se registra a cada sessão, com ou sem
token, e é isso que faz o `SEM_CELULAR` querer dizer "nenhum app atualizado com este login".
"""

import contextlib
import logging
from dataclasses import dataclass

from sqlalchemy.exc import IntegrityError, StatementError
from sqlalchemy.ext.asyncio import AsyncSession
from starlette import status as http

from app.core.config import settings
from app.core.exceptions import AppError
from app.modules.notificacoes import expo
from app.modules.notificacoes.repository import Aparelho, NotificacoesRepository
from app.modules.notificacoes.schemas import AparelhoFora, AparelhoIn, SituacaoDaNotificacao
from app.modules.usuarios.models import User

logger = logging.getLogger(__name__)

TITULO_DO_CHAMADO = "Leitor de código de barras"
#: O `data` que o app reconhece (`ehChamadoDoLeitor`). Mudou aqui, muda lá.
TIPO_DO_CHAMADO = "leitor-chamado"
#: Quanto o push espera para ser entregue: o chamado vale 5 min (`PRAZO_DO_CODIGO` do leitor,
#: que passa o dele); depois disso a notificação só abriria um "esse chamado já acabou".
VALIDADE_DO_CHAMADO_S = 300

#: O aviso de TESTE do diagnóstico do dono (`python -m app.cli testar-push`). O app não trata
#: este tipo: na frente, aparece como um aviso qualquer; o toque só abre o app.
TITULO_DO_TESTE = "Teste de notificação"
TEXTO_DO_TESTE = "Se este aviso apareceu, as notificações do leitor chegam a este celular."
TIPO_DO_TESTE = "teste-de-notificacao"


class RegistroIndisponivel(AppError):
    """O banco não gravou o registro do aparelho agora (tabela travada além do teto de
    consulta, conexão que caiu, a conta excluída no meio). O app trata qualquer 5xx do
    registro em silêncio e registra de novo na próxima volta."""

    code = "NOTIFICACAO_INDISPONIVEL"
    http_status = http.HTTP_503_SERVICE_UNAVAILABLE
    message = "O registro deste celular não foi gravado agora. O app tenta de novo sozinho."


def _nome_do_erro_do_banco(exc: StatementError) -> str:
    """O que o log pode dizer de um erro do banco: o nome do erro do Postgres e o SQLSTATE.

    Nunca `str(exc)`: ele traz o comando com os parâmetros, e a causa encadeada traz o DETAIL
    do Postgres ("Key (token)=(ExponentPushToken[...]) already exists").
    """
    origem = exc.orig
    causa = getattr(origem, "__cause__", None) or origem
    sqlstate = getattr(origem, "sqlstate", None) or getattr(causa, "sqlstate", None)
    nome = type(causa).__name__ if causa is not None else type(exc).__name__
    return f"{nome}, SQLSTATE {sqlstate}" if isinstance(sqlstate, str) else nome


def texto_do_chamado(sinal: str) -> str:
    return (
        f"O computador do sinal {sinal} está chamando: toque para abrir a câmera e ler as "
        "etiquetas."
    )


@dataclass(frozen=True)
class TesteDoPush:
    #: Os aparelhos do login com o app (com ou sem notificação).
    aparelhos: int
    #: Um por aparelho com token, na ordem; vazio quando nenhum tem.
    recibos: list[expo.Recibo]


@dataclass(frozen=True)
class ResultadoDoAviso:
    situacao: SituacaoDaNotificacao
    #: Em ENVIADA, os aparelhos que a Expo aceitou; em SEM_NOTIFICACAO e DESLIGADA, os
    #: aparelhos com o app (veem o chamado com ele aberto); nos outros casos, 0.
    celulares: int


class NotificacoesService:
    def __init__(self, session: AsyncSession):
        self.session = session
        self.repo = NotificacoesRepository(session)

    async def registrar(self, dados: AparelhoIn, usuario: User) -> None:
        """`PUT /notificacoes/aparelho`: esta instalação é deste login, com este token (ou
        sem). Também poda o login a 10 aparelhos e faz a faxina dos de 30 dias.

        O erro do banco NÃO sobe daqui: ele traz o comando com os parâmetros — o token — e,
        no UNIQUE, o DETAIL do Postgres com o token por extenso, na causa encadeada. Subindo,
        o uvicorn escreveria tudo no log ("Exception in ASGI application"). Vira 503
        `NOTIFICACAO_INDISPONIVEL`, levantado FORA do `except` (sem o erro do banco pendurado
        no `__context__`), e o log diz só o nome do erro e o SQLSTATE.
        """
        user_id = usuario.id
        com_token = "token" in dados.model_fields_set
        motivo, de_novo = "", False
        for tentativa in range(2):
            try:
                await self.repo.upsert(
                    user_id=user_id,
                    instalacao=dados.instalacao,
                    plataforma=dados.plataforma,
                    token=dados.token,
                    com_token=com_token,
                )
                await self.repo.podar_do_usuario(user_id)
                await self.repo.faxina()
                await self.session.commit()
                return
            except StatementError as exc:
                motivo = _nome_do_erro_do_banco(exc)
                # Duas instalações gravando o MESMO token ao mesmo tempo: a segunda esbarra no
                # UNIQUE dele. Desfeita, a nova tentativa já vê a outra e a apaga antes.
                de_novo = isinstance(exc, IntegrityError) and tentativa == 0
            with contextlib.suppress(Exception):
                await self.session.rollback()
            if not de_novo:
                break
        logger.warning("registro do aparelho: o banco recusou (%s)", motivo)
        raise RegistroIndisponivel()

    async def esquecer(self, dados: AparelhoFora) -> None:
        """`DELETE /notificacoes/aparelho`, SEM sessão: o app sai, a sessão caiu, ou limpa o
        registro do servidor de antes. O id é aleatório (122 bits) e nenhuma rota o devolve;
        quem o tiver só tira aquele aparelho do push até o próximo registro."""
        await self.repo.apagar_instalacao(dados.instalacao)
        await self.session.commit()

    async def esquecer_usuario(self, user_id: int) -> None:
        """Os aparelhos do login saem (troca de senha, desativação, exclusão de conta). Quem
        chama faz o commit, junto com o resto."""
        await self.repo.apagar_do_usuario(user_id)

    async def avisar_chamado_do_leitor(
        self, user_id: int, sinal: str, *, validade_s: int = VALIDADE_DO_CHAMADO_S
    ) -> ResultadoDoAviso:
        """Avisa os celulares do login que o computador do `sinal` está chamando.

        Nunca levanta: o chamado já foi commitado por quem chama, e o aviso é melhor
        esforço — qualquer erro vira FALHOU, logado só com o nome do tipo do erro.
        """
        try:
            resultado = await self._avisar(user_id, sinal, validade_s)
        except Exception as exc:  # noqa: BLE001 - ver a docstring
            logger.warning("chamado do leitor: o aviso falhou (%s)", type(exc).__name__)
            with contextlib.suppress(Exception):
                await self.session.rollback()
            return ResultadoDoAviso(SituacaoDaNotificacao.FALHOU, 0)
        # Só a situação e a contagem: nunca o token, nem o que a Expo respondeu.
        logger.info(
            "chamado do leitor: %s (%d celular(es))", resultado.situacao, resultado.celulares
        )
        return resultado

    async def _avisar(self, user_id: int, sinal: str, validade_s: int) -> ResultadoDoAviso:
        aparelhos = await self.repo.do_usuario(user_id)
        if not aparelhos:
            return ResultadoDoAviso(SituacaoDaNotificacao.SEM_CELULAR, 0)
        if settings.notificacoes_push == "desligado":
            return ResultadoDoAviso(SituacaoDaNotificacao.DESLIGADA, len(aparelhos))
        com_token = [a for a in aparelhos if a.token]
        if not com_token:
            return ResultadoDoAviso(SituacaoDaNotificacao.SEM_NOTIFICACAO, len(aparelhos))

        recibos = await self._mandar(
            com_token,
            titulo=TITULO_DO_CHAMADO,
            texto=texto_do_chamado(sinal),
            dados={"tipo": TIPO_DO_CHAMADO, "sinal": sinal},
            validade_s=validade_s,
            adaptador=settings.notificacoes_push,
        )
        aceitos = sum(1 for r in recibos if r.situacao == "ok")
        if aceitos:
            return ResultadoDoAviso(SituacaoDaNotificacao.ENVIADA, aceitos)
        if any(r.situacao == "sem_credencial" and r.plataforma == "ios" for r in recibos):
            return ResultadoDoAviso(SituacaoDaNotificacao.SEM_CHAVE_DA_APPLE, 0)
        if recibos and all(r.situacao == "token_morto" for r in recibos):
            return ResultadoDoAviso(SituacaoDaNotificacao.SEM_NOTIFICACAO, len(aparelhos))
        return ResultadoDoAviso(SituacaoDaNotificacao.FALHOU, 0)

    async def _mandar(
        self,
        aparelhos: list[Aparelho],
        *,
        titulo: str,
        texto: str,
        dados: dict[str, str],
        validade_s: int,
        adaptador: str,
    ) -> list[expo.Recibo]:
        """Manda o aviso aos aparelhos (todos com token) e esquece os tokens que a Expo disse
        que morreram."""
        # A leitura acaba ANTES da rede: nenhuma transação nem trava fica aberta durante os
        # até 4 s do envio (na demo, a renovação da madrugada esperaria por ela).
        await self.session.commit()
        mensagens = [
            expo.Mensagem(
                token=a.token,
                titulo=titulo,
                texto=texto,
                dados=dados,
                validade_s=validade_s,
                plataforma=a.plataforma,
            )
            for a in aparelhos
            if a.token
        ]
        recibos = await expo.fabrica(adaptador).enviar(mensagens)
        await self._anular_mortos([r.token for r in recibos if r.situacao == "token_morto"])
        return recibos

    async def _anular_mortos(self, tokens: list[str]) -> None:
        if tokens:
            # Transação curta, só nesta tabela. A instalação fica: com o app aberto ela ainda
            # vê o chamado, e o app registra o token novo quando houver um.
            await self.repo.anular_tokens(tokens)
            await self.session.commit()

    # ------------------------------------------------------------ o diagnóstico do dono

    async def mandar_teste(self, user_id: int) -> TesteDoPush:
        """`python -m app.cli testar-push`: um aviso de TESTE aos aparelhos do login, pela
        Expo, esteja o `NOTIFICACOES_PUSH` ligado ou não — é como o dono confere a chave de
        push da Apple antes (ou depois) de ligar. Sem chamado e sem dado da loja."""
        aparelhos = await self.repo.do_usuario(user_id)
        com_token = [a for a in aparelhos if a.token]
        if not com_token:
            await self.session.commit()
            return TesteDoPush(len(aparelhos), [])
        recibos = await self._mandar(
            com_token,
            titulo=TITULO_DO_TESTE,
            texto=TEXTO_DO_TESTE,
            dados={"tipo": TIPO_DO_TESTE},
            validade_s=VALIDADE_DO_CHAMADO_S,
            adaptador="expo",
        )
        return TesteDoPush(len(aparelhos), recibos)

    async def conferir_entregas(self, recibos: list[expo.Recibo]) -> dict[str, expo.Entrega] | None:
        """O que a Apple e o Google responderam aos avisos que a Expo aceitou (o recibo da
        ENTREGA: é só nele que uma chave de push revogada aparece). O token que morreu ali
        também sai. `None`: a Expo não respondeu agora."""
        ids = [r.id_na_expo for r in recibos if r.situacao == "ok" and r.id_na_expo]
        entregas = await expo.fabrica("expo").entregas(ids)
        if entregas:
            await self._anular_mortos(
                [
                    r.token
                    for r in recibos
                    if r.id_na_expo in entregas and entregas[r.id_na_expo].situacao == "token_morto"
                ]
            )
        return entregas
