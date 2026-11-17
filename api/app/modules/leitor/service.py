"""O celular como leitor de código de barras do computador (ADR-43).

O fluxo inteiro, do jeito que a loja vê:

1. No computador (PDV, Devolução, Entrada, Inventário, Condicional nova), alguém pede para
   parear: sai um código de 6 caracteres e um QR com ele, válidos por 5 min.
2. No celular, qualquer pessoa da equipe logada lê o QR (ou digita o código): o celular
   vira o leitor daquele computador por até 12 h, ou até alguém desligar.
3. Cada bipe na câmera do celular vira uma linha em `leitor_bipes`; o commit avisa
   "leitor" pelo tempo real e o computador RETIRA a fila, que cai no campo do leitor como
   se fosse o leitor USB.

O que trafega no aviso é só o assunto, nunca o código lido: quem busca é a rota REST, com o
dono do pareamento conferido.
"""

import re
import secrets
from datetime import datetime, timedelta

from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from starlette import status as http

from app.core.exceptions import AppError, Duplicado, NaoEncontrado, OperacaoInvalida
from app.modules.leitor.models import LeitorBipe, LeitorPareamento, MotivoEncerramento
from app.modules.leitor.repository import LeitorRepository
from app.modules.leitor.schemas import (
    AceiteIn,
    BipeIn,
    BipeOut,
    BipeRetiradoOut,
    PareamentoIn,
    PareamentoOut,
    RetiradaOut,
    StatusPareamento,
)
from app.modules.usuarios.models import User

#: Sem 0/O e 1/I: o código é lido em voz alta e digitado no celular. Espelho de
#: `web/js/leitor-remoto.js` e `mobile/src/lib/leitorRemoto.ts`.
ALFABETO = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"
TAMANHO_DO_CODIGO = 6
_FORMATO_DO_CODIGO = re.compile(r"^[2-9A-HJ-NP-Z]{6}$")

#: O código na tela serve para ser lido agora. Depois disso, gere outro.
PRAZO_DO_CODIGO = timedelta(minutes=5)
#: Um expediente. Fixo a partir do aceite: usar o leitor não estica o prazo.
PRAZO_DO_PAREAMENTO = timedelta(hours=12)
#: Bipe que espera mais que isto não é entregue: código lido há 2 min não pode cair no
#: carrinho de surpresa quando o computador volta. Espelho de `PRAZO_DO_BIPE_MS` nas pontas.
PRAZO_DO_BIPE = timedelta(seconds=120)
#: Teto de cada retirada. A tela busca de 2 em 2 s: 50 cobre uma rajada de bipes à vontade.
LOTE_DA_RETIRADA = 50
#: Pendentes por pareamento. Passou disso, o computador não está retirando (tela fechada,
#: aba no fundo) e continuar enfileirando só esconde o problema de quem está bipando.
FILA_MAXIMA = 100
#: Pareamentos vivos (AGUARDANDO ou ATIVO) por pessoa no computador, contando o novo. O mesmo
#: login em várias abas ou caixas é normal; código esquecido aberto às dezenas, não.
TETO_POR_COMPUTADOR = 10
#: Sorteios até achar um código livre. Com 31^6 códigos, passar de 1 já é raro.
_TENTATIVAS_DE_CODIGO = 8


class CodigoInvalido(AppError):
    """A MESMA resposta para código inexistente, vencido, já aceito ou encerrado: a tela não
    precisa saber qual foi, e quem testa códigos não aprende nada com a diferença."""

    code = "LEITOR_CODIGO_INVALIDO"
    http_status = http.HTTP_404_NOT_FOUND
    message = "Código não encontrado ou vencido. Gere outro no computador."


class LeitorDesligado(AppError):
    code = "LEITOR_DESLIGADO"
    http_status = http.HTTP_409_CONFLICT
    message = "Este celular não está mais ligado ao computador. Pareie de novo."


class FilaCheia(AppError):
    code = "LEITOR_FILA_CHEIA"
    http_status = http.HTTP_409_CONFLICT
    message = (
        "O computador não está recebendo as leituras. Confira se a tela dele está aberta."
    )


def gerar_codigo() -> str:
    return "".join(secrets.choice(ALFABETO) for _ in range(TAMANHO_DO_CODIGO))


def normalizar_codigo(texto: str) -> str | None:
    """Do jeito que a pessoa digitou ("abc-234", " ABC 234 ") para o jeito guardado."""
    limpo = re.sub(r"[\s-]+", "", texto).upper()
    return limpo if _FORMATO_DO_CODIGO.match(limpo) else None


def status_do_pareamento(p: LeitorPareamento, agora: datetime) -> StatusPareamento:
    """Calculado, nunca coluna: o relógio não avisa ninguém quando o prazo passa."""
    if p.encerrado_em is not None:
        return StatusPareamento.ENCERRADO
    if p.aceito_em is not None:
        assert p.expira_em is not None
        return StatusPareamento.ATIVO if p.expira_em > agora else StatusPareamento.EXPIRADO
    if p.codigo_expira_em > agora:
        return StatusPareamento.AGUARDANDO
    return StatusPareamento.EXPIRADO


def _encerrar(p: LeitorPareamento, agora: datetime, motivo: MotivoEncerramento) -> None:
    # Pelo ORM de propósito: o commit avisa "leitor" e a outra ponta refaz o status.
    p.encerrado_em = agora
    p.motivo_encerramento = motivo.value


class LeitorService:
    def __init__(self, session: AsyncSession):
        self.session = session
        self.repo = LeitorRepository(session)
        #: True quando o bipe já existia (replay idempotente): o router responde 200.
        self.replay = False

    # ------------------------------------------------------------------ pareamento

    async def criar(self, dados: PareamentoIn, usuario: User) -> PareamentoOut:
        usuario_id = usuario.id
        agora = await self.repo.agora()
        await self.repo.faxina(agora)

        if dados.substitui_id is not None:
            antigo = await self.repo.obter(dados.substitui_id)
            # Id de outra pessoa (ou que não existe) é ignorado: uma aba velha mandando o
            # que tinha não é motivo para recusar o código novo.
            if (
                antigo is not None
                and antigo.computador_user_id == usuario_id
                and antigo.encerrado_em is None
            ):
                _encerrar(antigo, agora, MotivoEncerramento.SUBSTITUIDO)
                # Gravado já: a releitura abaixo (`populate_existing`) passaria por cima da
                # mudança ainda só em memória.
                await self.session.flush()

        vivos = [
            p
            for p in await self.repo.vivos_do_computador(usuario_id, agora)
            if p.encerrado_em is None
        ]
        for velho in vivos[TETO_POR_COMPUTADOR - 1 :]:
            _encerrar(velho, agora, MotivoEncerramento.SUBSTITUIDO)

        for _ in range(_TENTATIVAS_DE_CODIGO):
            novo = LeitorPareamento(
                codigo=gerar_codigo(),
                computador_user_id=usuario_id,
                criado_em=agora,
                codigo_expira_em=agora + PRAZO_DO_CODIGO,
            )
            if await self.repo.inserir(novo):
                break
        else:  # pragma: no cover - 8 colisões seguidas em 887 milhões de códigos
            raise OperacaoInvalida("Não foi possível gerar um código agora. Tente de novo.")

        await self.session.commit()
        return await self._montar(novo, agora)

    async def aceitar(self, dados: AceiteIn, usuario: User) -> PareamentoOut:
        usuario_id = usuario.id
        codigo = normalizar_codigo(dados.codigo)
        if codigo is None:
            raise CodigoInvalido()

        await self.repo.travar_aparelho(usuario_id)
        agora = await self.repo.agora()
        pareamento = await self.repo.aguardando_por_codigo(codigo, agora)
        if pareamento is None:
            raise CodigoInvalido()

        pareamento.aparelho_user_id = usuario_id
        pareamento.aceito_em = agora
        pareamento.expira_em = agora + PRAZO_DO_PAREAMENTO
        # Um celular, um computador: o que este celular lia antes deixa de receber.
        for anterior in await self.repo.ativos_do_aparelho(
            usuario_id, agora, exceto_id=pareamento.id
        ):
            _encerrar(anterior, agora, MotivoEncerramento.TROCOU)

        await self.session.commit()
        return await self._montar(pareamento, agora)

    async def obter(self, pareamento_id: int, usuario: User) -> PareamentoOut:
        agora = await self.repo.agora()
        pareamento = await self.repo.obter(pareamento_id)
        if pareamento is None or usuario.id not in (
            pareamento.computador_user_id,
            pareamento.aparelho_user_id,
        ):
            raise NaoEncontrado("Leitor não encontrado.")
        return await self._montar(pareamento, agora)

    async def encerrar(self, pareamento_id: int, usuario: User) -> None:
        """Desliga. Quem desligou fica no motivo; o que já terminou fica como estava.

        Com o MESMO login nas duas pontas não há como saber de qual lado veio: conta como
        COMPUTADOR, que é quem gerou o pareamento.
        """
        usuario_id = usuario.id
        agora = await self.repo.agora()
        pareamento = await self.repo.obter(pareamento_id, travar=True)
        if pareamento is None:
            raise NaoEncontrado("Leitor não encontrado.")
        if usuario_id == pareamento.computador_user_id:
            motivo = MotivoEncerramento.COMPUTADOR
        elif usuario_id == pareamento.aparelho_user_id:
            motivo = MotivoEncerramento.CELULAR
        else:
            raise NaoEncontrado("Leitor não encontrado.")

        if status_do_pareamento(pareamento, agora) in (
            StatusPareamento.ENCERRADO,
            StatusPareamento.EXPIRADO,
        ):
            return
        _encerrar(pareamento, agora, motivo)
        await self.session.commit()

    # ------------------------------------------------------------------ bipes

    async def bipar(self, dados: BipeIn, usuario: User) -> BipeOut:
        usuario_id = usuario.id
        # A chave antes de tudo: o reenvio de um bipe que JÁ entrou responde 200 mesmo que,
        # nesse meio-tempo, o leitor tenha sido desligado — o bipe entrou, o celular só não
        # ficou sabendo.
        existente = await self.repo.bipe_por_client_uuid(dados.client_uuid)
        if existente is not None:
            return await self._replay(existente, dados, usuario_id)

        agora = await self.repo.agora()
        pareamento = await self.repo.obter(dados.pareamento_id)
        if pareamento is None or pareamento.aparelho_user_id != usuario_id:
            raise NaoEncontrado("Leitor não encontrado.")
        situacao = status_do_pareamento(pareamento, agora)
        if situacao != StatusPareamento.ATIVO:
            raise LeitorDesligado(detail={"status": situacao.value})
        if await self.repo.pendentes(pareamento.id) >= FILA_MAXIMA:
            raise FilaCheia()

        bipe = LeitorBipe(
            pareamento_id=pareamento.id, client_uuid=dados.client_uuid, codigo=dados.codigo
        )
        self.session.add(bipe)
        try:
            await self.session.flush()
        except IntegrityError:
            # O mesmo bipe em duas requisições ao mesmo tempo (o celular reenviou antes da
            # primeira responder): a perdedora devolve a vencedora.
            await self.session.rollback()
            # O rollback expirou o `usuario` (veio desta sessão): atributo expirado em sessão
            # async é MissingGreenlet. Recarrega antes de qualquer um ler.
            await self.session.refresh(usuario)
            existente = await self.repo.bipe_por_client_uuid(dados.client_uuid)
            if existente is None:
                raise
            return await self._replay(existente, dados, usuario_id)
        await self.session.commit()
        return _bipe_out(bipe)

    async def _replay(self, existente: LeitorBipe, dados: BipeIn, usuario_id: int) -> BipeOut:
        """O mesmo bipe reenviado é atendido; a MESMA chave com outro pedido não é.

        Outro código (ou outro computador) com a chave de um bipe que já entrou seria a
        leitura nova sumindo calada: 409 diz que a chave já foi usada. E o atalho não vira
        porta de leitura do bipe alheio: chave de outro celular também é 409, sem corpo.
        """
        aparelho = await self.repo.aparelho_do_pareamento(existente.pareamento_id)
        if (
            aparelho != usuario_id
            or existente.pareamento_id != dados.pareamento_id
            or existente.codigo != dados.codigo
        ):
            raise Duplicado("Esta leitura já foi enviada com outro código. Bipe de novo.")
        self.replay = True
        return _bipe_out(existente)

    async def retirar(self, pareamento_id: int, usuario: User) -> RetiradaOut:
        """Entrega a fila ao computador, uma vez só, e nada de aviso de tempo real.

        Pareamento que não está ATIVO não entrega nada: o que estava na fila é descartado
        (conta em `descartados`) e o status volta na resposta, para a tela saber que caiu.
        """
        agora = await self.repo.agora()
        pareamento = await self.repo.obter(pareamento_id)
        if pareamento is None or pareamento.computador_user_id != usuario.id:
            raise NaoEncontrado("Leitor não encontrado.")
        ativo = status_do_pareamento(pareamento, agora) == StatusPareamento.ATIVO

        linhas = await self.repo.consumir(
            pareamento.id, agora, limite=LOTE_DA_RETIRADA if ativo else None
        )
        validade = agora - PRAZO_DO_BIPE
        entregues = [
            BipeRetiradoOut(id=i, codigo=codigo, criado_em=em)
            for i, codigo, em in linhas
            if ativo and em >= validade
        ]
        await self.session.commit()
        return RetiradaOut(
            items=entregues,
            descartados=len(linhas) - len(entregues),
            pareamento=await self._montar(pareamento, agora),
        )

    # ------------------------------------------------------------------ montagem

    async def _montar(self, p: LeitorPareamento, agora: datetime) -> PareamentoOut:
        nomes = await self.repo.nomes(p.computador_user_id, p.aparelho_user_id)
        return PareamentoOut(
            id=p.id,
            codigo=p.codigo,
            status=status_do_pareamento(p, agora),
            computador_nome=nomes.get(p.computador_user_id, ""),
            aparelho_nome=nomes.get(p.aparelho_user_id) if p.aparelho_user_id else None,
            criado_em=p.criado_em,
            codigo_expira_em=p.codigo_expira_em,
            aceito_em=p.aceito_em,
            expira_em=p.expira_em,
            encerrado_em=p.encerrado_em,
            motivo_encerramento=(
                MotivoEncerramento(p.motivo_encerramento) if p.motivo_encerramento else None
            ),
        )


def _bipe_out(b: LeitorBipe) -> BipeOut:
    return BipeOut(
        id=b.id,
        client_uuid=b.client_uuid,
        pareamento_id=b.pareamento_id,
        codigo=b.codigo,
        criado_em=b.criado_em,
    )
