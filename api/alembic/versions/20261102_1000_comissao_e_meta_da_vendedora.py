"""comissao e meta do dia por pessoa da equipe (ADR-37)

- `users.comissao_percentual`: % sobre o faturamento LÍQUIDO da pessoa (venda menos
  devolução). Nasce 0 para toda a equipe: ninguém passa a "ganhar comissão" sem o dono
  dizer quanto.
- `users.meta_diaria`: meta de venda do dia. Opcional — sem meta, o PDV não mostra a régua.

Os CHECKs são a rede de segurança do dinheiro da folha: comissão fora de 0–100% e meta zero
ou negativa não entram nem por SQL direto.

Revision ID: b2c3d4e5f602
Revises: b1c2d3e4f501
Create Date: 2026-11-02 10:00:00.000000+00:00
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = 'b2c3d4e5f602'
down_revision: str | None = 'b1c2d3e4f501'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        'users',
        sa.Column(
            'comissao_percentual',
            sa.Numeric(precision=5, scale=2),
            server_default=sa.text('0'),
            nullable=False,
        ),
    )
    op.add_column(
        'users', sa.Column('meta_diaria', sa.Numeric(precision=14, scale=2), nullable=True)
    )
    op.create_check_constraint(
        op.f('ck_users_comissao_percentual'),
        'users',
        'comissao_percentual >= 0 AND comissao_percentual <= 100',
    )
    op.create_check_constraint(
        op.f('ck_users_meta_diaria'), 'users', 'meta_diaria IS NULL OR meta_diaria > 0'
    )


def downgrade() -> None:
    op.drop_constraint(op.f('ck_users_meta_diaria'), 'users', type_='check')
    op.drop_constraint(op.f('ck_users_comissao_percentual'), 'users', type_='check')
    op.drop_column('users', 'meta_diaria')
    op.drop_column('users', 'comissao_percentual')
