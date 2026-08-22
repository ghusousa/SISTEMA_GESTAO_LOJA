import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Index, func
from sqlalchemy.dialects.postgresql import UUID as PgUUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base


class RefreshToken(Base):
    """Refresh token persistido: permite revogar de verdade (logout) e detectar reuso.

    `family_id` agrupa a cadeia de rotações de um login. Se um token já rotacionado
    reaparece, a família inteira é revogada — é a assinatura de token roubado.
    """

    __tablename__ = "refresh_tokens"
    __table_args__ = (
        Index("ix_refresh_tokens_user_id", "user_id"),
        Index("ix_refresh_tokens_family_id", "family_id"),
        Index("ix_refresh_tokens_expires_at", "expires_at"),
    )

    jti: Mapped[uuid.UUID] = mapped_column(PgUUID(as_uuid=True), primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    family_id: Mapped[uuid.UUID] = mapped_column(PgUUID(as_uuid=True), nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    revoked: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
