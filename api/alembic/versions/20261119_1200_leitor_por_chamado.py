"""leitor por chamado: o computador chama o celular do mesmo login (ADR-47)

- `leitor_pareamentos` ganha o chamado:
  - `chamado`: o pareamento nasceu do botão "Abrir no app o leitor de código" do computador,
    para o celular do MESMO login, e não do QR. As linhas de antes ficam false (são QR);
  - `sinal`: 3 caracteres (dígito-letra-dígito) que a pessoa confere nas duas telas. Com o
    mesmo login em vários caixas é ele que diz qual chamado é o de cada um;
  - `client_uuid`: o POST do chamado é idempotente (um F5 no meio retoma o mesmo chamado em
    vez de deixar um órfão que o celular poderia atender);
  - `aparelho_instalacao`: a instalação do app que aceitou ou atendeu. O reenvio e o bipe
    valem só para ela, e o TROCOU passa a ser por aparelho, não por login. NULL = aceito por
    app antigo.
- CHECKs: só o login que chamou atende (nem por SQL direto); sinal existe se e só se é
  chamado, no formato certo; a chave só existe no chamado; a instalação só depois do aceite.
  UNIQUE na chave: é restrição de correção (a idempotência, como a do bipe), não índice de
  desempenho. Nenhum índice novo (ADR-31: só entra medido).
- `notificacao_aparelhos`: uma linha por instalação do app neste servidor, ligada ao login,
  com o token de push da Expo, opcional. O token é credencial ao portador: os `pg_dump` de
  backup levam só a estrutura desta tabela. FK CASCADE: não é histórico da loja.

O downgrade encerra os chamados que ainda esperam: no esquema antigo o código sorteado de um
chamado AGUARDANDO viraria um código aceitável por qualquer login. Um chamado ATIVO vira um
pareamento comum, com o mesmo login nas duas pontas, que o esquema antigo aceita.

Revision ID: b8c9daebfc08
Revises: b7c8d9eafb07
Create Date: 2026-11-19 12:00:00.000000+00:00
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "b8c9daebfc08"
down_revision: str | None = "b7c8d9eafb07"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_CHECKS = {
    "ck_leitor_pareamentos_chamado_do_mesmo_login": (
        "NOT chamado OR aparelho_user_id IS NULL OR aparelho_user_id = computador_user_id"
    ),
    "ck_leitor_pareamentos_sinal_do_chamado": (
        "chamado = (sinal IS NOT NULL)"
        " AND (sinal IS NULL OR sinal ~ '^[2-9][A-HJ-NP-Z][2-9]$')"
    ),
    "ck_leitor_pareamentos_chave_do_chamado": "client_uuid IS NULL OR chamado",
    "ck_leitor_pareamentos_instalacao_do_aceite": (
        "aparelho_instalacao IS NULL OR aceito_em IS NOT NULL"
    ),
}


def upgrade() -> None:
    op.add_column(
        "leitor_pareamentos",
        sa.Column("chamado", sa.Boolean(), server_default=sa.text("false"), nullable=False),
    )
    op.add_column("leitor_pareamentos", sa.Column("sinal", sa.String(length=3), nullable=True))
    op.add_column("leitor_pareamentos", sa.Column("client_uuid", sa.UUID(), nullable=True))
    op.add_column(
        "leitor_pareamentos", sa.Column("aparelho_instalacao", sa.UUID(), nullable=True)
    )
    for nome, condicao in _CHECKS.items():
        op.create_check_constraint(op.f(nome), "leitor_pareamentos", condicao)
    op.create_unique_constraint(
        op.f("uq_leitor_pareamentos_client_uuid"), "leitor_pareamentos", ["client_uuid"]
    )

    op.create_table(
        "notificacao_aparelhos",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("instalacao", sa.UUID(), nullable=False),
        sa.Column("plataforma", sa.String(length=10), nullable=False),
        sa.Column("token", sa.String(length=200), nullable=True),
        sa.Column(
            "criado_em",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "visto_em",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "plataforma IN ('ios','android')", name=op.f("ck_notificacao_aparelhos_plataforma")
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_notificacao_aparelhos_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_notificacao_aparelhos")),
        sa.UniqueConstraint("instalacao", name=op.f("uq_notificacao_aparelhos_instalacao")),
        sa.UniqueConstraint("token", name=op.f("uq_notificacao_aparelhos_token")),
    )


def downgrade() -> None:
    op.drop_table("notificacao_aparelhos")
    # Antes de as colunas sumirem: sem o `chamado`, o código sorteado de um chamado que ainda
    # espera viraria um código que qualquer login aceita.
    op.execute(
        "UPDATE leitor_pareamentos SET encerrado_em = now(), "
        "motivo_encerramento = 'SUBSTITUIDO' "
        "WHERE chamado AND aceito_em IS NULL AND encerrado_em IS NULL"
    )
    op.drop_constraint(
        op.f("uq_leitor_pareamentos_client_uuid"), "leitor_pareamentos", type_="unique"
    )
    for nome in reversed(list(_CHECKS)):
        op.drop_constraint(op.f(nome), "leitor_pareamentos", type_="check")
    for coluna in ("aparelho_instalacao", "client_uuid", "sinal", "chamado"):
        op.drop_column("leitor_pareamentos", coluna)
