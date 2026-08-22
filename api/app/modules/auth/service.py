import uuid
from datetime import UTC, datetime

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.exceptions import TokenInvalido
from app.core.security import (
    criar_access_token,
    criar_refresh_token,
    decodificar_token,
    validade_refresh,
)
from app.modules.auth.repository import AuthRepository
from app.modules.auth.schemas import TokenOut
from app.modules.usuarios.models import User
from app.modules.usuarios.schemas import UsuarioOut
from app.modules.usuarios.service import UsuarioService


class AuthService:
    def __init__(self, session: AsyncSession):
        self.session = session
        self.repo = AuthRepository(session)
        self.usuarios = UsuarioService(session)  # módulo usa o service público de outro módulo

    async def _emitir(self, user: User, family_id: uuid.UUID) -> TokenOut:
        jti = uuid.uuid4()
        self.repo.registrar(jti, user.id, family_id, validade_refresh())
        return TokenOut(
            access_token=criar_access_token(user.id, user.role),
            refresh_token=criar_refresh_token(user.id, jti, family_id),
            expires_in=settings.access_token_expire_minutes * 60,
            usuario=UsuarioOut.model_validate(user),
        )

    async def login(self, email: str, senha: str) -> TokenOut:
        user = await self.usuarios.autenticar(email, senha)
        tokens = await self._emitir(user, family_id=uuid.uuid4())
        await self.session.commit()
        return tokens

    async def refresh(self, refresh_token: str) -> TokenOut:
        payload = decodificar_token(refresh_token, "refresh")
        jti = uuid.UUID(payload["jti"])
        family_id = uuid.UUID(payload["fam"])

        armazenado = await self.repo.por_jti(jti)
        if armazenado is None:
            raise TokenInvalido()

        if armazenado.revoked:
            # Token já rotacionado reaparecendo: alguém está usando uma cópia. Derruba tudo.
            await self.repo.revogar_familia(family_id)
            await self.session.commit()
            raise TokenInvalido("Sessão encerrada por segurança. Faça login novamente.")

        if armazenado.expires_at <= datetime.now(UTC):
            raise TokenInvalido()

        user = await self.usuarios.obter(armazenado.user_id)
        if not user.is_active:
            raise TokenInvalido("Usuário desativado.")

        await self.repo.revogar(jti)  # rotação: o token usado morre aqui
        tokens = await self._emitir(user, family_id=family_id)
        await self.session.commit()
        return tokens

    async def logout(self, refresh_token: str) -> None:
        """Logout tolerante: token já inválido não é erro, o objetivo é a sessão terminar."""
        try:
            payload = decodificar_token(refresh_token, "refresh")
        except TokenInvalido:
            return
        await self.repo.revogar_familia(uuid.UUID(payload["fam"]))
        await self.session.commit()
