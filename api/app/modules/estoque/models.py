import uuid
from datetime import datetime
from enum import StrEnum

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    func,
)
from sqlalchemy.dialects.postgresql import UUID as PgUUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.db import Base


class TipoMovimento(StrEnum):
    ENTRADA = "ENTRADA"        # compra / reposição
    AJUSTE = "AJUSTE"          # correção manual com motivo
    INVENTARIO = "INVENTARIO"  # acerto vindo de contagem física
    VENDA = "VENDA"            # baixa do PDV
    ESTORNO = "ESTORNO"        # devolução por cancelamento de venda INTEIRA
    DEVOLUCAO = "DEVOLUCAO"    # peça devolvida pela cliente, venda continua de pé


class StockBalance(Base):
    """Saldo materializado. Só muda junto com uma linha em stock_movements, na mesma transação."""

    __tablename__ = "stock_balances"
    __table_args__ = (CheckConstraint("quantity >= 0", name="quantity"),)

    variant_id: Mapped[int] = mapped_column(
        ForeignKey("product_variants.id", ondelete="CASCADE"), primary_key=True
    )
    quantity: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )


class StockEntry(Base):
    """Cabeçalho de uma entrada (uma compra recebida), agrupando as movimentações bipadas."""

    __tablename__ = "stock_entries"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"), nullable=False)
    supplier: Mapped[str | None] = mapped_column(String(120))
    note: Mapped[str | None] = mapped_column(Text)
    client_uuid: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), nullable=False, unique=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    movements: Mapped[list["StockMovement"]] = relationship(lazy="selectin")


class StockMovement(Base):
    """Append-only: nunca editada nem apagada. É a explicação de todo saldo."""

    __tablename__ = "stock_movements"
    __table_args__ = (
        CheckConstraint(
            "movement_type IN ('ENTRADA','AJUSTE','INVENTARIO','VENDA','ESTORNO','DEVOLUCAO')",
            name="movement_type",
        ),
        CheckConstraint("quantity <> 0", name="quantity"),
        Index("ix_stock_movements_variant_id_created_at", "variant_id", "created_at"),
        Index("ix_stock_movements_sale_id", "sale_id"),
        Index("ix_stock_movements_entry_id", "entry_id"),
        Index("ix_stock_movements_return_id", "return_id"),
        Index("ix_stock_movements_movement_type_created_at", "movement_type", "created_at"),
        # O extrato filtra por período (`created_at >= inicio AND < fim`, ADR-27) e conta o
        # total: sem índice na coluna crua, contar um mês lia o histórico inteiro.
        Index("ix_stock_movements_created_at", "created_at"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    variant_id: Mapped[int] = mapped_column(
        ForeignKey("product_variants.id", ondelete="RESTRICT"), nullable=False
    )
    movement_type: Mapped[str] = mapped_column(String(12), nullable=False)
    quantity: Mapped[int] = mapped_column(Integer, nullable=False)  # com sinal
    balance_after: Mapped[int] = mapped_column(Integer, nullable=False)
    entry_id: Mapped[int | None] = mapped_column(
        ForeignKey("stock_entries.id", ondelete="RESTRICT")
    )
    sale_id: Mapped[int | None] = mapped_column(ForeignKey("sales.id", ondelete="RESTRICT"))
    #: De qual devolução veio. Sem isto o extrato mostra "+1 DEVOLUCAO" sem dizer de
    #: qual peça devolvida por quem — e conferir uma diferença de estoque vira pesquisa.
    return_id: Mapped[int | None] = mapped_column(
        ForeignKey("sale_returns.id", ondelete="RESTRICT")
    )
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"), nullable=False)
    note: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
