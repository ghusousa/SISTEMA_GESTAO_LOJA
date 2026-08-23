from datetime import date
from typing import Annotated

from fastapi import APIRouter, Depends, Query, status

from app.core.deps import ExigeDespesa, SessionDep
from app.core.pagination import Pagina, Paginacao, paginacao
from app.modules.despesas.schemas import (
    CategoriaDespesaIn,
    CategoriaDespesaOut,
    DespesaIn,
    DespesaOut,
    DespesaUpdate,
    ReplicacaoOut,
    validar_competencia,
)
from app.modules.despesas.service import DespesaService

# Despesa é informação de resultado do negócio: o módulo inteiro é ADMIN.
router = APIRouter(prefix="/despesas", tags=["despesas"])


# ------------------------------------------------------------------ categorias
@router.get(
    "/categorias", response_model=Pagina[CategoriaDespesaOut], summary="Categorias de despesa"
)
async def listar_categorias(
    session: SessionDep, _: ExigeDespesa, p: Annotated[Paginacao, Depends(paginacao)]
) -> Pagina[CategoriaDespesaOut]:
    return await DespesaService(session).listar_categorias(p)


@router.post(
    "/categorias",
    response_model=CategoriaDespesaOut,
    status_code=status.HTTP_201_CREATED,
    summary="Cria categoria de despesa",
)
async def criar_categoria(
    session: SessionDep, _: ExigeDespesa, dados: CategoriaDespesaIn
) -> CategoriaDespesaOut:
    return CategoriaDespesaOut.model_validate(
        await DespesaService(session).criar_categoria(dados)
    )


@router.patch(
    "/categorias/{categoria_id}",
    response_model=CategoriaDespesaOut,
    summary="Renomeia categoria de despesa",
)
async def atualizar_categoria(
    session: SessionDep, _: ExigeDespesa, categoria_id: int, dados: CategoriaDespesaIn
) -> CategoriaDespesaOut:
    return CategoriaDespesaOut.model_validate(
        await DespesaService(session).atualizar_categoria(categoria_id, dados)
    )


@router.delete(
    "/categorias/{categoria_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Exclui categoria de despesa vazia",
)
async def excluir_categoria(session: SessionDep, _: ExigeDespesa, categoria_id: int) -> None:
    await DespesaService(session).excluir_categoria(categoria_id)


# ------------------------------------------------------------------ recorrentes
@router.post(
    "/replicar-recorrentes",
    response_model=ReplicacaoOut,
    summary="Traz as contas fixas para a competência (idempotente)",
)
async def replicar_recorrentes(
    session: SessionDep,
    _: ExigeDespesa,
    competencia: Annotated[str, Query(description="AAAA-MM", examples=["2026-08"])],
) -> ReplicacaoOut:
    return await DespesaService(session).replicar_recorrentes(validar_competencia(competencia))


# ------------------------------------------------------------------ despesas
@router.get("", response_model=Pagina[DespesaOut], summary="Lista despesas")
async def listar(
    session: SessionDep,
    _: ExigeDespesa,
    p: Annotated[Paginacao, Depends(paginacao)],
    inicio: date | None = None,
    fim: date | None = None,
    categoria_id: int | None = None,
    recorrente: bool | None = None,
) -> Pagina[DespesaOut]:
    return await DespesaService(session).listar(p, inicio, fim, categoria_id, recorrente)


@router.post(
    "", response_model=DespesaOut, status_code=status.HTTP_201_CREATED, summary="Lança despesa"
)
async def criar(session: SessionDep, _: ExigeDespesa, dados: DespesaIn) -> DespesaOut:
    return await DespesaService(session).criar(dados)


@router.get("/{despesa_id}", response_model=DespesaOut, summary="Detalhe da despesa")
async def obter(session: SessionDep, _: ExigeDespesa, despesa_id: int) -> DespesaOut:
    return await DespesaService(session).obter(despesa_id)


@router.patch("/{despesa_id}", response_model=DespesaOut, summary="Atualiza despesa")
async def atualizar(
    session: SessionDep, _: ExigeDespesa, despesa_id: int, dados: DespesaUpdate
) -> DespesaOut:
    return await DespesaService(session).atualizar(despesa_id, dados)


@router.delete(
    "/{despesa_id}", status_code=status.HTTP_204_NO_CONTENT, summary="Exclui despesa"
)
async def excluir(session: SessionDep, _: ExigeDespesa, despesa_id: int) -> None:
    await DespesaService(session).excluir(despesa_id)
