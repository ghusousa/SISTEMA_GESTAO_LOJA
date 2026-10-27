"""A borda que registra tudo: um middleware que, depois de cada mutação bem-sucedida,
escreve uma linha no diário — sem cada rota precisar lembrar de fazê-lo.

**Por que na borda e não em cada serviço:** registrar em cada endpoint é a garantia de que
um dia alguém esquece, e o buraco no diário é exatamente onde importa. Aqui é um lugar só,
e o mapa de `classificar.py` decide o que vira frase.

**Por que numa sessão própria:** o Starlette roda o endpoint numa task separada, então a
sessão do request já foi fechada quando o middleware retoma. Abrimos uma sessão nova, curta,
só para o INSERT — e se ela falhar, o diário perde uma linha, mas a operação do usuário NÃO
é afetada (o `try/except` é largo de propósito: auditoria nunca derruba a venda).

Login (sucesso e falha) e refresh NÃO passam por aqui — `classificar` os ignora. Login tem
tratamento próprio no `AuthService`, que conhece o e-mail digitado mesmo quando a conta não
existe; refresh é ruído automático.
"""

import logging

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request

from app.core.db import SessionLocal
from app.core.security import decodificar_token
from app.modules.auditoria.classificar import classificar
from app.modules.auditoria.repository import AuditoriaRepository
from app.modules.usuarios.models import User

log = logging.getLogger("auditoria")

_PREFIXO = "/api/v1"
_MUTACOES = {"POST", "PUT", "PATCH", "DELETE"}


def _ip(request: Request) -> str | None:
    encaminhado = request.headers.get("x-forwarded-for")
    if encaminhado:
        return encaminhado.split(",")[0].strip()[:64]
    return request.client.host if request.client else None


def _quem(request: Request) -> tuple[int, str] | None:
    """(user_id, papel) do token da requisição, ou None se não houver token válido."""
    cabecalho = request.headers.get("authorization", "")
    if not cabecalho.lower().startswith("bearer "):
        return None
    try:
        payload = decodificar_token(cabecalho[7:], "access")
        return int(payload["sub"]), str(payload.get("role", ""))
    except Exception:
        return None


class AuditoriaMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        resposta = await call_next(request)

        try:
            if request.method not in _MUTACOES:
                return resposta
            if not request.url.path.startswith(_PREFIXO):
                return resposta
            # Só o que de fato aconteceu: 2xx/3xx. Um 4xx é uma tentativa barrada (o
            # 403 da vendedora, o 422 de dado inválido) — não é um ato consumado.
            if resposta.status_code >= 400:
                return resposta

            caminho = request.url.path[len(_PREFIXO):]
            ato = classificar(request.method, caminho)
            if ato is None:
                return resposta

            identidade = _quem(request)
            if identidade is None:
                return resposta  # mutação sem token válido: não há a quem atribuir
            user_id, papel = identidade

            async with SessionLocal() as sessao:
                usuario = await sessao.get(User, user_id)
                nome = usuario.name if usuario else f"usuário #{user_id}"
                AuditoriaRepository(sessao).registrar(
                    user_id=user_id,
                    user_nome=nome,
                    # O papel do BANCO, não o do token: o claim é de quando o token saiu (até
                    # 30 min atrás) e a autorização já usa o do banco. Rebaixada de gerente a
                    # vendedora, o ato seguinte dela não pode entrar no diário como GERENTE.
                    # O claim só serve se a conta nem existir mais.
                    user_papel=usuario.role if usuario else (papel or None),
                    acao=ato.acao,
                    descricao=ato.descricao,
                    metodo=request.method,
                    caminho=caminho,
                    entidade=ato.entidade,
                    entidade_id=ato.entidade_id,
                    ip=_ip(request),
                    status_http=resposta.status_code,
                )
                await sessao.commit()
        except Exception:  # noqa: BLE001 — auditoria nunca pode derrubar a requisição
            log.exception("Falha ao registrar auditoria (a requisição seguiu normalmente)")

        return resposta
