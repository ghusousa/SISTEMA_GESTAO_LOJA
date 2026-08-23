from enum import StrEnum

from sqlalchemy import Boolean, CheckConstraint, String
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base, TimestampMixin


class Papel(StrEnum):
    """Os cargos da loja, do mais alto para o mais baixo.

    Os valores gravados são históricos: ADMIN é o dono e VENDEDOR é a vendedora. Ficaram
    como estão porque renomeá-los quebraria os tokens em circulação e o banco de quem já
    instalou, sem nenhum ganho — o nome que a loja vê sai de `TITULO`.

    Quem pode o quê está em `app/core/permissoes.py`, não aqui.
    """

    ADMIN = "ADMIN"
    GERENTE = "GERENTE"
    SUPERVISORA = "SUPERVISORA"
    VENDEDOR = "VENDEDOR"


TITULO: dict[Papel, str] = {
    Papel.ADMIN: "Dono",
    Papel.GERENTE: "Gerente",
    Papel.SUPERVISORA: "Supervisora",
    Papel.VENDEDOR: "Vendedora",
}


class User(Base, TimestampMixin):
    __tablename__ = "users"
    __table_args__ = (
        CheckConstraint(
            "role IN ('ADMIN','GERENTE','SUPERVISORA','VENDEDOR')", name="role"
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    email: Mapped[str] = mapped_column(String(254), nullable=False, unique=True)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    role: Mapped[str] = mapped_column(String(20), nullable=False, default=Papel.VENDEDOR)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)

    @property
    def titulo(self) -> str:
        """Como o cargo aparece para a loja ("Dono", "Vendedora"…)."""
        return TITULO[Papel(self.role)]
