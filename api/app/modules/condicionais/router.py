"""Condicional (ADR-39). Tudo aqui exige `FAZER_CONDICIONAL` — da vendedora em diante.

Todas veem todas: a cliente devolve a sacola para quem estiver no balcão, não para quem
abriu. Nada de custo nem margem sai daqui; o preço é o de venda, que o balcão já vê.
"""

from typing import Annotated

from fastapi import APIRouter, Depends, Query, Response, status

from app.core.deps import ExigeCondicional, SessionDep
from app.core.pagination import Pagina, Paginacao, paginacao
from app.modules.condicionais.schemas import (
    CondicionalIn,
    CondicionalOut,
    FechamentoIn,
    FiltroCondicionais,
)
from app.modules.condicionais.service import CondicionalService

router = APIRouter(prefix="/condicionais", tags=["condicionais"])


@router.post(
    "",
    response_model=CondicionalOut,
    status_code=status.HTTP_201_CREATED,
    summary="Abre uma condicional: as peças saem do disponível (idempotente)",
)
async def abrir(
    session: SessionDep, usuario: ExigeCondicional, dados: CondicionalIn, resposta: Response
) -> CondicionalOut:
    servico = CondicionalService(session)
    condicional = await servico.abrir(dados, usuario)
    if servico.replay:
        resposta.status_code = status.HTTP_200_OK
    return condicional


@router.get(
    "",
    response_model=Pagina[CondicionalOut],
    summary="Lista condicionais: abertas (padrão), vencidas, fechadas ou todas; por cliente",
)
async def listar(
    session: SessionDep,
    _: ExigeCondicional,
    p: Annotated[Paginacao, Depends(paginacao)],
    situacao: Annotated[
        FiltroCondicionais,
        Query(description="abertas, vencidas (prazo passou no dia da loja), fechadas, todas"),
    ] = FiltroCondicionais.ABERTAS,
    cliente_id: int | None = None,
) -> Pagina[CondicionalOut]:
    return await CondicionalService(session).listar(p, situacao, cliente_id)


@router.get("/{condicional_id}", response_model=CondicionalOut, summary="Detalhe da condicional")
async def obter(session: SessionDep, _: ExigeCondicional, condicional_id: int) -> CondicionalOut:
    return await CondicionalService(session).obter(condicional_id)


@router.post(
    "/{condicional_id}/fechamento",
    response_model=CondicionalOut,
    status_code=status.HTTP_201_CREATED,
    summary="Fecha: o que voltou entra no estoque, o que ficou vira venda (idempotente)",
)
async def fechar(
    session: SessionDep,
    usuario: ExigeCondicional,
    condicional_id: int,
    dados: FechamentoIn,
    resposta: Response,
) -> CondicionalOut:
    servico = CondicionalService(session)
    condicional = await servico.fechar(condicional_id, dados, usuario)
    if servico.replay:
        resposta.status_code = status.HTTP_200_OK
    return condicional
