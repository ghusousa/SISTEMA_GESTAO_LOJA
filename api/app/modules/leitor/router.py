"""O celular como leitor do computador (ADR-43). Qualquer pessoa da equipe logada pareia:
não há capacidade nova — ler código de barras não mostra nada que a pessoa já não veja."""

from fastapi import APIRouter, Response, status

from app.core.deps import CurrentUser, SessionDep
from app.modules.leitor.schemas import (
    AceiteIn,
    BipeIn,
    BipeOut,
    PareamentoIn,
    PareamentoOut,
    RetiradaOut,
)
from app.modules.leitor.service import LeitorService

router = APIRouter(prefix="/leitor", tags=["leitor pelo celular"])


@router.post(
    "/pareamentos",
    response_model=PareamentoOut,
    status_code=status.HTTP_201_CREATED,
    summary="Computador: gera o código (5 min) para um celular virar o leitor dele",
)
async def criar(
    session: SessionDep, usuario: CurrentUser, dados: PareamentoIn | None = None
) -> PareamentoOut:
    return await LeitorService(session).criar(dados or PareamentoIn(), usuario)


# Rota de nome fixo antes de `/{pareamento_id}`.
@router.post(
    "/pareamentos/aceitar",
    response_model=PareamentoOut,
    summary="Celular: aceita o código e vira o leitor daquele computador (12 h)",
)
async def aceitar(session: SessionDep, usuario: CurrentUser, dados: AceiteIn) -> PareamentoOut:
    return await LeitorService(session).aceitar(dados, usuario)


@router.get(
    "/pareamentos/{pareamento_id}",
    response_model=PareamentoOut,
    summary="Situação do pareamento (só para as duas pontas dele)",
)
async def obter(session: SessionDep, usuario: CurrentUser, pareamento_id: int) -> PareamentoOut:
    return await LeitorService(session).obter(pareamento_id, usuario)


@router.delete(
    "/pareamentos/{pareamento_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Desliga o leitor (de qualquer uma das pontas)",
)
async def encerrar(session: SessionDep, usuario: CurrentUser, pareamento_id: int) -> Response:
    await LeitorService(session).encerrar(pareamento_id, usuario)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post(
    "/pareamentos/{pareamento_id}/retirar",
    response_model=RetiradaOut,
    summary="Computador: retira a fila de bipes (uma vez só, até 50 por chamada)",
)
async def retirar(session: SessionDep, usuario: CurrentUser, pareamento_id: int) -> RetiradaOut:
    return await LeitorService(session).retirar(pareamento_id, usuario)


@router.post(
    "/bipes",
    response_model=BipeOut,
    status_code=status.HTTP_201_CREATED,
    summary="Celular: manda uma leitura para o computador (idempotente por client_uuid)",
)
async def bipar(
    session: SessionDep, usuario: CurrentUser, dados: BipeIn, resposta: Response
) -> BipeOut:
    servico = LeitorService(session)
    bipe = await servico.bipar(dados, usuario)
    if servico.replay:
        resposta.status_code = status.HTTP_200_OK
    return bipe
