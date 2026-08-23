"""Clientes e crediário — o "fiado" da caderneta, dentro do sistema.

Existe por um motivo só: numa loja de bairro parte da venda sai sem dinheiro na hora. Isso
já acontecia; o que não existia era o registro. Caderneta perdida é venda perdida, e
ninguém cobra o que não sabe que tem a receber.

**Fiado não é dinheiro do dia.** A venda é faturamento hoje (competência), mas a gaveta não
recebeu nada — quem confunde as duas coisas fecha o caixa com falta todo dia em que vender
fiado. Ver `FORMAS_DE_GAVETA` em `vendas/models.py`.
"""

import uuid
from datetime import datetime
from decimal import Decimal

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Numeric,
    String,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import UUID as PgUUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base, TimestampMixin
from app.modules.vendas.models import _GAVETA


class Customer(Base, TimestampMixin):
    __tablename__ = "customers"
    __table_args__ = (
        CheckConstraint("credit_limit IS NULL OR credit_limit >= 0", name="credit_limit"),
        # UNIQUE parcial na convenção do projeto: dois cadastros do mesmo CPF viram duas
        # dívidas da mesma pessoa, e nenhuma das duas fecha com o que ela deve.
        Index(
            "uq_customers_document_active",
            "document",
            unique=True,
            postgresql_where=text("deleted_at IS NULL AND document IS NOT NULL"),
        ),
        Index(
            "uq_customers_phone_active",
            "phone",
            unique=True,
            postgresql_where=text("deleted_at IS NULL AND phone IS NOT NULL"),
        ),
        Index("ix_customers_name", "name"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    #: Guardado só com dígitos, para "(11) 99999-8888" e "11999998888" serem a mesma pessoa.
    phone: Mapped[str | None] = mapped_column(String(20))
    document: Mapped[str | None] = mapped_column(String(20))
    #: Combinado com a cliente. **Avisa, não bloqueia** (ADR-20): a dona conhece a freguesa
    #: melhor que o sistema, e uma trava aqui só ensina a vender por fora do sistema — e aí
    #: a dívida some da conta de verdade.
    credit_limit: Mapped[Decimal | None] = mapped_column(Numeric(14, 2))
    note: Mapped[str | None] = mapped_column(Text)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class CustomerPayment(Base):
    """A cliente veio pagar o que devia. ISTO é dinheiro na gaveta, no dia em que acontece."""

    __tablename__ = "customer_payments"
    __table_args__ = (
        CheckConstraint(f"method IN ('{_GAVETA}')", name="method"),
        CheckConstraint("amount > 0", name="amount"),
        # Receber no meio da rua, com o sinal caindo, é justamente onde o retry duplica —
        # e aqui duplicar significa perdoar uma dívida que ninguém pagou.
        UniqueConstraint("client_uuid", name="client_uuid"),
        Index("ix_customer_payments_customer_id", "customer_id"),
        Index("ix_customer_payments_paid_at", "paid_at"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    customer_id: Mapped[int] = mapped_column(
        ForeignKey("customers.id", ondelete="RESTRICT"), nullable=False
    )
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"), nullable=False)
    method: Mapped[str] = mapped_column(String(10), nullable=False)
    amount: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False)
    paid_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    client_uuid: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), nullable=False
    )
    note: Mapped[str | None] = mapped_column(Text)
