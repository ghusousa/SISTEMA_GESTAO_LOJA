from decimal import Decimal
from enum import StrEnum

from sqlalchemy import Boolean, CheckConstraint, Numeric, String, text
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
        CheckConstraint(
            "comissao_percentual >= 0 AND comissao_percentual <= 100",
            name="comissao_percentual",
        ),
        CheckConstraint("meta_diaria IS NULL OR meta_diaria > 0", name="meta_diaria"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    email: Mapped[str] = mapped_column(String(254), nullable=False, unique=True)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    role: Mapped[str] = mapped_column(String(20), nullable=False, default=Papel.VENDEDOR)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    #: Quanto a pessoa ganha sobre o que vendeu, em % do faturamento LÍQUIDO (venda menos
    #: devolução). Zero é "não ganha comissão", não "ainda não definido" (ADR-37).
    comissao_percentual: Mapped[Decimal] = mapped_column(
        Numeric(5, 2), nullable=False, default=Decimal("0"), server_default=text("0")
    )
    #: Meta de venda por dia. Opcional: sem meta, o PDV não mostra a régua.
    meta_diaria: Mapped[Decimal | None] = mapped_column(Numeric(14, 2))

    @property
    def titulo(self) -> str:
        """Como o cargo aparece para a loja ("Dono", "Vendedora"…)."""
        return TITULO[Papel(self.role)]
