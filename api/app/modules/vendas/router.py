from datetime import date
from typing import Annotated

from fastapi import APIRouter, Depends, Query, status

from app.core.datas import fim_exclusivo_do_dia, inicio_do_dia
from app.core.deps import CurrentUser, ExigeCancelarVenda, ExigeDevolucao, SessionDep
from app.core.pagination import Pagina, Paginacao, paginacao
from app.modules.vendas.models import StatusVenda
from app.modules.vendas.devolucao import DevolucaoService
from app.modules.vendas.schemas import (
    CancelamentoIn,
    DevolucaoIn,
    DevolucaoOut,
    VendaIn,
    ValeOut,
    VendaOut,
    VendaResumoOut,
)
from app.modules.vendas.service import VendaService

router = APIRouter(prefix="/vendas", tags=["vendas"])


# response_model=None: quem vê dinheiro (dono e gerente) recebe custo e lucro da
# venda; os demais, não. Com response_model, o modelo da classe base apagaria os
# campos extras justamente de quem tem direito a eles.
@router.post(
    "",
    response_model=None,
    status_code=status.HTTP_201_CREATED,
    summary="Registra uma venda do PDV (atômica e idempotente)",
)
async def registrar(session: SessionDep, usuario: CurrentUser, dados: VendaIn) -> VendaOut:
    return await VendaService(session).registrar(dados, usuario)


@router.get(
    "",
    response_model=Pagina[VendaResumoOut],
    summary="Lista vendas (vendedor vê apenas as suas)",
)
async def listar(
    session: SessionDep,
    usuario: CurrentUser,
    p: Annotated[Paginacao, Depends(paginacao)],
    # DIA, não instante: a tela manda "2026-08-23" e quem sabe o que isso significa em
    # horas é o servidor, o único que conhece o fuso da loja (app/core/datas.py).
    inicio: Annotated[date | None, Query(description="Primeiro dia (inclusive)")] = None,
    fim: Annotated[date | None, Query(description="Último dia (inclusive)")] = None,
    situacao: Annotated[StatusVenda | None, Query(alias="status")] = None,
    vendedor_id: int | None = None,
    variante_id: Annotated[
        int | None, Query(description="Só vendas que levaram esta peça — para devolver")
    ] = None,
    cliente_id: int | None = None,
) -> Pagina[VendaResumoOut]:
    return await VendaService(session).listar(
        p,
        inicio_do_dia(inicio),
        fim_exclusivo_do_dia(fim),
        situacao,
        vendedor_id,
        usuario,
        variante_id,
        cliente_id,
    )


@router.get(
    "/vales/{codigo}",
    response_model=ValeOut,
    summary="Saldo de um vale de troca",
)
async def consultar_vale(session: SessionDep, _: CurrentUser, codigo: str) -> ValeOut:
    """Aberto a qualquer autenticado: é a vendedora no balcão que precisa saber se o vale
    do papel na mão da cliente ainda vale, e quanto."""
    return await DevolucaoService(session).consultar_vale(codigo)


@router.post(
    "/{venda_id}/devolucoes",
    response_model=None,
    status_code=status.HTTP_201_CREATED,
    summary="Receber peça de volta (devolução parcial)",
)
async def devolver(
    session: SessionDep, usuario: ExigeDevolucao, venda_id: int, dados: DevolucaoIn
) -> DevolucaoOut:
    return await DevolucaoService(session).devolver(venda_id, dados, usuario)


@router.get(
    "/{venda_id}/devolucoes",
    response_model=list[DevolucaoOut],
    summary="Devoluções desta venda",
)
async def devolucoes_da_venda(
    session: SessionDep, usuario: CurrentUser, venda_id: int
) -> list[DevolucaoOut]:
    return await DevolucaoService(session).listar_da_venda(venda_id, usuario)


@router.get("/{venda_id}", response_model=None, summary="Detalhe da venda")
async def obter(session: SessionDep, usuario: CurrentUser, venda_id: int) -> VendaOut:
    return await VendaService(session).obter(venda_id, usuario)


@router.post(
    "/{venda_id}/cancelamento",
    response_model=None,
    summary="Cancela a venda e devolve as peças ao estoque",
)
async def cancelar(
    session: SessionDep, usuario: ExigeCancelarVenda, venda_id: int, dados: CancelamentoIn
) -> VendaOut:
    return await VendaService(session).cancelar(venda_id, dados.motivo, usuario)
