"""Dependências compartilhadas: usuário autenticado e exigência de papel."""

from typing import Annotated

from fastapi import Depends
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_session
from app.core.exceptions import SemPermissao, TokenInvalido
from app.core.security import decodificar_token
from app.modules.usuarios.models import Papel, User

bearer = HTTPBearer(auto_error=False)

SessionDep = Annotated[AsyncSession, Depends(get_session)]


async def get_current_user(
    session: SessionDep,
    credencial: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer)] = None,
) -> User:
    if credencial is None:
        raise TokenInvalido("Autenticação obrigatória.")
    payload = decodificar_token(credencial.credentials, "access")
    user = await session.get(User, int(payload["sub"]))
    if user is None or not user.is_active:
        raise TokenInvalido("Usuário inativo ou inexistente.")
    return user


CurrentUser = Annotated[User, Depends(get_current_user)]


async def get_admin_user(user: CurrentUser) -> User:
    if user.role != Papel.ADMIN:
        raise SemPermissao()
    return user


AdminUser = Annotated[User, Depends(get_admin_user)]
