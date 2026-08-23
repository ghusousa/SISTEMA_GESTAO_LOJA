"""Dependências compartilhadas: usuário autenticado e exigência de permissão."""

from typing import Annotated, Callable

from fastapi import Depends
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_session
from app.core.exceptions import SemPermissao, TokenInvalido
from app.core.permissoes import Pode, pode
from app.core.security import decodificar_token
from app.modules.usuarios.models import User

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


def exige(capacidade: Pode) -> Callable[[User], User]:
    """Dependência que barra quem não tem a capacidade pedida.

    A rota declara o que precisa (`ExigeDinheiro`), não quem pode. Assim mudar o que um
    cargo faz é uma linha em `core/permissoes.py`, e nenhuma rota precisa ser revisada.
    """

    async def verificar(user: CurrentUser) -> User:
        if not pode(user.role, capacidade):
            raise SemPermissao()
        return user

    return verificar


# Atalhos prontos: cada um é o "crachá" que a rota exige na porta.
ExigeDinheiro = Annotated[User, Depends(exige(Pode.VER_DINHEIRO))]
ExigeDespesa = Annotated[User, Depends(exige(Pode.LANCAR_DESPESA))]
ExigeCancelarVenda = Annotated[User, Depends(exige(Pode.CANCELAR_VENDA))]
ExigeDevolucao = Annotated[User, Depends(exige(Pode.DEVOLVER_VENDA))]
ExigeCrediario = Annotated[User, Depends(exige(Pode.GERIR_CREDIARIO))]
ExigeCorrigirEstoque = Annotated[User, Depends(exige(Pode.CORRIGIR_ESTOQUE))]
ExigeEditarCatalogo = Annotated[User, Depends(exige(Pode.EDITAR_CATALOGO))]
ExigeCaixa = Annotated[User, Depends(exige(Pode.FECHAR_CAIXA))]
ExigeUsuarios = Annotated[User, Depends(exige(Pode.GERIR_USUARIOS))]
