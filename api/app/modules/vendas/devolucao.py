"""Devolução parcial — e, com ela, a troca.

**Não existe "modo troca".** Troca é devolução que vira vale, mais uma venda nova paga com
esse vale. Um caminho só, com rastro em `vouchers`, em vez de um estado especial que
ninguém testa e que aparece num sábado cheio.

Três regras carregam o resto:

1. **O valor devolvido é pró-rata do desconto.** O ADR-3 põe o desconto no total da venda,
   não no item. Devolver o preço de etiqueta de uma peça comprada numa venda com 20% de
   desconto devolve mais do que a cliente pagou — e a diferença sai do bolso da loja em
   toda troca. Quando a devolução zera o saldo da venda, o valor é o que resta do total,
   para que devolver tudo devolva exatamente o que entrou, sem sobra de arredondamento.

2. **Ninguém recebe em espécie o que não pagou em espécie.** Venda paga metade no cartão
   não devolve tudo em dinheiro: isso esvazia a gaveta e deixa o caixa do dia negativo,
   sem nada na tela explicando por quê. O que passar do que entrou em cada forma sai como
   VALE — ou, se a venda foi no fiado, abate a dívida em vez de virar dinheiro.

3. **A conta de quanto já voltou é do banco, não da memória.** `sale_items.returned_quantity`
   sobe por `UPDATE ... WHERE returned_quantity + :q <= quantity`, mesma mecânica do saldo
   de estoque. Duas devoluções simultâneas da mesma peça (toque duplo, retry de rede)
   passariam as duas por qualquer checagem em memória, e a peça voltaria duas vezes para a
   arara com o dinheiro saindo duas vezes da gaveta.
"""

from decimal import ROUND_HALF_UP, Decimal

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import NaoEncontrado, OperacaoInvalida, Validacao
from app.core.permissoes import Pode, pode
from app.modules.estoque import movimentos
from app.modules.estoque.models import TipoMovimento
from app.modules.usuarios.models import User
from app.modules.vendas.models import (
    FORMAS_DE_GAVETA,
    FormaPagamento,
    Sale,
    SaleItem,
    SalePayment,
    SaleReturn,
    SaleReturnItem,
    SaleReturnPayment,
    StatusVenda,
    Voucher,
)

ZERO = Decimal("0.00")

#: Formas que a loja pode devolver em espécie no mesmo dia. Cartão fica de fora de
#: propósito: o estorno na adquirente acontece dias depois e não muda o que está na gaveta
#: hoje — descontar criaria uma sobra falsa justo na forma em que sobra é sinal de erro.
FORMAS_QUE_SAEM_DA_GAVETA: tuple[FormaPagamento, ...] = (
    FormaPagamento.DINHEIRO,
    FormaPagamento.PIX,
)


def centavos(valor: Decimal) -> Decimal:
    return valor.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


async def gerar_codigo_de_vale(session: AsyncSession) -> str:
    """Curto e ditável: o vale é escrito num papel e lido em voz alta no telefone."""
    proximo = await session.scalar(select(func.nextval("voucher_code_seq")))
    return f"V{int(proximo):06d}"


class DevolucaoService:
    def __init__(self, session: AsyncSession):
        self.session = session

    # ------------------------------------------------------------- leitura
    async def _venda_travada(self, venda_id: int) -> Sale:
        """Pega a venda com a linha travada: é o que serializa devolução × cancelamento."""
        venda = (
            await self.session.execute(
                select(Sale).where(Sale.id == venda_id).with_for_update()
            )
        ).scalar_one_or_none()
        if venda is None:
            raise NaoEncontrado("Venda não encontrada.")
        if venda.status != StatusVenda.CONCLUIDA:
            raise OperacaoInvalida(
                "Esta venda está cancelada; não há o que devolver."
            )
        return venda

    async def _pago_por_forma(self, venda_id: int) -> dict[str, Decimal]:
        linhas = (
            await self.session.execute(
                select(SalePayment.method, func.sum(SalePayment.amount))
                .where(SalePayment.sale_id == venda_id)
                .group_by(SalePayment.method)
            )
        ).all()
        return {forma: Decimal(valor) for forma, valor in linhas}

    async def _ja_devolvido_por_forma(self, venda_id: int) -> dict[str, Decimal]:
        linhas = (
            await self.session.execute(
                select(SaleReturnPayment.method, func.sum(SaleReturnPayment.amount))
                .join(SaleReturn, SaleReturn.id == SaleReturnPayment.return_id)
                .where(SaleReturn.sale_id == venda_id)
                .group_by(SaleReturnPayment.method)
            )
        ).all()
        return {forma: Decimal(valor) for forma, valor in linhas}

    async def _ja_devolvido_total(self, venda_id: int) -> Decimal:
        total = await self.session.scalar(
            select(func.coalesce(func.sum(SaleReturn.total), 0)).where(
                SaleReturn.sale_id == venda_id
            )
        )
        return Decimal(total or 0)

    # -------------------------------------------------------------- cálculo
    @staticmethod
    def _valor_pro_rata(item: SaleItem, quantidade: int, venda: Sale) -> Decimal:
        """O que a cliente pagou por estas unidades, com o desconto da venda rateado."""
        bruto = item.unit_price * quantidade
        if venda.subtotal <= ZERO:
            return ZERO
        return centavos(bruto * venda.total / venda.subtotal)

    async def _divida_atual(self, venda: Sale) -> Decimal:
        """Quanto o cliente desta venda ainda deve, hoje.

        Abater fiado só faz sentido até onde a dívida existe (ADR-21). A cliente que levou
        no fiado, PAGOU e só depois devolveu a peça já não deve nada: continuar abatendo
        deixaria o saldo dela em -R$ 100,00 — a loja devendo a ela, fora da lista de quem
        está devendo, sem nada na tela dizendo isso. O que não cabe na dívida sai como
        vale, que é um papel na mão dela.
        """
        if venda.customer_id is None:
            return ZERO
        # Import tardio de propósito: `clientes` já importa os models de `vendas`, e o
        # serviço público é a única porta permitida entre módulos (CLAUDE.md).
        from app.modules.clientes.service import ClienteService

        # `travar` segura a linha do cliente: sem isso, duas devoluções simultâneas de
        # vendas DIFERENTES do mesmo cliente leriam a mesma dívida e cada uma abateria o
        # valor inteiro. O `FOR UPDATE` da venda não cobre esse caso — são duas vendas.
        deve = await ClienteService(self.session).quanto_deve(venda.customer_id, travar=True)
        return max(ZERO, deve)

    async def _distribuir_devolucao(
        self, venda: Sale, total: Decimal
    ) -> list[tuple[FormaPagamento, Decimal]]:
        """Decide por qual forma o valor volta, respeitando o que entrou por cada uma.

        A ordem não é estética: primeiro sai o que a loja de fato recebeu em espécie
        (dinheiro, PIX), depois o cartão, depois o que já era crédito (vale) e por último o
        fiado, que não devolve nada — abate. O que sobrar vira vale novo.
        """
        pago = await self._pago_por_forma(venda.id)
        devolvido = await self._ja_devolvido_por_forma(venda.id)
        disponivel = {
            forma: pago.get(forma, ZERO) - devolvido.get(forma, ZERO) for forma in pago
        }
        if disponivel.get(FormaPagamento.FIADO, ZERO) > ZERO:
            disponivel[FormaPagamento.FIADO] = min(
                disponivel[FormaPagamento.FIADO], await self._divida_atual(venda)
            )

        ordem = [
            FormaPagamento.DINHEIRO,
            FormaPagamento.PIX,
            FormaPagamento.DEBITO,
            FormaPagamento.CREDITO,
            FormaPagamento.VALE,
            FormaPagamento.FIADO,
        ]
        saida: list[tuple[FormaPagamento, Decimal]] = []
        restante = total
        for forma in ordem:
            if restante <= ZERO:
                break
            cabe = min(restante, disponivel.get(forma, ZERO))
            if cabe > ZERO:
                saida.append((forma, cabe))
                restante -= cabe

        if restante > ZERO:
            # Sobra quando a dívida no fiado já foi paga: o valor não pode voltar por uma
            # forma que não entrou, então vira vale — nunca dinheiro que não está na gaveta.
            saida.append((FormaPagamento.VALE, restante))
        return saida

    # ---------------------------------------------------------------- ação
    async def _por_client_uuid(self, client_uuid) -> SaleReturn | None:
        return (
            await self.session.execute(
                select(SaleReturn).where(SaleReturn.client_uuid == client_uuid)
            )
        ).scalar_one_or_none()

    async def devolver(self, venda_id: int, dados, usuario: User):
        """Recebe as peças de volta. Tudo numa transação — ou nada."""
        ja = await self._por_client_uuid(dados.client_uuid)
        if ja is not None:
            return await self.montar(ja)

        venda = await self._venda_travada(venda_id)

        # A mesma pergunta de novo, agora com a venda travada. O retry que chega enquanto
        # a primeira tentativa ainda não fez commit passa pela checagem lá de cima sem ver
        # nada e fica parado na trava; quando ela solta, a primeira já gravou. Sem esta
        # releitura ele seguia até o INSERT, batia no UNIQUE do `client_uuid` e a tela
        # mostrava erro (500) para uma devolução que aconteceu.
        ja = await self._por_client_uuid(dados.client_uuid)
        if ja is not None:
            return await self.montar(ja)

        itens_da_venda = {
            item.id: item
            for item in (
                await self.session.execute(
                    select(SaleItem).where(SaleItem.sale_id == venda_id)
                )
            )
            .scalars()
            .all()
        }
        for pedido in dados.itens:
            if pedido.item_id not in itens_da_venda:
                raise NaoEncontrado(
                    "Esta peça não está nesta venda.", {"item_id": pedido.item_id}
                )

        devolucao = SaleReturn(
            sale_id=venda.id,
            user_id=usuario.id,
            reason=dados.motivo,
            total=ZERO,
            client_uuid=dados.client_uuid,
        )
        self.session.add(devolucao)
        await self.session.flush()

        # Ordem crescente de item: mesma disciplina anti-deadlock do estoque.
        total = ZERO
        linhas: list[SaleReturnItem] = []
        for pedido in sorted(dados.itens, key=lambda i: i.item_id):
            item = itens_da_venda[pedido.item_id]
            baixou = await self.session.execute(
                update(SaleItem)
                .where(
                    SaleItem.id == item.id,
                    SaleItem.returned_quantity + pedido.quantidade <= SaleItem.quantity,
                )
                .values(returned_quantity=SaleItem.returned_quantity + pedido.quantidade)
            )
            if baixou.rowcount == 0:
                raise OperacaoInvalida(
                    "Esta peça já foi devolvida (ou a quantidade não confere).",
                    {
                        "item_id": item.id,
                        "vendidas": item.quantity,
                        "ja_devolvidas": item.returned_quantity,
                    },
                )
            valor = self._valor_pro_rata(item, pedido.quantidade, venda)
            total += valor
            linha = SaleReturnItem(
                return_id=devolucao.id,
                sale_id=venda.id,
                sale_item_id=item.id,
                variant_id=item.variant_id,
                quantity=pedido.quantidade,
                refund_amount=valor,
                restock=pedido.voltar_ao_estoque,
            )
            linhas.append(linha)
            self.session.add(linha)

        # Devolver a venda inteira tem de devolver exatamente o total — o resíduo de todos
        # os arredondamentos pró-rata vai para a última devolução, não para o ralo.
        await self.session.flush()
        se_zerou = await self._venda_ficou_zerada(venda_id)
        if se_zerou:
            ja_devolvido = await self._ja_devolvido_total(venda_id)
            corrigido = venda.total - ja_devolvido
            # O resíduo entra TAMBÉM na linha do item, não só no total: quem soma o
            # faturamento devolvido é `sale_return_items.refund_amount` (relatórios), e
            # quem sai da gaveta é `sale_return_payments` (caixa). Corrigir um só faria os
            # dois discordarem por centavos — e um relatório que não fecha por um centavo
            # é um relatório em que ninguém confia.
            residuo = corrigido - total
            if residuo != ZERO and linhas:
                # Na maior linha, que absorve alguns centavos sem risco de ficar negativa.
                maior = max(linhas, key=lambda l: l.refund_amount)
                maior.refund_amount = maior.refund_amount + residuo
            total = corrigido

        devolucao.total = total

        for forma, valor in await self._distribuir_devolucao(venda, total):
            voucher_id = None
            if forma == FormaPagamento.VALE:
                vale = Voucher(
                    code=await gerar_codigo_de_vale(self.session),
                    value=valor,
                    return_id=devolucao.id,
                )
                self.session.add(vale)
                await self.session.flush()
                voucher_id = vale.id
            self.session.add(
                SaleReturnPayment(
                    return_id=devolucao.id,
                    method=forma,
                    amount=valor,
                    voucher_id=voucher_id,
                )
            )

        # Estoque só para o que volta a ser vendável. Peça com defeito não vai para a
        # arara, e o custo dela continua sendo custo da loja (não estorna CMV).
        volta = {}
        for pedido in dados.itens:
            if pedido.voltar_ao_estoque:
                item = itens_da_venda[pedido.item_id]
                volta[item.variant_id] = volta.get(item.variant_id, 0) + pedido.quantidade
        for variante_id in movimentos.ordenar_para_evitar_deadlock(list(volta)):
            await movimentos.aplicar_movimento(
                self.session,
                variante_id=variante_id,
                delta=volta[variante_id],
                tipo=TipoMovimento.DEVOLUCAO,
                user_id=usuario.id,
                sale_id=venda.id,
                return_id=devolucao.id,
                observacao=f"Devolução da venda #{venda.id}",
            )

        await self.session.commit()
        return await self.montar(await self._por_id(devolucao.id))

    async def _venda_ficou_zerada(self, venda_id: int) -> bool:
        sobrando = await self.session.scalar(
            select(func.coalesce(func.sum(SaleItem.quantity - SaleItem.returned_quantity), 0))
            .where(SaleItem.sale_id == venda_id)
        )
        return int(sobrando or 0) == 0

    async def consultar_vale(self, codigo: str):
        from app.modules.vendas.schemas import ValeOut

        vale = (
            await self.session.execute(
                select(Voucher).where(Voucher.code == codigo.strip().upper())
            )
        ).scalar_one_or_none()
        if vale is None:
            raise NaoEncontrado("Vale não encontrado.", {"codigo": codigo})
        saida = ValeOut.model_validate(vale)
        saida.saldo = vale.value - vale.used_value
        return saida

    async def listar_da_venda(self, venda_id: int, usuario: User) -> list:
        """As devoluções de uma venda, para a tela de detalhe mostrar o que já voltou.

        Mesmo escopo do detalhe da venda: quem não tem `VER_VENDAS_DE_TODOS` só enxerga as
        próprias. Sem isso, esta rota seria a porta lateral para ler o que passou pela mão
        das colegas — item e preço, por um caminho que o `GET /vendas/{id}` fecha.
        """
        venda = (
            await self.session.execute(select(Sale).where(Sale.id == venda_id))
        ).scalar_one_or_none()
        if venda is None:
            raise NaoEncontrado("Venda não encontrada.")
        if not pode(usuario.role, Pode.VER_VENDAS_DE_TODOS) and venda.seller_id != usuario.id:
            raise NaoEncontrado("Venda não encontrada.")

        devolucoes = list(
            (
                await self.session.execute(
                    select(SaleReturn)
                    .where(SaleReturn.sale_id == venda_id)
                    .order_by(SaleReturn.id)
                )
            )
            .scalars()
            .all()
        )
        return [await self.montar(d) for d in devolucoes]

    async def _por_id(self, devolucao_id: int) -> SaleReturn:
        devolucao = (
            await self.session.execute(
                select(SaleReturn).where(SaleReturn.id == devolucao_id)
            )
        ).scalar_one_or_none()
        if devolucao is None:
            raise NaoEncontrado("Devolução não encontrada.")
        return devolucao

    async def montar(self, devolucao: SaleReturn):
        """Monta a resposta com preço e custo vindos de `sale_items`, por JOIN.

        Preço e custo NÃO são copiados para a devolução de propósito: eles vivem
        congelados na venda, e copiar seria a chance de alguém escrever o custo de hoje.
        """
        from app.modules.vendas.schemas import (
            DevolucaoOut,
            ItemDevolvidoOut,
            PagamentoDevolucaoOut,
        )
        from app.modules.catalogo.models import Product, ProductVariant

        linhas = (
            await self.session.execute(
                select(
                    SaleReturnItem,
                    SaleItem.unit_price,
                    SaleItem.unit_cost,
                    Product.name,
                    ProductVariant.size,
                    ProductVariant.color,
                    ProductVariant.barcode,
                )
                .join(SaleItem, SaleItem.id == SaleReturnItem.sale_item_id)
                .join(ProductVariant, ProductVariant.id == SaleReturnItem.variant_id)
                .join(Product, Product.id == ProductVariant.product_id)
                .where(SaleReturnItem.return_id == devolucao.id)
                .order_by(SaleReturnItem.id)
            )
        ).all()

        pagamentos = (
            await self.session.execute(
                select(SaleReturnPayment, Voucher.code)
                .outerjoin(Voucher, Voucher.id == SaleReturnPayment.voucher_id)
                .where(SaleReturnPayment.return_id == devolucao.id)
                .order_by(SaleReturnPayment.id)
            )
        ).all()

        return DevolucaoOut(
            id=devolucao.id,
            venda_id=devolucao.sale_id,
            devolvida_em=devolucao.returned_at,
            motivo=devolucao.reason,
            total=devolucao.total,
            itens=[
                ItemDevolvidoOut(
                    item_id=item.sale_item_id,
                    variante_id=item.variant_id,
                    produto=nome,
                    tamanho=tamanho,
                    cor=cor,
                    codigo_barras=codigo,
                    quantidade=item.quantity,
                    preco_unitario=preco,
                    valor_devolvido=item.refund_amount,
                    voltou_ao_estoque=item.restock,
                )
                for item, preco, _custo, nome, tamanho, cor, codigo in linhas
            ],
            pagamentos=[
                PagamentoDevolucaoOut(
                    forma=pagamento.method, valor=pagamento.amount, codigo_vale=codigo
                )
                for pagamento, codigo in pagamentos
            ],
        )
