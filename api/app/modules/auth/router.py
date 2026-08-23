from fastapi import APIRouter, Cookie, Request, Response, status
from typing import Annotated

from app.core.config import settings
from app.core.deps import CurrentUser, SessionDep
from app.core.exceptions import TokenInvalido
from app.modules.auth.schemas import LoginIn, RefreshIn, TokenOut
from app.modules.auth.service import AuthService
from app.modules.usuarios.schemas import UsuarioOut

router = APIRouter(prefix="/auth", tags=["auth"])

COOKIE_REFRESH = "loja_refresh"


def _guardar_refresh(resposta: Response, token: str) -> None:
    """Grava o refresh num cookie que o JavaScript não enxerga.

    O app do celular guarda os tokens no cofre do sistema, mas no navegador não existe
    equivalente: refresh em localStorage é lido por qualquer script injetado. Com httpOnly
    o token vai e volta sozinho, sem passar pelo código da página.
    """
    resposta.set_cookie(
        COOKIE_REFRESH,
        token,
        httponly=True,
        # SameSite=strict: o cookie não acompanha requisição vinda de outro site, que é o
        # que impediria um formulário hostil de disparar rotação de sessão.
        samesite="strict",
        secure=settings.ambiente.lower() not in {"dev", "test", "local"},
        max_age=settings.refresh_token_expire_days * 24 * 3600,
        path="/api/v1/auth",
    )


def _ip_do_cliente(request: Request) -> str | None:
    """O IP de quem chamou. Atrás do proxy (Caddy/Nginx) o real vem no X-Forwarded-For."""
    encaminhado = request.headers.get("x-forwarded-for")
    if encaminhado:
        # O primeiro da lista é o cliente; os demais são os proxies pelo caminho.
        return encaminhado.split(",")[0].strip()[:64]
    return request.client.host if request.client else None


@router.post("/login", response_model=TokenOut, summary="Entrar")
async def login(
    session: SessionDep, request: Request, resposta: Response, dados: LoginIn
) -> TokenOut:
    tokens = await AuthService(session).login(dados.email, dados.senha, _ip_do_cliente(request))
    _guardar_refresh(resposta, tokens.refresh_token)
    return tokens


@router.post("/refresh", response_model=TokenOut, summary="Renovar sessão (rotaciona o refresh)")
async def refresh(
    session: SessionDep,
    resposta: Response,
    dados: RefreshIn | None = None,
    loja_refresh: Annotated[str | None, Cookie()] = None,
) -> TokenOut:
    """Aceita o token no corpo (app do celular) ou no cookie (navegador)."""
    token = (dados.refresh_token if dados else None) or loja_refresh
    if not token:
        raise TokenInvalido("Sessão não encontrada.")
    tokens = await AuthService(session).refresh(token)
    _guardar_refresh(resposta, tokens.refresh_token)
    return tokens


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT, summary="Sair")
async def logout(
    session: SessionDep,
    resposta: Response,
    _: CurrentUser,
    dados: RefreshIn | None = None,
    loja_refresh: Annotated[str | None, Cookie()] = None,
) -> None:
    token = (dados.refresh_token if dados else None) or loja_refresh
    if token:
        await AuthService(session).logout(token)
    resposta.delete_cookie(COOKIE_REFRESH, path="/api/v1/auth")


@router.get("/me", response_model=UsuarioOut, summary="Usuário da sessão atual")
async def me(user: CurrentUser) -> UsuarioOut:
    return UsuarioOut.model_validate(user)
