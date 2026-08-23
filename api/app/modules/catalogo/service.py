from datetime import UTC, datetime
from decimal import Decimal

from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import Duplicado, NaoEncontrado, OperacaoInvalida, Validacao
from app.core.pagination import Pagina, Paginacao
from app.modules.catalogo.barcode import eh_codigo_interno, montar_codigo_interno
from app.modules.catalogo.models import Category, Product, ProductVariant, TipoCodigo
from app.modules.catalogo.repository import CatalogoRepository
from app.modules.catalogo.schemas import (
    CategoriaIn,
    CategoriaOut,
    ProdutoAdminOut,
    ProdutoIn,
    ProdutoOut,
    ProdutoUpdate,
    VarianteAdminOut,
    VarianteIn,
    VarianteLookupOut,
    VarianteOut,
    VarianteUpdate,
)
from app.modules.estoque import movimentos
from app.modules.estoque.models import TipoMovimento
from app.core.permissoes import Pode, pode
from app.modules.usuarios.models import User


def _tipo_do_codigo(codigo: str | None) -> str:
    """Sem código, geramos um interno. Com código, o número diz de onde ele veio."""
    if not codigo or eh_codigo_interno(codigo):
        return TipoCodigo.INTERNO
    return TipoCodigo.EAN


#: Custo de quem não pode informá-lo. A dona preenche depois.
ZERO_DINHEIRO = Decimal("0.00")

class CatalogoService:
    def __init__(self, session: AsyncSession):
        self.session = session
        self.repo = CatalogoRepository(session)

    # ------------------------------------------------------------ categorias
    async def listar_categorias(self, p: Paginacao, q: str | None) -> Pagina[CategoriaOut]:
        items, total = await self.repo.listar_categorias(p, q)
        return Pagina.montar([CategoriaOut.model_validate(c) for c in items], total, p)

    async def criar_categoria(self, dados: CategoriaIn) -> Category:
        if await self.repo.categoria_por_nome(dados.nome) is not None:
            raise Duplicado(f"Já existe a categoria '{dados.nome}'.")
        categoria = Category(name=dados.nome)
        self.session.add(categoria)
        try:
            await self.session.commit()
        except IntegrityError as exc:
            await self.session.rollback()
            raise Duplicado(f"Já existe a categoria '{dados.nome}'.") from exc
        await self.session.refresh(categoria)
        return categoria

    async def atualizar_categoria(self, categoria_id: int, dados: CategoriaIn) -> Category:
        categoria = await self.repo.categoria_por_id(categoria_id)
        if categoria is None:
            raise NaoEncontrado("Categoria não encontrada.")
        existente = await self.repo.categoria_por_nome(dados.nome)
        if existente is not None and existente.id != categoria_id:
            raise Duplicado(f"Já existe a categoria '{dados.nome}'.")
        categoria.name = dados.nome
        await self.session.commit()
        await self.session.refresh(categoria)
        return categoria

    async def excluir_categoria(self, categoria_id: int) -> None:
        categoria = await self.repo.categoria_por_id(categoria_id)
        if categoria is None:
            raise NaoEncontrado("Categoria não encontrada.")
        if await self.repo.categoria_tem_produtos(categoria_id):
            raise OperacaoInvalida(
                "Esta categoria ainda tem produtos. Mova-os antes de excluí-la."
            )
        categoria.deleted_at = datetime.now(UTC)
        await self.session.commit()

    # ------------------------------------------------------------ códigos
    async def gerar_codigo_interno(self) -> str:
        """Gera um EAN-13 interno inédito. A sequência do banco garante que não repete."""
        for _ in range(10):
            codigo = montar_codigo_interno(await self.repo.proxima_sequencia_interna())
            if await self.repo.variante_por_codigo(codigo) is None:
                return codigo
        raise OperacaoInvalida("Não foi possível gerar um código interno livre.")

    async def _resolver_codigos(self, variantes: list[VarianteIn]) -> list[str]:
        """Devolve o código de cada variante, gerando os que vieram em branco."""
        informados = [v.codigo_barras for v in variantes if v.codigo_barras]
        ja_usados = await self.repo.codigos_existentes(informados)
        if ja_usados:
            raise Duplicado(
                "Código de barras já cadastrado em outra peça.",
                {"codigos": sorted(ja_usados)},
            )
        return [v.codigo_barras or await self.gerar_codigo_interno() for v in variantes]

    # ------------------------------------------------------------ produtos
    def _montar_produto_out(
        self, produto: Product, saldos: dict[int, int], usuario: User
    ) -> ProdutoOut:
        admin = pode(usuario.role, Pode.VER_DINHEIRO)
        schema_variante = VarianteAdminOut if admin else VarianteOut
        variantes = []
        for v in produto.variants:
            item = schema_variante.model_validate(v)
            item.saldo = saldos.get(v.id, 0)
            variantes.append(item)
        schema_produto = ProdutoAdminOut if admin else ProdutoOut
        return schema_produto(
            id=produto.id,
            nome=produto.name,
            descricao=produto.description,
            foto_url=produto.photo_url,
            categoria_id=produto.category_id,
            categoria=produto.category.name,
            variantes=variantes,
            saldo_total=sum(saldos.get(v.id, 0) for v in produto.variants),
        )

    async def listar_produtos(
        self, p: Paginacao, q: str | None, categoria_id: int | None, usuario: User
    ) -> Pagina[ProdutoOut]:
        produtos, total = await self.repo.listar_produtos(p, q, categoria_id)
        ids = [v.id for prod in produtos for v in prod.variants]
        saldos = await movimentos.saldos_de(self.session, ids)
        items = [self._montar_produto_out(prod, saldos, usuario) for prod in produtos]
        return Pagina.montar(items, total, p)

    async def obter_produto(self, produto_id: int, usuario: User) -> ProdutoOut:
        produto = await self.repo.produto_por_id(produto_id)
        if produto is None:
            raise NaoEncontrado("Produto não encontrado.")
        saldos = await movimentos.saldos_de(self.session, [v.id for v in produto.variants])
        return self._montar_produto_out(produto, saldos, usuario)

    @staticmethod
    def _custo_permitido(valor: Decimal, usuario: User) -> Decimal:
        """Custo só é gravado por quem vê dinheiro. Dos outros, entra zero.

        A vendedora cadastra a peça — é o trabalho dela, e a mercadoria precisa entrar no
        estoque na hora. Mas o custo é número de dono: ela não o recebe de volta em resposta
        nenhuma, então não teria como conferir o que digitou, e um erro só apareceria no
        lucro do mês. A dona preenche depois, na edição. As duas telas já não pedem o campo;
        isto aqui é a tranca, para o caso de a requisição vir por outro caminho.
        """
        return valor if pode(usuario.role, Pode.VER_DINHEIRO) else ZERO_DINHEIRO

    async def criar_produto(self, dados: ProdutoIn, usuario: User) -> ProdutoOut:
        """Cria produto + grade + estoque inicial em uma transação só.

        O estoque inicial vira movimentação de ENTRADA — assim o extrato explica de onde
        veio a primeira peça, em vez de um saldo que aparece do nada.
        """
        if await self.repo.categoria_por_id(dados.categoria_id) is None:
            raise NaoEncontrado("Categoria não encontrada.")

        codigos = await self._resolver_codigos(dados.variantes)

        produto = Product(
            category_id=dados.categoria_id, name=dados.nome, description=dados.descricao
        )
        self.session.add(produto)
        await self.session.flush()

        criadas: list[tuple[ProductVariant, int]] = []
        for entrada, codigo in zip(dados.variantes, codigos, strict=True):
            variante = ProductVariant(
                product_id=produto.id,
                size=entrada.tamanho,
                color=entrada.cor,
                barcode=codigo,
                barcode_type=_tipo_do_codigo(entrada.codigo_barras),
                cost_price=self._custo_permitido(entrada.preco_custo, usuario),
                sale_price=entrada.preco_venda,
                min_stock=entrada.estoque_minimo,
            )
            self.session.add(variante)
            criadas.append((variante, entrada.estoque_inicial))
        await self.session.flush()

        for variante, inicial in criadas:
            if inicial > 0:
                await movimentos.aplicar_movimento(
                    self.session,
                    variante_id=variante.id,
                    delta=inicial,
                    tipo=TipoMovimento.ENTRADA,
                    user_id=usuario.id,
                    observacao="Estoque inicial do cadastro",
                )

        try:
            await self.session.commit()
        except IntegrityError as exc:
            await self.session.rollback()
            raise Duplicado(
                "Código de barras ou combinação tamanho/cor já cadastrada."
            ) from exc

        return await self.obter_produto(produto.id, usuario)

    async def atualizar_produto(
        self, produto_id: int, dados: ProdutoUpdate, usuario: User
    ) -> ProdutoOut:
        produto = await self.repo.produto_por_id(produto_id)
        if produto is None:
            raise NaoEncontrado("Produto não encontrado.")
        if dados.categoria_id is not None:
            if await self.repo.categoria_por_id(dados.categoria_id) is None:
                raise NaoEncontrado("Categoria não encontrada.")
            produto.category_id = dados.categoria_id
        if dados.nome is not None:
            produto.name = dados.nome.strip()
        if dados.descricao is not None:
            produto.description = dados.descricao
        await self.session.commit()
        return await self.obter_produto(produto_id, usuario)

    async def excluir_produto(self, produto_id: int) -> None:
        """Soft delete: o produto some do catálogo mas continua explicando vendas antigas."""
        produto = await self.repo.produto_por_id(produto_id)
        if produto is None:
            raise NaoEncontrado("Produto não encontrado.")
        saldos = await movimentos.saldos_de(self.session, [v.id for v in produto.variants])
        if any(qtd > 0 for qtd in saldos.values()):
            raise OperacaoInvalida(
                "Este produto ainda tem peças em estoque. Zere o estoque antes de excluir."
            )
        agora = datetime.now(UTC)
        produto.deleted_at = agora
        for variante in produto.variants:
            variante.deleted_at = agora
        await self.session.commit()

    async def definir_foto(self, produto_id: int, url: str) -> ProdutoOut | None:
        produto = await self.repo.produto_por_id(produto_id)
        if produto is None:
            raise NaoEncontrado("Produto não encontrado.")
        produto.photo_url = url
        await self.session.commit()
        return None

    # ------------------------------------------------------------ variantes
    async def obter_variante(self, variante_id: int) -> ProductVariant:
        variante = await self.repo.variante_por_id(variante_id)
        if variante is None:
            raise NaoEncontrado("Peça não encontrada.")
        return variante

    async def adicionar_variante(
        self, produto_id: int, dados: VarianteIn, usuario: User
    ) -> ProdutoOut:
        produto = await self.repo.produto_por_id(produto_id)
        if produto is None:
            raise NaoEncontrado("Produto não encontrado.")
        codigo = (await self._resolver_codigos([dados]))[0]
        variante = ProductVariant(
            product_id=produto.id,
            size=dados.tamanho,
            color=dados.cor,
            barcode=codigo,
            barcode_type=_tipo_do_codigo(dados.codigo_barras),
            cost_price=self._custo_permitido(dados.preco_custo, usuario),
            sale_price=dados.preco_venda,
            min_stock=dados.estoque_minimo,
        )
        self.session.add(variante)
        try:
            await self.session.flush()
        except IntegrityError as exc:
            await self.session.rollback()
            raise Duplicado("Esta combinação de tamanho e cor já existe no produto.") from exc

        if dados.estoque_inicial > 0:
            await movimentos.aplicar_movimento(
                self.session,
                variante_id=variante.id,
                delta=dados.estoque_inicial,
                tipo=TipoMovimento.ENTRADA,
                user_id=usuario.id,
                observacao="Estoque inicial da peça",
            )
        await self.session.commit()
        return await self.obter_produto(produto_id, usuario)

    async def atualizar_variante(
        self, variante_id: int, dados: VarianteUpdate, usuario: User
    ) -> ProductVariant:
        variante = await self.obter_variante(variante_id)
        if dados.codigo_barras is not None and dados.codigo_barras != variante.barcode:
            if await self.repo.variante_por_codigo(dados.codigo_barras) is not None:
                raise Duplicado("Código de barras já cadastrado em outra peça.")
            variante.barcode = dados.codigo_barras.strip()
            variante.barcode_type = _tipo_do_codigo(variante.barcode)
        # Custo fora da lista de propósito: quem edita o catálogo não é necessariamente
        # quem vê dinheiro (a supervisora edita e não vê), e deixá-lo passar aqui daria a
        # ela o poder de mexer na margem da loja sem nunca poder conferir o número.
        for campo, valor in (
            ("size", dados.tamanho),
            ("color", dados.cor),
            ("sale_price", dados.preco_venda),
            ("min_stock", dados.estoque_minimo),
        ):
            if valor is not None:
                setattr(variante, campo, valor)
        if dados.preco_custo is not None and pode(usuario.role, Pode.VER_DINHEIRO):
            variante.cost_price = dados.preco_custo
        try:
            await self.session.commit()
        except IntegrityError as exc:
            await self.session.rollback()
            raise Duplicado("Já existe outra peça com esse tamanho, cor ou código.") from exc
        await self.session.refresh(variante)
        return variante

    async def excluir_variante(self, variante_id: int) -> None:
        variante = await self.obter_variante(variante_id)
        if await movimentos.saldo_atual(self.session, variante_id) > 0:
            raise OperacaoInvalida("Esta peça ainda tem estoque. Zere antes de excluir.")
        variante.deleted_at = datetime.now(UTC)
        await self.session.commit()

    async def listar_variantes(
        self, p: Paginacao, produto_id: int | None, q: str | None, usuario: User
    ) -> Pagina[VarianteOut]:
        variantes, total = await self.repo.listar_variantes(p, produto_id, q)
        saldos = await movimentos.saldos_de(self.session, [v.id for v in variantes])
        schema = VarianteAdminOut if pode(usuario.role, Pode.VER_DINHEIRO) else VarianteOut
        items = []
        for v in variantes:
            item = schema.model_validate(v)
            item.saldo = saldos.get(v.id, 0)
            item.produto = v.product.name
            items.append(item)
        return Pagina.montar(items, total, p)

    async def lookup_por_codigo(self, codigo: str) -> VarianteLookupOut:
        """O bipe do PDV: uma resposta com tudo que a tela precisa."""
        codigo = codigo.strip()
        if not codigo:
            raise Validacao("Código de barras vazio.")
        variante = await self.repo.variante_por_codigo(codigo)
        if variante is None:
            raise NaoEncontrado(
                "Nenhuma peça cadastrada com este código.", {"codigo_barras": codigo}
            )
        produto = await self.repo.produto_por_id(variante.product_id)
        if produto is None:
            raise NaoEncontrado("Produto da peça não encontrado.")
        return VarianteLookupOut(
            variante_id=variante.id,
            produto_id=produto.id,
            produto=produto.name,
            categoria=produto.category.name,
            tamanho=variante.size,
            cor=variante.color,
            codigo_barras=variante.barcode,
            preco_venda=Decimal(variante.sale_price),
            saldo=await movimentos.saldo_atual(self.session, variante.id),
            foto_url=produto.photo_url,
        )
