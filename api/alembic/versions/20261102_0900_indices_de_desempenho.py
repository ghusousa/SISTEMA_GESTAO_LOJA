"""indices de desempenho: clientes, resumo, caixa e busca por nome

Medido num banco de 3 anos de loja (200 mil vendas, 400 mil itens, 15 mil peças, 20 mil
clientes). Cada índice aqui foi conferido com EXPLAIN; o que não mudou o plano ficou de fora.

- `sales(customer_id)`: a lista "quem está devendo" calculava a dívida de cada cliente
  varrendo o UNIQUE (id, customer_id) inteiro, onde customer_id é a 2ª coluna: 49 s.
- `sale_items(sale_id) INCLUDE (...)`: CMV, peças por dia e mais vendidos do mês passam a
  sair do índice, sem ler os anos de itens.
- `sale_payments(sale_id) INCLUDE (amount) WHERE method = 'FIADO'`: "vendido a prazo".
- `customer_payments` pelo dia da loja: o caixa do dia lia todos os recebimentos de fiado.
- `stock_movements(created_at)`: o extrato por período contava o histórico inteiro. O
  ADR-27 já contava com este índice, que nunca tinha sido criado.
- `pg_trgm` + GIN no nome do produto e na cor ACHATADOS (catalogo/busca.py): a busca por
  nome deixa de aplicar translate() no catálogo inteiro a cada tecla.

`CREATE INDEX` comum (não CONCURRENTLY): numa loja deste tamanho leva segundos, e roda
dentro da transação da migration — se algo falhar, nada fica pela metade. `pg_trgm` é
extensão *trusted* desde o Postgres 13: o dono do banco a instala sem superusuário.

Revision ID: 3f9c1a7e5b20
Revises: 7c1f0e9a4b2d
Create Date: 2026-11-02 09:00:00.000000+00:00
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = '3f9c1a7e5b20'
down_revision: str | None = '7c1f0e9a4b2d'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Fotografia das tabelas de `app/modules/catalogo/busca.py` nesta revisão. A migration não
# importa o app (ela tem de continuar dizendo o mesmo daqui a um ano); se a tabela mudar
# lá, é uma migration nova que recria os dois índices — e o teste
# `test_busca_por_nome_usa_o_indice_trigram` acusa o descompasso.
_COM_ACENTO = "áàâãäéèêëíìîïóòôõöúùûüçñ"
_SEM_ACENTO = "aaaaaeeeeiiiiooooouuuucn"


def _achatado(coluna: str) -> str:
    return f"translate(lower({coluna}), '{_COM_ACENTO}', '{_SEM_ACENTO}')"


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm")

    op.create_index(
        'ix_sales_customer_id',
        'sales',
        ['customer_id'],
        postgresql_where=sa.text('customer_id IS NOT NULL'),
    )

    # Mesmo nome e mesma chave, agora cobrindo as colunas que os relatórios leem.
    op.drop_index('ix_sale_items_sale_id', table_name='sale_items')
    op.create_index(
        'ix_sale_items_sale_id',
        'sale_items',
        ['sale_id'],
        postgresql_include=['variant_id', 'quantity', 'unit_price', 'unit_cost'],
    )

    op.create_index(
        'ix_sale_payments_fiado',
        'sale_payments',
        ['sale_id'],
        postgresql_include=['amount'],
        postgresql_where=sa.text("method = 'FIADO'"),
    )

    op.create_index('ix_stock_movements_created_at', 'stock_movements', ['created_at'])

    op.create_index(
        'ix_customer_payments_business_date',
        'customer_payments',
        [sa.literal_column("((paid_at AT TIME ZONE 'America/Sao_Paulo')::date)")],
    )

    op.execute(
        "CREATE INDEX ix_products_nome_achatado ON products "
        f"USING gin ({_achatado('name')} gin_trgm_ops)"
    )
    op.execute(
        "CREATE INDEX ix_product_variants_cor_achatada ON product_variants "
        f"USING gin ({_achatado('color')} gin_trgm_ops)"
    )

    # Índice de EXPRESSÃO só tem estatística depois de um ANALYZE; sem ela o planejador
    # chuta a seletividade e pode ignorar o índice até o autovacuum passar.
    op.execute("ANALYZE customer_payments")
    op.execute("ANALYZE products")
    op.execute("ANALYZE product_variants")


def downgrade() -> None:
    op.drop_index('ix_product_variants_cor_achatada', table_name='product_variants')
    op.drop_index('ix_products_nome_achatado', table_name='products')
    op.drop_index('ix_customer_payments_business_date', table_name='customer_payments')
    op.drop_index('ix_stock_movements_created_at', table_name='stock_movements')
    op.drop_index('ix_sale_payments_fiado', table_name='sale_payments')
    op.drop_index('ix_sale_items_sale_id', table_name='sale_items')
    op.create_index('ix_sale_items_sale_id', 'sale_items', ['sale_id'])
    op.drop_index('ix_sales_customer_id', table_name='sales')
    # Sem CASCADE: se outra coisa no banco passou a depender do pg_trgm, o downgrade para
    # aqui em vez de apagar junto um índice que não é desta migration.
    op.execute("DROP EXTENSION IF EXISTS pg_trgm")
