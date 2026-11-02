"""Condicional: abrir tira a peça do disponível; fechar devolve e cobra o que ficou (ADR-39).

Quem fala com o estoque é `movimentos.aplicar_movimento` (a única porta do saldo); quem
fala com a cliente é o serviço público de clientes; quem registra a venda é o serviço
público de vendas. Este módulo só costura os três, sempre numa transação.
"""

from decimal import Decimal

from pydantic import ValidationError
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.datas import hoje_na_loja
from app.core.exceptions import (
    Duplicado,
    NaoEncontrado,
    OperacaoInvalida,
    Validacao,
)
from app.core.pagination import Pagina, Paginacao
from app.modules.condicionais.models import (
    Consignment,
    ConsignmentItem,
    StatusCondicional,
)
from app.modules.condicionais.repository import CondicionalRepository
from app.modules.condicionais.schemas import (
    CondicionalIn,
    CondicionalOut,
    FechamentoIn,
    FiltroCondicionais,
    ItemCondicionalOut,
)
from app.modules.estoque import movimentos
from app.modules.estoque.models import TipoMovimento
from app.modules.usuarios.models import User

ZERO = Decimal("0.00")


class CondicionalService:
    def __init__(self, session: AsyncSession):
        self.session = session
        self.repo = CondicionalRepository(session)
        #: A última abertura/fechamento devolveu o que já existia (ADR-2). O router lê para
        #: responder 200 em vez de 201.
        self.replay = False

    # ------------------------------------------------------------ abrir
    async def abrir(self, dados: CondicionalIn, usuario: User) -> CondicionalOut:
        """A peça sai da arara para a sacola da cliente — e do saldo, na mesma transação."""
        # Lido já: o ramo do IntegrityError faz rollback, que expira o `usuario`.
        usuario_id = usuario.id
        existente = await self.repo.por_client_uuid(dados.client_uuid)
        if existente is not None:
            return await self._replay_abertura(existente, dados)

        hoje = hoje_na_loja()
        if dados.prazo < hoje:
            raise Validacao(
                "O prazo já passou. Combine com a cliente um dia de hoje em diante.",
                {"prazo": dados.prazo.isoformat(), "hoje": hoje.isoformat()},
            )
        await self._conferir_cliente(dados.cliente_id)
        # Erro amigável antes (diz qual peça falta e quanto tem); o CHECK do saldo continua
        # sendo a rede de segurança se outra venda levar a peça no meio do caminho.
        await movimentos.conferir_disponibilidade(
            self.session, {i.variante_id: i.quantidade for i in dados.itens}
        )

        condicional = Consignment(
            customer_id=dados.cliente_id,
            seller_id=usuario_id,
            due_date=dados.prazo,
            status=StatusCondicional.ABERTA,
            client_uuid=dados.client_uuid,
            note=dados.observacao,
        )
        self.session.add(condicional)
        try:
            await self.session.flush()
        except IntegrityError:
            # Dois toques ao mesmo tempo: o perdedor devolve o que o outro gravou.
            await self.session.rollback()
            existente = await self.repo.por_client_uuid(dados.client_uuid)
            if existente is None:
                raise
            return await self._replay_abertura(existente, dados)

        quantidades = {i.variante_id: i.quantidade for i in dados.itens}
        for variante_id in movimentos.ordenar_para_evitar_deadlock(list(quantidades)):
            self.session.add(
                ConsignmentItem(
                    consignment_id=condicional.id,
                    variant_id=variante_id,
                    quantity=quantidades[variante_id],
                )
            )
            await movimentos.aplicar_movimento(
                self.session,
                variante_id=variante_id,
                delta=-quantidades[variante_id],
                tipo=TipoMovimento.CONDICIONAL_SAIDA,
                user_id=usuario_id,
                consignment_id=condicional.id,
                # Sem o nome da cliente: o extrato é append-only e a exclusão de cliente
                # apaga o dado pessoal. O número leva à ficha, que obedece à exclusão.
                observacao=f"Condicional #{condicional.id}",
            )
        await self.session.commit()
        return await self.obter(condicional.id)

    async def _replay_abertura(
        self, condicional: Consignment, dados: CondicionalIn
    ) -> CondicionalOut:
        """O mesmo pedido reenviado é atendido; outro pedido com a mesma chave, não.

        A resposta se perde, a vendedora bipa mais uma blusa e reenvia: devolver a antiga
        como sucesso deixaria a blusa nova na sacola SEM sair do saldo — e ela seria
        vendida no balcão enquanto está na casa da cliente.
        """
        pedido = (
            dados.cliente_id,
            dados.prazo,
            sorted((i.variante_id, i.quantidade) for i in dados.itens),
        )
        gravado = (
            condicional.customer_id,
            condicional.due_date,
            sorted((i.variant_id, i.quantity) for i in condicional.items),
        )
        if pedido != gravado:
            raise Duplicado(
                f"Esta condicional já foi registrada (#{condicional.id}) com outras peças, "
                "outra cliente ou outro prazo. Confira a lista antes de abrir de novo.",
                {"condicional_id": condicional.id},
            )
        self.replay = True
        return await self.obter(condicional.id)

    async def _conferir_cliente(self, cliente_id: int) -> None:
        """A cliente existe e está ativa. Pergunta ao serviço público, nunca ao repositório."""
        from app.modules.clientes.service import ClienteService

        await ClienteService(self.session).conferir_ativa_para_venda(cliente_id)

    # ------------------------------------------------------------ fechar
    async def fechar(
        self, condicional_id: int, dados: FechamentoIn, usuario: User
    ) -> CondicionalOut:
        """Tudo volta ao estoque; o que ficou com a cliente sai por uma VENDA comum.

        Devolver tudo e vender o que ficou (em vez de baixar só o que voltou) é o que faz o
        que ficou ser venda de verdade: entra no caixa do dia, no faturamento, na comissão,
        tem recibo e pode ser devolvido depois — pelo mesmo `VendaService.registrar` do PDV,
        com as mesmas regras de preço (ADR-4), vale e fiado. Retorno, venda e o vínculo
        `condicional.venda_id` vão no MESMO commit: venda sem retorno baixaria a peça duas
        vezes; retorno sem venda daria a peça de presente.
        """
        usuario_id = usuario.id
        condicional = await self.repo.por_id(condicional_id)
        if condicional is None:
            raise NaoEncontrado("Condicional não encontrada.")
        if condicional.status == StatusCondicional.FECHADA:
            return await self._replay_fechamento(condicional, dados, usuario)

        itens = {i.variant_id: i for i in condicional.items}
        devolvidas = {i.variante_id: i.devolvida for i in dados.itens}
        if set(devolvidas) != set(itens):
            raise Validacao(
                "Diga o que voltou de CADA peça da condicional — nem mais, nem menos.",
                {
                    "faltando": sorted(set(itens) - set(devolvidas)),
                    "fora_da_condicional": sorted(set(devolvidas) - set(itens)),
                },
            )
        demais = [
            {"variante_id": vid, "levou": itens[vid].quantity, "devolvida": qtd}
            for vid, qtd in devolvidas.items()
            if qtd > itens[vid].quantity
        ]
        if demais:
            raise Validacao("Voltou mais peça do que a cliente levou.", {"itens": demais})

        ficou_algo = any(itens[vid].quantity > devolvidas[vid] for vid in itens)
        if ficou_algo and not dados.pagamentos:
            raise Validacao("Ficou peça com a cliente: diga como ela pagou.")
        if not ficou_algo and (dados.pagamentos or dados.desconto):
            raise Validacao("Tudo voltou: não há o que cobrar nem descontar.")

        try:
            fechou = await self.repo.marcar_fechada(
                condicional.id, usuario_id=usuario_id, closing_uuid=dados.client_uuid
            )
        except IntegrityError as exc:
            # A chave já fechou OUTRA condicional: é a tela reaproveitando chave velha.
            await self.session.rollback()
            raise Duplicado(
                "Esta chave de fechamento já foi usada em outra condicional. Recarregue a tela."
            ) from exc
        if not fechou:
            # Outro aparelho fechou no meio do caminho: vale a regra do reenvio.
            condicional = await self.repo.por_id(condicional_id)
            assert condicional is not None
            return await self._replay_fechamento(condicional, dados, usuario)

        # O que ficou é vendido da peça que RECEBEU o retorno, não da que saiu: se a dona
        # excluiu a peça e a recadastrou enquanto ela estava na casa da cliente, o retorno
        # vai para a ativa (ADR-30) — e vender a excluída daria "Peça não encontrada".
        ficaram: dict[int, int] = {}
        for variante_id in movimentos.ordenar_para_evitar_deadlock(list(itens)):
            item = itens[variante_id]
            ficou = item.quantity - devolvidas[variante_id]
            retorno = await movimentos.aplicar_movimento(
                self.session,
                variante_id=variante_id,
                delta=item.quantity,
                tipo=TipoMovimento.CONDICIONAL_RETORNO,
                user_id=usuario_id,
                consignment_id=condicional.id,
                observacao=(
                    f"Voltou da condicional #{condicional.id}"
                    if not ficou
                    else f"Condicional #{condicional.id} fechada: {ficou} ficou com a "
                    "cliente e sai pela venda"
                ),
            )
            item.returned_quantity = devolvidas[variante_id]
            if ficou:
                recebeu = retorno.variant_id
                ficaram[recebeu] = ficaram.get(recebeu, 0) + ficou

        if ficaram:
            venda_id = await self._vender(condicional, ficaram, dados, usuario)
            await self.repo.ligar_venda(condicional.id, venda_id)

        await self.session.commit()
        return await self.obter(condicional.id)

    async def _vender(
        self,
        condicional: Consignment,
        ficaram: dict[int, int],
        dados: FechamentoIn,
        usuario: User,
    ) -> int:
        """O que ficou vira venda pelo serviço público de vendas, sem commit (a transação é
        do fechamento). A cliente da condicional é a cliente da venda — e do fiado, se for."""
        from app.modules.vendas.schemas import ItemVendaIn, VendaIn
        from app.modules.vendas.service import VendaService

        observacao = f"Condicional #{condicional.id}"
        if dados.observacao:
            observacao = f"{observacao} — {dados.observacao}"
        try:
            pedido = VendaIn(
                client_uuid=dados.client_uuid,
                desconto=dados.desconto,
                observacao=observacao,
                itens=[ItemVendaIn(variante_id=v, quantidade=q) for v, q in ficaram.items()],
                pagamentos=dados.pagamentos,
                cliente_id=condicional.customer_id,
            )
        except ValidationError as exc:
            raise Validacao(
                "O fechamento não forma uma venda válida.",
                {"erros": [e["msg"] for e in exc.errors()]},
            ) from exc
        vendas = VendaService(self.session)
        venda = await vendas.registrar(pedido, usuario, confirmar=False)
        if vendas.replay:
            # A chave já era de uma venda do PDV: devolvê-la como a venda desta condicional
            # ligaria a cliente a uma compra que não é dela.
            raise Duplicado(
                f"Esta chave já registrou a venda #{venda.id}. Recarregue a tela e feche de novo.",
                {"venda_id": venda.id},
            )
        return venda.id

    async def _replay_fechamento(
        self, condicional: Consignment, dados: FechamentoIn, usuario: User
    ) -> CondicionalOut:
        """Fechada com ESTA chave e o MESMO pedido: é o reenvio, e é atendido. Senão, 409.

        A resposta se perde, a vendedora troca o PIX por dinheiro e fecha de novo: devolver
        o fechamento antigo como sucesso mostraria um recibo que não aconteceu, e a gaveta
        esperaria PIX onde entrou dinheiro. Por isso o pagamento também é conferido.
        """
        if condicional.closing_uuid != dados.client_uuid:
            raise OperacaoInvalida(
                f"A condicional #{condicional.id} já foi fechada.",
                {"condicional_id": condicional.id, "venda_id": condicional.sale_id},
            )
        mesmo = sorted((i.variant_id, i.returned_quantity) for i in condicional.items) == sorted(
            (i.variante_id, i.devolvida) for i in dados.itens
        )
        if mesmo and condicional.sale_id is not None:
            mesmo = await self._mesma_cobranca(condicional.sale_id, dados, usuario)
        elif mesmo:
            mesmo = not dados.pagamentos
        if not mesmo:
            raise Duplicado(
                f"A condicional #{condicional.id} já foi fechada com outro retorno ou outro "
                "pagamento. Confira antes de cobrar de novo.",
                {"condicional_id": condicional.id, "venda_id": condicional.sale_id},
            )
        self.replay = True
        return await self.obter(condicional.id)

    async def _mesma_cobranca(self, venda_id: int, dados: FechamentoIn, usuario: User) -> bool:
        from app.modules.vendas.service import VendaService

        # A mesma régua do reenvio do PDV: forma, valor, parcelas, bandeira e vale. Crédito
        # 1x reenviado como 3x é outra cobrança — devolver o fechamento antigo como sucesso
        # deixaria a taxa e os recebíveis do 1x numa venda que a moça acha que parcelou.
        return await VendaService(self.session).mesma_cobranca(
            venda_id, dados.pagamentos, dados.desconto, usuario
        )

    # ------------------------------------------------------------ leitura
    async def abertas_da_cliente(self, cliente_id: int) -> int:
        """Quantas sacolas esta cliente tem em casa. Público: a exclusão da cliente pergunta.

        A anonimização deixaria a condicional sem nome nem telefone para cobrar a volta — e o
        fechamento vende o que ficou para uma cliente que não existe mais, então as peças
        ficariam fora do saldo para sempre.
        """
        return await self.repo.abertas_da_cliente(cliente_id)

    async def obter(self, condicional_id: int) -> CondicionalOut:
        condicional = await self.repo.por_id(condicional_id)
        if condicional is None:
            raise NaoEncontrado("Condicional não encontrada.")
        return (await self._montar([condicional]))[0]

    async def listar(
        self, p: Paginacao, filtro: FiltroCondicionais, cliente_id: int | None
    ) -> Pagina[CondicionalOut]:
        condicionais, total = await self.repo.listar(p, filtro, hoje_na_loja(), cliente_id)
        return Pagina.montar(await self._montar(condicionais), total, p)

    async def _montar(self, condicionais: list[Consignment]) -> list[CondicionalOut]:
        hoje = hoje_na_loja()
        nomes = await self.repo.nomes(condicionais)
        pecas = await self.repo.pecas([i.variant_id for c in condicionais for i in c.items])
        saida: list[CondicionalOut] = []
        for c in condicionais:
            cliente, telefone, vendedora, fechou = nomes[c.id]
            itens = []
            for i in c.items:
                variante, produto = pecas[i.variant_id]
                itens.append(
                    ItemCondicionalOut(
                        variante_id=i.variant_id,
                        produto=produto.name,
                        tamanho=variante.size,
                        cor=variante.color,
                        codigo_barras=variante.barcode,
                        preco_venda=variante.sale_price,
                        quantidade=i.quantity,
                        devolvida=i.returned_quantity,
                        ficou=(
                            None
                            if i.returned_quantity is None
                            else i.quantity - i.returned_quantity
                        ),
                    )
                )
            aberta = c.status == StatusCondicional.ABERTA
            saida.append(
                CondicionalOut(
                    id=c.id,
                    status=c.status,
                    cliente_id=c.customer_id,
                    cliente=cliente,
                    cliente_telefone=telefone,
                    vendedora_id=c.seller_id,
                    vendedora=vendedora,
                    prazo=c.due_date,
                    vencida=aberta and c.due_date < hoje,
                    dias_para_vencer=(c.due_date - hoje).days,
                    observacao=c.note,
                    criada_em=c.created_at,
                    fechada_em=c.closed_at,
                    fechada_por=fechou,
                    venda_id=c.sale_id,
                    itens=itens,
                    total_pecas=sum(i.quantity for i in c.items),
                    valor_pecas=sum((it.preco_venda * it.quantidade for it in itens), ZERO),
                )
            )
        return saida
