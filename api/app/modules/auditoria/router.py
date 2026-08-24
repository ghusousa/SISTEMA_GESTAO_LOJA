"""A porta do diário — só para o dono (`VER_AUDITORIA`)."""

from datetime import date, datetime, time
from typing import Annotated

from fastapi import APIRouter, Depends, Query

from app.core.datas import fim_exclusivo_do_dia, inicio_do_dia
from app.core.deps import ExigeAuditoria, SessionDep
from app.core.pagination import Pagina, Paginacao, paginacao
from app.modules.auditoria.schemas import AuditoriaOut
from app.modules.auditoria.service import AuditoriaService

router = APIRouter(prefix="/auditoria", tags=["auditoria"])


@router.get("", response_model=Pagina[AuditoriaOut], summary="Diário de auditoria (só o dono)")
async def listar(
    session: SessionDep,
    _: ExigeAuditoria,
    p: Annotated[Paginacao, Depends(paginacao)],
    usuario_id: Annotated[int | None, Query(description="Só os atos deste usuário")] = None,
    acao: Annotated[str | None, Query(description="Só uma ação, ex. VENDA_CANCELADA")] = None,
    inicio: Annotated[date | None, Query(description="Primeiro dia (inclusive)")] = None,
    fim: Annotated[date | None, Query(description="Último dia (inclusive)")] = None,
) -> Pagina[AuditoriaOut]:
    return await AuditoriaService(session).listar(
        p,
        usuario_id=usuario_id,
        acao=acao,
        inicio=inicio_do_dia(inicio),
        fim=fim_exclusivo_do_dia(fim),
    )
