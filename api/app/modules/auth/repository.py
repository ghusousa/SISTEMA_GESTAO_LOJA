import uuid
from datetime import datetime

from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.auth.models import RefreshToken


class AuthRepository:
    def __init__(self, session: AsyncSession):
        self.session = session

    async def por_jti(self, jti: uuid.UUID) -> RefreshToken | None:
        return await self.session.get(RefreshToken, jti)

    def registrar(
        self, jti: uuid.UUID, user_id: int, family_id: uuid.UUID, expires_at: datetime
    ) -> RefreshToken:
        token = RefreshToken(
            jti=jti, user_id=user_id, family_id=family_id, expires_at=expires_at
        )
        self.session.add(token)
        return token

    async def revogar(self, jti: uuid.UUID) -> None:
        await self.session.execute(
            update(RefreshToken).where(RefreshToken.jti == jti).values(revoked=True)
        )

    async def revogar_familia(self, family_id: uuid.UUID) -> None:
        """Reuso de token rotacionado = provável roubo: derruba a cadeia inteira."""
        await self.session.execute(
            update(RefreshToken)
            .where(RefreshToken.family_id == family_id, RefreshToken.revoked.is_(False))
            .values(revoked=True)
        )

    async def limpar_expirados(self, agora: datetime) -> int:
        from sqlalchemy import delete

        resultado = await self.session.execute(
            delete(RefreshToken).where(RefreshToken.expires_at < agora)
        )
        return resultado.rowcount or 0
