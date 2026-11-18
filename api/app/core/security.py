"""Senhas (bcrypt) e tokens JWT.

bcrypt é usado direto: passlib não recebe manutenção desde 2020 e quebra com bcrypt >= 4.1.
"""

import asyncio
import secrets
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any, Literal

import bcrypt
from jose import JWTError, jwt

from app.core.config import settings
from app.core.exceptions import TokenInvalido, Validacao

# bcrypt ignora silenciosamente o que passa de 72 bytes — recusar é melhor que truncar sem avisar.
MAX_SENHA_BYTES = 72

#: Custo do bcrypt (2^12 rodadas, ~0,3 s por conferência). Lento de propósito: é o que torna
#: cara a força bruta contra um dump roubado.
CUSTO_BCRYPT = 12


def hash_senha(senha: str) -> str:
    dados = senha.encode("utf-8")
    if len(dados) > MAX_SENHA_BYTES:
        raise Validacao("A senha deve ter no máximo 72 bytes.")
    return bcrypt.hashpw(dados, bcrypt.gensalt(rounds=CUSTO_BCRYPT)).decode("utf-8")


def verificar_senha(senha: str, hash_armazenado: str) -> bool:
    dados = senha.encode("utf-8")
    if len(dados) > MAX_SENHA_BYTES:
        return False
    try:
        return bcrypt.checkpw(dados, hash_armazenado.encode("utf-8"))
    except ValueError:
        return False


#: Hash de uma senha que ninguém conhece, com o MESMO custo dos de verdade. Quando o e-mail
#: digitado não existe, a senha é conferida contra ele: o "não existe" passa a levar o mesmo
#: tempo do "senha errada". Sem isso o primeiro respondia em 10 ms e o segundo em 300 ms, e
#: cronometrar o login listava os e-mails da equipe (ADR-24). Calculado ao importar (~0,3 s,
#: uma vez) em vez de colado como texto para acompanhar `CUSTO_BCRYPT` se ele mudar.
HASH_DE_MENTIRA = bcrypt.hashpw(
    secrets.token_urlsafe(24).encode("utf-8"), bcrypt.gensalt(rounds=CUSTO_BCRYPT)
).decode("utf-8")


# As rotas usam as variantes abaixo. bcrypt é CPU pura por ~0,3 s e, chamado direto numa
# rota async, prende o event loop: nesse tempo nenhuma outra requisição anda — PDV, bipagem,
# ping do WebSocket. Uma rajada de 30 logins errados segurava o servidor por ~9 s. Numa
# thread, o loop segue atendendo (o bcrypt solta o GIL enquanto calcula). As síncronas
# continuam para quem não está atendendo requisição (as fixtures dos testes, por exemplo).
async def hash_senha_async(senha: str) -> str:
    return await asyncio.to_thread(hash_senha, senha)


async def verificar_senha_async(senha: str, hash_armazenado: str) -> bool:
    return await asyncio.to_thread(verificar_senha, senha, hash_armazenado)


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
