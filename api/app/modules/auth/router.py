from fastapi import APIRouter, status

from app.core.deps import CurrentUser, SessionDep
from app.modules.auth.schemas import LoginIn, RefreshIn, TokenOut
from app.modules.auth.service import AuthService
from app.modules.usuarios.schemas import UsuarioOut

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/login", response_model=TokenOut, summary="Entrar")
async def login(session: SessionDep, dados: LoginIn) -> TokenOut:
    return await AuthService(session).login(dados.email, dados.senha)


@router.post("/refresh", response_model=TokenOut, summary="Renovar sessão (rotaciona o refresh)")
async def refresh(session: SessionDep, dados: RefreshIn) -> TokenOut:
    return await AuthService(session).refresh(dados.refresh_token)


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT, summary="Sair")
async def logout(session: SessionDep, _: CurrentUser, dados: RefreshIn) -> None:
    await AuthService(session).logout(dados.refresh_token)


@router.get("/me", response_model=UsuarioOut, summary="Usuário da sessão atual")
async def me(user: CurrentUser) -> UsuarioOut:
    return UsuarioOut.model_validate(user)
