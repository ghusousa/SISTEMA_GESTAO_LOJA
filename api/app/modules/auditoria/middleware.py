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


def _caminho_na_api(request: Request) -> str:
    """O caminho como a API o enxerga, sem o prefixo em que ela foi montada.

    A demonstração em `/demo` (ADR-46) recebe `/demo/api/v1/vendas`, com "/demo" no
    `root_path`. Lido cru, nada começava com `/api/v1` e TODA mutação da demo saía do
    diário, calada; e o caminho gravado tem de ser o mesmo nas duas, que o mapa de
    `classificar.py` é um só.
    """
    caminho = request.url.path
    raiz = request.scope.get("root_path", "")
    if raiz and caminho.startswith(raiz):
        caminho = caminho[len(raiz):] or "/"
    return caminho


def _ip(request: Request) -> str | None:
    encaminhado = request.headers.get("x-forwarded-for")
    if encaminhado:
        return encaminhado.split(",")[0].strip()[:64]
    return request.client.host if request.client else None


def fora_do_diario(request: Request) -> None:
    """A rota avisa a borda: esta resposta 2xx não foi um ato, não vira linha no diário.

    Só para o caminho idempotente que não mudou nada — desligar o que já tinha terminado, o
    reenvio de um aceite (ADR-43). Sem isto o diário mostraria atos que não aconteceram, no
    nome de quem só estava saindo do sistema. Esquecer de chamar deixa uma linha a mais;
    nunca esconde um ato, que é o que o registro na borda protege.
    """
    request.state.fora_do_diario = True


def congelar_autor(request: Request, usuario: User) -> None:
    """A rota avisa a borda: a conta de quem age vai deixar de existir NESTE ato.

    É o "Excluir minha conta" (ADR-45). A linha do diário é gravada depois do commit, e aí
    a conta já saiu: buscá-la pelo id não acha nada, e o `user_id` dela quebraria o FK — a
    linha inteira se perderia no `try/except`. Com isto, ela sai sem o vínculo e com o nome
    e o papel de ANTES, congelados como em todo ato (ADR-23). Chamar antes do service: depois
    do commit o objeto já não tem o que ler.
    """
    request.state.autor_congelado = (usuario.name, usuario.role)


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
            caminho_na_api = _caminho_na_api(request)
            if not caminho_na_api.startswith(_PREFIXO):
                return resposta
            # Só o que de fato aconteceu: 2xx/3xx. Um 4xx é uma tentativa barrada (o
            # 403 da vendedora, o 422 de dado inválido) — não é um ato consumado.
            if resposta.status_code >= 400:
                return resposta
            # A rota disse que nada mudou (`fora_do_diario`): um 204 sem efeito não é ato.
            if getattr(request.state, "fora_do_diario", False):
                return resposta

            caminho = caminho_na_api[len(_PREFIXO):]
            ato = classificar(request.method, caminho)
            if ato is None:
                return resposta

            identidade = _quem(request)
            if identidade is None:
                return resposta  # mutação sem token válido: não há a quem atribuir
            user_id, papel = identidade

            async with SessionLocal() as sessao:
                congelado = getattr(request.state, "autor_congelado", None)
                if congelado is not None:
                    # Excluiu a própria conta: nome e papel de antes de sair, sem vínculo.
                    vinculo, (nome, papel_do_autor) = None, congelado
                else:
                    usuario = await sessao.get(User, user_id)
                    # Conta que não existe mais vai sem vínculo: o FK derrubaria a linha.
                    vinculo = usuario.id if usuario else None
                    nome = usuario.name if usuario else f"usuário #{user_id}"
                    # O papel do BANCO, não o do token: o claim é de quando o token saiu (até
                    # 30 min atrás) e a autorização já usa o do banco. Rebaixada de gerente a
                    # vendedora, o ato seguinte dela não pode entrar no diário como GERENTE.
                    # O claim só serve se a conta nem existir mais.
                    papel_do_autor = usuario.role if usuario else (papel or None)
                AuditoriaRepository(sessao).registrar(
                    user_id=vinculo,
                    user_nome=nome,
                    user_papel=papel_do_autor,
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
