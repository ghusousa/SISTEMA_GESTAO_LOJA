"""celular como leitor de código de barras do computador (ADR-43)

- `leitor_pareamentos`: um computador (quem gerou o código) e, depois do aceite, o celular
  que lê por ele. O código vale 5 min; o pareamento, 12 h fixas a partir do aceite. O
  status (AGUARDANDO, ATIVO, EXPIRADO, ENCERRADO) é calculado das datas, nunca coluna. O
  código é único só enquanto pode ser digitado (UNIQUE parcial).
- `leitor_bipes`: a fila do que o celular leu, esperando o computador retirar. Idempotente
  por `client_uuid`; o índice parcial cobre exatamente a fila pendente que a retirada
  percorre de 2 em 2 s.

Tabelas de vida curta: os FKs para `users` são CASCADE (como os do refresh token), senão
excluir a conta de alguém travaria num pareamento de ontem; os bipes vão junto com o
pareamento.

Revision ID: b6c7d8e9fa06
Revises: b5c6d7e8f905
Create Date: 2026-11-17 12:00:00.000000+00:00
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "b6c7d8e9fa06"
down_revision: str | None = "b5c6d7e8f905"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "leitor_pareamentos",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("codigo", sa.String(length=8), nullable=False),
        sa.Column("computador_user_id", sa.Integer(), nullable=False),
        sa.Column("aparelho_user_id", sa.Integer(), nullable=True),
        sa.Column(
            "criado_em",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("codigo_expira_em", sa.DateTime(timezone=True), nullable=False),
        sa.Column("aceito_em", sa.DateTime(timezone=True), nullable=True),
        sa.Column("expira_em", sa.DateTime(timezone=True), nullable=True),
        sa.Column("encerrado_em", sa.DateTime(timezone=True), nullable=True),
        sa.Column("motivo_encerramento", sa.String(length=20), nullable=True),
        sa.CheckConstraint(
            "motivo_encerramento IN ('COMPUTADOR','CELULAR','TROCOU','SUBSTITUIDO')",
            name=op.f("ck_leitor_pareamentos_motivo_encerramento"),
        ),
        sa.CheckConstraint(
            "(encerrado_em IS NULL) = (motivo_encerramento IS NULL)",
            name=op.f("ck_leitor_pareamentos_encerramento"),
        ),
        sa.CheckConstraint(
            "(aceito_em IS NULL) = (aparelho_user_id IS NULL)"
            " AND (aceito_em IS NULL) = (expira_em IS NULL)",
            name=op.f("ck_leitor_pareamentos_aceite"),
        ),
        sa.ForeignKeyConstraint(
            ["aparelho_user_id"],
            ["users.id"],
            name=op.f("fk_leitor_pareamentos_aparelho_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["computador_user_id"],
            ["users.id"],
            name=op.f("fk_leitor_pareamentos_computador_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_leitor_pareamentos")),
    )
    op.create_index(
        "uq_leitor_pareamentos_codigo_aguardando",
        "leitor_pareamentos",
        ["codigo"],
        unique=True,
        postgresql_where=sa.text("aceito_em IS NULL AND encerrado_em IS NULL"),
    )

    op.create_table(
        "leitor_bipes",
        sa.Column("id", sa.BigInteger(), nullable=False),
        sa.Column("pareamento_id", sa.Integer(), nullable=False),
        sa.Column("client_uuid", sa.UUID(), nullable=False),
        sa.Column("codigo", sa.String(length=64), nullable=False),
        sa.Column(
            "criado_em",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("consumido_em", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(
            ["pareamento_id"],
            ["leitor_pareamentos.id"],
            name=op.f("fk_leitor_bipes_pareamento_id_leitor_pareamentos"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_leitor_bipes")),
        sa.UniqueConstraint("client_uuid", name=op.f("uq_leitor_bipes_client_uuid")),
    )
    op.create_index(
        "ix_leitor_bipes_pendentes",
        "leitor_bipes",
        ["pareamento_id", "id"],
        postgresql_where=sa.text("consumido_em IS NULL"),
    )


def downgrade() -> None:
    op.drop_index("ix_leitor_bipes_pendentes", table_name="leitor_bipes")
    op.drop_table("leitor_bipes")
    op.drop_index("uq_leitor_pareamentos_codigo_aguardando", table_name="leitor_pareamentos")
    op.drop_table("leitor_pareamentos")
