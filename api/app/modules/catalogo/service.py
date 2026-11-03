import uuid
from datetime import UTC, datetime
from decimal import Decimal

from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import Duplicado, NaoEncontrado, OperacaoInvalida, Validacao
from app.core.pagination import Pagina, Paginacao
from app.modules.catalogo import fotos
from app.modules.catalogo.barcode import eh_codigo_interno, montar_codigo_interno
from app.modules.catalogo.models import Category, Product, ProductVariant, TipoCodigo
from app.modules.catalogo.repository import CatalogoRepository
from app.modules.catalogo.schemas import (
    CFOP_PADRAO,
    CategoriaIn,
    CategoriaOut,
    DadosFiscaisPecaOut,
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
            ncm=produto.ncm,
            cest=produto.cest,
            origem=produto.origem,
            cfop=produto.cfop,
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
            category_id=dados.categoria_id,
            name=dados.nome,
            description=dados.descricao,
            ncm=dados.ncm,
            cest=dados.cest,
            origem=dados.origem if dados.origem is not None else 0,
            cfop=dados.cfop or CFOP_PADRAO,
        )
        self.session.add(produto)
        await self.session.flush()

        criadas: list[ProductVariant] = []
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
            criadas.append(variante)
        await self.session.flush()

        # A peça nasce com saldo ZERO, de propósito (ADR-29). Mercadoria entra por UMA
        # porta só: `POST /estoque/entradas`, que guarda fornecedor e custo e deixa rastro
        # no extrato. Ter estoque também aqui era a segunda porta — a que confundia quem
        # usa e a que fazia a PRIMEIRA compra de cada peça não ter fornecedor nenhum.

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
        # Fiscais pelo `exclude_unset`: `null` em NCM/CEST apaga (código errado tem de poder
        # sair); origem e CFOP nunca ficam vazios — `null` neles volta ao padrão.
        fiscais = dados.model_dump(include={"ncm", "cest", "origem", "cfop"}, exclude_unset=True)
        if "ncm" in fiscais:
            produto.ncm = fiscais["ncm"]
        if "cest" in fiscais:
            produto.cest = fiscais["cest"]
        if "origem" in fiscais:
            produto.origem = fiscais["origem"] if fiscais["origem"] is not None else 0
        if "cfop" in fiscais:
            produto.cfop = fiscais["cfop"] or CFOP_PADRAO
        await self.session.commit()
        return await self.obter_produto(produto_id, usuario)

    async def excluir_produto(self, produto_id: int) -> None:
        """Soft delete: o produto some do catálogo mas continua explicando vendas antigas."""
        # Trava a grade e os saldos ANTES de conferir (ADR-30). Conferir solto deixava uma
        # Entrada do mesmo instante somar estoque numa peça que estava saindo do catálogo
        # — peças que nenhuma tela alcança mais. Com a trava, quem chega depois espera e
        # enxerga o que o outro gravou: a exclusão vê o saldo novo e recusa, ou a Entrada
        # vê a peça excluída e recusa.
        await self.repo.travar_grade(produto_id)
        produto = await self.repo.produto_por_id(produto_id)
        if produto is None:
            raise NaoEncontrado("Produto não encontrado.")
        saldos = await movimentos.travar_saldos(self.session, [v.id for v in produto.variants])
        if any(qtd > 0 for qtd in saldos.values()):
            raise OperacaoInvalida(
                "Este produto ainda tem peças em estoque. Zere o estoque antes de excluir."
            )
        agora = datetime.now(UTC)
        produto.deleted_at = agora
        for variante in produto.variants:
            variante.deleted_at = agora
        await self.session.commit()

    async def trocar_foto(
        self, produto_id: int, conteudo: bytes, extensao: str, tipo: str
    ) -> None:
        """Guarda a foto nova, aponta o produto para ela e só então tira a antiga.

        Nessa ordem: a rede do Blob fica FORA da trava do produto, e se a troca falhar a
        foto que está na tela continua existindo. Onde a foto mora (disco ou Vercel Blob) é
        decisão do ambiente, em `fotos.armazenamento()` (ADR-42).
        """
        casa = fotos.armazenamento()
        # Nome gerado pelo servidor: o nome do arquivo do celular não entra no caminho.
        url = await casa.gravar(f"{produto_id}-{uuid.uuid4().hex}{extensao}", conteudo, tipo)
        try:
            produto = await self.repo.travar_produto(produto_id)
            if produto is None:  # excluído enquanto a foto subia
                raise NaoEncontrado("Produto não encontrado.")
        except Exception:
            await casa.apagar(url)
            raise
        antiga = produto.photo_url
        produto.photo_url = url
        await self.session.commit()
        if antiga and antiga != url:
            await casa.apagar(antiga)

    async def dados_fiscais_das_pecas(
        self, variante_ids: list[int]
    ) -> dict[int, DadosFiscaisPecaOut]:
        """NCM, CFOP e origem de cada peça, para a NFC-e (ADR-41). Porta pública do
        catálogo para o módulo fiscal, que não lê o repositório daqui (CLAUDE.md)."""
        linhas = await self.repo.dados_fiscais_das_pecas(variante_ids)
        return {
            variante.id: DadosFiscaisPecaOut(
                variante_id=variante.id,
                produto_id=produto.id,
                produto=produto.name,
                tamanho=variante.size,
                cor=variante.color,
                codigo_barras=variante.barcode,
                ncm=produto.ncm,
                cest=produto.cest,
                origem=produto.origem,
                cfop=produto.cfop,
            )
            for variante, produto in linhas
        }

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

        # Sem estoque aqui: a peça nasce zerada e a mercadoria entra pela Entrada (ADR-29).
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
        # Peça e saldo travados antes de conferir, como em `excluir_produto` (ADR-30).
        await self.repo.travar_peca(variante_id)
        variante = await self.obter_variante(variante_id)
        saldos = await movimentos.travar_saldos(self.session, [variante_id])
        if saldos.get(variante_id, 0) > 0:
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


# ------------------------------------------------------------ peça que volta (ADR-30)
async def peca_que_recebe(
    session: AsyncSession, variante_id: int, *, devolucao: bool
) -> tuple[int, str | None]:
    """Em qual peça ATIVA mora a mercadoria que está entrando — e trava essa peça.

    `movimentos.aplicar_movimento` pergunta isto antes de todo movimento POSITIVO.
    Devolve `(variante_id, nota)`: a peça que recebe e, quando não é a pedida, o porquê,
    que vai para a observação do extrato.

    Peça excluída do catálogo é invisível e invendável: saldo dela é mercadoria presa no
    banco que nenhuma tela alcança. A exclusão só vale com saldo zero, mas uma venda feita
    ANTES dela pode ser cancelada ou devolvida DEPOIS — a peça esgota, a dona tira do
    catálogo, a cliente traz de volta. Essa peça está de volta na arara, então:

    - outra peça ATIVA com a mesma etiqueta (a dona recadastrou) recebe: mesma etiqueta é
      a mesma peça, e é ela que o bipe acha;
    - senão, outra ativa no mesmo produto, tamanho e cor — o UNIQUE da grade diz que é a
      mesma peça, e reativar a antiga estouraria esse UNIQUE;
    - senão, a peça (e o produto, se saiu junto) volta ao catálogo.

    Entrada, ajuste e inventário recusam peça excluída na própria tela; se chegam aqui com
    uma, ela foi excluída enquanto a mercadoria era conferida, e o certo é recusar também.
    """
    repo = CatalogoRepository(session)
    peca = await repo.travar_peca(variante_id)
    if peca is None:
        raise NaoEncontrado("Peça não encontrada.", {"variante_id": variante_id})
    if peca.deleted_at is None:
        return variante_id, None
    if not devolucao:
        raise NaoEncontrado(
            "Esta peça acabou de ser excluída do catálogo.", {"variante_id": variante_id}
        )

    substituta = await _ativa_no_lugar_da_excluida(repo, peca, travar=True)
    if substituta is not None:
        return substituta
    await repo.reativar_peca(variante_id, peca.product_id)
    return variante_id, (
        "A peça estava excluída do catálogo e voltou para ele: está de volta na arara."
    )


async def _ativa_no_lugar_da_excluida(
    repo: CatalogoRepository, peca, *, travar: bool
) -> tuple[int, str] | None:
    """A peça ATIVA que recebe no lugar de uma excluída: a mesma etiqueta, senão a mesma
    grade. None: nenhuma — a excluída é que volta ao catálogo."""
    mesma_etiqueta = await repo.travar_ativa_por_codigo(peca.barcode, travar=travar)
    if mesma_etiqueta is not None:
        return mesma_etiqueta, (
            f"A peça vendida (#{peca.id}) foi excluída do catálogo; voltou para esta, "
            f"que tem a mesma etiqueta {peca.barcode}."
        )
    mesma_grade = await repo.travar_ativa_da_grade(
        peca.product_id, peca.size, peca.color, travar=travar
    )
    if mesma_grade is not None:
        return mesma_grade, (
            f"A peça vendida (#{peca.id}) foi excluída do catálogo; voltou para esta, "
            "do mesmo produto, tamanho e cor."
        )
    return None


async def pecas_que_receberiam(session: AsyncSession, variante_ids: list[int]) -> dict[int, int]:
    """Para MOSTRAR: a peça que `peca_que_recebe` escolheria HOJE para cada uma destas —
    sem travar nem reativar nada.

    A condicional aberta mostra o preço da peça que o fechamento vai VENDER, e o fechamento
    vende da peça que recebe o retorno. Se a dona excluiu a peça e a recadastrou (com outro
    preço, ou a etiqueta noutro produto) enquanto ela estava na casa da cliente, mostrar o
    preço da excluída faria a tela cobrar um valor e a venda pedir outro (422) — e a
    condicional não fecharia. Peça ativa, ou excluída sem substituta (seria ela a voltar
    ao catálogo), é ela mesma.
    """
    repo = CatalogoRepository(session)
    destino: dict[int, int] = {}
    for variante_id in sorted(set(variante_ids)):
        destino[variante_id] = variante_id
        peca = await repo.travar_peca(variante_id, travar=False)
        if peca is None or peca.deleted_at is None:
            continue
        substituta = await _ativa_no_lugar_da_excluida(repo, peca, travar=False)
        if substituta is not None:
            destino[variante_id] = substituta[0]
    return destino
