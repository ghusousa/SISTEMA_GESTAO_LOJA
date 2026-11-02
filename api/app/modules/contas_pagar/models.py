"""Contas a pagar do fornecedor — a coleção comprada em 30/60/90 (ADR-40).

**Não é despesa, e não entra no Resultado.** O Resultado já desconta a mercadoria pelo CMV,
no dia em que a peça é VENDIDA. Lançar o boleto do fornecedor em Despesas contava o mesmo
custo duas vezes: uma no CMV, outra na despesa — e o lucro do mês despencava sem aviso.
Aqui fica só o que a loja DEVE e QUANDO vence: é o calendário de saída de dinheiro, não o
custo do mês.
"""

import uuid
from datetime import date, datetime
from decimal import Decimal
from enum import StrEnum

from sqlalchemy import (
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Numeric,
    SmallInteger,
    String,
    Text,
    text,
)
from sqlalchemy.dialects.postgresql import UUID as PgUUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base, TimestampMixin


class FormaPagamentoConta(StrEnum):
    """Como a LOJA pagou o fornecedor — não é a forma de pagamento do PDV.

    Boleto e transferência não existem no balcão; vale e fiado não existem aqui. Pagar em
    dinheiro NÃO mexe na conferência do caixa: sangria é decisão de produto em aberto.
    """

    BOLETO = "BOLETO"
    PIX = "PIX"
    TRANSFERENCIA = "TRANSFERENCIA"
    DINHEIRO = "DINHEIRO"
    CARTAO = "CARTAO"


_FORMAS = "','".join(FormaPagamentoConta)


class Payable(Base, TimestampMixin):
    """Uma parcela que a loja deve a um fornecedor."""

    __tablename__ = "payables"
    __table_args__ = (
        CheckConstraint("amount > 0", name="amount"),
        CheckConstraint(f"payment_method IN ('{_FORMAS}')", name="payment_method"),
        # Paga é paga por inteiro: dia, forma e quem marcou andam juntos. Meio pagamento
        # (dia sem forma) deixaria a conta fora das abertas E fora de qualquer conferência.
        CheckConstraint(
            "(paid_on IS NULL AND payment_method IS NULL AND paid_by_id IS NULL)"
            " OR (paid_on IS NOT NULL AND payment_method IS NOT NULL AND paid_by_id IS NOT NULL)",
            name="paid_consistency",
        ),
        CheckConstraint(
            "installment_number >= 1 AND installment_number <= installment_count",
            name="installment",
        ),
        # A tela de contas abre nas ABERTAS por vencimento: índice só delas, que é a fatia
        # que cresce devagar — a de pagas cresce para sempre.
        Index(
            "ix_payables_open_due_date",
            "due_date",
            postgresql_where=text("paid_on IS NULL AND deleted_at IS NULL"),
        ),
        Index("ix_payables_paid_on", "paid_on"),
        Index("ix_payables_entry_id", "entry_id"),
        # Idempotência: a mesma Entrada (ou o mesmo lançamento avulso) reenviada não cria a
        # parcela 2 duas vezes. Cada parcela é única dentro do pedido que a criou.
        Index(
            "uq_payables_entry_id_installment_number",
            "entry_id",
            "installment_number",
            unique=True,
            postgresql_where=text("entry_id IS NOT NULL"),
        ),
        Index(
            "uq_payables_client_uuid_installment_number",
            "client_uuid",
            "installment_number",
            unique=True,
            postgresql_where=text("client_uuid IS NOT NULL"),
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    supplier: Mapped[str] = mapped_column(String(120), nullable=False)
    description: Mapped[str] = mapped_column(String(160), nullable=False)
    invoice_number: Mapped[str | None] = mapped_column(String(40))
    amount: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False)
    #: Dia de calendário, como `expenses.expense_date`: nunca passa por fuso (core/datas.py).
    due_date: Mapped[date] = mapped_column(Date, nullable=False)
    paid_on: Mapped[date | None] = mapped_column(Date)
    payment_method: Mapped[str | None] = mapped_column(String(13))
    installment_number: Mapped[int] = mapped_column(SmallInteger, nullable=False, default=1)
    installment_count: Mapped[int] = mapped_column(SmallInteger, nullable=False, default=1)
    #: A Entrada que trouxe a mercadoria desta nota. Vazio no lançamento avulso.
    entry_id: Mapped[int | None] = mapped_column(
        ForeignKey("stock_entries.id", ondelete="RESTRICT")
    )
    #: Chave do lançamento avulso (a Entrada usa a dela, pelo `entry_id`).
    client_uuid: Mapped[uuid.UUID | None] = mapped_column(PgUUID(as_uuid=True))
    note: Mapped[str | None] = mapped_column(Text)
    created_by_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
    paid_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"))
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
