from datetime import UTC, date, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, Query, status

from app.core.config import settings
from app.core.deps import AdminUser, SessionDep
from app.core.pagination import Pagina, Paginacao, paginacao
from app.modules.caixa.schemas import DiaCaixaOut, FechamentoIn, FechamentoOut
from app.modules.caixa.service import CaixaService

router = APIRouter(prefix="/caixa", tags=["caixa"])


@router.get("/dia", response_model=DiaCaixaOut, summary="O que o sistema espera no caixa do dia")
async def dia(
    session: SessionDep,
    _: AdminUser,
    data: Annotated[date | None, Query(description="Padrão: hoje no fuso da loja")] = None,
) -> DiaCaixaOut:
    dia_pedido = data or datetime.now(UTC).astimezone(settings.tz_loja).date()
    return await CaixaService(session).dia(dia_pedido)


@router.post(
    "/fechamentos",
    response_model=FechamentoOut,
    status_code=status.HTTP_201_CREATED,
    summary="Registra a conferência do caixa (refechar o mesmo dia atualiza)",
)
async def fechar(
    session: SessionDep, usuario: AdminUser, dados: FechamentoIn
) -> FechamentoOut:
    return await CaixaService(session).fechar(dados, usuario)


@router.get(
    "/fechamentos", response_model=Pagina[FechamentoOut], summary="Histórico de fechamentos"
)
async def listar(
    session: SessionDep,
    _: AdminUser,
    p: Annotated[Paginacao, Depends(paginacao)],
    inicio: date | None = None,
    fim: date | None = None,
) -> Pagina[FechamentoOut]:
    return await CaixaService(session).listar(p, inicio, fim)
