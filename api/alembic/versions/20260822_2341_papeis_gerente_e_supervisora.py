"""Abre o CHECK de `users.role` para GERENTE e SUPERVISORA.

Só a restrição muda. Ninguém é reclassificado: quem é ADMIN (o dono) continua ADMIN e
quem é VENDEDOR continua VENDEDOR — promover alguém é decisão da loja, não da migration.

O downgrade precisa rebaixar antes de apertar o CHECK, senão o Postgres recusa a
restrição por causa das linhas que já existem. Rebaixa para VENDEDOR, e não para ADMIN,
porque voltar de versão não pode dar a ninguém um acesso que ele não tinha.

Revision ID: c21c1f54bade
Revises: a4a623292a0c
Create Date: 2026-08-22 23:41:35.525541+00:00
"""

from collections.abc import Sequence

from alembic import op

revision: str = "c21c1f54bade"
down_revision: str | None = "a4a623292a0c"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

PAPEIS_NOVOS = "'ADMIN','GERENTE','SUPERVISORA','VENDEDOR'"
PAPEIS_ANTIGOS = "'ADMIN','VENDEDOR'"


def upgrade() -> None:
    op.drop_constraint("role", "users", type_="check")
    op.create_check_constraint("role", "users", f"role IN ({PAPEIS_NOVOS})")


def downgrade() -> None:
    op.execute("UPDATE users SET role = 'VENDEDOR' WHERE role IN ('GERENTE','SUPERVISORA')")
    op.drop_constraint("role", "users", type_="check")
    op.create_check_constraint("role", "users", f"role IN ({PAPEIS_ANTIGOS})")
