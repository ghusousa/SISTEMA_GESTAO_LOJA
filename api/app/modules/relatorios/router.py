from datetime import date
from typing import Annotated

from fastapi import APIRouter, Depends, Query

from app.core.deps import ExigeDinheiro, SessionDep
from app.core.pagination import Pagina, Paginacao, paginacao
from app.modules.relatorios.schemas import (
    DespesaCategoriaOut,
    DiaVendaOut,
    EstoqueBaixoOut,
    MaisVendidoOut,
    ResumoOut,
)
from app.modules.relatorios.service import RelatorioService

# Resultado do negócio é informação de dono: o módulo inteiro é ADMIN.
router = APIRouter(prefix="/relatorios", tags=["relatorios"])

Inicio = Annotated[date, Query(description="Primeiro dia do período (inclusive)")]
Fim = Annotated[date, Query(description="Último dia do período (inclusive)")]


@router.get(
    "/resumo",
    response_model=ResumoOut,
    summary="Faturamento, CMV, lucro bruto, despesas e resultado do período",
)
async def resumo(session: SessionDep, _: ExigeDinheiro, inicio: Inicio, fim: Fim) -> ResumoOut:
    return await RelatorioService(session).resumo(inicio, fim)


@router.get(
    "/vendas-por-dia",
    response_model=list[DiaVendaOut],
    summary="Curva diária de vendas (dias sem venda vêm zerados)",
)
async def vendas_por_dia(
    session: SessionDep, _: ExigeDinheiro, inicio: Inicio, fim: Fim
) -> list[DiaVendaOut]:
    return await RelatorioService(session).vendas_por_dia(inicio, fim)


@router.get(
    "/mais-vendidos", response_model=list[MaisVendidoOut], summary="Ranking de peças vendidas"
)
async def mais_vendidos(
    session: SessionDep,
    _: ExigeDinheiro,
    inicio: Inicio,
    fim: Fim,
    limite: Annotated[int, Query(ge=1, le=100)] = 10,
) -> list[MaisVendidoOut]:
    return await RelatorioService(session).mais_vendidos(inicio, fim, limite)


@router.get(
    "/despesas-por-categoria",
    response_model=list[DespesaCategoriaOut],
    summary="Para onde o dinheiro foi no período",
)
async def despesas_por_categoria(
    session: SessionDep, _: ExigeDinheiro, inicio: Inicio, fim: Fim
) -> list[DespesaCategoriaOut]:
    return await RelatorioService(session).despesas_por_categoria(inicio, fim)


@router.get(
    "/estoque-baixo",
    response_model=Pagina[EstoqueBaixoOut],
    summary="Peças no estoque mínimo ou abaixo, mais urgentes primeiro (sem período: é o agora)",
)
async def estoque_baixo(
    session: SessionDep,
    _: ExigeDinheiro,
    p: Annotated[Paginacao, Depends(paginacao)],
) -> Pagina[EstoqueBaixoOut]:
    # Paginada como toda listagem. Quem só mostra "N peças no mínimo" pede `size=1` e lê
    # o `total` — não baixa a lista inteira para contar.
    return await RelatorioService(session).estoque_baixo(p)
