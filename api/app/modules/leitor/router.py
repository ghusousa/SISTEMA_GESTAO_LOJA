"""O celular como leitor do computador (ADR-43, ADR-47). Qualquer pessoa da equipe logada
pareia ou chama: não há capacidade nova — ler código de barras não mostra nada que a pessoa
já não veja."""

from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request, Response, status

from app.core.deps import CurrentUser, SessionDep
from app.core.pagination import Pagina, Paginacao
from app.modules.auditoria.middleware import fora_do_diario
from app.modules.leitor.schemas import (
    AceiteIn,
    AtendimentoIn,
    BipeIn,
    BipeOut,
    ChamadoAbertoOut,
    ChamadoIn,
    ChamadoOut,
    PareamentoIn,
    PareamentoOut,
    PontaDoLeitor,
    RetiradaOut,
)
from app.modules.leitor.service import TETO_POR_COMPUTADOR, LeitorService

router = APIRouter(prefix="/leitor", tags=["leitor pelo celular"])


def _paginacao_dos_chamados(
    page: int = Query(1, ge=1, description="Página, começando em 1"),
    size: int = Query(
        TETO_POR_COMPUTADOR,
        ge=1,
        le=TETO_POR_COMPUTADOR,
        description="Itens por página: o teto de vivos por login cabe numa página",
    ),
) -> Paginacao:
    return Paginacao(page=page, size=size)


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
async def aceitar(
    request: Request, session: SessionDep, usuario: CurrentUser, dados: AceiteIn
) -> PareamentoOut:
    servico = LeitorService(session)
    pareamento = await servico.aceitar(dados, usuario)
    if servico.replay:
        # O reenvio de quem já tinha aceitado: nada ligou de novo.
        fora_do_diario(request)
    return pareamento


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
async def encerrar(
    request: Request,
    session: SessionDep,
    usuario: CurrentUser,
    pareamento_id: int,
    ponta: PontaDoLeitor | None = None,
) -> Response:
    if not await LeitorService(session).encerrar(pareamento_id, usuario, ponta):
        # Nenhum celular desligado (já tinha terminado, ou era só o código esperando): o
        # 204 deixa as duas pontas saírem sem erro, mas não é "Desligou" no diário.
        fora_do_diario(request)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post(
    "/pareamentos/{pareamento_id}/retirar",
    response_model=RetiradaOut,
    summary="Computador: retira a fila de bipes (uma vez só, até 50 por chamada)",
)
async def retirar(session: SessionDep, usuario: CurrentUser, pareamento_id: int) -> RetiradaOut:
    return await LeitorService(session).retirar(pareamento_id, usuario)


@router.post(
    "/chamados",
    response_model=ChamadoOut,
    status_code=status.HTTP_201_CREATED,
    summary="Computador: chama o celular do próprio login (idempotente por client_uuid)",
)
async def chamar(
    session: SessionDep, usuario: CurrentUser, dados: ChamadoIn, resposta: Response
) -> ChamadoOut:
    servico = LeitorService(session)
    chamado = await servico.chamar(dados, usuario)
    if servico.replay:
        resposta.status_code = status.HTTP_200_OK
    return chamado


@router.get(
    "/chamados/abertos",
    response_model=Pagina[ChamadoAbertoOut],
    summary="Celular: os chamados do próprio login que ainda esperam",
)
async def chamados_abertos(
    session: SessionDep,
    usuario: CurrentUser,
    p: Annotated[Paginacao, Depends(_paginacao_dos_chamados)],
) -> Pagina[ChamadoAbertoOut]:
    return await LeitorService(session).chamados_abertos(usuario, p)


@router.post(
    "/chamados/{pareamento_id}/atender",
    response_model=PareamentoOut,
    summary="Celular: atende o chamado do próprio login, sem código (12 h)",
)
async def atender(
    request: Request,
    session: SessionDep,
    usuario: CurrentUser,
    pareamento_id: int,
    dados: AtendimentoIn,
) -> PareamentoOut:
    servico = LeitorService(session)
    pareamento = await servico.atender(pareamento_id, dados, usuario)
    if servico.replay:
        # O reenvio da mesma instalação: nada ligou de novo.
        fora_do_diario(request)
    return pareamento


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
