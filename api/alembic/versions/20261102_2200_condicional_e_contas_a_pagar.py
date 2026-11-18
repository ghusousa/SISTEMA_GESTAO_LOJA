"""condicional e contas a pagar do fornecedor (ADR-39, ADR-40)

- `consignments` / `consignment_items`: a peça que vai para a casa da cliente provar. Sai do
  saldo por um movimento novo, `CONDICIONAL_SAIDA`, e volta por `CONDICIONAL_RETORNO`.
- `stock_movements.movement_type` cresce de 12 para 20 caracteres (o nome mais longo,
  CONDICIONAL_RETORNO, tem 19) e o CHECK ganha os dois tipos; `consignment_id` liga o
  movimento à condicional, como `return_id` liga à devolução.
- `payables`: o que a loja deve ao fornecedor e quando vence. Fora do Resultado: o CMV já
  conta a mercadoria.

O tipo de movimento é texto com CHECK (não enum do Postgres), então o downgrade recria o
CHECK antigo em vez de esbarrar no `ALTER TYPE ... DROP VALUE` que não existe. O limite
está em outro lugar: o extrato é append-only, e um movimento de condicional não cabe no
CHECK antigo — apagar o histórico para descer de versão seria pior que não descer. Por isso
o downgrade RECUSA se a loja já usou a condicional, dizendo o porquê.

Revision ID: b3c4d5e6f703
Revises: b2c3d4e5f602
Create Date: 2026-11-02 22:00:00.000000+00:00
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "b3c4d5e6f703"
down_revision: str | None = "b2c3d4e5f602"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Fotografia dos tipos nesta revisão (a migration não importa o app).
_TIPOS_ANTES = "'ENTRADA','AJUSTE','INVENTARIO','VENDA','ESTORNO','DEVOLUCAO'"
_TIPOS_DEPOIS = _TIPOS_ANTES + ",'CONDICIONAL_SAIDA','CONDICIONAL_RETORNO'"


def upgrade() -> None:
    op.create_table(
        "consignments",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("customer_id", sa.Integer(), nullable=False),
        sa.Column("seller_id", sa.Integer(), nullable=False),
        sa.Column("due_date", sa.Date(), nullable=False),
        sa.Column("status", sa.String(length=8), nullable=False),
        sa.Column("client_uuid", sa.UUID(), nullable=False),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("closed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("closed_by_id", sa.Integer(), nullable=True),
        sa.Column("closing_uuid", sa.UUID(), nullable=True),
        sa.Column("sale_id", sa.Integer(), nullable=True),
        sa.CheckConstraint(
            "(status = 'ABERTA' AND closed_at IS NULL AND closed_by_id IS NULL"
            " AND closing_uuid IS NULL AND sale_id IS NULL)"
            " OR (status = 'FECHADA' AND closed_at IS NOT NULL AND closed_by_id IS NOT NULL"
            " AND closing_uuid IS NOT NULL)",
            name=op.f("ck_consignments_close_consistency"),
        ),
        sa.CheckConstraint("status IN ('ABERTA','FECHADA')", name=op.f("ck_consignments_status")),
        sa.ForeignKeyConstraint(
            ["closed_by_id"],
            ["users.id"],
            name=op.f("fk_consignments_closed_by_id_users"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["customer_id"],
            ["customers.id"],
            name=op.f("fk_consignments_customer_id_customers"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["sale_id"],
            ["sales.id"],
            name=op.f("fk_consignments_sale_id_sales"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["seller_id"],
            ["users.id"],
            name=op.f("fk_consignments_seller_id_users"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_consignments")),
        sa.UniqueConstraint("client_uuid", name=op.f("uq_consignments_client_uuid")),
        sa.UniqueConstraint("closing_uuid", name=op.f("uq_consignments_closing_uuid")),
        sa.UniqueConstraint("sale_id", name=op.f("uq_consignments_sale_id")),
    )
    op.create_index("ix_consignments_customer_id", "consignments", ["customer_id"])
    op.create_index(
        "ix_consignments_open_due_date",
        "consignments",
        ["due_date"],
        postgresql_where=sa.text("status = 'ABERTA'"),
    )

    op.create_table(
        "consignment_items",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("consignment_id", sa.Integer(), nullable=False),
        sa.Column("variant_id", sa.Integer(), nullable=False),
        sa.Column("quantity", sa.Integer(), nullable=False),
        sa.Column("returned_quantity", sa.Integer(), nullable=True),
        sa.CheckConstraint("quantity > 0", name=op.f("ck_consignment_items_quantity")),
        sa.CheckConstraint(
            "returned_quantity IS NULL"
            " OR (returned_quantity >= 0 AND returned_quantity <= quantity)",
            name=op.f("ck_consignment_items_returned_quantity"),
        ),
        sa.ForeignKeyConstraint(
            ["consignment_id"],
            ["consignments.id"],
            name=op.f("fk_consignment_items_consignment_id_consignments"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["variant_id"],
            ["product_variants.id"],
            name=op.f("fk_consignment_items_variant_id_product_variants"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_consignment_items")),
        sa.UniqueConstraint(
            "consignment_id",
            "variant_id",
            name=op.f("uq_consignment_items_consignment_id_variant_id"),
        ),
    )
    op.create_index("ix_consignment_items_variant_id", "consignment_items", ["variant_id"])

    op.create_table(
        "payables",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("supplier", sa.String(length=120), nullable=False),
        sa.Column("description", sa.String(length=160), nullable=False),
        sa.Column("invoice_number", sa.String(length=40), nullable=True),
        sa.Column("amount", sa.Numeric(precision=14, scale=2), nullable=False),
        sa.Column("due_date", sa.Date(), nullable=False),
        sa.Column("paid_on", sa.Date(), nullable=True),
        sa.Column("payment_method", sa.String(length=13), nullable=True),
        sa.Column("installment_number", sa.SmallInteger(), nullable=False),
        sa.Column("installment_count", sa.SmallInteger(), nullable=False),
        sa.Column("entry_id", sa.Integer(), nullable=True),
        sa.Column("client_uuid", sa.UUID(), nullable=True),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("created_by_id", sa.Integer(), nullable=False),
        sa.Column("paid_by_id", sa.Integer(), nullable=True),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "payment_method IN ('BOLETO','PIX','TRANSFERENCIA','DINHEIRO','CARTAO')",
            name=op.f("ck_payables_payment_method"),
        ),
        sa.CheckConstraint(
            "(paid_on IS NULL AND payment_method IS NULL AND paid_by_id IS NULL)"
            " OR (paid_on IS NOT NULL AND payment_method IS NOT NULL AND paid_by_id IS NOT NULL)",
            name=op.f("ck_payables_paid_consistency"),
        ),
        sa.CheckConstraint("amount > 0", name=op.f("ck_payables_amount")),
        sa.CheckConstraint(
            "installment_number >= 1 AND installment_number <= installment_count",
            name=op.f("ck_payables_installment"),
        ),
        sa.ForeignKeyConstraint(
            ["created_by_id"],
            ["users.id"],
            name=op.f("fk_payables_created_by_id_users"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["entry_id"],
            ["stock_entries.id"],
            name=op.f("fk_payables_entry_id_stock_entries"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["paid_by_id"],
            ["users.id"],
            name=op.f("fk_payables_paid_by_id_users"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_payables")),
    )
    op.create_index("ix_payables_entry_id", "payables", ["entry_id"])
    op.create_index(
        "ix_payables_open_due_date",
        "payables",
        ["due_date"],
        postgresql_where=sa.text("paid_on IS NULL AND deleted_at IS NULL"),
    )
    op.create_index("ix_payables_paid_on", "payables", ["paid_on"])
    op.create_index(
        "uq_payables_client_uuid_installment_number",
        "payables",
        ["client_uuid", "installment_number"],
        unique=True,
        postgresql_where=sa.text("client_uuid IS NOT NULL"),
    )
    op.create_index(
        "uq_payables_entry_id_installment_number",
        "payables",
        ["entry_id", "installment_number"],
        unique=True,
        postgresql_where=sa.text("entry_id IS NOT NULL"),
    )

    # Extrato: dois tipos novos, coluna mais larga e o vínculo com a condicional.
    op.alter_column(
        "stock_movements",
        "movement_type",
        existing_type=sa.VARCHAR(length=12),
        type_=sa.String(length=20),
        existing_nullable=False,
    )
    # Nome curto: a convenção de nomes do metadata vira "ck_stock_movements_movement_type".
    op.drop_constraint("movement_type", "stock_movements", type_="check")
    op.create_check_constraint(
        "movement_type",
        "stock_movements",
        f"movement_type IN ({_TIPOS_DEPOIS})",
    )
    op.add_column("stock_movements", sa.Column("consignment_id", sa.Integer(), nullable=True))
    op.create_index("ix_stock_movements_consignment_id", "stock_movements", ["consignment_id"])
    op.create_foreign_key(
        op.f("fk_stock_movements_consignment_id_consignments"),
        "stock_movements",
        "consignments",
        ["consignment_id"],
        ["id"],
        ondelete="RESTRICT",
    )


def downgrade() -> None:
    usados = (
        op.get_bind()
        .execute(
            sa.text(
                "SELECT count(*) FROM stock_movements"
                " WHERE movement_type IN ('CONDICIONAL_SAIDA','CONDICIONAL_RETORNO')"
            )
        )
        .scalar_one()
    )
    if usados:
        raise RuntimeError(
            f"A loja já tem {usados} movimento(s) de condicional no extrato, e o extrato não "
            "se apaga. Descer desta versão exigiria reescrever o histórico de estoque: "
            "restaure o backup anterior à atualização em vez de fazer downgrade."
        )

    op.drop_constraint(
        op.f("fk_stock_movements_consignment_id_consignments"),
        "stock_movements",
        type_="foreignkey",
    )
    op.drop_index("ix_stock_movements_consignment_id", table_name="stock_movements")
    op.drop_column("stock_movements", "consignment_id")
    # Nome curto: a convenção de nomes do metadata vira "ck_stock_movements_movement_type".
    op.drop_constraint("movement_type", "stock_movements", type_="check")
    op.create_check_constraint(
        "movement_type",
        "stock_movements",
        f"movement_type IN ({_TIPOS_ANTES})",
    )
    op.alter_column(
        "stock_movements",
        "movement_type",
        existing_type=sa.String(length=20),
        type_=sa.VARCHAR(length=12),
        existing_nullable=False,
    )

    op.drop_index("uq_payables_entry_id_installment_number", table_name="payables")
    op.drop_index("uq_payables_client_uuid_installment_number", table_name="payables")
    op.drop_index("ix_payables_paid_on", table_name="payables")
    op.drop_index("ix_payables_open_due_date", table_name="payables")
    op.drop_index("ix_payables_entry_id", table_name="payables")
    op.drop_table("payables")

    op.drop_index("ix_consignment_items_variant_id", table_name="consignment_items")
    op.drop_table("consignment_items")
    op.drop_index("ix_consignments_open_due_date", table_name="consignments")
    op.drop_index("ix_consignments_customer_id", table_name="consignments")
    op.drop_table("consignments")
