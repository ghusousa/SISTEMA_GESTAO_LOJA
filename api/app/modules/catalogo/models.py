from datetime import datetime
from decimal import Decimal
from enum import StrEnum

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    Sequence,
    SmallInteger,
    String,
    Text,
    func,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.db import Base, TimestampMixin
from app.modules.catalogo.busca import achatar

# Alimenta o código de barras interno (EAN-13 com prefixo 2) das peças sem etiqueta do fornecedor.
internal_barcode_seq = Sequence("internal_barcode_seq", start=1, metadata=Base.metadata)


class TipoCodigo(StrEnum):
    EAN = "EAN"          # etiqueta do fornecedor
    INTERNO = "INTERNO"  # gerado pelo sistema


class Category(Base):
    __tablename__ = "categories"
    __table_args__ = (
        Index(
            "uq_categories_name_active",
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


class Product(Base, TimestampMixin):
    __tablename__ = "products"
    __table_args__ = (
        Index("ix_products_category_id", "category_id"),
        Index("ix_products_name_lower", text("lower(name)")),
        # Trigram sobre o nome ACHATADO (catalogo/busca.py): é o que a busca por nome
        # compara com `LIKE '%calca%'`. Sem ele, cada tecla da busca aplica translate() no
        # catálogo inteiro. A expressão tem de ser a mesma da consulta, letra por letra.
        Index(
            "ix_products_nome_achatado",
            achatar(text("name")).label("nome_achatado"),
            postgresql_using="gin",
            postgresql_ops={"nome_achatado": "gin_trgm_ops"},
        ),
        # Formato dos dados fiscais (ADR-41). Nulo passa: a peça nasce sem NCM e a emissão
        # da NFC-e é quem recusa, listando o que falta — exigir no cadastro travaria a loja
        # que ainda não emite nota. O banco só garante que, preenchido, está no formato.
        CheckConstraint("ncm ~ '^[0-9]{8}$'", name="ncm_formato"),
        CheckConstraint("cest ~ '^[0-9]{7}$'", name="cest_formato"),
        CheckConstraint("origem BETWEEN 0 AND 8", name="origem_faixa"),
        CheckConstraint("cfop ~ '^[0-9]{4}$'", name="cfop_formato"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    category_id: Mapped[int] = mapped_column(
        ForeignKey("categories.id", ondelete="RESTRICT"), nullable=False
    )
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    photo_url: Mapped[str | None] = mapped_column(Text)
    #: Classificação fiscal da mercadoria (8 dígitos, tabela da Receita). Sem ele não há
    #: NFC-e — e é o contador quem diz qual é, não o sistema.
    ncm: Mapped[str | None] = mapped_column(String(8))
    #: Código da substituição tributária (7 dígitos). Só existe para mercadoria com ST.
    cest: Mapped[str | None] = mapped_column(String(7))
    #: Origem da mercadoria (0 = nacional; 1, 2, 3, 8 = importada em graus diferentes).
    origem: Mapped[int] = mapped_column(
        SmallInteger, nullable=False, default=0, server_default=text("0")
    )
    #: CFOP da venda dentro do estado. 5102 = mercadoria comprada de terceiros; 5405 =
    #: com ICMS já recolhido por substituição tributária.
    cfop: Mapped[str] = mapped_column(
        String(4), nullable=False, default="5102", server_default=text("'5102'")
    )
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    category: Mapped[Category] = relationship(lazy="joined")
    variants: Mapped[list["ProductVariant"]] = relationship(
        back_populates="product", lazy="selectin", order_by="ProductVariant.id"
    )


class ProductVariant(Base, TimestampMixin):
    """O que de fato se conta e se vende: produto + tamanho + cor, com código de barras próprio."""

    __tablename__ = "product_variants"
    __table_args__ = (
        CheckConstraint("barcode_type IN ('EAN','INTERNO')", name="barcode_type"),
        CheckConstraint("cost_price >= 0", name="cost_price"),
        CheckConstraint("sale_price > 0", name="sale_price"),
        CheckConstraint("min_stock >= 0", name="min_stock"),
        Index("ix_product_variants_product_id", "product_id"),
        Index(
            "uq_product_variants_barcode_active",
            "barcode",
            unique=True,
            postgresql_where=text("deleted_at IS NULL"),
        ),
        Index(
            "uq_product_variants_combo_active",
            "product_id",
            "size",
            "color",
            unique=True,
            postgresql_where=text("deleted_at IS NULL"),
        ),
        # A busca por nome também acha pela cor ("rose" acha a "Rosé"): mesmo índice do
        # nome do produto, pelo mesmo motivo.
        Index(
            "ix_product_variants_cor_achatada",
            achatar(text("color")).label("cor_achatada"),
            postgresql_using="gin",
            postgresql_ops={"cor_achatada": "gin_trgm_ops"},
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    product_id: Mapped[int] = mapped_column(
        ForeignKey("products.id", ondelete="RESTRICT"), nullable=False
    )
    size: Mapped[str] = mapped_column(String(20), nullable=False)
    color: Mapped[str] = mapped_column(String(40), nullable=False)
    barcode: Mapped[str] = mapped_column(String(32), nullable=False)
    barcode_type: Mapped[str] = mapped_column(String(10), nullable=False, default=TipoCodigo.EAN)
    cost_price: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False)
    sale_price: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False)
    min_stock: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    product: Mapped[Product] = relationship(back_populates="variants")
