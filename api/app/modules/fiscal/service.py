"""Regras da NFC-e (ADR-41): emitir, consultar e cancelar junto com a venda.

Três promessas que este arquivo cumpre:

1. **Nota autorizada não se emite de novo.** "Emitir" numa venda com nota autorizada
   devolve a mesma nota; dois cliques simultâneos esperam um pelo outro (trava na linha).
2. **Falha fiscal nunca impede vender.** A venda grava sem passar por aqui; a emissão vem
   depois — pelo botão, ou sozinha (`automatico.py`) — e o que der errado fica na nota,
   com a mensagem, para tentar de novo.
3. **Venda com nota autorizada só se cancela se a nota se cancelar.** A nota vai ao
   emissor ANTES; se ele recusar (prazo de 30 minutos da SEFAZ, sem internet...), a venda
   continua concluída e a tela diz por quê. O contrário — venda cancelada e nota valendo —
   é imposto sobre uma venda que não existe.
"""

from datetime import datetime

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.exceptions import OperacaoInvalida, Validacao
from app.modules.catalogo.service import CatalogoService
from app.modules.configuracao.service import ConfiguracaoService
from app.modules.fiscal import emissores
from app.modules.fiscal.emissores import (
    DadosFiscaisIncompletos,
    Emissor,
    NotaParaEmitir,
    Resultado,
)
from app.modules.fiscal.models import Ambiente, NotaFiscal, StatusNota
from app.modules.fiscal.nfce import DadosDaLoja, montar_nota, o_que_falta
from app.modules.fiscal.repository import FiscalRepository, nova_referencia
from app.modules.fiscal.schemas import EmissorOut, NfceOut, NotaOut
from app.modules.usuarios.models import User
from app.modules.vendas.models import StatusVenda
from app.modules.vendas.schemas import VendaOut
from app.modules.vendas.service import VendaService

#: Mínimo da SEFAZ para a justificativa do cancelamento (e máximo, 255).
JUSTIFICATIVA_MINIMA = 15
JUSTIFICATIVA_MAXIMA = 255


def emissor_out() -> EmissorOut:
    estado = emissores.estado_do_emissor()
    return EmissorOut(
        nome=estado.nome,
        ambiente=estado.ambiente,
        configurado=estado.configurado,
        faltando=estado.faltando,
        emitir_automatico=settings.fiscal_emitir_automatico,
    )


def _resumo(nota: NotaFiscal) -> dict:
    return {"status": nota.status, "chave": nota.chave, "mensagem": nota.mensagem}


class FiscalService:
    def __init__(self, session: AsyncSession):
        self.session = session
        self.repo = FiscalRepository(session)

    async def _out(self, venda_id: int, nota: NotaFiscal | None) -> NfceOut:
        if nota is not None:
            # `updated_at` é do banco (onupdate): depois do commit, só relendo.
            await self.session.refresh(nota)
        return NfceOut(
            venda_id=venda_id,
            emissor=emissor_out(),
            nota=NotaOut.model_validate(nota) if nota is not None else None,
        )

    # ------------------------------------------------------------------ leitura
    async def obter(self, venda_id: int, usuario: User) -> NfceOut:
        # A venda decide quem enxerga: a vendedora vê a nota só das vendas dela.
        await VendaService(self.session).obter(venda_id, usuario)
        return await self._out(venda_id, await self.repo.por_venda(venda_id))

    # ------------------------------------------------------------------ emissão
    async def emitir(self, venda_id: int, usuario: User) -> NfceOut:
        emissor = emissores.emissor_configurado()  # 409 com o que falta no .env
        vendas = VendaService(self.session)
        venda = await vendas.obter(venda_id, usuario)

        existente = await self.repo.por_venda(venda_id)
        if (
            existente is not None
            and existente.status == StatusNota.AUTORIZADA
            and self._mesma_origem(existente, emissor)
        ):
            return await self._out(venda_id, existente)  # idempotente: autorizada não reemite
        if venda.status != StatusVenda.CONCLUIDA:
            raise OperacaoInvalida("Venda cancelada não emite NFC-e.")

        nota_para_emitir = await self._preparar(venda)

        # A referência fica gravada ANTES do primeiro envio (ver models.py): se o processo
        # cair no meio da chamada, a próxima tentativa acha o que o emissor já fez.
        await self.repo.garantir(venda_id, emissor=emissor.nome, ambiente=emissor.ambiente)
        await self.session.commit()

        nota = await self.repo.por_venda(venda_id, travar=True)
        assert nota is not None
        # Relida COM a nota travada: um cancelamento que terminou enquanto este pedido
        # esperava não pode ganhar uma nota de presente.
        venda = await vendas.obter(venda_id, usuario)
        if venda.status != StatusVenda.CONCLUIDA:
            await self.session.rollback()
            raise OperacaoInvalida("Venda cancelada não emite NFC-e.")

        if not self._mesma_origem(nota, emissor):
            if not self._pode_recomecar(nota):
                await self.session.rollback()
                raise OperacaoInvalida(
                    f"A NFC-e desta venda é do emissor '{nota.emissor}' em {nota.ambiente} "
                    f"(situação: {nota.status}). Emitir por outro emissor ou ambiente "
                    "deixaria a venda com duas notas: confira no painel dele primeiro.",
                    {"nfce": _resumo(nota)},
                )
            self._recomecar(nota, emissor)

        if nota.status == StatusNota.AUTORIZADA:
            # Outro pedido autorizou enquanto este esperava a trava.
            await self.session.commit()
            return await self._out(venda_id, nota)
        if nota.status == StatusNota.CANCELADA:
            await self.session.rollback()
            raise OperacaoInvalida("A NFC-e desta venda foi cancelada.", {"nfce": _resumo(nota)})

        if nota.status == StatusNota.PENDENTE and nota.tentativas > 0:
            # Já foi enviada e não teve resposta: pergunta antes de reenviar.
            consulta = await emissor.consultar(nota.referencia)
            if consulta.encontrada and consulta.status != StatusNota.REJEITADA:
                self._aplicar(nota, consulta)
                await self.session.commit()
                return await self._out(venda_id, nota)

        nota.tentativas += 1
        self._aplicar(nota, await emissor.emitir(nota.referencia, nota_para_emitir))
        await self.session.commit()
        return await self._out(venda_id, nota)

    async def emitir_pelo_sistema(self, venda_id: int, vendedor_id: int) -> NfceOut:
        """Emissão automática depois da venda, em nome de quem vendeu (`automatico.py`)."""
        from app.modules.usuarios.service import UsuarioService

        vendedora = await UsuarioService(self.session).obter(vendedor_id)
        return await self.emitir(venda_id, vendedora)

    async def _preparar(self, venda: VendaOut) -> NotaParaEmitir:
        config = await ConfiguracaoService(self.session).obter()
        loja = DadosDaLoja(
            documento=config.documento,
            inscricao_estadual=config.inscricao_estadual,
            regime_tributario=config.regime_tributario,
            serie_nfce=config.serie_nfce,
        )
        pecas = await CatalogoService(self.session).dados_fiscais_das_pecas(
            [item.variante_id for item in venda.itens]
        )
        faltando, sem_ncm = o_que_falta(loja, pecas)
        faltando.extend(
            f"Peça #{item.variante_id} não encontrada no catálogo"
            for item in venda.itens
            if item.variante_id not in pecas
        )
        if faltando:
            raise DadosFiscaisIncompletos(
                "Faltam dados fiscais para emitir a NFC-e desta venda.",
                {"faltando": faltando, "produtos_sem_ncm": sem_ncm},
            )
        return montar_nota(venda, loja, pecas, datetime.now(settings.tz_loja))

    # ------------------------------------------------------------------ cancelamento
    async def cancelar_nota_da_venda(self, venda_id: int, justificativa: str) -> None:
        """Chamado por `VendaService.cancelar`, dentro da transação dele, ANTES de a venda
        mudar de vez. Lança `AppError` para recusar o cancelamento da venda; não faz commit
        (quem confirma tudo junto é a venda)."""
        nota = await self.repo.por_venda(venda_id, travar=True)
        if nota is None or nota.status in (StatusNota.REJEITADA, StatusNota.CANCELADA):
            return  # nada vale na SEFAZ: a venda segue

        estado = emissores.estado_do_emissor()
        homologacao_ligada = (
            estado.configurado
            and estado.nome == nota.emissor
            and estado.ambiente == Ambiente.HOMOLOGACAO
        )
        if nota.ambiente == Ambiente.HOMOLOGACAO and not homologacao_ligada:
            # Nota de teste, sem valor fiscal (a loja já foi para produção ou desligou o
            # emissor). Não há imposto a desfazer, e ela não pode segurar a venda.
            return

        emissor = emissores.emissor_da_nota(nota.emissor)  # 409 se o emissor sumiu do .env
        if emissor.ambiente != nota.ambiente:
            raise OperacaoInvalida(
                f"A NFC-e desta venda é de {nota.ambiente}, e o servidor está em "
                f"{emissor.ambiente}: ela só pode ser cancelada no ambiente em que nasceu.",
                {"nfce": _resumo(nota)},
            )

        if nota.status == StatusNota.PENDENTE:
            # Sem resposta definitiva: pode ter sido autorizada. Pergunta antes.
            consulta = await emissor.consultar(nota.referencia)
            if not consulta.encontrada or consulta.status == StatusNota.REJEITADA:
                nota.status = StatusNota.REJEITADA
                nota.mensagem = (
                    "Venda cancelada antes de a NFC-e ser autorizada: nenhuma nota vale."
                )
                return
            self._aplicar(nota, consulta)
            if nota.status == StatusNota.CANCELADA:
                return
            if nota.status != StatusNota.AUTORIZADA:
                raise OperacaoInvalida(
                    "A NFC-e desta venda ainda não tem resposta definitiva do emissor "
                    "(processando na SEFAZ, ou sem internet). Espere um minuto e cancele de "
                    "novo — cancelar agora poderia deixar uma nota valendo.",
                    {"nfce": _resumo(nota)},
                )

        texto = " ".join(justificativa.split())
        if len(texto) < JUSTIFICATIVA_MINIMA:
            raise Validacao(
                "Esta venda tem NFC-e autorizada: o motivo do cancelamento vai para a SEFAZ "
                f"e precisa de pelo menos {JUSTIFICATIVA_MINIMA} caracteres.",
                {"minimo": JUSTIFICATIVA_MINIMA},
            )
        resposta = await emissor.cancelar(nota.referencia, texto[:JUSTIFICATIVA_MAXIMA])
        if resposta.status != StatusNota.CANCELADA:
            raise OperacaoInvalida(
                "O emissor fiscal não cancelou a NFC-e desta venda, então a venda também "
                f"NÃO foi cancelada. Resposta: {resposta.mensagem or 'sem resposta'}. "
                "A SEFAZ só cancela NFC-e até 30 minutos depois da autorização; passado "
                "isso, registre a Devolução das peças (e veja com o contador a nota de "
                "devolução).",
                {"nfce": {**_resumo(nota), "resposta_do_emissor": resposta.mensagem}},
            )
        self._aplicar(nota, resposta)

    # ------------------------------------------------------------------ apoio
    @staticmethod
    def _mesma_origem(nota: NotaFiscal, emissor: Emissor) -> bool:
        return nota.emissor == emissor.nome and nota.ambiente == emissor.ambiente

    @staticmethod
    def _pode_recomecar(nota: NotaFiscal) -> bool:
        """Trocar de emissor/ambiente só larga a nota antiga quando ela não vale nada:
        de homologação (sem valor fiscal), rejeitada, ou que nunca chegou a ser enviada."""
        return (
            nota.ambiente == Ambiente.HOMOLOGACAO
            or nota.status == StatusNota.REJEITADA
            or (nota.status == StatusNota.PENDENTE and nota.tentativas == 0)
        )

    @staticmethod
    def _recomecar(nota: NotaFiscal, emissor: Emissor) -> None:
        nota.emissor = emissor.nome
        nota.ambiente = emissor.ambiente
        nota.referencia = nova_referencia(nota.sale_id)
        nota.status = StatusNota.PENDENTE
        nota.tentativas = 0
        for campo in ("numero", "serie", "chave", "protocolo", "url_danfe", "url_xml"):
            setattr(nota, campo, None)
        nota.autorizada_em = None
        nota.cancelada_em = None
        nota.mensagem = None

    @staticmethod
    def _aplicar(nota: NotaFiscal, resultado: Resultado) -> None:
        if resultado.status is None:
            return
        agora = datetime.now(settings.tz_loja)
        chave = resultado.chave or nota.chave
        if resultado.status == StatusNota.AUTORIZADA and not chave:
            # Autorizada sem chave não se consulta nem se cancela: fica pendente, e a
            # próxima tentativa consulta o emissor de novo.
            nota.status = StatusNota.PENDENTE
            nota.mensagem = "O emissor disse 'autorizada' sem mandar a chave. Consulte de novo."
            return
        nota.status = resultado.status
        nota.mensagem = resultado.mensagem
        nota.numero = resultado.numero if resultado.numero is not None else nota.numero
        nota.serie = resultado.serie if resultado.serie is not None else nota.serie
        nota.chave = chave
        nota.url_danfe = resultado.url_danfe or nota.url_danfe
        nota.url_xml = resultado.url_xml or nota.url_xml
        if resultado.status == StatusNota.AUTORIZADA:
            nota.protocolo = resultado.protocolo or nota.protocolo
            nota.autorizada_em = nota.autorizada_em or agora
        if resultado.status == StatusNota.CANCELADA:
            nota.cancelada_em = nota.cancelada_em or agora
