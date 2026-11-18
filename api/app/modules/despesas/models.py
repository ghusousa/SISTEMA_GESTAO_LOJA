from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Computed,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Numeric,
    String,
    Text,
    func,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.db import Base, TimestampMixin

#: O índice que segura a réplica duplicada. O service reconhece a colisão pelo nome.
UQ_RECORRENCIA = "uq_expenses_recurring_source_competencia"


class ExpenseCategory(Base):
    __tablename__ = "expense_categories"
    __table_args__ = (
        Index(
            "uq_expense_categories_name_active",
            text("lower(name)"),
            unique=True,
            postgresql_where=text("deleted_at IS NULL"),
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(80), nullable=False)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class Expense(Base, TimestampMixin):
    __tablename__ = "expenses"
    __table_args__ = (
        CheckConstraint("amount > 0", name="amount"),
        # Replicar as recorrentes do mês duas vezes não duplica o aluguel. Parcial, como todo
        # soft delete: a réplica excluída não pode continuar ocupando o mês, senão "Lançar
        # fixas" nunca mais traz aquele aluguel de volta.
        Index(
            UQ_RECORRENCIA,
            "recurring_source_id",
            "competencia",
            unique=True,
            postgresql_where=text("deleted_at IS NULL"),
        ),
        Index("ix_expenses_expense_date", "expense_date"),
        Index("ix_expenses_category_id", "category_id"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    category_id: Mapped[int] = mapped_column(
        ForeignKey("expense_categories.id", ondelete="RESTRICT"), nullable=False
    )
    description: Mapped[str] = mapped_column(String(160), nullable=False)
    amount: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False)
    expense_date: Mapped[date] = mapped_column(Date, nullable=False)
    # O cast para `timestamp` é obrigatório: date_trunc sobre `date` resolve para a variante
    # timestamptz, que é STABLE — e o Postgres recusa expressão não imutável em coluna gerada.
    competencia: Mapped[date] = mapped_column(
        Date, Computed("date_trunc('month', expense_date::timestamp)::date", persisted=True)
    )
    is_recurring: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    note: Mapped[str | None] = mapped_column(Text)
    recurring_source_id: Mapped[int | None] = mapped_column(
        ForeignKey("expenses.id", ondelete="SET NULL")
    )
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    category: Mapped[ExpenseCategory] = relationship(lazy="joined")
