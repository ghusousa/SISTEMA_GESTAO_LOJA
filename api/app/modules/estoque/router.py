from datetime import date
from typing import Annotated

from fastapi import APIRouter, Depends, Query, status

from app.core.datas import fim_exclusivo_do_dia, inicio_do_dia
from app.core.deps import CurrentUser, ExigeCorrigirEstoque, SessionDep
from app.core.pagination import Pagina, Paginacao, paginacao
from app.modules.estoque.models import TipoMovimento
from app.modules.estoque.schemas import (
    AjusteIn,
    EntradaIn,
    EntradaOut,
    InventarioIn,
    InventarioOut,
    MovimentoOut,
    SaldoOut,
)
from app.modules.estoque.service import EstoqueService

router = APIRouter(prefix="/estoque", tags=["estoque"])


@router.post(
    "/entradas",
    response_model=EntradaOut,
    status_code=status.HTTP_201_CREATED,
    summary="Registra entrada de mercadoria (bipagem contínua)",
)
async def registrar_entrada(
    session: SessionDep, usuario: CurrentUser, dados: EntradaIn
) -> EntradaOut:
    return await EstoqueService(session).registrar_entrada(dados, usuario)


@router.post(
    "/ajustes",
    response_model=MovimentoOut,
    status_code=status.HTTP_201_CREATED,
    summary="Ajusta o saldo de uma peça (admin, com motivo)",
)
async def ajustar(session: SessionDep, usuario: ExigeCorrigirEstoque, dados: AjusteIn) -> MovimentoOut:
    return await EstoqueService(session).ajustar(dados, usuario)


@router.post(
    "/inventarios",
    response_model=InventarioOut,
    status_code=status.HTTP_201_CREATED,
    summary="Lança uma contagem física e acerta as diferenças (admin)",
)
async def inventariar(
    session: SessionDep, usuario: ExigeCorrigirEstoque, dados: InventarioIn
) -> InventarioOut:
    return await EstoqueService(session).inventariar(dados, usuario)


# response_model=None: ADMIN recebe saldo com custo e valor imobilizado; VENDEDOR, sem.
@router.get("/saldos", response_model=None, summary="Saldo por peça")
async def listar_saldos(
    session: SessionDep,
    usuario: CurrentUser,
    p: Annotated[Paginacao, Depends(paginacao)],
    q: Annotated[str | None, Query(description="Nome do produto ou código de barras")] = None,
    categoria_id: int | None = None,
    somente_baixo: Annotated[
        bool, Query(description="Só peças no estoque mínimo ou abaixo")
    ] = False,
) -> Pagina[SaldoOut]:
    return await EstoqueService(session).listar_saldos(p, q, categoria_id, somente_baixo, usuario)


@router.get(
    "/movimentacoes",
    response_model=Pagina[MovimentoOut],
    summary="Extrato: toda mudança de saldo, com autor e motivo",
)
async def listar_movimentos(
    session: SessionDep,
    _: CurrentUser,
    p: Annotated[Paginacao, Depends(paginacao)],
    variante_id: int | None = None,
    tipo: TipoMovimento | None = None,
    inicio: Annotated[date | None, Query(description="Primeiro dia (inclusive)")] = None,
    fim: Annotated[date | None, Query(description="Último dia (inclusive)")] = None,
) -> Pagina[MovimentoOut]:
    return await EstoqueService(session).listar_movimentos(
        p, variante_id, tipo, inicio_do_dia(inicio), fim_exclusivo_do_dia(fim)
    )
