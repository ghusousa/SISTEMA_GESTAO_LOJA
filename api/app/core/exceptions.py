"""Exceções de domínio e o handler que as traduz em resposta HTTP.

Regra do projeto: o service lança AppError; só o router conhece HTTP.
"""

from typing import Any

from fastapi import FastAPI, Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse


class AppError(Exception):
    code = "ERRO"
    http_status = status.HTTP_400_BAD_REQUEST
    message = "Erro na operação."

    def __init__(self, message: str | None = None, detail: dict[str, Any] | None = None):
        self.message = message or self.message
        self.detail = detail or {}
        super().__init__(self.message)


class CredenciaisInvalidas(AppError):
    code = "CREDENCIAIS_INVALIDAS"
    http_status = status.HTTP_401_UNAUTHORIZED
    message = "E-mail ou senha incorretos."


class TokenInvalido(AppError):
    code = "TOKEN_INVALIDO"
    http_status = status.HTTP_401_UNAUTHORIZED
    message = "Sessão inválida ou expirada. Faça login novamente."


class SemPermissao(AppError):
    code = "SEM_PERMISSAO"
    http_status = status.HTTP_403_FORBIDDEN
    message = "Você não tem permissão para esta operação."


class NaoEncontrado(AppError):
    code = "NAO_ENCONTRADO"
    http_status = status.HTTP_404_NOT_FOUND
    message = "Registro não encontrado."


class Duplicado(AppError):
    code = "DUPLICADO"
    http_status = status.HTTP_409_CONFLICT
    message = "Já existe um registro com esses dados."


class EstoqueInsuficiente(AppError):
    code = "ESTOQUE_INSUFICIENTE"
    http_status = status.HTTP_409_CONFLICT
    message = "Estoque insuficiente."


class OperacaoInvalida(AppError):
    code = "OPERACAO_INVALIDA"
    http_status = status.HTTP_409_CONFLICT
    message = "Operação não permitida no estado atual."


class PagamentoDivergente(AppError):
    code = "PAGAMENTO_DIVERGENTE"
    http_status = status.HTTP_422_UNPROCESSABLE_CONTENT
    message = "A soma dos pagamentos não confere com o total da venda."


class Validacao(AppError):
    code = "VALIDACAO"
    http_status = status.HTTP_422_UNPROCESSABLE_CONTENT
    message = "Dados inválidos."


class MuitasTentativas(AppError):
    """Bloqueio de força bruta: erros de senha demais no mesmo e-mail ou IP.

    Carrega os segundos até liberar, que viram o cabeçalho `Retry-After` no handler.
    """

    code = "MUITAS_TENTATIVAS"
    http_status = status.HTTP_429_TOO_MANY_REQUESTS
    message = "Tentativas de mais. Espere um pouco antes de tentar de novo."

    def __init__(self, segundos: int):
        super().__init__(detail={"retry_after": segundos})
        self.segundos = segundos


def registrar_handlers(app: FastAPI) -> None:
    @app.exception_handler(AppError)
    async def _app_error(_: Request, exc: AppError) -> JSONResponse:
        # Retry-After é o cabeçalho padrão do 429: diz ao cliente (e a um humano) quantos
        # segundos esperar. O front lê daqui para mostrar "tente de novo em X".
        cabecalhos = (
            {"Retry-After": str(exc.detail["retry_after"])}
            if exc.code == "MUITAS_TENTATIVAS" and "retry_after" in exc.detail
            else None
        )
        return JSONResponse(
            status_code=exc.http_status,
            content={"code": exc.code, "message": exc.message, "detail": exc.detail},
            headers=cabecalhos,
        )

    @app.exception_handler(RequestValidationError)
    async def _validation(_: Request, exc: RequestValidationError) -> JSONResponse:
        campos = [
            {
                "campo": ".".join(str(p) for p in err["loc"][1:]) or str(err["loc"][0]),
                "erro": err["msg"],
            }
            for err in exc.errors()
        ]
        return JSONResponse(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            content={
                "code": "VALIDACAO",
                "message": "Dados inválidos.",
                "detail": {"campos": campos},
            },
        )
