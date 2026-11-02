"""Contas a pagar do fornecedor (ADR-40).

Duas portas criam conta: a Entrada de mercadoria, com a nota do fornecedor (na MESMA
transação da entrada, e idempotente pela chave dela), e o lançamento avulso. Ver, pagar e
lançar é de quem vê o dinheiro da loja; quem chama já passou pelo crachá no router.

Nada daqui entra no Resultado: o custo da mercadoria já está no CMV (ver `models.py`).
"""

from datetime import UTC, date, datetime, timedelta
from decimal import Decimal

from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.datas import hoje_na_loja
from app.core.exceptions import Duplicado, NaoEncontrado, OperacaoInvalida, Validacao
from app.core.pagination import Pagina, Paginacao
from app.modules.contas_pagar.models import Payable
from app.modules.contas_pagar.repository import ContaPagarRepository
from app.modules.contas_pagar.schemas import (
    ContaPagarIn,
    ContaPagarOut,
    ContaPagarUpdate,
    FaixaOut,
    FiltroContas,
    LancamentoContasOut,
    NotaFornecedorIn,
    PagamentoContaIn,
    ResumoContasOut,
    SituacaoConta,
)
from app.modules.usuarios.models import User


def _assinatura(numero: str | None, parcelas: list[tuple[date, Decimal]]) -> tuple:
    """O que torna duas notas a MESMA nota: número e o calendário de parcelas."""
    return ((numero or "").strip(), sorted(parcelas))


class ContaPagarService:
    def __init__(self, session: AsyncSession):
        self.session = session
        self.repo = ContaPagarRepository(session)
        #: O último `lancar`/`pagar` devolveu o que já existia (ADR-2). O router lê para
        #: responder 200 em vez de 201.
        self.replay = False

    # ------------------------------------------------------------ montar
    def montar(self, conta: Payable, hoje: date | None = None) -> ContaPagarOut:
        hoje = hoje or hoje_na_loja()
        if conta.paid_on is not None:
            situacao = SituacaoConta.PAGA
        elif conta.due_date < hoje:
            situacao = SituacaoConta.VENCIDA
        else:
            situacao = SituacaoConta.ABERTA
        return ContaPagarOut(
            id=conta.id,
            fornecedor=conta.supplier,
            descricao=conta.description,
            numero_nota=conta.invoice_number,
            valor=conta.amount,
            vencimento=conta.due_date,
            parcela=conta.installment_number,
            parcelas=conta.installment_count,
            situacao=situacao,
            dias_para_vencer=(conta.due_date - hoje).days,
            paga_em=conta.paid_on,
            forma_pagamento=conta.payment_method,
            entrada_id=conta.entry_id,
            observacao=conta.note,
            ativo=conta.deleted_at is None,
            criada_em=conta.created_at,
        )

    def _parcelas(
        self,
        nota: NotaFornecedorIn,
        *,
        fornecedor: str,
        descricao: str,
        usuario_id: int,
        entrada_id: int | None = None,
        client_uuid=None,  # noqa: ANN001 — uuid.UUID | None
        observacao: str | None = None,
    ) -> list[Payable]:
        # Ordenadas por vencimento: "parcela 1 de 3" é a que vence primeiro, não a primeira
        # que a pessoa digitou.
        ordenadas = sorted(nota.parcelas, key=lambda p: p.vencimento)
        return [
            Payable(
                supplier=fornecedor,
                description=descricao,
                invoice_number=nota.numero,
                amount=parcela.valor,
                due_date=parcela.vencimento,
                installment_number=n,
                installment_count=len(ordenadas),
                entry_id=entrada_id,
                client_uuid=client_uuid,
                note=observacao,
                created_by_id=usuario_id,
            )
            for n, parcela in enumerate(ordenadas, start=1)
        ]

    # ------------------------------------------------------------ a Entrada
    async def lancar_da_entrada(
        self, *, entrada_id: int, fornecedor: str, nota: NotaFornecedorIn, usuario_id: int
    ) -> int:
        """Cria as parcelas da nota DENTRO da transação da Entrada — sem commit.

        Quem confirma é a Entrada: se a mercadoria não entrar, a dívida também não nasce, e
        a chave da Entrada (`client_uuid`) protege as duas contra o reenvio.
        """
        contas = self._parcelas(
            nota,
            fornecedor=fornecedor,
            descricao=f"Mercadoria da entrada #{entrada_id}",
            usuario_id=usuario_id,
            entrada_id=entrada_id,
        )
        self.session.add_all(contas)
        await self.session.flush()
        return len(contas)

    async def nota_da_entrada(self, entrada_id: int) -> tuple | None:
        """A assinatura da nota gravada com a Entrada, para o reenvio conferir (ou None)."""
        contas = await self.repo.da_entrada(entrada_id)
        if not contas:
            return None
        return _assinatura(contas[0].invoice_number, [(c.due_date, c.amount) for c in contas])

    @staticmethod
    def assinatura_do_pedido(nota: NotaFornecedorIn | None) -> tuple | None:
        if nota is None:
            return None
        return _assinatura(nota.numero, [(p.vencimento, p.valor) for p in nota.parcelas])

    async def contar_da_entrada(self, entrada_id: int) -> int:
        return await self.repo.contar_da_entrada(entrada_id)

    # ------------------------------------------------------------ avulsa
    async def lancar(self, dados: ContaPagarIn, usuario: User) -> LancamentoContasOut:
        usuario_id = usuario.id  # lido antes de um rollback possível (MissingGreenlet)
        existentes = await self.repo.do_lancamento(dados.client_uuid)
        if existentes:
            return self._replay_lancamento(existentes, dados)

        contas = self._parcelas(
            dados.nota,
            fornecedor=dados.fornecedor,
            descricao=dados.descricao,
            usuario_id=usuario_id,
            client_uuid=dados.client_uuid,
            observacao=dados.observacao,
        )
        self.session.add_all(contas)
        try:
            await self.session.flush()
        except IntegrityError:
            # Dois toques ao mesmo tempo: o perdedor devolve o que o outro gravou.
            await self.session.rollback()
            existentes = await self.repo.do_lancamento(dados.client_uuid)
            if not existentes:
                raise
            return self._replay_lancamento(existentes, dados)
        await self.session.commit()
        return self._lancamento(contas)

    def _replay_lancamento(
        self, existentes: list[Payable], dados: ContaPagarIn
    ) -> LancamentoContasOut:
        gravado = (
            existentes[0].supplier,
            _assinatura(existentes[0].invoice_number, [(c.due_date, c.amount) for c in existentes]),
        )
        if gravado != (dados.fornecedor, self.assinatura_do_pedido(dados.nota)):
            raise Duplicado(
                "Esta conta já foi lançada com outro fornecedor, valor ou vencimento. Confira "
                "a lista antes de lançar de novo.",
                {"contas": [c.id for c in existentes]},
            )
        self.replay = True
        return self._lancamento(existentes)

    def _lancamento(self, contas: list[Payable]) -> LancamentoContasOut:
        hoje = hoje_na_loja()
        return LancamentoContasOut(
            contas=[self.montar(c, hoje) for c in contas],
            valor_total=sum((c.amount for c in contas), Decimal("0.00")),
        )

    # ------------------------------------------------------------ leitura
    async def listar(
        self,
        p: Paginacao,
        filtro: FiltroContas,
        fornecedor: str | None,
        entrada_id: int | None,
    ) -> Pagina[ContaPagarOut]:
        hoje = hoje_na_loja()
        contas, total = await self.repo.listar(p, filtro, hoje, fornecedor, entrada_id)
        return Pagina.montar([self.montar(c, hoje) for c in contas], total, p)

    async def resumo(self) -> ResumoContasOut:
        """Três somas, uma consulta cada, no índice das abertas. Leve de propósito: é o
        aviso que aparece toda vez que o dono abre a tela."""
        hoje = hoje_na_loja()
        vencidas = await self.repo.faixa(Payable.due_date < hoje)
        semana = await self.repo.faixa(
            Payable.due_date >= hoje, Payable.due_date <= hoje + timedelta(7)
        )
        abertas = await self.repo.faixa()
        return ResumoContasOut(
            hoje=hoje,
            vencidas=FaixaOut(quantidade=vencidas[0], valor=vencidas[1]),
            proximos_7_dias=FaixaOut(quantidade=semana[0], valor=semana[1]),
            em_aberto=FaixaOut(quantidade=abertas[0], valor=abertas[1]),
        )

    async def _ativa(self, conta_id: int, *, travar: bool = False) -> Payable:
        conta = await self.repo.por_id(conta_id, travar=travar)
        if conta is None or conta.deleted_at is not None:
            raise NaoEncontrado("Conta não encontrada.")
        return conta

    async def obter(self, conta_id: int) -> ContaPagarOut:
        return self.montar(await self._ativa(conta_id))

    # ------------------------------------------------------------ edição
    async def editar(self, conta_id: int, dados: ContaPagarUpdate) -> ContaPagarOut:
        conta = await self._ativa(conta_id, travar=True)
        if conta.paid_on is not None:
            raise OperacaoInvalida(
                "Esta conta já foi paga. Desfaça o pagamento antes de mudar valor ou vencimento."
            )
        campos = dados.model_dump(exclude_unset=True)
        for nulo in ("fornecedor", "descricao", "valor", "vencimento"):
            if nulo in campos and campos[nulo] is None:
                raise Validacao(f"O campo {nulo} não pode ficar vazio.")
        mapa = {
            "fornecedor": "supplier",
            "descricao": "description",
            "numero_nota": "invoice_number",
            "valor": "amount",
            "vencimento": "due_date",
            "observacao": "note",
        }
        for campo, valor in campos.items():
            if isinstance(valor, str):
                valor = valor.strip() or None
            setattr(conta, mapa[campo], valor)
        await self.session.commit()
        return self.montar(conta)

    async def excluir(self, conta_id: int) -> None:
        conta = await self._ativa(conta_id, travar=True)
        if conta.paid_on is not None:
            # Apagar uma conta paga some com a saída de dinheiro do histórico.
            raise OperacaoInvalida("Conta paga não se exclui: desfaça o pagamento antes.")
        conta.deleted_at = datetime.now(UTC)
        await self.session.commit()

    # ------------------------------------------------------------ pagamento
    async def pagar(self, conta_id: int, dados: PagamentoContaIn, usuario: User) -> ContaPagarOut:
        usuario_id = usuario.id
        hoje = hoje_na_loja()
        pago_em = dados.pago_em or hoje
        if pago_em > hoje:
            # Pagamento agendado não é pagamento: a conta continua devida até o dinheiro sair.
            raise Validacao(
                "A data de pagamento é depois de hoje. Marque como paga quando o dinheiro sair.",
                {"pago_em": pago_em.isoformat(), "hoje": hoje.isoformat()},
            )
        if await self.repo.marcar_paga(
            conta_id, pago_em=pago_em, forma=dados.forma, usuario_id=usuario_id
        ):
            await self.session.commit()
            return self.montar(await self._ativa(conta_id), hoje)

        conta = await self._ativa(conta_id)
        # Já estava paga. O mesmo pedido reenviado (resposta perdida) é atendido; outro
        # pagamento por cima do primeiro, não — pagaria o boleto duas vezes no papel.
        if conta.paid_on == pago_em and conta.payment_method == dados.forma:
            self.replay = True
            return self.montar(conta, hoje)
        raise OperacaoInvalida(
            f"Esta conta já foi paga em {conta.paid_on:%d/%m/%Y}.",
            {"conta_id": conta.id, "paga_em": conta.paid_on.isoformat()},
        )

    async def desfazer_pagamento(self, conta_id: int) -> ContaPagarOut:
        """Marcou como paga por engano: a conta volta a ser devida. Idempotente."""
        await self._ativa(conta_id)
        if await self.repo.reabrir(conta_id):
            await self.session.commit()
        return self.montar(await self._ativa(conta_id))
