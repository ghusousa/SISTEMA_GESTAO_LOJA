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
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.datas import hoje_na_loja
from app.core.exceptions import Duplicado, NaoEncontrado, OperacaoInvalida, Validacao
from app.core.pagination import Pagina, Paginacao
from app.modules.clientes.models import Customer, CustomerPayment
from app.modules.clientes.schemas import (
    ClienteBalcaoIn,
    ClienteBalcaoOut,
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
        #: O último `receber` respondeu com um pagamento que já existia (ADR-2): o router
        #: devolve 200 em vez de 201.
        self.replay = False

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
            nascimento=dados.nascimento,
            preferencias=dados.preferencias,
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
            ("nascimento", "nascimento"),
            ("preferencias", "preferencias"),
        ):
            valor = getattr(dados, campo)
            if valor is not None:
                setattr(cliente, coluna, valor)
        await self.session.commit()
        return await self._com_saldo(cliente)

    async def excluir(self, cliente_id: int) -> None:
        """Some da lista e leva junto o dado pessoal, mas só se não estiver devendo.

        Excluir cliente com dívida em aberto apagaria da conta da loja um dinheiro que
        existe — e o UNIQUE parcial ainda deixaria recadastrar a mesma pessoa do zero,
        limpinha, devendo nada.

        Quitada, a exclusão ANONIMIZA (LGPD): telefone, documento e observação viram nulos
        e o nome vira "Cliente removido #id". Só marcar `deleted_at` deixava CPF e telefone
        para sempre no banco — e em todo backup dali em diante —, ao contrário do que a
        página pública de exclusão promete. A linha fica, com o mesmo id: vendas,
        pagamentos e devoluções continuam apontando para ela, e o caixa e os relatórios
        de meses passados não mudam um centavo. Não há volta: o cadastro não se restaura.
        """
        cliente = await self._obter(cliente_id)
        # Travado: uma venda no fiado que entrasse entre a conta e a anonimização deixaria
        # uma dívida pendurada num cadastro sem nome nem telefone para cobrar.
        deve = await self.quanto_deve(cliente_id, travar=True)
        if deve > ZERO:
            raise OperacaoInvalida(
                "Este cliente ainda deve. Receba ou perdoe a dívida antes de excluir.",
                {"deve": str(deve)},
            )
        from datetime import UTC, datetime

        cliente.deleted_at = datetime.now(UTC)
        cliente.name = f"Cliente removido #{cliente.id}"
        cliente.phone = None
        cliente.document = None
        cliente.note = None
        # Aniversário e gosto pessoal também são dado pessoal (ADR-36): somem junto.
        cliente.nascimento = None
        cliente.preferencias = None
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

    # ---------------------------------------------------------------- balcão
    # Buscar e cadastrar no balcão (`ATENDER_CLIENTE`, ADR-36). Tudo aqui responde
    # `ClienteBalcaoOut` — nenhum saldo, limite ou observação do crediário sai por estas
    # portas, nem calculado: a conta do `deve` nem chega a rodar.

    @staticmethod
    def _filtro_busca(stmt: Select, q: str | None) -> Select:
        """Nome sem acento, telefone ou documento — a mesma busca do crediário."""
        if not q:
            return stmt
        from app.modules.catalogo.repository import _achatar, achatar_termo

        termo = f"%{achatar_termo(q)}%"
        so_digitos = "".join(c for c in q if c.isdigit())
        condicoes = [_achatar(Customer.name).like(termo)]
        if so_digitos:
            condicoes.append(Customer.phone.like(f"%{so_digitos}%"))
            condicoes.append(Customer.document.like(f"%{so_digitos}%"))
        return stmt.where(or_(*condicoes))

    async def buscar_no_balcao(self, p: Paginacao, q: str | None) -> Pagina[ClienteBalcaoOut]:
        stmt = self._filtro_busca(select(Customer).where(Customer.deleted_at.is_(None)), q)
        total = await self._contar(stmt)
        linhas = (
            await self.session.execute(
                stmt.order_by(Customer.name, Customer.id).offset(p.offset).limit(p.limit)
            )
        ).scalars()
        return Pagina.montar([ClienteBalcaoOut.model_validate(c) for c in linhas], total, p)

    async def _por_client_uuid(self, client_uuid) -> Customer | None:
        return (
            await self.session.execute(
                select(Customer).where(Customer.client_uuid == client_uuid)
            )
        ).scalar_one_or_none()

    def _replay_balcao(self, cliente: Customer, dados: ClienteBalcaoIn) -> ClienteBalcaoOut:
        """A mesma chave com OUTRO cadastro é 409, nunca o cadastro antigo como sucesso.

        Devolver a "Ana" gravada para um pedido de "Maria" com a chave reaproveitada poria
        a venda da Maria no nome da Ana — e o histórico das duas ficaria errado.
        """
        if (cliente.name, cliente.phone) != (dados.nome, dados.telefone):
            raise Duplicado(
                f"Este cadastro já foi gravado com outro nome ou telefone (cliente "
                f"#{cliente.id}). Procure a cliente antes de cadastrar de novo.",
                {"cliente_id": cliente.id},
            )
        self.replay = True
        return ClienteBalcaoOut.model_validate(cliente)

    async def cadastrar_no_balcao(self, dados: ClienteBalcaoIn) -> ClienteBalcaoOut:
        ja = await self._por_client_uuid(dados.client_uuid)
        if ja is not None:
            return self._replay_balcao(ja, dados)
        await self._recusar_repetido(dados.telefone, None)
        cliente = Customer(
            name=dados.nome,
            phone=dados.telefone,
            nascimento=dados.nascimento,
            preferencias=dados.preferencias,
            client_uuid=dados.client_uuid,
        )
        self.session.add(cliente)
        try:
            await self.session.commit()
        except IntegrityError:
            # Os dois toques chegaram juntos: o perdedor responde o que o vencedor gravou.
            # (Ou o telefone entrou por outro aparelho no meio: aí o recado é o de sempre.)
            await self.session.rollback()
            ja = await self._por_client_uuid(dados.client_uuid)
            if ja is not None:
                return self._replay_balcao(ja, dados)
            await self._recusar_repetido(dados.telefone, None)
            raise
        await self.session.refresh(cliente)
        return ClienteBalcaoOut.model_validate(cliente)

    async def aniversariantes(self, p: Paginacao, mes: int | None) -> Pagina[ClienteBalcaoOut]:
        """Quem faz aniversário no mês (o da loja, se não vier), na ordem do calendário."""
        mes = mes or hoje_na_loja().month
        stmt = select(Customer).where(
            Customer.deleted_at.is_(None),
            Customer.nascimento.is_not(None),
            func.extract("month", Customer.nascimento) == mes,
        )
        total = await self._contar(stmt)
        linhas = (
            await self.session.execute(
                stmt.order_by(
                    func.extract("day", Customer.nascimento), Customer.name, Customer.id
                )
                .offset(p.offset)
                .limit(p.limit)
            )
        ).scalars()
        return Pagina.montar([ClienteBalcaoOut.model_validate(c) for c in linhas], total, p)

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
        stmt = self._filtro_busca(select(Customer).where(Customer.deleted_at.is_(None)), q)

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

    async def conferir_ativa_para_venda(self, cliente_id: int) -> None:
        """A cliente existe e está ativa — e segue assim até o commit de quem pergunta.

        `FOR SHARE`: a venda no fiado espera uma exclusão em andamento terminar (o `excluir`
        trava a linha com FOR UPDATE) e relê a linha depois do commit dela. Ler sem trava
        deixava a venda passar com a cliente já anonimizada: dívida nova numa ficha que
        ninguém mais vê.
        """
        cliente = (
            await self.session.execute(
                select(Customer)
                .where(Customer.id == cliente_id, Customer.deleted_at.is_(None))
                .with_for_update(read=True)
                .execution_options(populate_existing=True)
            )
        ).scalar_one_or_none()
        if cliente is None:
            raise NaoEncontrado("Cliente não encontrado.")

    # -------------------------------------------------------------- extrato
    async def _contar(self, stmt: Select) -> int:
        return int(
            await self.session.scalar(select(func.count()).select_from(stmt.subquery())) or 0
        )

    async def extrato(self, cliente_id: int, p: Paginacao) -> ExtratoClienteOut:
        """A conta da cliente: as duas listas paginadas, os totais sobre a vida inteira.

        A freguesa de caderneta antiga tem anos de compras e pagamentos, e mandar tudo numa
        resposta só pesava mais a cada mês — toda listagem é paginada (CLAUDE.md). As duas
        listas andam juntas pelo mesmo `?page=&size=`: a tela mostra as mais recentes de
        cada uma e o "carregar mais" traz a próxima leva das duas. Os totais NÃO saem da
        página: vêm dos mesmos agregados do `quanto_deve`, senão a conta mudaria conforme o
        tamanho da página e deixaria de fechar com o "deve" da lista de clientes.
        """
        cliente = await self._obter(cliente_id)

        vendas = (
            select(Sale.id, Sale.sold_at, Sale.total, func.sum(SalePayment.amount))
            .join(SalePayment, SalePayment.sale_id == Sale.id)
            .where(
                Sale.customer_id == cliente_id,
                Sale.status == StatusVenda.CONCLUIDA,
                SalePayment.method == FormaPagamento.FIADO,
            )
            .group_by(Sale.id, Sale.sold_at, Sale.total)
        )
        # `id` desempata: duas linhas no mesmo instante trocariam de página entre um
        # "carregar mais" e outro, e uma apareceria duas vezes enquanto a outra sumia.
        linhas = (
            await self.session.execute(
                vendas.order_by(Sale.sold_at.desc(), Sale.id.desc())
                .offset(p.offset)
                .limit(p.limit)
            )
        ).all()

        pagos = select(CustomerPayment).where(CustomerPayment.customer_id == cliente_id)
        pagamentos = list(
            (
                await self.session.execute(
                    pagos.order_by(CustomerPayment.paid_at.desc(), CustomerPayment.id.desc())
                    .offset(p.offset)
                    .limit(p.limit)
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
            vendas=Pagina.montar(
                [
                    VendaEmAbertoOut(
                        venda_id=vid, vendida_em=quando, total_da_venda=total, no_fiado=fiado
                    )
                    for vid, quando, total, fiado in linhas
                ],
                await self._contar(vendas),
                p,
            ),
            pagamentos=Pagina.montar(
                [PagamentoClienteOut.model_validate(pg) for pg in pagamentos],
                await self._contar(pagos),
                p,
            ),
            total_fiado=total_fiado,
            total_pago=total_pago,
            total_devolvido=devolvido,
            deve=total_fiado - total_pago - devolvido,
        )

    # ----------------------------------------------------------- recebimento
    async def _recebimento_por_client_uuid(self, client_uuid) -> CustomerPayment | None:
        return (
            await self.session.execute(
                select(CustomerPayment).where(CustomerPayment.client_uuid == client_uuid)
            )
        ).scalar_one_or_none()

    def _replay(
        self, pagamento: CustomerPayment, cliente_id: int, dados: PagamentoClienteIn
    ) -> PagamentoClienteOut:
        """Responde o recebimento que este `client_uuid` já gravou — se for o MESMO.

        O uuid é de UM recebimento: desta cliente, deste valor, por esta forma. Responder o
        gravado para outro pedido com a chave reaproveitada dizia "R$ 50 recebidos" quando
        entraram R$ 30 — a tela mostra a quitação que a cliente pediu, e a dívida continua
        do tamanho de antes. Ou dizia PIX quando entrou dinheiro, e a gaveta não fecha.
        """
        if (pagamento.customer_id, pagamento.method, pagamento.amount) != (
            cliente_id,
            dados.forma,
            dados.valor,
        ):
            raise Duplicado(
                "Este recebimento já foi gravado com outro valor, forma ou cliente "
                f"(recebimento #{pagamento.id}). Confira o extrato antes de receber de novo.",
                {"pagamento_id": pagamento.id},
            )
        self.replay = True
        return PagamentoClienteOut.model_validate(pagamento)

    async def receber(
        self, cliente_id: int, dados: PagamentoClienteIn, usuario: User
    ) -> PagamentoClienteOut:
        # Idempotência antes de tudo: recebimento é a operação mais provável de ser
        # reenviada (sinal ruim no meio da rua), e reenviar aqui perdoaria uma dívida.
        ja = await self._recebimento_por_client_uuid(dados.client_uuid)
        if ja is not None:
            return self._replay(ja, cliente_id, dados)

        cliente = await self._obter(cliente_id)
        deve = await self.quanto_deve(cliente_id, travar=True)

        # E de novo, já com a cliente travada. O retry que chega enquanto a primeira
        # tentativa ainda não fez commit passa pela checagem lá de cima sem ver nada e
        # fica parado na trava; quando ela solta, o pagamento já está gravado e a dívida
        # já caiu. Sem esta releitura ele respondia "o valor é maior do que a dívida" para
        # um recebimento que entrou — e quem está no balcão, vendo erro, cobrava de novo.
        ja = await self._recebimento_por_client_uuid(dados.client_uuid)
        if ja is not None:
            return self._replay(ja, cliente_id, dados)

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
