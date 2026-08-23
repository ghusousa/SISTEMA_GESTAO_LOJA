"""A porta do diário — só para o dono (`VER_AUDITORIA`)."""

from datetime import date, datetime, time
from typing import Annotated

from fastapi import APIRouter, Depends, Query

from app.core.config import settings
from app.core.deps import ExigeAuditoria, SessionDep
from app.core.pagination import Pagina, Paginacao, paginacao
from app.modules.auditoria.schemas import AuditoriaOut
from app.modules.auditoria.service import AuditoriaService

router = APIRouter(prefix="/auditoria", tags=["auditoria"])


def _inicio_do_dia(dia: date | None) -> datetime | None:
    """00:00 do dia no fuso da loja, em UTC — o mesmo 'dia' do resto do sistema."""
    if dia is None:
        return None
    return datetime.combine(dia, time.min, tzinfo=settings.tz_loja)


def _fim_do_dia(dia: date | None) -> datetime | None:
    """00:00 do dia SEGUINTE (fim exclusivo): pega o dia inteiro sem cair na virada."""
    if dia is None:
        return None
    return datetime.combine(dia, time.max, tzinfo=settings.tz_loja)


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
        inicio=_inicio_do_dia(inicio),
        fim=_fim_do_dia(fim),
    )
