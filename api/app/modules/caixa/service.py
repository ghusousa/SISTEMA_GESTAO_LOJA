from datetime import UTC, date, datetime
from decimal import Decimal

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.datas import dia_da_loja, hoje_na_loja
from app.core.exceptions import NaoEncontrado, Validacao
from app.core.pagination import Pagina, Paginacao
from app.modules.caixa.models import CashClosing, CashClosingLine
from app.modules.caixa.schemas import (
    DiaCaixaOut,
    FechamentoIn,
    FechamentoOut,
    LinhaCaixa,
)
from app.modules.usuarios.models import User
from app.modules.clientes.models import CustomerPayment
from app.modules.vendas.devolucao import FORMAS_QUE_SAEM_DA_GAVETA
from app.modules.vendas.models import (
    FORMAS_DE_GAVETA,
    FormaPagamento,
    Sale,
    SalePayment,
    SaleReturn,
    SaleReturnPayment,
    StatusVenda,
)

ZERO = Decimal("0.00")


class CaixaService:
    """Leitura analítica: consulta as tabelas de venda direto, sem escrever nelas (CQRS-lite)."""

    def __init__(self, session: AsyncSession):
        self.session = session

    async def _somar(self, stmt) -> dict[str, Decimal]:
        return {forma: Decimal(valor) for forma, valor in (await self.session.execute(stmt)).all()}

    async def _movimento_do_dia(
        self, dia: date
    ) -> tuple[dict[str, Decimal], dict[str, Decimal], dict[str, Decimal]]:
        """As três coisas que mexem na gaveta hoje: venda, devolução e fiado recebido.

        **Só formas de gaveta.** VALE e FIADO ficam de fora porque não são dinheiro:
        o vale foi pago na venda que o gerou, e o fiado ainda nem foi pago. Somá-los faria
        a loja procurar na gaveta por um dinheiro que nunca entrou, e o caixa fecharia com
        falta todo santo dia em que alguém vendesse no fiado.
        """
        vendas = await self._somar(
            select(SalePayment.method, func.sum(SalePayment.amount))
            .join(Sale, Sale.id == SalePayment.sale_id)
            .where(
                dia_da_loja(Sale.sold_at) == dia,
                Sale.status == StatusVenda.CONCLUIDA,
                SalePayment.method.in_(FORMAS_DE_GAVETA),
            )
            .group_by(SalePayment.method)
        )
        # Pelo dia da DEVOLUÇÃO, nunca pelo da venda (ADR-19): amarrar pela venda
        # reescreveria um caixa já fechado e o esperado de hoje discordaria do de ontem.
        devolucoes = await self._somar(
            select(SaleReturnPayment.method, func.sum(SaleReturnPayment.amount))
            .join(SaleReturn, SaleReturn.id == SaleReturnPayment.return_id)
            .where(
                dia_da_loja(SaleReturn.returned_at) == dia,
                SaleReturnPayment.method.in_(FORMAS_QUE_SAEM_DA_GAVETA),
            )
            .group_by(SaleReturnPayment.method)
        )
        recebimentos = await self._somar(
            select(CustomerPayment.method, func.sum(CustomerPayment.amount))
            .where(dia_da_loja(CustomerPayment.paid_at) == dia)
            .group_by(CustomerPayment.method)
        )
        return vendas, devolucoes, recebimentos

    async def _esperado_do_dia(self, dia: date) -> tuple[dict[str, Decimal], int, int]:
        vendas, devolucoes, recebimentos = await self._movimento_do_dia(dia)
        por_forma = {
            forma: vendas.get(forma, ZERO)
            + recebimentos.get(forma, ZERO)
            - devolucoes.get(forma, ZERO)
            for forma in FORMAS_DE_GAVETA
        }
        contagens = (
            await self.session.execute(
                select(Sale.status, func.count())
                .where(dia_da_loja(Sale.sold_at) == dia)
                .group_by(Sale.status)
            )
        ).all()
        concluidas = next((n for s, n in contagens if s == StatusVenda.CONCLUIDA), 0)
        canceladas = next((n for s, n in contagens if s == StatusVenda.CANCELADA), 0)
        return por_forma, int(concluidas), int(canceladas)

    async def dia(self, dia: date) -> DiaCaixaOut:
        esperado, concluidas, canceladas = await self._esperado_do_dia(dia)
        fechamento = await self._fechamento_do_dia(dia)
        contados = (
            {linha.method: linha.counted_amount for linha in fechamento.lines}
            if fechamento
            else {}
        )
        vendas, devolucoes, recebimentos = await self._movimento_do_dia(dia)
        linhas = [
            LinhaCaixa(
                forma=forma,
                vendas=vendas.get(forma, ZERO),
                devolucoes=devolucoes.get(forma, ZERO),
                recebimentos_de_fiado=recebimentos.get(forma, ZERO),
                esperado=esperado.get(forma, ZERO),
                contado=contados.get(forma),
                diferenca=(
                    contados[forma] - esperado.get(forma, ZERO) if forma in contados else None
                ),
            )
            # `FORMAS_DE_GAVETA` e não `FormaPagamento`: pedir a contagem de VALE e de
            # FIADO seria pedir para contar o que não está lá.
            for forma in FORMAS_DE_GAVETA
        ]
        return DiaCaixaOut(
            data=dia,
            linhas=linhas,
            total_esperado=sum(esperado.values(), ZERO),
            quantidade_vendas=concluidas,
            quantidade_canceladas=canceladas,
            fechado=fechamento is not None,
            fechamento_id=fechamento.id if fechamento else None,
        )

    async def _fechamento_do_dia(self, dia: date) -> CashClosing | None:
        stmt = (
            select(CashClosing)
            .options(selectinload(CashClosing.lines))
            .where(CashClosing.closing_date == dia)
            .execution_options(populate_existing=True)
        )
        return (await self.session.execute(stmt)).unique().scalar_one_or_none()

    async def fechar(self, dados: FechamentoIn, usuario: User) -> FechamentoOut:
        """Registra a conferência do dia. Refechar o mesmo dia atualiza o registro.

        O fechamento não trava nada: é conferência, não bloqueio. Uma venda lançada
        depois simplesmente muda o esperado, e o dia pode ser refechado.
        """
        hoje_loja = hoje_na_loja()
        if dados.data > hoje_loja:
            raise Validacao("Não dá para fechar o caixa de um dia que ainda não aconteceu.")
        # Lido já, enquanto o objeto está fresco: o rollback da corrida lá embaixo expira
        # tudo o que a sessão carregou, e ler `usuario.id` depois dele, em sessão async,
        # é MissingGreenlet — o ramo que existe para a corrida dava 500 justo nela.
        usuario_id = usuario.id

        formas = [c.forma for c in dados.contagens]
        if len(formas) != len(set(formas)):
            raise Validacao("A mesma forma de pagamento foi contada duas vezes.")

        # Forma com dinheiro esperado precisa ser conferida: gravar "contado zero" para uma
        # forma que ninguém contou inventaria uma diferença enorme e mentiria sobre o dia.
        esperado_previa, _, _ = await self._esperado_do_dia(dados.data)
        # `!= ZERO` e não `> ZERO`: um dia em que se devolveu mais do que se vendeu numa
        # forma tem esperado NEGATIVO — e é justamente o dia que mais precisa de contagem.
        nao_conferidas = [
            forma
            for forma, valor in esperado_previa.items()
            if valor != ZERO and forma not in set(formas)
        ]
        if nao_conferidas:
            raise Validacao(
                "Há formas de pagamento com valor esperado que não foram conferidas.",
                {"formas": sorted(nao_conferidas)},
            )

        esperado, _, _ = await self._esperado_do_dia(dados.data)
        contados = {c.forma: c.valor_contado for c in dados.contagens}

        fechamento = await self._fechamento_do_dia(dados.data)
        if fechamento is None:
            fechamento = CashClosing(closing_date=dados.data, user_id=usuario_id)
            self.session.add(fechamento)
            try:
                await self.session.flush()
            except IntegrityError:
                # Dois dispositivos fechando o mesmo dia ao mesmo tempo: a UNIQUE de
                # closing_date segura, e a requisição perdedora vira uma atualização.
                await self.session.rollback()
                fechamento = await self._fechamento_do_dia(dados.data)
                if fechamento is None:
                    raise
                fechamento.user_id = usuario_id
                fechamento.closed_at = datetime.now(UTC)
                for linha in list(fechamento.lines):
                    await self.session.delete(linha)
                await self.session.flush()
        else:
            fechamento.user_id = usuario_id
            fechamento.closed_at = datetime.now(UTC)
            for linha in list(fechamento.lines):
                await self.session.delete(linha)
            await self.session.flush()

        fechamento.note = dados.observacao
        total_esperado = ZERO
        total_contado = ZERO
        # `FORMAS_DE_GAVETA`: o CHECK de `cash_closing_lines` só aceita estas quatro, e é
        # ele que garante que VALE e FIADO nunca entrem numa conferência de gaveta.
        for forma in FORMAS_DE_GAVETA:
            valor_esperado = esperado.get(forma, ZERO)
            valor_contado = contados.get(forma, ZERO)
            total_esperado += valor_esperado
            total_contado += valor_contado
            self.session.add(
                CashClosingLine(
                    closing_id=fechamento.id,
                    method=forma,
                    expected_amount=valor_esperado,
                    counted_amount=valor_contado,
                )
            )
        fechamento.total_expected = total_esperado
        fechamento.total_counted = total_contado

        await self.session.commit()
        return await self.obter(fechamento.id)

    async def obter(self, fechamento_id: int) -> FechamentoOut:
        stmt = (
            select(CashClosing, User)
            .join(User, User.id == CashClosing.user_id)
            .options(selectinload(CashClosing.lines))
            .where(CashClosing.id == fechamento_id)
            .execution_options(populate_existing=True)
        )
        linha = (await self.session.execute(stmt)).unique().first()
        if linha is None:
            raise NaoEncontrado("Fechamento não encontrado.")
        fechamento, usuario = linha
        return self._out(fechamento, usuario.name)

    @staticmethod
    def _out(fechamento: CashClosing, nome_usuario: str) -> FechamentoOut:
        return FechamentoOut(
            id=fechamento.id,
            data=fechamento.closing_date,
            fechado_por=nome_usuario,
            fechado_em=fechamento.closed_at,
            linhas=[
                LinhaCaixa(
                    forma=linha.method,
                    esperado=linha.expected_amount,
                    contado=linha.counted_amount,
                    diferenca=linha.counted_amount - linha.expected_amount,
                )
                for linha in sorted(fechamento.lines, key=lambda linha: linha.method)
            ],
            total_esperado=fechamento.total_expected,
            total_contado=fechamento.total_counted,
            diferenca=fechamento.total_counted - fechamento.total_expected,
            observacao=fechamento.note,
        )

    async def listar(
        self, p: Paginacao, inicio: date | None, fim: date | None
    ) -> Pagina[FechamentoOut]:
        stmt = (
            select(CashClosing, User)
            .join(User, User.id == CashClosing.user_id)
            .options(selectinload(CashClosing.lines))
        )
        if inicio:
            stmt = stmt.where(CashClosing.closing_date >= inicio)
        if fim:
            stmt = stmt.where(CashClosing.closing_date <= fim)
        total = await self.session.scalar(select(func.count()).select_from(stmt.subquery()))
        stmt = stmt.order_by(CashClosing.closing_date.desc()).offset(p.offset).limit(p.limit)
        linhas = (await self.session.execute(stmt)).unique().all()
        return Pagina.montar(
            [self._out(f, u.name) for f, u in linhas], int(total or 0), p
        )
