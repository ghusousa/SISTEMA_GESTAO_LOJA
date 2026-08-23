import uuid
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends, File, Query, UploadFile, status
from starlette.concurrency import run_in_threadpool

from app.core.config import settings
from app.core.permissoes import Pode, pode
from app.core.deps import CurrentUser, ExigeEditarCatalogo, SessionDep
from app.core.exceptions import Validacao
from app.core.pagination import Pagina, Paginacao, paginacao
from app.modules.catalogo.schemas import (
    CategoriaIn,
    CategoriaOut,
    CodigoInternoOut,
    ProdutoIn,
    ProdutoOut,
    ProdutoUpdate,
    VarianteAdminOut,
    VarianteIn,
    VarianteLookupOut,
    VarianteOut,
    VarianteUpdate,
)
from app.modules.catalogo.service import CatalogoService

router = APIRouter(tags=["catalogo"])

EXTENSOES_FOTO = {".jpg", ".jpeg", ".png", ".webp"}

# `response_model=None` nas rotas cujo formato muda com o papel: o service escolhe entre
# o schema com custo (ADMIN) e o sem custo (VENDEDOR), e um response_model fixo na classe
# base apagaria justamente o campo extra do admin.


# ------------------------------------------------------------------ categorias
@router.get("/categorias", response_model=Pagina[CategoriaOut], summary="Lista categorias")
async def listar_categorias(
    session: SessionDep,
    _: CurrentUser,
    p: Annotated[Paginacao, Depends(paginacao)],
    q: str | None = None,
) -> Pagina[CategoriaOut]:
    return await CatalogoService(session).listar_categorias(p, q)


@router.post(
    "/categorias",
    response_model=CategoriaOut,
    status_code=status.HTTP_201_CREATED,
    summary="Cria categoria",
)
async def criar_categoria(session: SessionDep, _: ExigeEditarCatalogo, dados: CategoriaIn) -> CategoriaOut:
    return CategoriaOut.model_validate(await CatalogoService(session).criar_categoria(dados))


@router.patch("/categorias/{categoria_id}", response_model=CategoriaOut, summary="Renomeia categoria")
async def atualizar_categoria(
    session: SessionDep, _: ExigeEditarCatalogo, categoria_id: int, dados: CategoriaIn
) -> CategoriaOut:
    return CategoriaOut.model_validate(
        await CatalogoService(session).atualizar_categoria(categoria_id, dados)
    )


@router.delete(
    "/categorias/{categoria_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Exclui categoria vazia",
)
async def excluir_categoria(session: SessionDep, _: ExigeEditarCatalogo, categoria_id: int) -> None:
    await CatalogoService(session).excluir_categoria(categoria_id)


# ------------------------------------------------------------------ variantes
# Declarado antes de /variantes/{variante_id} para a rota fixa vencer o path param.
@router.get(
    "/variantes/codigo-barras/{codigo}",
    response_model=VarianteLookupOut,
    summary="Lookup do PDV por código de barras",
)
async def lookup_codigo(session: SessionDep, _: CurrentUser, codigo: str) -> VarianteLookupOut:
    return await CatalogoService(session).lookup_por_codigo(codigo)


@router.post(
    "/variantes/gerar-codigo-interno",
    response_model=CodigoInternoOut,
    summary="Gera código interno para peça sem etiqueta",
)
async def gerar_codigo_interno(session: SessionDep, _: CurrentUser) -> CodigoInternoOut:
    return CodigoInternoOut(codigo=await CatalogoService(session).gerar_codigo_interno())


@router.get("/variantes", response_model=None, summary="Lista peças")
async def listar_variantes(
    session: SessionDep,
    usuario: CurrentUser,
    p: Annotated[Paginacao, Depends(paginacao)],
    produto_id: int | None = None,
    q: Annotated[
        str | None, Query(description="Busca por nome do produto, cor ou código de barras")
    ] = None,
) -> Pagina[VarianteOut]:
    return await CatalogoService(session).listar_variantes(p, produto_id, q, usuario)


@router.patch("/variantes/{variante_id}", response_model=None, summary="Atualiza peça")
async def atualizar_variante(
    session: SessionDep, usuario: ExigeEditarCatalogo, variante_id: int, dados: VarianteUpdate
) -> VarianteOut:
    variante = await CatalogoService(session).atualizar_variante(variante_id, dados, usuario)
    # O schema é escolhido pela capacidade, como em toda rota de leitura. Fixar o de admin
    # aqui devolvia o custo para a SUPERVISORA — que edita o catálogo (EDITAR_CATALOGO) e
    # não vê dinheiro (VER_DINHEIRO). Era a única porta por onde o número escapava.
    schema = VarianteAdminOut if pode(usuario.role, Pode.VER_DINHEIRO) else VarianteOut
    return schema.model_validate(variante)


@router.delete(
    "/variantes/{variante_id}", status_code=status.HTTP_204_NO_CONTENT, summary="Exclui peça"
)
async def excluir_variante(session: SessionDep, _: ExigeEditarCatalogo, variante_id: int) -> None:
    await CatalogoService(session).excluir_variante(variante_id)


# ------------------------------------------------------------------ produtos
@router.get("/produtos", response_model=None, summary="Lista produtos")
async def listar_produtos(
    session: SessionDep,
    usuario: CurrentUser,
    p: Annotated[Paginacao, Depends(paginacao)],
    q: Annotated[str | None, Query(description="Busca por nome ou código de barras")] = None,
    categoria_id: int | None = None,
) -> Pagina[ProdutoOut]:
    return await CatalogoService(session).listar_produtos(p, q, categoria_id, usuario)


@router.post(
    "/produtos",
    response_model=None,
    status_code=status.HTTP_201_CREATED,
    summary="Cadastra produto com grade de variantes",
)
async def criar_produto(session: SessionDep, usuario: CurrentUser, dados: ProdutoIn) -> ProdutoOut:
    return await CatalogoService(session).criar_produto(dados, usuario)


@router.get("/produtos/{produto_id}", response_model=None, summary="Detalhe do produto")
async def obter_produto(session: SessionDep, usuario: CurrentUser, produto_id: int) -> ProdutoOut:
    return await CatalogoService(session).obter_produto(produto_id, usuario)


@router.patch("/produtos/{produto_id}", response_model=None, summary="Atualiza produto")
async def atualizar_produto(
    session: SessionDep, usuario: ExigeEditarCatalogo, produto_id: int, dados: ProdutoUpdate
) -> ProdutoOut:
    return await CatalogoService(session).atualizar_produto(produto_id, dados, usuario)


@router.delete(
    "/produtos/{produto_id}", status_code=status.HTTP_204_NO_CONTENT, summary="Exclui produto"
)
async def excluir_produto(session: SessionDep, _: ExigeEditarCatalogo, produto_id: int) -> None:
    await CatalogoService(session).excluir_produto(produto_id)


@router.post(
    "/produtos/{produto_id}/variantes",
    response_model=None,
    status_code=status.HTTP_201_CREATED,
    summary="Adiciona peça à grade de um produto",
)
async def adicionar_variante(
    session: SessionDep, usuario: CurrentUser, produto_id: int, dados: VarianteIn
) -> ProdutoOut:
    return await CatalogoService(session).adicionar_variante(produto_id, dados, usuario)


@router.put("/produtos/{produto_id}/foto", response_model=None, summary="Envia foto")
async def enviar_foto(
    session: SessionDep,
    usuario: CurrentUser,
    produto_id: int,
    arquivo: Annotated[UploadFile, File(alias="arquivo")],
) -> ProdutoOut:
    service = CatalogoService(session)
    await service.obter_produto(produto_id, usuario)  # 404 antes de gravar qualquer byte

    extensao = Path(arquivo.filename or "").suffix.lower()
    if extensao not in EXTENSOES_FOTO:
        raise Validacao(
            "Formato de imagem não aceito.", {"aceitos": sorted(EXTENSOES_FOTO)}
        )

    # Lê em blocos e aborta ao passar do limite: `await arquivo.read()` traria o arquivo
    # inteiro para a memória antes de qualquer checagem, e um envio de vários GB derrubaria
    # o servidor da loja no meio do expediente.
    partes: list[bytes] = []
    lidos = 0
    while bloco := await arquivo.read(64 * 1024):
        lidos += len(bloco)
        if lidos > settings.max_upload_bytes:
            raise Validacao(
                "Imagem muito grande.",
                {"limite_mb": round(settings.max_upload_bytes / 1024 / 1024, 1)},
            )
        partes.append(bloco)
    conteudo = b"".join(partes)

    if not _parece_imagem(conteudo):
        raise Validacao("O arquivo enviado não é uma imagem.")

    destino = Path(settings.media_dir) / "produtos"
    destino.mkdir(parents=True, exist_ok=True)
    # Nome gerado pelo servidor: o nome do arquivo do celular não entra no caminho.
    nome = f"{produto_id}-{uuid.uuid4().hex}{extensao}"
    # Gravação é I/O bloqueante: fora da thread do event loop, senão a foto trava o PDV.
    await run_in_threadpool((destino / nome).write_bytes, conteudo)

    # Caminho relativo, nunca derivado do header Host: uma requisição com
    # `Host: atacante.com` gravaria essa URL no banco e todo mundo passaria a buscar a
    # imagem no servidor do atacante.
    await service.definir_foto(produto_id, f"/media/produtos/{nome}")
    return await service.obter_produto(produto_id, usuario)


# Assinaturas de arquivo: a extensão do nome é escolhida por quem envia e não prova nada.
_ASSINATURAS = (b"\xff\xd8\xff", b"\x89PNG\r\n\x1a\n", b"RIFF")


def _parece_imagem(conteudo: bytes) -> bool:
    if any(conteudo.startswith(assinatura) for assinatura in _ASSINATURAS):
        # WebP é RIFF com "WEBP" no oitavo byte; os demais já bastam pelo prefixo.
        return not conteudo.startswith(b"RIFF") or conteudo[8:12] == b"WEBP"
    return False
