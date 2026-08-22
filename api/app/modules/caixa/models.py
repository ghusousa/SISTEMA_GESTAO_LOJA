from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import (
    CheckConstraint,
    Computed,
    Date,
    DateTime,
    ForeignKey,
    Numeric,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.db import Base, TimestampMixin


class CashClosing(Base, TimestampMixin):
    """Conferência do dia: o que o sistema esperava por forma de pagamento x o que foi contado.

    É registro de conferência — não bloqueia vendas nem cancelamentos. Refechar o mesmo dia
    atualiza o registro com um novo snapshot do esperado.
    """

    __tablename__ = "cash_closings"

    id: Mapped[int] = mapped_column(primary_key=True)
    closing_date: Mapped[date] = mapped_column(Date, nullable=False, unique=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"), nullable=False)
    note: Mapped[str | None] = mapped_column(Text)
    total_expected: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False, default=0)
    total_counted: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False, default=0)
    difference: Mapped[Decimal] = mapped_column(
        Numeric(14, 2), Computed("total_counted - total_expected", persisted=True)
    )
    closed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    lines: Mapped[list["CashClosingLine"]] = relationship(
        back_populates="closing", lazy="selectin", cascade="all, delete-orphan"
    )


class CashClosingLine(Base):
    __tablename__ = "cash_closing_lines"
    __table_args__ = (
        CheckConstraint("method IN ('DINHEIRO','PIX','DEBITO','CREDITO')", name="method"),
        UniqueConstraint("closing_id", "method", name="closing_id_method"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    closing_id: Mapped[int] = mapped_column(
        ForeignKey("cash_closings.id", ondelete="CASCADE"), nullable=False
    )
    method: Mapped[str] = mapped_column(Text, nullable=False)
    expected_amount: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False, default=0)
    counted_amount: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False, default=0)
    difference: Mapped[Decimal] = mapped_column(
        Numeric(14, 2), Computed("counted_amount - expected_amount", persisted=True)
    )

    closing: Mapped[CashClosing] = relationship(back_populates="lines")
