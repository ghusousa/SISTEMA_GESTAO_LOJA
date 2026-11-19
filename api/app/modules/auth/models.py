import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Index, String, func
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


class LoginAttempt(Base):
    """Cada tentativa de login, para travar força bruta.

    Um atacante que testa senha atrás de senha precisa ser barrado — sem isto, a única
    defesa é o comprimento da senha, e a dona escolhe "loja123". A trava conta as falhas
    recentes por e-mail e por IP numa janela deslizante; passou do teto, o login responde
    429 até a janela liberar. Não bloqueia a conta para sempre: a janela escorrega e o
    acesso volta sozinho — quando quem erra PARA. Quem insiste (uma senha errada a cada
    liberação) mantém o e-mail travado enquanto quiser; por isso a conta pública da
    demonstração, cujo e-mail está nas notas da Apple, trava só pelo IP (ADR-46).

    Guarda o e-mail digitado mesmo quando não existe: é assim que se barra quem fica
    adivinhando e-mails, e não vaza se o e-mail existe ou não (a resposta é a mesma).
    """

    __tablename__ = "login_attempts"
    __table_args__ = (
        Index("ix_login_attempts_email_created_at", "email", "created_at"),
        Index("ix_login_attempts_ip_created_at", "ip", "created_at"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    #: Guardado em minúsculas — a conta é a mesma escrevendo DONA@ ou dona@.
    email: Mapped[str] = mapped_column(String(255), nullable=False)
    ip: Mapped[str | None] = mapped_column(String(64))
    sucesso: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False, index=False
    )
