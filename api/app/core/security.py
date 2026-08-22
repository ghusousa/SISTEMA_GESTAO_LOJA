"""Senhas (bcrypt) e tokens JWT.

bcrypt é usado direto: passlib não recebe manutenção desde 2020 e quebra com bcrypt >= 4.1.
"""

import uuid
from datetime import UTC, datetime, timedelta
from typing import Any, Literal

import bcrypt
from jose import JWTError, jwt

from app.core.config import settings
from app.core.exceptions import TokenInvalido, Validacao

# bcrypt ignora silenciosamente o que passa de 72 bytes — recusar é melhor que truncar sem avisar.
MAX_SENHA_BYTES = 72


def hash_senha(senha: str) -> str:
    dados = senha.encode("utf-8")
    if len(dados) > MAX_SENHA_BYTES:
        raise Validacao("A senha deve ter no máximo 72 bytes.")
    return bcrypt.hashpw(dados, bcrypt.gensalt(rounds=12)).decode("utf-8")


def verificar_senha(senha: str, hash_armazenado: str) -> bool:
    dados = senha.encode("utf-8")
    if len(dados) > MAX_SENHA_BYTES:
        return False
    try:
        return bcrypt.checkpw(dados, hash_armazenado.encode("utf-8"))
    except ValueError:
        return False


def _criar_token(payload: dict[str, Any], expira_em: timedelta) -> str:
    agora = datetime.now(UTC)
    dados = {**payload, "iat": agora, "exp": agora + expira_em}
    return jwt.encode(dados, settings.jwt_secret, algorithm=settings.jwt_algorithm)


def criar_access_token(user_id: int, role: str) -> str:
    return _criar_token(
        {"sub": str(user_id), "role": role, "type": "access"},
        timedelta(minutes=settings.access_token_expire_minutes),
    )


def criar_refresh_token(user_id: int, jti: uuid.UUID, family_id: uuid.UUID) -> str:
    return _criar_token(
        {
            "sub": str(user_id),
            "jti": str(jti),
            "fam": str(family_id),
            "type": "refresh",
        },
        timedelta(days=settings.refresh_token_expire_days),
    )


def decodificar_token(token: str, tipo: Literal["access", "refresh"]) -> dict[str, Any]:
    try:
        payload = jwt.decode(token, settings.jwt_secret, algorithms=[settings.jwt_algorithm])
    except JWTError as exc:
        raise TokenInvalido() from exc
    if payload.get("type") != tipo:
        raise TokenInvalido()
    return payload


def validade_refresh() -> datetime:
    return datetime.now(UTC) + timedelta(days=settings.refresh_token_expire_days)
