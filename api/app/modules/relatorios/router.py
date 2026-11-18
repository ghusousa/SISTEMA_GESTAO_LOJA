from datetime import date
from typing import Annotated

from fastapi import APIRouter, Depends, Query

from app.core.deps import CurrentUser, ExigeDinheiro, SessionDep
from app.core.pagination import Pagina, Paginacao, paginacao
from app.modules.relatorios.giro import GiroService
from app.modules.relatorios.schemas import (
    CurvaAbcOut,
    DespesaCategoriaOut,
    DiaVendaOut,
    EstoqueBaixoOut,
    MaisVendidoOut,
    RecebivelOut,
    MeuDiaOut,
    PaginaEstoqueParado,
    PaginaVendedoras,
    ResumoOut,
    ValorEstoqueOut,
)
from app.modules.relatorios.service import RelatorioService
from app.modules.relatorios.vendedoras import VendedorasService

# Resultado do negócio é informação de quem vê dinheiro (VER_DINHEIRO). A única rota aberta
# a toda a equipe é `/meu-dia`: o placar da própria pessoa, sem custo nem lucro.
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


@router.get(
    "/recebiveis",
    response_model=Pagina[RecebivelOut],
    summary="Agenda do cartão: bruto, taxa e líquido por dia previsto de crédito",
)
async def recebiveis(
    session: SessionDep,
    _: ExigeDinheiro,
    inicio: Inicio,
    fim: Fim,
    p: Annotated[Paginacao, Depends(paginacao)],
) -> Pagina[RecebivelOut]:
    # O período é o da DATA PREVISTA de crédito, não o da venda: "quanto cai na conta em
    # dezembro" inclui a 3ª parcela de uma venda de outubro.
    return await RelatorioService(session).recebiveis(inicio, fim, p)


# ------------------------------------------------------------------ equipe (ADR-37)


@router.get(
    "/vendedoras",
    response_model=PaginaVendedoras,
    summary="Faturamento líquido, peças, ticket médio e comissão de cada pessoa da equipe",
)
async def vendedoras(
    session: SessionDep,
    _: ExigeDinheiro,
    inicio: Inicio,
    fim: Fim,
    p: Annotated[Paginacao, Depends(paginacao)],
) -> PaginaVendedoras:
    return await VendedorasService(session).relatorio(inicio, fim, p)


@router.get(
    "/meu-dia",
    response_model=MeuDiaOut,
    summary="Quanto quem está logado vendeu hoje, e quanto falta para a meta",
)
async def meu_dia(session: SessionDep, usuario: CurrentUser) -> MeuDiaOut:
    # Sem crachá de propósito: cada um vê SÓ o próprio número (o id vem do token, não da
    # URL), e a resposta não tem custo, lucro nem a comissão de ninguém.
    return await VendedorasService(session).meu_dia(usuario)


# ------------------------------------------------------- giro do estoque (ADR-38)


@router.get(
    "/estoque-parado",
    response_model=PaginaEstoqueParado,
    summary="Peças com saldo sem vender há mais de N dias, as mais antigas primeiro",
)
async def estoque_parado(
    session: SessionDep,
    _: ExigeDinheiro,
    p: Annotated[Paginacao, Depends(paginacao)],
    dias: Annotated[int, Query(ge=1, le=3650, description="Parada há mais de quantos dias")] = 90,
) -> PaginaEstoqueParado:
    return await GiroService(session).estoque_parado(dias, p)


@router.get(
    "/curva-abc",
    response_model=Pagina[CurvaAbcOut],
    summary="Produtos por faturamento líquido no período, com % acumulado e classe A/B/C",
)
async def curva_abc(
    session: SessionDep,
    _: ExigeDinheiro,
    inicio: Inicio,
    fim: Fim,
    p: Annotated[Paginacao, Depends(paginacao)],
) -> Pagina[CurvaAbcOut]:
    return await GiroService(session).curva_abc(inicio, fim, p)


@router.get(
    "/valor-do-estoque",
    response_model=ValorEstoqueOut,
    summary="Peças, valor em custo e em preço de venda da loja inteira (o agora, sem período)",
)
async def valor_do_estoque(session: SessionDep, _: ExigeDinheiro) -> ValorEstoqueOut:
    return await GiroService(session).valor_do_estoque()
