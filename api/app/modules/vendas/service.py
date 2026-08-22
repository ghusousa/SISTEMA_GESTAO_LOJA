from datetime import UTC, datetime
from decimal import Decimal

from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.exceptions import (
    NaoEncontrado,
    OperacaoInvalida,
    PagamentoDivergente,
    SemPermissao,
    Validacao,
)
from app.core.pagination import Pagina, Paginacao
from app.modules.estoque import movimentos
from app.modules.estoque.models import TipoMovimento
from app.modules.usuarios.models import Papel, User
from app.modules.vendas.models import Sale, SaleItem, SalePayment, StatusVenda
from app.modules.vendas.repository import VendaRepository
from app.modules.vendas.schemas import (
    ItemVendaAdminOut,
    ItemVendaOut,
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

    # ------------------------------------------------------------ criação
    async def registrar(self, dados: VendaIn, usuario: User) -> VendaOut:
        """Registra a venda inteira em uma transação: itens, pagamentos e baixa de estoque.

        Ou tudo acontece, ou nada acontece — meia venda deixaria estoque baixado sem
        registro de dinheiro, que é o pior estado possível para a loja.
        """
        ja_registrada = await self.repo.por_client_uuid(dados.client_uuid)
        if ja_registrada is not None:
            # O replay devolve a venda existente, mas com o mesmo escopo do GET: quem
            # descobrisse o client_uuid de uma venda alheia leria por aqui o que
            # `GET /vendas/{id}` recusaria.
            if usuario.role != Papel.ADMIN and ja_registrada.seller_id != usuario.id:
                raise SemPermissao("Esta venda pertence a outro vendedor.")
            return await self._montar_venda(ja_registrada, usuario)

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

        venda = Sale(
            seller_id=usuario.id,
            status=StatusVenda.CONCLUIDA,
            subtotal=subtotal,
            discount=dados.desconto,
            total=total,
            client_uuid=dados.client_uuid,
            note=dados.observacao,
        )
        self.session.add(venda)
        try:
            await self.session.flush()
        except IntegrityError:
            # Duas requisições da mesma venda ao mesmo tempo: a perdedora devolve a vencedora.
            await self.session.rollback()
            existente = await self.repo.por_client_uuid(dados.client_uuid)
            if existente is None:
                raise
            return await self._montar_venda(existente, usuario)

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
        for pagamento in dados.pagamentos:
            self.session.add(
                SalePayment(sale_id=venda.id, method=pagamento.forma, amount=pagamento.valor)
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

        await self.session.commit()
        registrada = await self.repo.por_id(venda.id)
        assert registrada is not None
        return await self._montar_venda(registrada, usuario)

    # ------------------------------------------------------------ cancelamento
    async def cancelar(self, venda_id: int, motivo: str, usuario: User) -> VendaOut:
        """Cancelar não apaga: marca CANCELADA e devolve as peças por movimentação."""
        venda = await self.repo.por_id(venda_id)
        if venda is None:
            raise NaoEncontrado("Venda não encontrada.")
        if venda.status == StatusVenda.CANCELADA:
            raise OperacaoInvalida("Esta venda já está cancelada.")

        if usuario.role != Papel.ADMIN:
            # Mesma resposta de venda inexistente: dizer "não é sua" confirmaria a
            # existência da venda alheia e deixaria mapear o movimento da loja.
            if venda.seller_id != usuario.id:
                raise NaoEncontrado("Venda não encontrada.")
            if self._dia_da_loja(venda.sold_at) != self._dia_da_loja(datetime.now(UTC)):
                raise SemPermissao(
                    "Vendas de dias anteriores só podem ser canceladas pelo administrador."
                )

        # A troca de status vem ANTES dos estornos e só acontece se a venda ainda estiver
        # concluída. Sem isso, dois cancelamentos simultâneos (toque duplo, retry após
        # timeout) passariam os dois pela checagem em memória e devolveriam o estoque duas
        # vezes — o UPDATE de saldo é atômico, mas soma, então o erro não apareceria.
        cancelou = await self.repo.marcar_cancelada(
            venda_id, cancelada_por=usuario.id, motivo=motivo
        )
        if not cancelou:
            await self.session.rollback()
            raise OperacaoInvalida("Esta venda já está cancelada.")

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

        await self.session.commit()

        atualizada = await self.repo.por_id(venda_id)
        assert atualizada is not None
        return await self._montar_venda(atualizada, usuario)

    @staticmethod
    def _dia_da_loja(momento: datetime) -> object:
        """O 'dia' do comércio é o do fuso da loja, não o do UTC."""
        return momento.astimezone(settings.tz_loja).date()

    # ------------------------------------------------------------ leitura
    async def obter(self, venda_id: int, usuario: User) -> VendaOut:
        venda = await self.repo.por_id(venda_id)
        if venda is None:
            raise NaoEncontrado("Venda não encontrada.")
        if usuario.role != Papel.ADMIN and venda.seller_id != usuario.id:
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
    ) -> Pagina[VendaResumoOut]:
        if usuario.role != Papel.ADMIN:
            vendedor_id = usuario.id  # vendedor só enxerga as próprias vendas
        linhas, total = await self.repo.listar(p, inicio, fim, status, vendedor_id)
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
        admin = usuario.role == Papel.ADMIN

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
            "observacao": venda.note,
            "itens": itens,
            "pagamentos": [
                PagamentoOut(forma=p.method, valor=p.amount) for p in venda.payments
            ],
        }
        if not admin:
            return VendaOut(**comum_venda)

        custo_total = sum((i.unit_cost * i.quantity for i in venda.items), ZERO)
        return VendaAdminOut(
            **comum_venda, custo_total=custo_total, lucro_bruto=venda.total - custo_total
        )
