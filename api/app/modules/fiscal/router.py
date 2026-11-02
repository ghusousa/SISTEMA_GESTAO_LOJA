"""A NFC-e de uma venda: ver e emitir (ADR-41).

Ficam sob `/vendas/{id}/nfce` porque a nota é DA venda — quem enxerga a venda enxerga a
nota, e mais ninguém (a vendedora, só das vendas dela). Cancelar a nota não tem rota
própria: acontece dentro do cancelamento da venda, e só ali.
"""

from fastapi import APIRouter

from app.core.deps import CurrentUser, SessionDep
from app.modules.fiscal.schemas import EmissorOut, NfceOut
from app.modules.fiscal.service import FiscalService, emissor_out

router = APIRouter(tags=["fiscal"])


@router.get("/vendas/{venda_id}/nfce", response_model=NfceOut, summary="Situação da NFC-e")
async def obter(session: SessionDep, usuario: CurrentUser, venda_id: int) -> NfceOut:
    return await FiscalService(session).obter(venda_id, usuario)


@router.post(
    "/vendas/{venda_id}/nfce",
    response_model=NfceOut,
    summary="Emite a NFC-e da venda (idempotente: autorizada não reemite)",
)
async def emitir(session: SessionDep, usuario: CurrentUser, venda_id: int) -> NfceOut:
    return await FiscalService(session).emitir(venda_id, usuario)


@router.get("/fiscal/emissor", response_model=EmissorOut, summary="Emissor fiscal ligado?")
async def emissor(_: CurrentUser) -> EmissorOut:
    """Se há emissor e o que falta no `.env`. O token nunca sai — só se ele existe."""
    return emissor_out()
