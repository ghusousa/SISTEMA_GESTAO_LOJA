import uuid
from datetime import datetime
from decimal import Decimal
from enum import StrEnum

from sqlalchemy import (
    CheckConstraint,
    Computed,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    Text,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import UUID as PgUUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.config import settings
from app.core.db import Base


class StatusVenda(StrEnum):
    CONCLUIDA = "CONCLUIDA"
    CANCELADA = "CANCELADA"


class FormaPagamento(StrEnum):
    DINHEIRO = "DINHEIRO"
    PIX = "PIX"
    DEBITO = "DEBITO"
    CREDITO = "CREDITO"


class Sale(Base):
    __tablename__ = "sales"
    __table_args__ = (
        CheckConstraint("status IN ('CONCLUIDA','CANCELADA')", name="status"),
        CheckConstraint("subtotal >= 0 AND discount >= 0 AND total >= 0", name="amounts"),
        CheckConstraint("discount <= subtotal", name="discount_max"),
        CheckConstraint("total = subtotal - discount", name="total_math"),
        CheckConstraint(
            "(status = 'CANCELADA' AND cancelled_at IS NOT NULL AND cancelled_by_id IS NOT NULL)"
            " OR (status = 'CONCLUIDA' AND cancelled_at IS NULL AND cancelled_by_id IS NULL)",
            name="cancel_consistency",
        ),
        Index("ix_sales_sold_at", "sold_at"),
        Index("ix_sales_seller_id", "seller_id"),
        Index("ix_sales_status_sold_at", "status", "sold_at"),
        # "Dia" do comércio no fuso da loja: usado por relatórios e fechamento de caixa.
        Index(
            "ix_sales_business_date",
            text(f"((sold_at AT TIME ZONE '{settings.timezone_loja}')::date)"),
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    seller_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
    status: Mapped[str] = mapped_column(String(10), nullable=False, default=StatusVenda.CONCLUIDA)
    subtotal: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False)
    discount: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False, default=0)
    total: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False)
    sold_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    cancelled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    cancelled_by_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT")
    )
    cancel_reason: Mapped[str | None] = mapped_column(Text)
    # Chave de idempotência gerada pelo app: retry de rede não vira venda duplicada.
    client_uuid: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), nullable=False, unique=True
    )
    note: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    items: Mapped[list["SaleItem"]] = relationship(
        back_populates="sale", lazy="selectin", cascade="all, delete-orphan"
    )
    payments: Mapped[list["SalePayment"]] = relationship(
        back_populates="sale", lazy="selectin", cascade="all, delete-orphan"
    )


class SaleItem(Base):
    """Preço e custo congelados: reajuste de amanhã não reescreve o lucro de ontem."""

    __tablename__ = "sale_items"
    __table_args__ = (
        CheckConstraint("quantity > 0", name="quantity"),
        CheckConstraint("unit_price >= 0 AND unit_cost >= 0", name="prices"),
        Index("ix_sale_items_sale_id", "sale_id"),
        Index("ix_sale_items_variant_id", "variant_id"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    sale_id: Mapped[int] = mapped_column(ForeignKey("sales.id", ondelete="CASCADE"), nullable=False)
    variant_id: Mapped[int] = mapped_column(
        ForeignKey("product_variants.id", ondelete="RESTRICT"), nullable=False
    )
    quantity: Mapped[int] = mapped_column(Integer, nullable=False)
    unit_price: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False)
    unit_cost: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False)
    line_total: Mapped[Decimal] = mapped_column(
        Numeric(14, 2), Computed("unit_price * quantity", persisted=True)
    )

    sale: Mapped[Sale] = relationship(back_populates="items")


class SalePayment(Base):
    __tablename__ = "sale_payments"
    __table_args__ = (
        CheckConstraint("method IN ('DINHEIRO','PIX','DEBITO','CREDITO')", name="method"),
        CheckConstraint("amount > 0", name="amount"),
        Index("ix_sale_payments_sale_id", "sale_id"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    sale_id: Mapped[int] = mapped_column(ForeignKey("sales.id", ondelete="CASCADE"), nullable=False)
    method: Mapped[str] = mapped_column(String(10), nullable=False)
    amount: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False)

    sale: Mapped[Sale] = relationship(back_populates="payments")
