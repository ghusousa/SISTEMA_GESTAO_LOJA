from datetime import datetime
from decimal import Decimal

from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import (
    Duplicado,
    EstoqueInsuficiente,
    NaoEncontrado,
    SemPermissao,
    Validacao,
)
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
from app.core.permissoes import Pode, pode
from app.modules.usuarios.models import User


class EstoqueService:
    def __init__(self, session: AsyncSession):
        self.session = session
        self.repo = EstoqueRepository(session)
        #: A última `registrar_entrada` devolveu uma entrada que já existia (ADR-2). É o
        #: router que lê, para responder 200 em vez de 201.
        self.replay = False

    # ------------------------------------------------------------ entradas
    async def registrar_entrada(self, dados: EntradaIn, usuario: User) -> EntradaOut:
        """Recebimento de mercadoria: um cabeçalho e uma movimentação por peça bipada.

        Idempotente por client_uuid: o app pode reenviar depois de um timeout sem medo
        de somar o estoque duas vezes.
        """
        # Lido já: o ramo do IntegrityError faz rollback, que expira o `usuario`, e tocar
        # `usuario.role` depois estoura MissingGreenlet.
        grava_custo = pode(usuario.role, Pode.VER_DINHEIRO)
        if dados.nota is not None and not grava_custo:
            # Recusa, em vez de ignorar como o custo: ignorar a nota em silêncio deixaria a
            # loja achando que o boleto entrou em Contas a pagar — e ele venceria esquecido.
            raise SemPermissao(
                "A nota do fornecedor (valor e vencimentos) é de quem vê o dinheiro da loja. "
                "Dê a entrada sem ela."
            )
        existente = await self.repo.entrada_por_client_uuid(dados.client_uuid)
        if existente is not None:
            return await self._replay(existente, dados, grava_custo)

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
            return await self._replay(existente, dados, grava_custo)

        # Custo só é gravado por quem vê dinheiro — a mesma tranca do catálogo
        # (`_custo_permitido`, `atualizar_variante`). A vendedora dá entrada de mercadoria,
        # mas não recebe o custo em resposta nenhuma: um `custo_unitario` vindo dela
        # reescreveria a margem da loja sem ela nunca poder conferir o número. A tela já
        # não mostra o campo; isto aqui é para a requisição que vier por outro caminho.
        itens_por_variante = {i.variante_id: i for i in dados.itens}
        for variante_id in movimentos.ordenar_para_evitar_deadlock(list(itens_por_variante)):
            item = itens_por_variante[variante_id]
            if item.custo_unitario is not None and grava_custo:
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
        if dados.nota is not None:
            # Mesma transação: a mercadoria e a dívida dela entram juntas, ou nenhuma entra.
            await self._contas().lancar_da_entrada(
                entrada_id=entrada.id,
                fornecedor=(dados.fornecedor or "").strip(),
                nota=dados.nota,
                usuario_id=usuario.id,
            )
        await self.session.commit()
        return await self._montar_entrada(entrada)

    def _contas(self):  # noqa: ANN202 — ContaPagarService (import tardia, sem ciclo)
        from app.modules.contas_pagar.service import ContaPagarService

        return ContaPagarService(self.session)

    async def _replay(
        self, entrada: StockEntry, dados: EntradaIn, grava_custo: bool
    ) -> EntradaOut:
        """Devolve a entrada que este `client_uuid` já gravou — se o pedido for o MESMO.

        A resposta se perde, a pessoa bipa mais sete peças M e reenvia: a tela guarda o
        uuid até dar certo, então o reenvio leva a chave da entrada que JÁ foi gravada.
        Devolver a antiga como sucesso descartava as sete em silêncio — e a tela ainda
        oferecia etiqueta para elas, como se tivessem entrado. O 409 diz que a entrada
        existe e qual é; o reenvio idêntico continua sendo atendido (ADR-2).

        Confere peças, quantidades e fornecedor. O custo não fica gravado por item na
        entrada: o que ela gravou foi para a PEÇA, então a peça é quem diz se o custo
        pedido agora é o mesmo. (De quem não grava custo, o custo nem é conferido: seria
        ignorado de qualquer jeito.)
        """
        movs = await self.repo.movimentos_da_entrada(entrada.id)
        pedido = sorted((i.variante_id, i.quantidade) for i in dados.itens)
        gravado = sorted((m.variant_id, m.quantity) for m in movs)
        mesmo_fornecedor = (dados.fornecedor or "").strip() == (entrada.supplier or "").strip()
        # A nota faz parte do pedido: o reenvio com outro valor ou outro vencimento não pode
        # sair como sucesso com as parcelas antigas (ADR-40).
        contas = self._contas()
        mesma_nota = await contas.nota_da_entrada(entrada.id) == contas.assinatura_do_pedido(
            dados.nota
        )
        mesmo_pedido = pedido == gravado and mesmo_fornecedor and mesma_nota
        custos = {
            i.variante_id: i.custo_unitario for i in dados.itens if i.custo_unitario is not None
        }
        if mesmo_pedido and grava_custo and custos:
            pecas = await self.repo.variantes_por_ids(list(custos))
            mesmo_pedido = all(
                pecas[vid].cost_price == custo for vid, custo in custos.items() if vid in pecas
            )
        if not mesmo_pedido:
            pecas = sum(m.quantity for m in movs)
            # `itens` vai junto para a tela tirar da lista o que JÁ entrou antes de trocar a
            # chave: só trocar a chave e reenviar a lista inteira somaria de novo as peças
            # da entrada gravada (10 P + 7 M viravam +20 P em vez de +10).
            detalhe: dict = {
                "entrada_id": entrada.id,
                "itens": [{"variante_id": m.variant_id, "quantidade": m.quantity} for m in movs],
            }
            if grava_custo:
                # E a `nota`, pelo mesmo motivo: a tela que só tirasse as peças reenviaria o
                # resto com a nota que a entrada gravada JÁ lançou, e a dívida do fornecedor
                # dobraria em Contas a pagar. `None` = a gravada foi sem nota, e a do
                # formulário fica. Quem não vê dinheiro não recebe a chave: nem manda nota
                # (`SemPermissao` acima), e o valor dela é custo da mercadoria.
                detalhe["nota"] = await contas.nota_gravada_da_entrada(entrada.id)
            raise Duplicado(
                f"Esta entrada já foi gravada (entrada #{entrada.id}, {pecas} "
                f"{'peça' if pecas == 1 else 'peças'}), com outras peças, outro "
                "fornecedor ou outra nota.",
                detalhe,
            )
        self.replay = True
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
            contas_a_pagar=await self._contas().contar_da_entrada(entrada.id),
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
        # Peças e saldos TRAVADOS antes de calcular a diferença, nessa ordem e por id.
        # O inventário SUBSTITUI o saldo pelo contado, mas escreve por soma (delta): lendo
        # solto, duas contagens iguais (toque duplo, dois aparelhos) liam o mesmo saldo e
        # aplicavam a diferença duas vezes, e uma venda entre a leitura e a escrita deixava
        # o saldo e o extrato errados. A trava da peça cobre a que ainda não tem linha de
        # saldo, onde `FOR UPDATE` não teria o que travar.
        variantes = await self.repo.variantes_por_ids(ids, travar=True)
        desconhecidas = [i for i in ids if i not in variantes]
        if desconhecidas:
            raise NaoEncontrado("Peça não encontrada.", {"variantes": desconhecidas})

        saldos = await movimentos.travar_saldos(self.session, ids)
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
        admin = pode(usuario.role, Pode.VER_DINHEIRO)
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
