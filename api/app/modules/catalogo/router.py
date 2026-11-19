from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.exceptions import RequestValidationError
from starlette.datastructures import FormData, UploadFile
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.core.permissoes import Pode, pode
from app.core.deps import CurrentUser, ExigeEditarCatalogo, SessionDep
from app.core.exceptions import Validacao
from app.core.pagination import Pagina, Paginacao, paginacao
from app.modules.catalogo.fotos import limite_do_envio, tipo_da_imagem
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


#: O corpo do envio, para a documentação: a rota lê o multipart ela mesma (depois do login,
#: ver `enviar_foto`), e o FastAPI não o descobre sozinho. É o que o `File()` descrevia.
_CORPO_DO_ENVIO_DE_FOTO = {
    "requestBody": {
        "required": True,
        "content": {
            "multipart/form-data": {
                "schema": {
                    "type": "object",
                    "title": "Envio de foto",
                    "required": ["arquivo"],
                    "properties": {
                        "arquivo": {
                            "type": "string",
                            "contentMediaType": "application/octet-stream",
                            "title": "Arquivo",
                            "description": "A foto (JPEG, PNG ou WebP): um arquivo só.",
                        }
                    },
                }
            }
        },
    }
}
#: Campos de texto aceitos ao lado da foto. O app e a web mandam só o arquivo; o resto é
#: ignorado, como sempre foi, mas não sem teto.
_CAMPOS_DE_TEXTO_DO_ENVIO = 4


async def _ler_o_envio(request: Request) -> FormData:
    """O multipart do envio, com UM arquivo. Multipart quebrado é o 400 do Starlette, com a
    frase dele; outra falha ao ler, o 400 que o FastAPI dava quando lia o corpo sozinho."""
    try:
        return await request.form(max_files=1, max_fields=_CAMPOS_DE_TEXTO_DO_ENVIO)
    except StarletteHTTPException:
        raise
    except Exception as exc:  # noqa: BLE001 — o mesmo 400 de antes, para qualquer falha
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="There was an error parsing the body"
        ) from exc


def _o_arquivo(form: FormData) -> UploadFile:
    """O campo `arquivo`, com as mesmas recusas (e o mesmo 422 VALIDACAO, pelo mesmo handler)
    que o FastAPI dava ao validar `arquivo: UploadFile = File()`."""
    valor = form.get("arquivo")
    if isinstance(valor, UploadFile):
        return valor
    if valor is None or valor == "":
        erro = {"type": "missing", "loc": ("body", "arquivo"), "msg": "Field required"}
    else:
        erro = {
            "type": "value_error",
            "loc": ("body", "arquivo"),
            "msg": f"Value error, Expected UploadFile, received: {type(valor)}",
        }
    raise RequestValidationError([erro])


@router.put(
    "/produtos/{produto_id}/foto",
    response_model=None,
    summary="Envia foto",
    openapi_extra=_CORPO_DO_ENVIO_DE_FOTO,
)
async def enviar_foto(
    request: Request,
    session: SessionDep,
    usuario: CurrentUser,
    produto_id: int,
) -> ProdutoOut:
    # O login ANTES do corpo. Com `arquivo: UploadFile = File()` o FastAPI lia o multipart
    # inteiro antes de resolver as dependências (e o Starlette gravava o arquivo num
    # temporário): um PUT de 10 MB sem login era gravado todo para só então dar 401. Sem corpo
    # declarado, o crachá roda primeiro, e o corpo é lido aqui, só para quem entrou.
    # A conferência do login abriu uma transação (o SELECT em `users`); ela termina antes da
    # leitura, para o envio lento de um celular não segurar uma conexão do pool nem a trava
    # de leitura de `users` — a mesma que o TRUNCATE da renovação da demo espera (ADR-46).
    await session.commit()
    form = await _ler_o_envio(request)
    try:
        arquivo = _o_arquivo(form)
        service = CatalogoService(session)
        await service.obter_produto(produto_id, usuario)  # 404 antes de gravar qualquer byte

        extensao = Path(arquivo.filename or "").suffix.lower()
        if extensao not in EXTENSOES_FOTO:
            raise Validacao(
                "Formato de imagem não aceito.", {"aceitos": sorted(EXTENSOES_FOTO)}
            )

        # Lê em blocos e aborta ao passar do limite: `await arquivo.read()` traria o arquivo
        # inteiro para a memória antes de qualquer checagem, e um envio de vários GB
        # derrubaria o servidor da loja no meio do expediente.
        # Na Vercel o teto é menor: a função recusa corpo acima de 4,5 MB antes da API
        # (ADR-42).
        limite = limite_do_envio()
        partes: list[bytes] = []
        lidos = 0
        while bloco := await arquivo.read(64 * 1024):
            lidos += len(bloco)
            if lidos > limite:
                raise Validacao(
                    "Imagem muito grande.",
                    {"limite_mb": round(limite / 1024 / 1024, 1)},
                )
            partes.append(bloco)
        conteudo = b"".join(partes)
    finally:
        await form.close()

    # A extensão do nome é escolhida por quem envia e não prova nada: vale a assinatura.
    tipo = tipo_da_imagem(conteudo)
    if tipo is None:
        raise Validacao("O arquivo enviado não é uma imagem.")

    # Disco (a loja de sempre) ou Vercel Blob: quem decide é o ambiente (ADR-42).
    await service.trocar_foto(produto_id, conteudo, extensao, tipo)
    return await service.obter_produto(produto_id, usuario)
