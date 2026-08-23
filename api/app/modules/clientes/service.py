"""Crediário: quem deve, quanto deve, e quem já pagou.

**O saldo devedor não é uma coluna.** É sempre calculado a partir do que aconteceu:

    deve = Σ pagamentos FIADO de vendas CONCLUÍDAS
         − Σ pagamentos do cliente
         − Σ devoluções abatidas em FIADO

Guardar o saldo numa coluna seria mais rápido de ler e erraria no primeiro cancelamento
que alguém esquecesse de refletir — e "a cliente diz que pagou e o sistema diz que não" é
exatamente o tipo de briga que faz a loja voltar para a caderneta de papel.

As três parcelas importam. Sem a primeira filtrar por CONCLUÍDA, venda cancelada continua
cobrando. Sem a terceira, a cliente que devolveu a peça segue devendo por ela.
"""

from decimal import Decimal

from sqlalchemy import Select, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import NaoEncontrado, OperacaoInvalida, Validacao
from app.core.pagination import Pagina, Paginacao
from app.modules.clientes.models import Customer, CustomerPayment
from app.modules.clientes.schemas import (
    ClienteIn,
    ClienteOut,
    ClienteUpdate,
    ExtratoClienteOut,
    PagamentoClienteIn,
    PagamentoClienteOut,
    VendaEmAbertoOut,
)
from app.modules.usuarios.models import User
from app.modules.vendas.models import (
    FormaPagamento,
    Sale,
    SalePayment,
    SaleReturn,
    SaleReturnPayment,
    StatusVenda,
)

ZERO = Decimal("0.00")


def _fiado_das_vendas(cliente_id_col) -> Select:
    """Σ do que saiu no fiado, só de venda que continua de pé."""
    return (
        select(func.coalesce(func.sum(SalePayment.amount), 0))
        .join(Sale, Sale.id == SalePayment.sale_id)
        .where(
            Sale.customer_id == cliente_id_col,
            Sale.status == StatusVenda.CONCLUIDA,
            SalePayment.method == FormaPagamento.FIADO,
        )
    )


def _devolvido_em_fiado(cliente_id_col) -> Select:
    """Σ do que voltou abatendo a dívida em vez de sair da gaveta."""
    return (
        select(func.coalesce(func.sum(SaleReturnPayment.amount), 0))
        .join(SaleReturn, SaleReturn.id == SaleReturnPayment.return_id)
        .join(Sale, Sale.id == SaleReturn.sale_id)
        .where(
            Sale.customer_id == cliente_id_col,
            SaleReturnPayment.method == FormaPagamento.FIADO,
        )
    )


def _pago_pelo_cliente(cliente_id_col) -> Select:
    return select(func.coalesce(func.sum(CustomerPayment.amount), 0)).where(
        CustomerPayment.customer_id == cliente_id_col
    )


def _deve_expr():
    """A mesma conta do `quanto_deve`, mas como EXPRESSÃO SQL correlacionada.

    Existe para a listagem poder filtrar e contar "quem está devendo" **dentro do banco**.
    Filtrar em Python depois do LIMIT responderia a pergunta errada: numa loja com mais de
    uma página de clientes, as devedoras que caem depois do corte sumiriam, e a tela cuja
    pergunta é "quem preciso cobrar?" imprimiria "todo mundo em dia". De quebra, evita as
    três consultas por linha que o `_com_saldo` fazia.
    """
    return (
        _fiado_das_vendas(Customer.id).scalar_subquery()
        - _pago_pelo_cliente(Customer.id).scalar_subquery()
        - _devolvido_em_fiado(Customer.id).scalar_subquery()
    )


class ClienteService:
    def __init__(self, session: AsyncSession):
        self.session = session

    # ------------------------------------------------------------- cadastro
    async def _obter(self, cliente_id: int) -> Customer:
        cliente = await self.session.get(Customer, cliente_id)
        if cliente is None or cliente.deleted_at is not None:
            raise NaoEncontrado("Cliente não encontrado.")
        return cliente

    async def criar(self, dados: ClienteIn) -> ClienteOut:
        await self._recusar_repetido(dados.telefone, dados.documento)
        cliente = Customer(
            name=dados.nome,
            phone=dados.telefone,
            document=dados.documento,
            credit_limit=dados.limite,
            note=dados.observacao,
        )
        self.session.add(cliente)
        await self.session.commit()
        return await self._com_saldo(cliente)

    async def atualizar(self, cliente_id: int, dados: ClienteUpdate) -> ClienteOut:
        cliente = await self._obter(cliente_id)
        await self._recusar_repetido(dados.telefone, dados.documento, exceto=cliente_id)
        for campo, coluna in (
            ("nome", "name"),
            ("telefone", "phone"),
            ("documento", "document"),
            ("limite", "credit_limit"),
            ("observacao", "note"),
        ):
            valor = getattr(dados, campo)
            if valor is not None:
                setattr(cliente, coluna, valor)
        await self.session.commit()
        return await self._com_saldo(cliente)

    async def excluir(self, cliente_id: int) -> None:
        """Some da lista, mas só se não estiver devendo.

        Excluir cliente com dívida em aberto apagaria da conta da loja um dinheiro que
        existe — e o UNIQUE parcial ainda deixaria recadastrar a mesma pessoa do zero,
        limpinha, devendo nada.
        """
        cliente = await self._obter(cliente_id)
        deve = await self.quanto_deve(cliente_id)
        if deve > ZERO:
            raise OperacaoInvalida(
                "Este cliente ainda deve. Receba ou perdoe a dívida antes de excluir.",
                {"deve": str(deve)},
            )
        from datetime import UTC, datetime

        cliente.deleted_at = datetime.now(UTC)
        await self.session.commit()

    async def _recusar_repetido(
        self, telefone: str | None, documento: str | None, exceto: int | None = None
    ) -> None:
        """O UNIQUE parcial no banco é a rede; aqui o recado é legível."""
        condicoes = []
        if telefone:
            condicoes.append(Customer.phone == telefone)
        if documento:
            condicoes.append(Customer.document == documento)
        if not condicoes:
            return
        stmt = select(Customer).where(or_(*condicoes), Customer.deleted_at.is_(None))
        if exceto is not None:
            stmt = stmt.where(Customer.id != exceto)
        existente = (await self.session.execute(stmt)).scalars().first()
        if existente is not None:
            raise Validacao(
                f"Já existe um cliente com esse telefone ou documento: {existente.name}.",
                {"cliente_id": existente.id},
            )

    # --------------------------------------------------------------- saldos
    async def quanto_deve(self, cliente_id: int, *, travar: bool = False) -> Decimal:
        """Quanto este cliente deve AGORA. Público: a devolução precisa perguntar.

        Uma devolução de venda no fiado abate a dívida — mas só até onde ela existe. Sem
        essa pergunta, a cliente que pagou tudo e depois devolveu a peça ficaria com saldo
        negativo, que é a loja devendo a ela sem nada na tela dizendo isso.

        `travar=True` segura a linha do cliente até o fim da transação. É o que impede que
        dois recebimentos (ou duas devoluções) simultâneos leiam a mesma dívida de R$ 100 e
        cada um abata os R$ 100 inteiros — o mesmo cuidado que o saldo de estoque tem no
        `UPDATE` condicional e a venda tem no `FOR UPDATE`. Ler para depois escrever, sem
        travar, é sempre a mesma corrida.
        """
        if travar:
            await self.session.execute(
                select(Customer.id).where(Customer.id == cliente_id).with_for_update()
            )
        fiado = await self.session.scalar(_fiado_das_vendas(cliente_id))
        pago = await self.session.scalar(_pago_pelo_cliente(cliente_id))
        devolvido = await self.session.scalar(_devolvido_em_fiado(cliente_id))
        return Decimal(fiado or 0) - Decimal(pago or 0) - Decimal(devolvido or 0)

    @staticmethod
    def _montar(cliente: Customer, deve: Decimal) -> ClienteOut:
        """Monta a resposta com um saldo já calculado — sem ir ao banco de novo."""
        saida = ClienteOut.model_validate(cliente)
        saida.ativo = cliente.deleted_at is None
        saida.deve = deve
        saida.acima_do_limite = (
            cliente.credit_limit is not None and deve > cliente.credit_limit
        )
        return saida

    async def _com_saldo(self, cliente: Customer) -> ClienteOut:
        return self._montar(cliente, await self.quanto_deve(cliente.id))

    # ------------------------------------------------------------- listagem
    async def listar(
        self, p: Paginacao, q: str | None, somente_devendo: bool
    ) -> Pagina[ClienteOut]:
        stmt = select(Customer).where(Customer.deleted_at.is_(None))
        if q:
            from app.modules.catalogo.repository import _achatar, achatar_termo

            termo = f"%{achatar_termo(q)}%"
            so_digitos = "".join(c for c in q if c.isdigit())
            condicoes = [_achatar(Customer.name).like(termo)]
            if so_digitos:
                condicoes.append(Customer.phone.like(f"%{so_digitos}%"))
                condicoes.append(Customer.document.like(f"%{so_digitos}%"))
            stmt = stmt.where(or_(*condicoes))

        deve = _deve_expr()
        if somente_devendo:
            # No banco, ANTES do LIMIT: filtrar a página já cortada esconderia justamente
            # as devedoras que a tela existe para mostrar.
            stmt = stmt.where(deve > 0)

        total = await self.session.scalar(select(func.count()).select_from(stmt.subquery()))
        pagina = (
            stmt.add_columns(deve.label("deve"))
            .order_by(Customer.name, Customer.id)
            .offset(p.offset)
            .limit(p.limit)
        )
        items = [
            self._montar(cliente, Decimal(saldo or 0))
            for cliente, saldo in (await self.session.execute(pagina)).all()
        ]
        return Pagina.montar(items, int(total or 0), p)

    async def obter(self, cliente_id: int) -> ClienteOut:
        return await self._com_saldo(await self._obter(cliente_id))

    # -------------------------------------------------------------- extrato
    async def extrato(self, cliente_id: int) -> ExtratoClienteOut:
        cliente = await self._obter(cliente_id)

        linhas = (
            await self.session.execute(
                select(Sale.id, Sale.sold_at, Sale.total, func.sum(SalePayment.amount))
                .join(SalePayment, SalePayment.sale_id == Sale.id)
                .where(
                    Sale.customer_id == cliente_id,
                    Sale.status == StatusVenda.CONCLUIDA,
                    SalePayment.method == FormaPagamento.FIADO,
                )
                .group_by(Sale.id, Sale.sold_at, Sale.total)
                .order_by(Sale.sold_at.desc())
            )
        ).all()

        pagamentos = list(
            (
                await self.session.execute(
                    select(CustomerPayment)
                    .where(CustomerPayment.customer_id == cliente_id)
                    .order_by(CustomerPayment.paid_at.desc())
                )
            )
            .scalars()
            .all()
        )

        total_fiado = Decimal(await self.session.scalar(_fiado_das_vendas(cliente_id)) or 0)
        total_pago = Decimal(await self.session.scalar(_pago_pelo_cliente(cliente_id)) or 0)
        devolvido = Decimal(await self.session.scalar(_devolvido_em_fiado(cliente_id)) or 0)

        return ExtratoClienteOut(
            cliente=await self._com_saldo(cliente),
            vendas=[
                VendaEmAbertoOut(
                    venda_id=vid, vendida_em=quando, total_da_venda=total, no_fiado=fiado
                )
                for vid, quando, total, fiado in linhas
            ],
            pagamentos=[PagamentoClienteOut.model_validate(p) for p in pagamentos],
            total_fiado=total_fiado,
            total_pago=total_pago,
            total_devolvido=devolvido,
            deve=total_fiado - total_pago - devolvido,
        )

    # ----------------------------------------------------------- recebimento
    async def receber(
        self, cliente_id: int, dados: PagamentoClienteIn, usuario: User
    ) -> PagamentoClienteOut:
        # Idempotência antes de tudo: recebimento é a operação mais provável de ser
        # reenviada (sinal ruim no meio da rua), e reenviar aqui perdoaria uma dívida.
        ja = (
            await self.session.execute(
                select(CustomerPayment).where(CustomerPayment.client_uuid == dados.client_uuid)
            )
        ).scalar_one_or_none()
        if ja is not None:
            return PagamentoClienteOut.model_validate(ja)

        cliente = await self._obter(cliente_id)
        deve = await self.quanto_deve(cliente_id, travar=True)
        if deve <= ZERO:
            raise OperacaoInvalida("Este cliente não está devendo nada.")
        if dados.valor > deve:
            # Receber a mais viraria saldo negativo, que ninguém sabe ler depois: é a loja
            # que passa a dever ao cliente, sem lugar nenhum dizendo isso.
            raise Validacao(
                "O valor é maior do que a dívida.",
                {"deve": str(deve), "recebendo": str(dados.valor)},
            )

        pagamento = CustomerPayment(
            customer_id=cliente.id,
            user_id=usuario.id,
            method=dados.forma,
            amount=dados.valor,
            client_uuid=dados.client_uuid,
            note=dados.observacao,
        )
        self.session.add(pagamento)
        await self.session.commit()
        await self.session.refresh(pagamento)
        return PagamentoClienteOut.model_validate(pagamento)
