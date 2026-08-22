from datetime import datetime
from decimal import Decimal

from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import EstoqueInsuficiente, NaoEncontrado, Validacao
from app.core.pagination import Pagina, Paginacao
from app.modules.estoque import movimentos
from app.modules.estoque.models import StockEntry, TipoMovimento
from app.modules.estoque.repository import EstoqueRepository
from app.modules.estoque.schemas import (
    AjusteIn,
    ContagemIn,
    DiferencaInventario,
    EntradaIn,
    EntradaOut,
    InventarioIn,
    InventarioOut,
    MovimentoOut,
    SaldoAdminOut,
    SaldoOut,
)
from app.modules.usuarios.models import Papel, User


class EstoqueService:
    def __init__(self, session: AsyncSession):
        self.session = session
        self.repo = EstoqueRepository(session)

    # ------------------------------------------------------------ entradas
    async def registrar_entrada(self, dados: EntradaIn, usuario: User) -> EntradaOut:
        """Recebimento de mercadoria: um cabeçalho e uma movimentação por peça bipada.

        Idempotente por client_uuid: o app pode reenviar depois de um timeout sem medo
        de somar o estoque duas vezes.
        """
        existente = await self.repo.entrada_por_client_uuid(dados.client_uuid)
        if existente is not None:
            return await self._montar_entrada(existente)

        variantes = await self.repo.variantes_por_ids([i.variante_id for i in dados.itens])
        desconhecidas = [i.variante_id for i in dados.itens if i.variante_id not in variantes]
        if desconhecidas:
            raise NaoEncontrado("Peça não encontrada.", {"variantes": desconhecidas})

        entrada = StockEntry(
            user_id=usuario.id,
            supplier=dados.fornecedor,
            note=dados.observacao,
            client_uuid=dados.client_uuid,
        )
        self.session.add(entrada)
        try:
            await self.session.flush()
        except IntegrityError:
            # Duas requisições idênticas ao mesmo tempo: a perdedora lê o que a outra gravou.
            await self.session.rollback()
            existente = await self.repo.entrada_por_client_uuid(dados.client_uuid)
            if existente is None:
                raise
            return await self._montar_entrada(existente)

        itens_por_variante = {i.variante_id: i for i in dados.itens}
        for variante_id in movimentos.ordenar_para_evitar_deadlock(list(itens_por_variante)):
            item = itens_por_variante[variante_id]
            if item.custo_unitario is not None:
                variantes[variante_id].cost_price = item.custo_unitario
            await movimentos.aplicar_movimento(
                self.session,
                variante_id=variante_id,
                delta=item.quantidade,
                tipo=TipoMovimento.ENTRADA,
                user_id=usuario.id,
                entry_id=entrada.id,
                observacao=f"Fornecedor: {dados.fornecedor}" if dados.fornecedor else None,
            )
        await self.session.commit()
        return await self._montar_entrada(entrada)

    async def _montar_entrada(self, entrada: StockEntry) -> EntradaOut:
        movs = await self.repo.movimentos_da_entrada(entrada.id)
        return EntradaOut(
            id=entrada.id,
            fornecedor=entrada.supplier,
            observacao=entrada.note,
            criada_em=entrada.created_at,
            itens=[MovimentoOut.model_validate(m) for m in movs],
            total_pecas=sum(m.quantity for m in movs),
        )

    # ------------------------------------------------------------ ajuste
    async def ajustar(self, dados: AjusteIn, usuario: User) -> MovimentoOut:
        """Correção manual. Motivo é obrigatório: ajuste sem explicação vira buraco no caixa."""
        variantes = await self.repo.variantes_por_ids([dados.variante_id])
        if dados.variante_id not in variantes:
            raise NaoEncontrado("Peça não encontrada.")

        if dados.quantidade < 0:
            saldo = await movimentos.saldo_atual(self.session, dados.variante_id)
            if saldo < abs(dados.quantidade):
                raise EstoqueInsuficiente(
                    "O ajuste deixaria o estoque negativo.",
                    {"saldo_atual": saldo, "retirada": abs(dados.quantidade)},
                )

        movimento = await movimentos.aplicar_movimento(
            self.session,
            variante_id=dados.variante_id,
            delta=dados.quantidade,
            tipo=TipoMovimento.AJUSTE,
            user_id=usuario.id,
            observacao=dados.motivo,
        )
        await self.session.commit()
        return MovimentoOut.model_validate(movimento)

    # ------------------------------------------------------------ inventário
    async def inventariar(self, dados: InventarioIn, usuario: User) -> InventarioOut:
        """Contagem física: gera uma movimentação por diferença encontrada.

        Peça contada igual ao sistema não gera movimentação — o extrato guarda acertos,
        não a rotina de conferir.
        """
        ids = [c.variante_id for c in dados.contagens]
        variantes = await self.repo.variantes_por_ids(ids)
        desconhecidas = [i for i in ids if i not in variantes]
        if desconhecidas:
            raise NaoEncontrado("Peça não encontrada.", {"variantes": desconhecidas})

        saldos = await movimentos.saldos_de(self.session, ids)
        contagens: dict[int, ContagemIn] = {c.variante_id: c for c in dados.contagens}

        diferencas: list[DiferencaInventario] = []
        for variante_id in movimentos.ordenar_para_evitar_deadlock(ids):
            contagem = contagens[variante_id]
            saldo = saldos.get(variante_id, 0)
            delta = contagem.quantidade_contada - saldo
            if delta == 0:
                continue
            variante = variantes[variante_id]
            await movimentos.aplicar_movimento(
                self.session,
                variante_id=variante_id,
                delta=delta,
                tipo=TipoMovimento.INVENTARIO,
                user_id=usuario.id,
                observacao=dados.observacao or "Acerto por contagem física",
            )
            produto = variante.product
            diferencas.append(
                DiferencaInventario(
                    variante_id=variante_id,
                    codigo_barras=variante.barcode,
                    produto=produto.name if produto else "",
                    tamanho=variante.size,
                    cor=variante.color,
                    saldo_sistema=saldo,
                    quantidade_contada=contagem.quantidade_contada,
                    diferenca=delta,
                )
            )
        await self.session.commit()
        return InventarioOut(
            conferidas=len(dados.contagens),
            ajustadas=len(diferencas),
            diferenca_total=sum(d.diferenca for d in diferencas),
            diferencas=diferencas,
        )

    # ------------------------------------------------------------ leitura
    async def listar_saldos(
        self,
        p: Paginacao,
        q: str | None,
        categoria_id: int | None,
        somente_baixo: bool,
        usuario: User,
    ) -> Pagina[SaldoOut]:
        linhas, total = await self.repo.listar_saldos(p, q, categoria_id, somente_baixo)
        admin = usuario.role == Papel.ADMIN
        items: list[SaldoOut] = []
        for variante, produto, categoria, quantidade in linhas:
            saldo = int(quantidade or 0)
            comum = {
                "variante_id": variante.id,
                "produto_id": produto.id,
                "produto": produto.name,
                "categoria": categoria.name,
                "tamanho": variante.size,
                "cor": variante.color,
                "codigo_barras": variante.barcode,
                "preco_venda": variante.sale_price,
                "saldo": saldo,
                "estoque_minimo": variante.min_stock,
                "estoque_baixo": saldo <= variante.min_stock,
            }
            if admin:
                items.append(
                    SaldoAdminOut(
                        **comum,
                        preco_custo=variante.cost_price,
                        valor_em_custo=Decimal(saldo) * variante.cost_price,
                    )
                )
            else:
                items.append(SaldoOut(**comum))
        return Pagina.montar(items, total, p)

    async def listar_movimentos(
        self,
        p: Paginacao,
        variante_id: int | None,
        tipo: str | None,
        inicio: datetime | None,
        fim: datetime | None,
    ) -> Pagina[MovimentoOut]:
        if inicio and fim and inicio > fim:
            raise Validacao("A data inicial é depois da final.")
        linhas, total = await self.repo.listar_movimentos(p, variante_id, tipo, inicio, fim)
        items = []
        for movimento, variante, produto, user in linhas:
            item = MovimentoOut.model_validate(movimento)
            item.produto = produto.name
            item.tamanho = variante.size
            item.cor = variante.color
            item.codigo_barras = variante.barcode
            item.usuario = user.name
            items.append(item)
        return Pagina.montar(items, total, p)
