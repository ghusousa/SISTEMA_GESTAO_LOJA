"""taxa da maquininha, credito parcelado e cliente em qualquer venda

Itens 22 e 27 do plano de melhorias (ADR-35 e ADR-36).

- `card_fees`: a tabela de taxas que o dono preenche (forma, faixa de parcelas, percentual
  e prazo para cair na conta).
- `sale_payments` ganha `parcelas`, `bandeira`, `taxa_percentual` e `prazo_dias`. Taxa e
  prazo são FOTOGRAFADOS na venda: mudar a tabela depois não reescreve o passado.
  Pagamentos antigos de cartão nascem com 0% (era o que o resultado já assumia) e o prazo
  de mercado (débito D+1, crédito D+30), para a agenda de recebíveis ter data.
- `customers` ganha `nascimento`, `preferencias` e `client_uuid` (a chave do cadastro feito
  no balcão, que a rede caindo não pode duplicar).

Não há enum do Postgres envolvido: as formas são texto com CHECK.

Revision ID: b1c2d3e4f501
Revises: 3f9c1a7e5b20
Create Date: 2026-11-02 21:00:00.000000+00:00
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = 'b1c2d3e4f501'
down_revision: str | None = '3f9c1a7e5b20'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        'card_fees',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('forma', sa.String(length=10), nullable=False),
        sa.Column('parcelas_de', sa.SmallInteger(), nullable=False),
        sa.Column('parcelas_ate', sa.SmallInteger(), nullable=False),
        sa.Column('percentual', sa.Numeric(precision=5, scale=2), nullable=False),
        sa.Column('prazo_dias', sa.SmallInteger(), nullable=False),
        sa.Column(
            'created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'),
            nullable=False,
        ),
        sa.Column(
            'updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'),
            nullable=False,
        ),
        sa.CheckConstraint(
            "forma = 'CREDITO' OR parcelas_ate = 1", name=op.f('ck_card_fees_debito_a_vista')
        ),
        sa.CheckConstraint("forma IN ('DEBITO','CREDITO')", name=op.f('ck_card_fees_forma')),
        sa.CheckConstraint(
            'parcelas_de >= 1 AND parcelas_ate >= parcelas_de AND parcelas_ate <= 12',
            name=op.f('ck_card_fees_parcelas'),
        ),
        sa.CheckConstraint(
            'percentual >= 0 AND percentual < 100', name=op.f('ck_card_fees_percentual')
        ),
        sa.CheckConstraint(
            'prazo_dias >= 0 AND prazo_dias <= 366', name=op.f('ck_card_fees_prazo_dias')
        ),
        sa.PrimaryKeyConstraint('id', name=op.f('pk_card_fees')),
    )
    op.create_index('ix_card_fees_forma', 'card_fees', ['forma'], unique=False)

    op.add_column('customers', sa.Column('nascimento', sa.Date(), nullable=True))
    op.add_column('customers', sa.Column('preferencias', sa.String(length=200), nullable=True))
    op.add_column('customers', sa.Column('client_uuid', sa.UUID(), nullable=True))
    op.create_unique_constraint(op.f('uq_customers_client_uuid'), 'customers', ['client_uuid'])

    op.add_column(
        'sale_payments',
        sa.Column('parcelas', sa.SmallInteger(), server_default='1', nullable=False),
    )
    op.add_column('sale_payments', sa.Column('bandeira', sa.String(length=20), nullable=True))
    op.add_column(
        'sale_payments',
        sa.Column(
            'taxa_percentual', sa.Numeric(precision=5, scale=2), server_default='0',
            nullable=False,
        ),
    )
    op.add_column('sale_payments', sa.Column('prazo_dias', sa.SmallInteger(), nullable=True))
    # O passado no cartão ganha o prazo de mercado — o CHECK abaixo exige prazo no cartão.
    op.execute("UPDATE sale_payments SET prazo_dias = 1 WHERE method = 'DEBITO'")
    op.execute("UPDATE sale_payments SET prazo_dias = 30 WHERE method = 'CREDITO'")

    op.create_check_constraint(
        op.f('ck_sale_payments_parcelas'),
        'sale_payments',
        "parcelas >= 1 AND (parcelas = 1 OR method = 'CREDITO')",
    )
    op.create_check_constraint(
        op.f('ck_sale_payments_bandeira_so_cartao'),
        'sale_payments',
        "bandeira IS NULL OR method IN ('DEBITO','CREDITO')",
    )
    op.create_check_constraint(
        op.f('ck_sale_payments_taxa_percentual'),
        'sale_payments',
        "taxa_percentual >= 0 AND taxa_percentual < 100"
        " AND (taxa_percentual = 0 OR method IN ('DEBITO','CREDITO'))",
    )
    op.create_check_constraint(
        op.f('ck_sale_payments_prazo_so_cartao'),
        'sale_payments',
        "(method IN ('DEBITO','CREDITO')) = (prazo_dias IS NOT NULL)"
        " AND (prazo_dias IS NULL OR prazo_dias >= 0)",
    )


def downgrade() -> None:
    # Volta sem perder venda: some só o que esta revisão acrescentou. O que se perde é o
    # que só existia aqui — parcelas, bandeira, taxa fotografada, nascimento e preferências.
    op.drop_constraint(op.f('ck_sale_payments_prazo_so_cartao'), 'sale_payments', type_='check')
    op.drop_constraint(op.f('ck_sale_payments_taxa_percentual'), 'sale_payments', type_='check')
    op.drop_constraint(op.f('ck_sale_payments_bandeira_so_cartao'), 'sale_payments', type_='check')
    op.drop_constraint(op.f('ck_sale_payments_parcelas'), 'sale_payments', type_='check')
    op.drop_column('sale_payments', 'prazo_dias')
    op.drop_column('sale_payments', 'taxa_percentual')
    op.drop_column('sale_payments', 'bandeira')
    op.drop_column('sale_payments', 'parcelas')

    op.drop_constraint(op.f('uq_customers_client_uuid'), 'customers', type_='unique')
    op.drop_column('customers', 'client_uuid')
    op.drop_column('customers', 'preferencias')
    op.drop_column('customers', 'nascimento')

    op.drop_index('ix_card_fees_forma', table_name='card_fees')
    op.drop_table('card_fees')
