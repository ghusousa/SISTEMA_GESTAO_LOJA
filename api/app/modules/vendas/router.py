from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, Query, status

from app.core.deps import CurrentUser, ExigeCancelarVenda, SessionDep
from app.core.pagination import Pagina, Paginacao, paginacao
from app.modules.vendas.models import StatusVenda
from app.modules.vendas.schemas import CancelamentoIn, VendaIn, VendaOut, VendaResumoOut
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
    inicio: datetime | None = None,
    fim: datetime | None = None,
    situacao: Annotated[StatusVenda | None, Query(alias="status")] = None,
    vendedor_id: int | None = None,
) -> Pagina[VendaResumoOut]:
    return await VendaService(session).listar(p, inicio, fim, situacao, vendedor_id, usuario)


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
