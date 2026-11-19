"""O celular como leitor de código de barras do computador (ADR-43, ADR-47).

O fluxo inteiro, do jeito que a loja vê:

1. No computador (PDV, Devolução, Entrada, Inventário, Condicional nova), quem está logado
   toca em "Abrir no app o leitor de código": sai um CHAMADO para o celular do MESMO login,
   com um sinal de 3 caracteres que aparece nas duas telas (ADR-47). O app aberto mostra a
   faixa "O computador está chamando"; com o app fechado, chega a notificação (quando a loja
   liga o push). Um toque em "Abrir o leitor" atende — sem código.
2. O caminho de antes continua como alternativa (e é o do celular de OUTRA pessoa): o
   computador mostra um código de 6 caracteres e um QR, válidos por 5 min, e qualquer pessoa
   da equipe logada lê o QR (ou digita o código).
3. Ligado, o celular é o leitor daquele computador por até 12 h, ou até alguém desligar.
   Cada bipe na câmera vira uma linha em `leitor_bipes`; o commit avisa "leitor" pelo tempo
   real e o computador RETIRA a fila, que cai no campo do leitor como se fosse o leitor USB.

O que trafega no aviso é só o assunto, nunca o código lido nem o sinal: quem busca é a rota
REST, com o dono do pareamento conferido.

A fronteira de segurança do chamado é o LOGIN, não a pessoa: com o mesmo login em vários
caixas, quem desambigua é o sinal, comparado por gente. O vínculo estrito é o QR.
"""

import math
import re
import secrets
import uuid
from datetime import datetime, timedelta

from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from starlette import status as http

from app.core.exceptions import AppError, Duplicado, NaoEncontrado, OperacaoInvalida
from app.core.pagination import Pagina, Paginacao
from app.modules.leitor.models import LeitorBipe, LeitorPareamento, MotivoEncerramento
from app.modules.leitor.repository import LeitorRepository
from app.modules.leitor.schemas import (
    AceiteIn,
    AtendimentoIn,
    BipeIn,
    BipeOut,
    BipeRetiradoOut,
    ChamadoAbertoOut,
    ChamadoIn,
    ChamadoOut,
    PareamentoIn,
    PareamentoOut,
    PontaDoLeitor,
    RetiradaOut,
    StatusPareamento,
)
from app.modules.notificacoes.service import NotificacoesService
from app.modules.usuarios.models import User

#: Sem 0/O e 1/I: o código é lido em voz alta e digitado no celular. Espelho de
#: `web/js/leitor-remoto.js` e `mobile/src/lib/leitorRemoto.ts`.
ALFABETO = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"
TAMANHO_DO_CODIGO = 6
_FORMATO_DO_CODIGO = re.compile(r"^[2-9A-HJ-NP-Z]{6}$")

#: O sinal do chamado (ADR-47): dígito-letra-dígito, sem 0/O e 1/I, e sem formar palavra.
#: 8 × 24 × 8 = 1536 sinais — não é segredo (o chamado só serve ao próprio login): só escolhe,
#: entre os chamados abertos do login, o da tela de cada um. Espelho do formato nas pontas.
DIGITOS_DO_SINAL = "23456789"
LETRAS_DO_SINAL = "ABCDEFGHJKLMNPQRSTUVWXYZ"
FORMATO_DO_SINAL = re.compile(r"^[2-9][A-HJ-NP-Z][2-9]$")

#: O código na tela serve para ser lido agora. Depois disso, gere outro. É também o prazo do
#: chamado, e o mesmo valor é o `ttl` do push.
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
#: Entre um chamado e outro do MESMO login. Segura o laço e a rajada (um clique repetido seria
#: um push por clique em todo celular do login) sem fazer esperar quem perdeu a notificação e
#: toca em "Chamar de novo".
INTERVALO_ENTRE_CHAMADOS = timedelta(seconds=2)
#: Sorteios até achar um código livre. Com 32^6 códigos, passar de 1 já é raro.
_TENTATIVAS_DE_CODIGO = 8
#: Sorteios até achar um sinal que nenhum chamado vivo do login usa (são no máximo 10).
_TENTATIVAS_DE_SINAL = 8


class CodigoInvalido(AppError):
    """A MESMA resposta para código inexistente, vencido, já aceito por outro ou encerrado: a
    tela não precisa saber qual foi, e quem testa códigos não aprende nada com a diferença.
    (O reenvio de quem já aceitou não cai aqui: recebe o pareamento dele — `aceitar`.)"""

    code = "LEITOR_CODIGO_INVALIDO"
    http_status = http.HTTP_404_NOT_FOUND
    message = "Código não encontrado ou vencido. Gere outro no computador."


class ChamadoInvalido(AppError):
    """O mesmo molde do `CodigoInvalido`: UMA resposta, com o mesmo corpo, para o chamado que
    não existe, é de outro login, é pareamento de QR, venceu, foi cancelado ou substituído, ou
    já foi atendido (por esta ou por outra instalação). Sem oráculo."""

    code = "LEITOR_CHAMADO_INVALIDO"
    http_status = http.HTTP_404_NOT_FOUND
    message = (
        "Este chamado venceu, foi cancelado ou já foi atendido. Toque de novo no botão do "
        "computador."
    )


class LeitorJaLigado(AppError):
    """O pareamento que a aba quer trocar está ATIVO: trocar desligaria um celular sem linha
    no diário. Quem quer chamar outro desliga antes (DELETE, que vai ao diário)."""

    code = "LEITOR_JA_LIGADO"
    http_status = http.HTTP_409_CONFLICT
    message = (
        "Este computador já tem um celular ligado como leitor. Desligue antes de chamar outro."
    )


class ChamadoRapido(AppError):
    code = "LEITOR_CHAMADO_RAPIDO"
    http_status = http.HTTP_429_TOO_MANY_REQUESTS
    message = "Espere um instante antes de chamar o celular de novo."


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


def gerar_sinal() -> str:
    return (
        secrets.choice(DIGITOS_DO_SINAL)
        + secrets.choice(LETRAS_DO_SINAL)
        + secrets.choice(DIGITOS_DO_SINAL)
    )


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
    # Pelo ORM de propósito: o commit avisa "leitor_pareamento" e a outra ponta refaz o status.
    p.encerrado_em = agora
    p.motivo_encerramento = motivo.value


class LeitorService:
    def __init__(self, session: AsyncSession):
        self.session = session
        self.repo = LeitorRepository(session)
        #: True no replay idempotente — o bipe que já existia (o router responde 200), o
        #: chamado reenviado com a mesma chave (200, sem push de novo), ou o aceite/atender
        #: reenviado por quem já ligou (nada mudou: fora do diário).
        self.replay = False

    # ------------------------------------------------------------------ pareamento por QR

    async def criar(self, dados: PareamentoIn, usuario: User) -> PareamentoOut:
        usuario_id = usuario.id
        agora = await self.repo.agora()
        await self.repo.faxina(agora)
        await self._substituir(dados.substitui_id, usuario_id, agora)
        self._aplicar_teto(await self._vivos(usuario_id, agora), agora)
        novo = await self._novo_pareamento(usuario_id, agora)
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
            # O reenvio de quem JÁ aceitou este código (a resposta se perdeu: Wi-Fi fraco,
            # partida a frio) recebe o mesmo pareamento, sem mudar nada — senão o celular
            # ficaria sem leitor e o computador com ele ligado. Só muda a resposta para o
            # próprio dono do aceite (e, no app novo, para a MESMA instalação): quem testa
            # códigos continua vendo o 404 de sempre.
            meu = await self.repo.aceito_pelo_aparelho(
                codigo, usuario_id, agora, instalacao=dados.instalacao
            )
            if meu is None:
                raise CodigoInvalido()
            self.replay = True
            return await self._montar(meu, agora)

        await self._ligar(pareamento, usuario_id, dados.instalacao, agora)
        await self.session.commit()
        return await self._montar(pareamento, agora)

    # ------------------------------------------------------------------ chamado (ADR-47)

    async def chamar(self, dados: ChamadoIn, usuario: User) -> ChamadoOut:
        """O computador chama o celular do próprio login.

        O chamado é um pareamento como o do QR, com `chamado`, `sinal` e `client_uuid`. O
        código continua sorteado (o NOT NULL e o UNIQUE parcial pedem), mas nunca sai em
        resposta e nunca abre aceite: quem atende é o mesmo login, pelo id, sem código.
        """
        usuario_id = usuario.id
        # A chave antes de tudo: o reenvio (F5 no meio, rede que caiu) devolve o MESMO
        # chamado, sem push de novo — senão sobraria um órfão que o celular poderia atender.
        existente = await self.repo.chamado_por_client_uuid(dados.client_uuid)
        if existente is not None:
            return await self._replay_do_chamado(existente, usuario_id)
        # A trava do aceite: chamar e atender do mesmo login se enfileiram, e dois POST com a
        # mesma chave esperam aqui — o segundo relê a chave e vira replay.
        await self.repo.travar_aparelho(usuario_id)
        existente = await self.repo.chamado_por_client_uuid(dados.client_uuid)
        if existente is not None:
            return await self._replay_do_chamado(existente, usuario_id)

        agora = await self.repo.agora()
        await self.repo.faxina(agora)
        ultimo = await self.repo.ultimo_chamado_em(usuario_id)
        if ultimo is not None and agora - ultimo < INTERVALO_ENTRE_CHAMADOS:
            falta = (INTERVALO_ENTRE_CHAMADOS - (agora - ultimo)).total_seconds()
            teto = math.ceil(INTERVALO_ENTRE_CHAMADOS.total_seconds())
            raise ChamadoRapido(detail={"retry_after": min(teto, max(1, math.ceil(falta)))})

        await self._substituir(dados.substitui_id, usuario_id, agora)
        vivos = await self._vivos(usuario_id, agora)
        self._aplicar_teto(vivos, agora)
        sinal = self._sortear_sinal({p.sinal for p in vivos if p.chamado and p.sinal})
        novo = await self._novo_pareamento(
            usuario_id, agora, chamado=True, sinal=sinal, client_uuid=dados.client_uuid
        )
        # O chamado vai para o banco ANTES do push: o app aberto o vê pela faixa mesmo que a
        # Expo demore, e o celular que tocar na notificação acha o chamado já gravado.
        await self.session.commit()
        pareamento = await self._montar(novo, agora)
        aviso = await NotificacoesService(self.session).avisar_chamado_do_leitor(
            usuario_id, sinal, validade_s=int(PRAZO_DO_CODIGO.total_seconds())
        )
        return ChamadoOut(
            pareamento=pareamento, notificacao=aviso.situacao, celulares=aviso.celulares
        )

    async def chamados_abertos(
        self, usuario: User, paginacao: Paginacao
    ) -> Pagina[ChamadoAbertoOut]:
        """O que o celular deste login pode atender agora: os chamados que esperam, do mais
        novo ao mais velho. Nunca o código nem nomes — o sinal é o que a pessoa confere."""
        agora = await self.repo.agora()
        chamados, total = await self.repo.chamados_abertos(
            usuario.id, agora, offset=paginacao.offset, limite=paginacao.limit
        )
        return Pagina[ChamadoAbertoOut].montar(
            [
                ChamadoAbertoOut(
                    id=p.id, sinal=p.sinal or "", criado_em=p.criado_em, vence_em=p.codigo_expira_em
                )
                for p in chamados
            ],
            total,
            paginacao,
        )

    async def atender(
        self, pareamento_id: int, dados: AtendimentoIn, usuario: User
    ) -> PareamentoOut:
        """O celular atende o chamado do próprio login: vira o leitor daquele computador.

        A ordem das travas é a do aceite: a advisory do login, a linha do chamado, os ativos
        do aparelho. Dois aparelhos do mesmo login atendendo juntos: um liga, o outro recebe
        o 404 de sempre (a linha já está aceita quando ele a lê).
        """
        usuario_id = usuario.id
        await self.repo.travar_aparelho(usuario_id)
        agora = await self.repo.agora()
        chamado = await self.repo.chamado_para_atender(pareamento_id, usuario_id, agora)
        if chamado is None:
            # O reenvio da MESMA instalação (a resposta se perdeu) recebe o mesmo pareamento,
            # sem mudar nada. Um segundo aparelho do mesmo login não: para ele, é o 404.
            meu = await self.repo.atendido_pela_instalacao(
                pareamento_id, usuario_id, dados.instalacao, agora
            )
            if meu is None:
                raise ChamadoInvalido()
            self.replay = True
            return await self._montar(meu, agora)

        await self._ligar(chamado, usuario_id, dados.instalacao, agora)
        await self.session.commit()
        return await self._montar(chamado, agora)

    # ------------------------------------------------------------------ as duas pontas

    async def obter(self, pareamento_id: int, usuario: User) -> PareamentoOut:
        agora = await self.repo.agora()
        pareamento = await self.repo.obter(pareamento_id)
        if pareamento is None or usuario.id not in (
            pareamento.computador_user_id,
            pareamento.aparelho_user_id,
        ):
            raise NaoEncontrado("Leitor não encontrado.")
        return await self._montar(pareamento, agora)

    async def encerrar(
        self, pareamento_id: int, usuario: User, ponta: PontaDoLeitor | None = None
    ) -> bool:
        """Desliga. Quem desligou fica no motivo; o que já terminou fica como estava.

        Com o MESMO login nas duas pontas (o chamado, sempre; o QR, às vezes) só a ponta que
        pede sabe de que lado está: o app manda `?ponta=celular` e fica CELULAR. Sem ela,
        conta como COMPUTADOR, que é quem gerou o pareamento.

        Devolve se havia um celular LIGADO (ATIVO) e ele foi desligado — só isso é ato para o
        diário. Encerrar um código que ninguém leu (AGUARDANDO) tira o código de circulação,
        mas não desliga celular nenhum; o que já tinha terminado não muda nada.
        """
        usuario_id = usuario.id
        agora = await self.repo.agora()
        pareamento = await self.repo.obter(pareamento_id, travar=True)
        if pareamento is None:
            raise NaoEncontrado("Leitor não encontrado.")
        eh_aparelho = usuario_id == pareamento.aparelho_user_id
        eh_computador = usuario_id == pareamento.computador_user_id
        if eh_aparelho and (ponta == "celular" or not eh_computador):
            motivo = MotivoEncerramento.CELULAR
        elif eh_computador:
            motivo = MotivoEncerramento.COMPUTADOR
        else:
            raise NaoEncontrado("Leitor não encontrado.")

        antes = status_do_pareamento(pareamento, agora)
        if antes in (StatusPareamento.ENCERRADO, StatusPareamento.EXPIRADO):
            return False
        _encerrar(pareamento, agora, motivo)
        await self.session.commit()
        return antes == StatusPareamento.ATIVO

    async def esquecer_usuario(self, user_id: int) -> None:
        """A conta foi excluída mas a linha dela ficou, presa ao histórico da loja (ADR-45).

        Pareamento não é histórico: some como o CASCADE o levaria se a linha tivesse saído
        (os bipes vão junto), chamados inclusive. Pelo ORM de propósito — o commit avisa, e o
        computador que esperava bipe deste celular descobre na hora. Quem chama faz o commit,
        junto com o resto da exclusão.
        """
        for pareamento in await self.repo.do_usuario(user_id):
            await self.session.delete(pareamento)

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
        # Ligado por um app que diz qual instalação é (ADR-47): só ela bipa. O segundo
        # aparelho do mesmo login recebe o mesmo 404 de quem não é o celular — o app já trata
        # esse 404 como leitor desligado.
        if (
            pareamento.aparelho_instalacao is not None
            and pareamento.aparelho_instalacao != dados.instalacao
        ):
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

    # ------------------------------------------------------------------ peças comuns

    async def _substituir(
        self, substitui_id: int | None, usuario_id: int, agora: datetime
    ) -> None:
        """O pareamento AGUARDANDO desta aba sai de circulação (código novo, chamado novo).

        Lido com FOR UPDATE: um aceite no meio espera, e quem chega depois lê a linha como o
        outro a deixou. ATIVO não se troca (`LeitorJaLigado`): desligaria um celular sem
        linha no diário. Id de outra pessoa, que não existe ou que já terminou é ignorado:
        uma aba velha mandando o que tinha não é motivo para recusar o novo.
        """
        if substitui_id is None:
            return
        antigo = await self.repo.obter(substitui_id, travar=True)
        if antigo is None or antigo.computador_user_id != usuario_id:
            return
        situacao = status_do_pareamento(antigo, agora)
        if situacao == StatusPareamento.ATIVO:
            raise LeitorJaLigado(detail={"pareamento_id": antigo.id})
        if situacao == StatusPareamento.AGUARDANDO:
            _encerrar(antigo, agora, MotivoEncerramento.SUBSTITUIDO)
            # Gravado já: a releitura dos vivos (`populate_existing`) passaria por cima da
            # mudança ainda só em memória.
            await self.session.flush()

    async def _vivos(self, usuario_id: int, agora: datetime) -> list[LeitorPareamento]:
        return [
            p
            for p in await self.repo.vivos_do_computador(usuario_id, agora)
            if p.encerrado_em is None
        ]

    @staticmethod
    def _aplicar_teto(vivos: list[LeitorPareamento], agora: datetime) -> None:
        # Do mais novo ao mais velho; o que vai nascer conta como um.
        for velho in vivos[TETO_POR_COMPUTADOR - 1 :]:
            _encerrar(velho, agora, MotivoEncerramento.SUBSTITUIDO)

    @staticmethod
    def _sortear_sinal(em_uso: set[str]) -> str:
        # A trava do login serializa os chamados dele: nenhum outro sorteia junto.
        sinal = gerar_sinal()
        for _ in range(_TENTATIVAS_DE_SINAL - 1):
            if sinal not in em_uso:
                break
            sinal = gerar_sinal()
        return sinal

    async def _novo_pareamento(
        self,
        usuario_id: int,
        agora: datetime,
        *,
        chamado: bool = False,
        sinal: str | None = None,
        client_uuid: uuid.UUID | None = None,
    ) -> LeitorPareamento:
        """Sorteia o código e grava. Num chamado o código continua sorteado — o NOT NULL e o
        UNIQUE parcial pedem —, mas nunca sai em resposta nem abre aceite."""
        for _ in range(_TENTATIVAS_DE_CODIGO):
            novo = LeitorPareamento(
                codigo=gerar_codigo(),
                computador_user_id=usuario_id,
                criado_em=agora,
                codigo_expira_em=agora + PRAZO_DO_CODIGO,
                chamado=chamado,
                sinal=sinal,
                client_uuid=client_uuid,
            )
            if await self.repo.inserir(novo):
                break
            if client_uuid is not None and await self.repo.chamado_por_client_uuid(client_uuid):
                # Não foi o código: outro login gravou esta chave agora (o mesmo login espera
                # na trava e relê a chave antes de chegar aqui).
                raise Duplicado("Esta chave já foi usada em outro chamado. Chame de novo.")
        else:  # pragma: no cover - 8 colisões seguidas em 1 bilhão de códigos
            raise OperacaoInvalida("Não foi possível gerar um código agora. Tente de novo.")
        return novo

    async def _ligar(
        self,
        pareamento: LeitorPareamento,
        usuario_id: int,
        instalacao: uuid.UUID | None,
        agora: datetime,
    ) -> None:
        """O aceite (QR) e o atender (chamado) terminam igual: o celular vira o leitor."""
        pareamento.aparelho_user_id = usuario_id
        pareamento.aparelho_instalacao = instalacao
        pareamento.aceito_em = agora
        pareamento.expira_em = agora + PRAZO_DO_PAREAMENTO
        # Um celular, um computador — por aparelho (ADR-47): o que ESTA instalação lia antes
        # deixa de receber. O outro aparelho do mesmo login continua no computador dele.
        for anterior in await self.repo.ativos_do_aparelho(
            usuario_id, agora, exceto_id=pareamento.id, instalacao=instalacao
        ):
            _encerrar(anterior, agora, MotivoEncerramento.TROCOU)

    async def _replay_do_chamado(
        self, existente: LeitorPareamento, usuario_id: int
    ) -> ChamadoOut:
        if existente.computador_user_id != usuario_id:
            raise Duplicado("Esta chave já foi usada em outro chamado. Chame de novo.")
        self.replay = True
        agora = await self.repo.agora()
        return ChamadoOut(
            pareamento=await self._montar(existente, agora), notificacao=None, celulares=0
        )

    # ------------------------------------------------------------------ montagem

    async def _montar(self, p: LeitorPareamento, agora: datetime) -> PareamentoOut:
        nomes = await self.repo.nomes(p.computador_user_id, p.aparelho_user_id)
        return PareamentoOut(
            id=p.id,
            # O código do chamado é só o que o NOT NULL pede: nunca sai, nunca abre aceite.
            codigo=None if p.chamado else p.codigo,
            status=status_do_pareamento(p, agora),
            chamado=p.chamado,
            sinal=p.sinal,
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
