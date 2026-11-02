"""Condicional: a peça que vai para a casa da cliente provar (ADR-39).

Sem isto a peça continuava "disponível": podia ser vendida de novo no balcão enquanto
estava no guarda-roupa da cliente, ou a vendedora simulava venda + devolução — e sujava o
faturamento, a taxa de devolução e o caixa. Aqui a saída tira a peça do saldo
(`CONDICIONAL_SAIDA`), e o fechamento devolve TUDO (`CONDICIONAL_RETORNO`) e registra o que
ficou como uma venda comum, pelo serviço de vendas: um caminho de venda só.
"""

import uuid
from datetime import date, datetime
from enum import StrEnum

from sqlalchemy import (
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import UUID as PgUUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.db import Base


class StatusCondicional(StrEnum):
    ABERTA = "ABERTA"
    FECHADA = "FECHADA"


class Consignment(Base):
    """Uma condicional: quem levou, até quando, e — depois de fechada — no que deu."""

    __tablename__ = "consignments"
    __table_args__ = (
        CheckConstraint("status IN ('ABERTA','FECHADA')", name="status"),
        # Fechar é um ato inteiro: quem, quando e com qual chave. Venda só existe depois
        # de fechada (e só se algo ficou com a cliente).
        CheckConstraint(
            "(status = 'ABERTA' AND closed_at IS NULL AND closed_by_id IS NULL"
            " AND closing_uuid IS NULL AND sale_id IS NULL)"
            " OR (status = 'FECHADA' AND closed_at IS NOT NULL AND closed_by_id IS NOT NULL"
            " AND closing_uuid IS NOT NULL)",
            name="close_consistency",
        ),
        # "Quem está com o quê" e "quem já devia ter devolvido": as abertas por prazo.
        Index(
            "ix_consignments_open_due_date",
            "due_date",
            postgresql_where=text("status = 'ABERTA'"),
        ),
        Index("ix_consignments_customer_id", "customer_id"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    customer_id: Mapped[int] = mapped_column(
        ForeignKey("customers.id", ondelete="RESTRICT"), nullable=False
    )
    #: Quem abriu (atendeu a cliente).
    seller_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
    #: Dia de calendário combinado com a cliente. Vence no dia SEGUINTE a este, no dia da
    #: loja — nunca no do servidor (core/datas.py).
    due_date: Mapped[date] = mapped_column(Date, nullable=False)
    status: Mapped[str] = mapped_column(String(8), nullable=False, default=StatusCondicional.ABERTA)
    client_uuid: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), nullable=False, unique=True
    )
    note: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    closed_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"))
    #: Chave do FECHAMENTO. É também a chave da venda que ele registra: o reenvio do
    #: fechamento não cobra a cliente duas vezes.
    closing_uuid: Mapped[uuid.UUID | None] = mapped_column(PgUUID(as_uuid=True), unique=True)
    #: A venda do que ficou com a cliente. Vazia se tudo voltou.
    sale_id: Mapped[int | None] = mapped_column(
        ForeignKey("sales.id", ondelete="RESTRICT"), unique=True
    )

    items: Mapped[list["ConsignmentItem"]] = relationship(
        lazy="selectin", order_by="ConsignmentItem.id"
    )


class ConsignmentItem(Base):
    __tablename__ = "consignment_items"
    __table_args__ = (
        CheckConstraint("quantity > 0", name="quantity"),
        CheckConstraint(
            "returned_quantity IS NULL"
            " OR (returned_quantity >= 0 AND returned_quantity <= quantity)",
            name="returned_quantity",
        ),
        UniqueConstraint("consignment_id", "variant_id"),
        Index("ix_consignment_items_variant_id", "variant_id"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    consignment_id: Mapped[int] = mapped_column(
        ForeignKey("consignments.id", ondelete="CASCADE"), nullable=False
    )
    variant_id: Mapped[int] = mapped_column(
        ForeignKey("product_variants.id", ondelete="RESTRICT"), nullable=False
    )
    quantity: Mapped[int] = mapped_column(Integer, nullable=False)
    #: Quanto voltou, preenchido no fechamento. O que ficou é `quantity - returned_quantity`.
    returned_quantity: Mapped[int | None] = mapped_column(Integer)
