from enum import StrEnum

from sqlalchemy import Boolean, CheckConstraint, String
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base, TimestampMixin


class Papel(StrEnum):
    ADMIN = "ADMIN"
    VENDEDOR = "VENDEDOR"


class User(Base, TimestampMixin):
    __tablename__ = "users"
    __table_args__ = (
        CheckConstraint("role IN ('ADMIN','VENDEDOR')", name="role"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    email: Mapped[str] = mapped_column(String(254), nullable=False, unique=True)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    role: Mapped[str] = mapped_column(String(20), nullable=False, default=Papel.VENDEDOR)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)

    @property
    def is_admin(self) -> bool:
        return self.role == Papel.ADMIN
