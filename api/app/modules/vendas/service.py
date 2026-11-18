from datetime import datetime
from decimal import Decimal

from sqlalchemy import func, or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.exceptions import (
    Duplicado,
    NaoEncontrado,
    OperacaoInvalida,
    PagamentoDivergente,
    SemPermissao,
    Validacao,
)
from app.core.pagination import Pagina, Paginacao
from app.modules.estoque import movimentos
from app.modules.estoque.models import TipoMovimento
from app.core.permissoes import Pode, pode
from app.modules.usuarios.models import User
from app.modules.vendas.models import (
    FormaPagamento,
    Sale,
    SaleItem,
    SalePayment,
    StatusVenda,
    Voucher,
)
from app.modules.taxas.service import TaxaService, valor_da_taxa
from app.modules.vendas.repository import VendaRepository
from app.modules.vendas.schemas import (
    ItemVendaAdminOut,
    ItemVendaOut,
    PagamentoAdminOut,
    PagamentoIn,
    PagamentoOut,
    VendaAdminOut,
    VendaIn,
    VendaOut,
    VendaResumoOut,
)

ZERO = Decimal("0.00")


class VendaService:
    def __init__(self, session: AsyncSession):
        self.session = session
        self.repo = VendaRepository(session)
        #: A última chamada a `registrar` devolveu uma venda que já existia (ADR-2). É o
        #: router que lê, para responder 200 em vez de 201.
        self.replay = False

    # ------------------------------------------------------------ criação
    async def registrar(
        self, dados: VendaIn, usuario: User, *, confirmar: bool = True
    ) -> VendaOut:
        """Registra a venda inteira em uma transação: itens, pagamentos e baixa de estoque.

        Ou tudo acontece, ou nada acontece — meia venda deixaria estoque baixado sem
        registro de dinheiro, que é o pior estado possível para a loja.

        `confirmar=False` é para quem registra a venda DENTRO da própria transação (o
        fechamento da condicional, ADR-39): grava tudo, mas o commit é de quem chamou — e o
        rollback de um erro leva junto o que ele já tinha feito.
        """
        ja_registrada = await self.repo.por_client_uuid(dados.client_uuid)
        if ja_registrada is not None:
            return await self._replay(ja_registrada, dados, usuario)

        variantes = await self.repo.variantes_para_venda([i.variante_id for i in dados.itens])
        faltando = [i.variante_id for i in dados.itens if i.variante_id not in variantes]
        if faltando:
            raise NaoEncontrado("Peça não encontrada.", {"variantes": faltando})

        subtotal = sum(
            (variantes[i.variante_id][0].sale_price * i.quantidade for i in dados.itens),
            ZERO,
        )
        if dados.desconto > subtotal:
            raise Validacao(
                "O desconto é maior que o valor da venda.",
                {"subtotal": str(subtotal), "desconto": str(dados.desconto)},
            )
        total = subtotal - dados.desconto

        pago = sum((p.valor for p in dados.pagamentos), ZERO)
        if pago != total:
            # O preço quem decide é o servidor (ADR-4): se o app estava com preço velho,
            # a diferença aparece aqui. O total correto vai no detail para o app refazer.
            raise PagamentoDivergente(
                "A soma dos pagamentos não confere com o total da venda.",
                {
                    "total_da_venda": str(total),
                    "soma_dos_pagamentos": str(pago),
                    "subtotal": str(subtotal),
                    "desconto": str(dados.desconto),
                },
            )

        await movimentos.conferir_disponibilidade(
            self.session, {i.variante_id: i.quantidade for i in dados.itens}
        )

        if any(pg.forma == FormaPagamento.FIADO for pg in dados.pagamentos):
            # Vender no fiado é abrir uma dívida que alguém vai ter de cobrar depois. Quem
            # não cuida do crediário não enxerga essa dívida em tela nenhuma: deixar
            # registrar criaria a conta e esconderia a cobrança. O vale, ao contrário,
            # continua aberto a todos — é o papel na mão da cliente, no balcão.
            if not pode(usuario.role, Pode.GERIR_CREDIARIO):
                raise SemPermissao("Vender no fiado é de quem cuida do crediário.")

        if dados.cliente_id is not None:
            await self._conferir_cliente(dados.cliente_id)

        venda = Sale(
            seller_id=usuario.id,
            status=StatusVenda.CONCLUIDA,
            subtotal=subtotal,
            discount=dados.desconto,
            total=total,
            # A % de quem vende AGORA fica na venda (ADR-37): a folha deste mês não muda
            # quando o dono ajustar a comissão no mês que vem.
            comissao_percentual=usuario.comissao_percentual,
            client_uuid=dados.client_uuid,
            note=dados.observacao,
            customer_id=dados.cliente_id,
        )
        self.session.add(venda)
        try:
            await self.session.flush()
        except IntegrityError:
            if not confirmar:
                # O rollback desfaria o que quem chamou já gravou nesta transação; quem
                # chama decide o que fazer com a chave repetida.
                raise Duplicado("Esta cobrança já foi registrada por outra requisição.") from None
            # Duas requisições da mesma venda ao mesmo tempo: a perdedora devolve a vencedora.
            await self.session.rollback()
            # O rollback expirou o `usuario` (veio desta mesma sessão), e o `_replay` lê
            # `role` e `id`: atributo expirado em sessão async é MissingGreenlet — 500 justo
            # no ramo que existe para a corrida. Recarrega antes, explicitamente.
            await self.session.refresh(usuario)
            existente = await self.repo.por_client_uuid(dados.client_uuid)
            if existente is None:
                raise
            return await self._replay(existente, dados, usuario)

        for item in dados.itens:
            variante = variantes[item.variante_id][0]
            self.session.add(
                SaleItem(
                    sale_id=venda.id,
                    variant_id=variante.id,
                    quantity=item.quantidade,
                    # Congelados: reajuste de amanhã não reescreve o lucro de hoje.
                    unit_price=variante.sale_price,
                    unit_cost=variante.cost_price,
                )
            )
        taxas = TaxaService(self.session)
        for pagamento in dados.pagamentos:
            voucher_id = None
            if pagamento.forma == FormaPagamento.VALE:
                voucher_id = await self._consumir_vale(pagamento.codigo_vale, pagamento.valor)
            # A taxa da maquininha é FOTOGRAFADA aqui (ADR-35): a tabela de amanhã não
            # reescreve o resultado de hoje. Fora do cartão não há taxa nem prazo.
            aplicada = await taxas.aplicada(pagamento.forma, pagamento.parcelas)
            self.session.add(
                SalePayment(
                    sale_id=venda.id,
                    method=pagamento.forma,
                    amount=pagamento.valor,
                    voucher_id=voucher_id,
                    # A FK composta obriga: o cliente do pagamento é o cliente DA VENDA.
                    customer_id=(
                        dados.cliente_id if pagamento.forma == FormaPagamento.FIADO else None
                    ),
                    parcelas=pagamento.parcelas,
                    bandeira=pagamento.bandeira,
                    taxa_percentual=aplicada.percentual if aplicada else Decimal("0.00"),
                    prazo_dias=aplicada.prazo_dias if aplicada else None,
                )
            )

        quantidades = {i.variante_id: i.quantidade for i in dados.itens}
        for variante_id in movimentos.ordenar_para_evitar_deadlock(list(quantidades)):
            await movimentos.aplicar_movimento(
                self.session,
                variante_id=variante_id,
                delta=-quantidades[variante_id],
                tipo=TipoMovimento.VENDA,
                user_id=usuario.id,
                sale_id=venda.id,
            )

        if confirmar:
            await self.session.commit()
        else:
            await self.session.flush()
        registrada = await self.repo.por_id(venda.id)
        assert registrada is not None
        return await self._montar_venda(registrada, usuario)

    async def _replay(self, venda: Sale, dados: VendaIn, usuario: User) -> VendaOut:
        """Devolve a venda que este `client_uuid` já registrou — se o pedido for o MESMO.

        O replay devolve a venda existente com o mesmo escopo do GET: quem descobrisse o
        client_uuid de uma venda alheia leria por aqui o que `GET /vendas/{id}` recusaria.

        E só devolve se as peças e a cobrança forem as de antes (`_cobrada_assim`: forma,
        valor, parcelas, bandeira, código do vale e desconto). A resposta se perde, a
        moça troca o PIX por dinheiro (ou bipa mais uma peça) e cobra de novo com o carrinho
        de sempre: devolver a venda antiga como sucesso mostraria o recibo de uma cobrança
        que não aconteceu — a peça nova sai sem baixa de estoque e a gaveta espera PIX onde
        entrou dinheiro. O 409 diz que a venda já existe e qual é; o retry de verdade (o
        mesmo pedido, reenviado) continua sendo atendido.
        """
        if not pode(usuario.role, Pode.VER_VENDAS_DE_TODOS) and venda.seller_id != usuario.id:
            raise SemPermissao("Esta venda pertence a outro vendedor.")
        mesmas_pecas = sorted((i.variante_id, i.quantidade) for i in dados.itens) == sorted(
            (i.variant_id, i.quantity) for i in venda.items
        )
        if not (
            mesmas_pecas and await self._cobrada_assim(venda, dados.pagamentos, dados.desconto)
        ):
            raise Duplicado(
                f"Esta cobrança já foi registrada como a venda #{venda.id}, com outras peças "
                "ou outro pagamento. Confira essa venda antes de cobrar de novo; para uma "
                "venda nova, limpe o carrinho.",
                {"venda_id": venda.id},
            )
        self.replay = True
        return await self._montar_venda(venda, usuario)

    async def mesma_cobranca(
        self,
        venda_id: int,
        pagamentos: list[PagamentoIn],
        desconto: Decimal,
        usuario: User,
    ) -> bool:
        """A venda `venda_id` foi cobrada exatamente assim? Para quem registra venda por
        dentro e precisa decidir se um reenvio é o MESMO pedido (o fechamento da
        condicional, ADR-39) — com a mesma régua do reenvio do PDV (`_replay`).

        Forma, valor, parcelas, bandeira e código do vale: "crédito 1x" reenviado como
        "crédito 3x" é outra cobrança (outra taxa, outra agenda de recebíveis), e o vale de
        outro código é outro papel na mão da cliente. Venda de outra vendedora, para quem
        não vê as de todos, não é o reenvio de quem pergunta.
        """
        venda = await self.repo.por_id(venda_id)
        if venda is None:
            return False
        if not pode(usuario.role, Pode.VER_VENDAS_DE_TODOS) and venda.seller_id != usuario.id:
            return False
        return await self._cobrada_assim(venda, pagamentos, desconto)

    async def _cobrada_assim(
        self, venda: Sale, pagamentos: list[PagamentoIn], desconto: Decimal
    ) -> bool:
        """A régua do reenvio — do PDV (`_replay`) e do fechamento da condicional."""
        codigos = await self.repo.codigos_dos_vales(
            [p.voucher_id for p in venda.payments if p.voucher_id is not None]
        )
        gravado = sorted(
            (
                FormaPagamento(p.method),
                p.amount,
                p.parcelas,
                p.bandeira or "",
                codigos.get(p.voucher_id, "") if p.voucher_id is not None else "",
            )
            for p in venda.payments
        )
        pedido = sorted(
            (FormaPagamento(p.forma), p.valor, p.parcelas, p.bandeira or "", p.codigo_vale or "")
            for p in pagamentos
        )
        return gravado == pedido and venda.discount == desconto

    async def _conferir_cliente(self, cliente_id: int) -> None:
        """A cliente do fiado precisa existir E estar ativa.

        Sem esta checagem: cliente inexistente vira 500 (a FK estoura crua, e o handler
        global só entende `AppError`); cliente EXCLUÍDA passa com 201 e cria uma dívida
        que ninguém mais vê — a listagem do crediário só mostra quem tem
        `deleted_at IS NULL`. Não é caso de laboratório: basta a cliente ter sido excluída
        noutro aparelho enquanto o PDV ainda a tinha na tela.

        Quem pergunta é o serviço público do outro módulo, nunca o repositório dele.
        """
        from app.modules.clientes.service import ClienteService

        await ClienteService(self.session).conferir_ativa_para_venda(cliente_id)

    async def _consumir_vale(self, codigo: str, valor: Decimal) -> int:
        """Gasta `valor` do vale, ou recusa. A trava é o UPDATE, não uma leitura antes.

        Conferir o saldo e depois gravar deixaria o mesmo vale pagar duas vendas
        simultâneas — e o dinheiro da segunda nunca existiu. Mesma mecânica do saldo de
        estoque: a condição vai DENTRO do UPDATE e quem não alterar linha nenhuma perdeu.
        """
        vale = (
            await self.session.execute(select(Voucher).where(Voucher.code == codigo))
        ).scalar_one_or_none()
        if vale is None:
            raise NaoEncontrado("Vale não encontrado.", {"codigo": codigo})

        resultado = await self.session.execute(
            update(Voucher)
            .where(
                Voucher.id == vale.id,
                Voucher.used_value + valor <= Voucher.value,
                or_(Voucher.expires_at.is_(None), Voucher.expires_at > func.now()),
            )
            .values(used_value=Voucher.used_value + valor)
        )
        if (resultado.rowcount or 0) == 0:
            raise OperacaoInvalida(
                "Este vale não cobre esse valor, já foi usado ou está vencido.",
                {"codigo": codigo, "saldo": str(vale.value - vale.used_value)},
            )
        return vale.id

    async def _devolver_vales_da_venda(self, venda: Sale) -> None:
        """Cancelou a venda, o vale volta a valer.

        Sem isto, a peça volta para a arara E o crédito da cliente evapora: `used_value`
        continua cheio, o papel na mão dela não compra mais nada, e a loja fica com o
        dinheiro sem nada em lugar nenhum registrando que aquele crédito existiu. É o
        dinheiro sumindo do lado mais silencioso.

        O `WHERE used_value >= :valor` é a mesma disciplina do consumo: devolver mais do
        que se gastou criaria crédito do nada.
        """
        for pagamento in venda.payments:
            if pagamento.voucher_id is None:
                continue
            await self.session.execute(
                update(Voucher)
                .where(
                    Voucher.id == pagamento.voucher_id,
                    Voucher.used_value >= pagamento.amount,
                )
                .values(used_value=Voucher.used_value - pagamento.amount)
            )

    # ------------------------------------------------------------ cancelamento
    async def cancelar(self, venda_id: int, motivo: str, usuario: User) -> VendaOut:
        """Cancelar não apaga: marca CANCELADA e devolve as peças por movimentação."""
        venda = await self.repo.por_id(venda_id)
        if venda is None:
            raise NaoEncontrado("Venda não encontrada.")
        if venda.status == StatusVenda.CANCELADA:
            raise OperacaoInvalida("Esta venda já está cancelada.")

        # Estornar é de dono e gerente. Quem vende não desfaz a própria venda: é o
        # controle clássico contra desvio, e foi decisão explícita da loja. A rota já
        # barra na porta (`ExigeCancelarVenda`); aqui é a segunda tranca, para o caso de
        # alguém chamar o service por outro caminho.
        if not pode(usuario.role, Pode.CANCELAR_VENDA):
            raise SemPermissao("Cancelar venda é do dono ou do gerente.")

        await self._recusar_se_o_caixa_do_dia_ja_fechou(venda)

        # A troca de status vem ANTES dos estornos e só acontece se a venda ainda estiver
        # concluída. Sem isso, dois cancelamentos simultâneos (toque duplo, retry após
        # timeout) passariam os dois pela checagem em memória e devolveriam o estoque duas
        # vezes — o UPDATE de saldo é atômico, mas soma, então o erro não apareceria.
        cancelou = await self.repo.marcar_cancelada(
            venda_id, cancelada_por=usuario.id, motivo=motivo
        )
        if not cancelou:
            await self.session.rollback()
            # Dois motivos possíveis, e a diferença importa para quem está no balcão.
            atual = await self.repo.por_id(venda_id)
            if atual is not None and atual.status == StatusVenda.CONCLUIDA:
                raise OperacaoInvalida(
                    "Esta venda já teve peça devolvida. Devolva o restante em vez de cancelar."
                )
            raise OperacaoInvalida("Esta venda já está cancelada.")

        await self._recusar_se_o_fiado_ja_foi_pago(venda)

        # NFC-e autorizada se cancela no emissor ANTES de a venda mudar de vez (ADR-41).
        # Fica depois de todas as recusas da venda (caixa fechado, fiado pago, corrida):
        # cancelar a nota e depois recusar a venda deixaria a venda valendo sem nota. E
        # antes dos estornos, para a chamada ao emissor não segurar a trava dos saldos.
        # Se o emissor recusar, nada desta transação fica: a venda segue concluída.
        from app.core.exceptions import AppError
        from app.modules.fiscal.service import FiscalService

        try:
            await FiscalService(self.session).cancelar_nota_da_venda(venda_id, motivo)
        except AppError:
            await self.session.rollback()
            raise

        quantidades = {item.variant_id: item.quantity for item in venda.items}
        for variante_id in movimentos.ordenar_para_evitar_deadlock(list(quantidades)):
            await movimentos.aplicar_movimento(
                self.session,
                variante_id=variante_id,
                delta=quantidades[variante_id],
                tipo=TipoMovimento.ESTORNO,
                user_id=usuario.id,
                sale_id=venda.id,
                observacao=f"Cancelamento da venda #{venda.id}: {motivo}",
            )

        await self._devolver_vales_da_venda(venda)

        # O fiado desta venda some junto, sem nada a fazer: o saldo do cliente só soma
        # pagamentos de vendas CONCLUÍDAS, e esta deixou de ser uma. (O que a cliente já
        # pagou dele é que não some — por isso a recusa acima.)
        await self.session.commit()

        atualizada = await self.repo.por_id(venda_id)
        assert atualizada is not None
        return await self._montar_venda(atualizada, usuario)

    async def _recusar_se_o_caixa_do_dia_ja_fechou(self, venda: Sale) -> None:
        """Venda de um dia cujo caixa já foi fechado não se cancela: devolve-se (ADR-19).

        O caixa e o relatório leem a venda pelo dia em que ela ACONTECEU e só somam as
        concluídas. Cancelar hoje a venda de R$ 100 em dinheiro de ontem tira os R$ 100 do
        esperado de ontem — o dia que já foi contado e fechou certinho passa a mostrar sobra
        de R$ 100 — e não põe nada no de hoje, que fecha com falta dos R$ 100 que saíram da
        gaveta. A Devolução atende o mesmo pedido pelo caminho certo: é reconhecida no dia em
        que acontece, e o dinheiro sai pela forma em que entrou.

        A régua é o fechamento, não a data: venda de ontem com o caixa ainda aberto não foi
        conferida por ninguém, e cancelar só acerta um dia que ainda vai ser contado.
        """
        # Serviço público do outro módulo, nunca o repositório dele (CLAUDE.md).
        from app.modules.caixa.service import CaixaService

        dia = venda.sold_at.astimezone(settings.tz_loja).date()
        if await CaixaService(self.session).dia_fechado(dia):
            raise OperacaoInvalida(
                f"O caixa de {dia:%d/%m/%Y} já foi fechado: cancelar esta venda mudaria uma "
                "conferência já feita. Faça a devolução das peças — ela entra no caixa de hoje.",
                {"dia_do_caixa": dia.isoformat()},
            )

    async def _recusar_se_o_fiado_ja_foi_pago(self, venda: Sale) -> None:
        """Cancelar venda no fiado que a cliente já pagou deixaria a loja devendo a ela.

        É a armadilha do ADR-21 entrando pela outra porta: ela levou R$ 100,00 no fiado,
        pagou, e a venda é cancelada. O fiado some da conta (venda CANCELADA não cobra), o
        pagamento fica, e o saldo dela vai a −R$ 100,00 — fora da lista de quem deve, sem
        nada na tela dizendo que a loja tem um dinheiro dela. A Devolução resolve o mesmo
        pedido sem esse buraco: abate só o que ainda se deve e entrega o resto em vale.

        Roda DEPOIS de `marcar_cancelada`, dentro da mesma transação: a conta já enxerga
        esta venda como cancelada, e "deve < 0" é exatamente "tirar este fiado deixa o
        saldo negativo". A ordem das travas é a da devolução — venda (no `marcar_cancelada`)
        e depois cliente —, para as duas nunca se esperarem em cruz. Sem travar a cliente,
        um recebimento simultâneo leria a dívida antiga e o saldo iria a negativo igual.
        """
        fiado = sum(
            (p.amount for p in venda.payments if p.method == FormaPagamento.FIADO), ZERO
        )
        if fiado <= ZERO or venda.customer_id is None:
            return
        # Serviço público do outro módulo, nunca o repositório dele (CLAUDE.md).
        from app.modules.clientes.service import ClienteService

        deve_depois = await ClienteService(self.session).quanto_deve(
            venda.customer_id, travar=True
        )
        if deve_depois < ZERO:
            await self.session.rollback()
            raise OperacaoInvalida(
                "A cliente já pagou este fiado, no todo ou em parte: cancelar deixaria a loja "
                "devendo a ela sem registro. Faça a devolução das peças — o que já foi pago "
                "volta em vale.",
                {"no_fiado": str(fiado), "deve_hoje": str(deve_depois + fiado)},
            )

    # ------------------------------------------------------------ leitura
    async def obter(self, venda_id: int, usuario: User) -> VendaOut:
        venda = await self.repo.por_id(venda_id)
        if venda is None:
            raise NaoEncontrado("Venda não encontrada.")
        if not pode(usuario.role, Pode.VER_VENDAS_DE_TODOS) and venda.seller_id != usuario.id:
            raise NaoEncontrado("Venda não encontrada.")
        return await self._montar_venda(venda, usuario)

    async def listar(
        self,
        p: Paginacao,
        inicio: datetime | None,
        fim: datetime | None,
        status: str | None,
        vendedor_id: int | None,
        usuario: User,
        variante_id: int | None = None,
        cliente_id: int | None = None,
    ) -> Pagina[VendaResumoOut]:
        if not pode(usuario.role, Pode.VER_VENDAS_DE_TODOS):
            vendedor_id = usuario.id  # vendedora só enxerga as próprias vendas
        linhas, total = await self.repo.listar(
            p, inicio, fim, status, vendedor_id, variante_id, cliente_id
        )
        resumos = await self.repo.resumo_de_vendas([venda.id for venda, _ in linhas])
        items = [
            VendaResumoOut(
                id=venda.id,
                status=venda.status,
                vendedor=vendedor.name,
                total=venda.total,
                quantidade_pecas=resumos.get(venda.id, (0, []))[0],
                vendida_em=venda.sold_at,
                formas_pagamento=resumos.get(venda.id, (0, []))[1],
            )
            for venda, vendedor in linhas
        ]
        return Pagina.montar(items, total, p)

    async def _montar_venda(self, venda: Sale, usuario: User) -> VendaOut:
        variantes = await self.repo.variantes_historicas([i.variant_id for i in venda.items])
        vendedor = await self.repo.usuario(venda.seller_id)
        admin = pode(usuario.role, Pode.VER_DINHEIRO)

        itens: list[ItemVendaOut] = []
        for item in venda.items:
            variante, produto = variantes.get(item.variant_id, (None, None))
            comum = {
                "id": item.id,
                "variante_id": item.variant_id,
                "produto": produto.name if produto else "(peça removida)",
                "tamanho": variante.size if variante else "",
                "cor": variante.color if variante else "",
                "codigo_barras": variante.barcode if variante else "",
                "quantidade": item.quantity,
                "quantidade_devolvida": item.returned_quantity,
                "preco_unitario": item.unit_price,
                "total_item": item.unit_price * item.quantity,
            }
            itens.append(
                ItemVendaAdminOut(**comum, custo_unitario=item.unit_cost)
                if admin
                else ItemVendaOut(**comum)
            )

        comum_venda = {
            "id": venda.id,
            "status": venda.status,
            "vendedor_id": venda.seller_id,
            "vendedor": vendedor.name if vendedor else "",
            "subtotal": venda.subtotal,
            "desconto": venda.discount,
            "total": venda.total,
            "quantidade_pecas": sum(i.quantity for i in venda.items),
            "vendida_em": venda.sold_at,
            "cancelada_em": venda.cancelled_at,
            "motivo_cancelamento": venda.cancel_reason,
            "cliente_id": venda.customer_id,
            "cliente": await self.repo.nome_do_cliente(venda.customer_id),
            "observacao": venda.note,
            "itens": itens,
        }
        pagamento_comum = [
            {
                "forma": p.method,
                "valor": p.amount,
                "parcelas": p.parcelas,
                "bandeira": p.bandeira,
            }
            for p in venda.payments
        ]
        if not admin:
            return VendaOut(
                **comum_venda, pagamentos=[PagamentoOut(**p) for p in pagamento_comum]
            )

        # A taxa da maquininha é dinheiro da loja: só sai pelo schema de quem vê dinheiro.
        pagamentos = [
            PagamentoAdminOut(
                **comum,
                taxa_percentual=p.taxa_percentual,
                taxa=valor_da_taxa(p.amount, p.taxa_percentual),
            )
            for comum, p in zip(pagamento_comum, venda.payments, strict=True)
        ]
        custo_total = sum((i.unit_cost * i.quantity for i in venda.items), ZERO)
        return VendaAdminOut(
            **comum_venda,
            pagamentos=pagamentos,
            custo_total=custo_total,
            lucro_bruto=venda.total - custo_total,
            taxas_cartao=sum((p.taxa for p in pagamentos), ZERO),
        )
