"""% da comissao congelada na venda (ADR-37)

- `sales.comissao_percentual`: a % de quem vendeu NAQUELE instante, fotografada como o
  custo em `sale_items` e a taxa da maquininha em `sale_payments`. O relatório da equipe
  soma líquido × % DA VENDA (e a devolução estorna com a % da venda original): o dono
  mudar a % hoje não reescreve a folha de um mês já pago.
- Vendas que já existem herdam a % atual de quem vendeu — é a mesma conta que o relatório
  fazia até aqui, então nenhum número antigo muda nesta migration.

Sem valor padrão no banco de propósito: venda nova que esquecesse a % viraria comissão
zero sem ninguém ver. O CHECK é o mesmo de `users`.

Revision ID: b5c6d7e8f905
Revises: b4c5d6e7f804
Create Date: 2026-11-02 23:00:00.000000+00:00
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = 'b5c6d7e8f905'
down_revision: str | None = 'b4c5d6e7f804'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        'sales',
        sa.Column('comissao_percentual', sa.Numeric(precision=5, scale=2), nullable=True),
    )
    op.execute(
        "UPDATE sales SET comissao_percentual = users.comissao_percentual"
        " FROM users WHERE users.id = sales.seller_id"
    )
    op.alter_column('sales', 'comissao_percentual', nullable=False)
    op.create_check_constraint(
        op.f('ck_sales_comissao_percentual'),
        'sales',
        'comissao_percentual >= 0 AND comissao_percentual <= 100',
    )


def downgrade() -> None:
    op.drop_constraint(op.f('ck_sales_comissao_percentual'), 'sales', type_='check')
    op.drop_column('sales', 'comissao_percentual')
