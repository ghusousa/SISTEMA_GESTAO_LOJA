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


def registrar_handlers(app: FastAPI) -> None:
    @app.exception_handler(AppError)
    async def _app_error(_: Request, exc: AppError) -> JSONResponse:
        return JSONResponse(
            status_code=exc.http_status,
            content={"code": exc.code, "message": exc.message, "detail": exc.detail},
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
