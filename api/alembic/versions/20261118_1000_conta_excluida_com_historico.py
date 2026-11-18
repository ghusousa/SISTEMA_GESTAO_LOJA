"""conta excluída que deixa a linha para segurar o histórico (ADR-45)

- `users.deleted_at`: marca a conta excluída cuja linha NÃO pôde sair. Excluir apaga a linha
  inteira quando nada da loja depende dela; quando a pessoa já vendeu, abriu caixa ou deu
  entrada, os FKs dessas tabelas são RESTRICT (a venda é documento contábil da loja) e a
  linha fica só com o nome e o papel de quem fez cada registro — e-mail, senha, sessões e
  leitor vão embora. Antes desta coluna, excluir quem já tinha vendido dava 500.
- CHECK `deleted_at IS NULL OR NOT is_active`: conta excluída nunca volta a entrar, nem por
  SQL direto.

Revision ID: b7c8d9eafb07
Revises: b6c7d8e9fa06
Create Date: 2026-11-18 10:00:00.000000+00:00
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = 'b7c8d9eafb07'
down_revision: str | None = 'b6c7d8e9fa06'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column('users', sa.Column('deleted_at', sa.DateTime(timezone=True), nullable=True))
    op.create_check_constraint(
        op.f('ck_users_excluida_sem_acesso'), 'users', 'deleted_at IS NULL OR NOT is_active'
    )


def downgrade() -> None:
    # A conta excluída continua inativa, com e-mail de mentira e sem senha que confira: na
    # versão de antes ela aparece como "desativada", e nada nela volta a entrar.
    op.drop_constraint(op.f('ck_users_excluida_sem_acesso'), 'users', type_='check')
    op.drop_column('users', 'deleted_at')
