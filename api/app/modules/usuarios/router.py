from typing import Annotated

from fastapi import APIRouter, Depends, Query, status

from app.core.deps import CurrentUser, ExigeUsuarios, SessionDep
from app.core.pagination import Pagina, Paginacao, paginacao
from app.modules.usuarios.models import Papel
from app.modules.usuarios.schemas import (
    SenhaReset,
    SenhaTroca,
    UsuarioCreate,
    UsuarioOut,
    UsuarioUpdate,
)
from app.modules.usuarios.service import UsuarioService

router = APIRouter(prefix="/usuarios", tags=["usuarios"])


@router.get("", response_model=Pagina[UsuarioOut], summary="Lista a equipe")
async def listar(
    session: SessionDep,
    ator: ExigeUsuarios,
    p: Annotated[Paginacao, Depends(paginacao)],
    q: Annotated[str | None, Query(description="Busca por nome ou e-mail")] = None,
    papel: Papel | None = None,
    ativo: bool | None = None,
) -> Pagina[UsuarioOut]:
    return await UsuarioService(session).listar(p, q, papel, ativo)


@router.post(
    "", response_model=UsuarioOut, status_code=status.HTTP_201_CREATED, summary="Cria usuário"
)
async def criar(session: SessionDep, ator: ExigeUsuarios, dados: UsuarioCreate) -> UsuarioOut:
    return UsuarioOut.model_validate(await UsuarioService(session).criar(dados, ator))


@router.patch("/me/senha", status_code=status.HTTP_204_NO_CONTENT, summary="Troca a própria senha")
async def trocar_propria_senha(
    session: SessionDep, user: CurrentUser, dados: SenhaTroca
) -> None:
    await UsuarioService(session).trocar_propria_senha(
        user, dados.senha_atual, dados.nova_senha
    )


@router.get("/{user_id}", response_model=UsuarioOut, summary="Detalhe de usuário")
async def obter(session: SessionDep, ator: ExigeUsuarios, user_id: int) -> UsuarioOut:
    return UsuarioOut.model_validate(await UsuarioService(session).obter(user_id))


@router.patch("/{user_id}", response_model=UsuarioOut, summary="Atualiza usuário")
async def atualizar(
    session: SessionDep, ator: ExigeUsuarios, user_id: int, dados: UsuarioUpdate
) -> UsuarioOut:
    return UsuarioOut.model_validate(await UsuarioService(session).atualizar(user_id, dados, ator))


@router.delete(
    "/{user_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Exclui um usuário e os dados de acesso dele",
)
async def excluir(session: SessionDep, ator: ExigeUsuarios, user_id: int) -> None:
    await UsuarioService(session).excluir(user_id, ator)


@router.patch(
    "/{user_id}/senha",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Redefine a senha de alguém da equipe",
)
async def redefinir_senha(
    session: SessionDep, ator: ExigeUsuarios, user_id: int, dados: SenhaReset
) -> None:
    await UsuarioService(session).redefinir_senha(user_id, dados.nova_senha, ator)
