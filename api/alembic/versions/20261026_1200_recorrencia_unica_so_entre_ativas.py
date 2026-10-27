"""recorrencia unica so entre as despesas ativas

A UNIQUE (recurring_source_id, competencia) não era parcial: a réplica excluída (soft
delete) continuava ocupando o mês, e "Lançar fixas" nunca mais conseguia trazer aquele
aluguel de volta. Vira índice único parcial `WHERE deleted_at IS NULL`, a convenção de
todo soft delete do projeto.

Revision ID: 7c1f0e9a4b2d
Revises: b6a389f137a3
Create Date: 2026-10-26 12:00:00.000000+00:00
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = '7c1f0e9a4b2d'
down_revision: str | None = 'b6a389f137a3'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.drop_constraint('recurring_source_id_competencia', 'expenses', type_='unique')
    op.create_index(
        'uq_expenses_recurring_source_competencia',
        'expenses',
        ['recurring_source_id', 'competencia'],
        unique=True,
        postgresql_where=sa.text('deleted_at IS NULL'),
    )


def downgrade() -> None:
    # A UNIQUE total não cabe se, já com o índice parcial, a mesma origem foi relançada
    # no mês depois de uma exclusão. A linha excluída é a que sai da cadeia (perde a
    # origem): a ativa é a que o relatório conta, e a excluída ninguém mais vê.
    op.execute(
        """
        UPDATE expenses AS e
           SET recurring_source_id = NULL
         WHERE e.deleted_at IS NOT NULL
           AND e.recurring_source_id IS NOT NULL
           AND EXISTS (
                 SELECT 1 FROM expenses o
                  WHERE o.id <> e.id
                    AND o.recurring_source_id = e.recurring_source_id
                    AND o.competencia = e.competencia
                    AND (o.deleted_at IS NULL OR o.id > e.id)
               )
        """
    )
    op.drop_index('uq_expenses_recurring_source_competencia', table_name='expenses')
    op.create_unique_constraint(
        'recurring_source_id_competencia', 'expenses', ['recurring_source_id', 'competencia']
    )
