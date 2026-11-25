"""O registro do aparelho para o chamado do leitor (ADR-47).

`PUT` exige sessão (qualquer papel: o leitor não tem capacidade própria). `DELETE` é SEM
sessão: o app esquece a instalação ao sair, depois de a sessão cair, ou no servidor de antes
— e aí não há mais crachá. Nenhuma das duas devolve o token nem o id da instalação.
"""

from fastapi import APIRouter, Response, status

from app.core.deps import CurrentUser, SessionDep
from app.modules.notificacoes.schemas import AparelhoFora, AparelhoIn
from app.modules.notificacoes.service import NotificacoesService

router = APIRouter(prefix="/notificacoes", tags=["notificações do leitor"])


@router.put(
    "/aparelho",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="App: registra esta instalação para o login (token de push opcional)",
)
async def registrar(session: SessionDep, usuario: CurrentUser, dados: AparelhoIn) -> Response:
    await NotificacoesService(session).registrar(dados, usuario)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.delete(
    "/aparelho",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="App: esquece esta instalação (sem sessão; 204 sempre)",
)
async def esquecer(session: SessionDep, dados: AparelhoFora) -> Response:
    await NotificacoesService(session).esquecer(dados)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
