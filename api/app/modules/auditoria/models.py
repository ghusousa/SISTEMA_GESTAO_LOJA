"""O diário da loja: quem fez o quê, quando, de onde.

Existe para o dono — e só para o dono (`VER_AUDITORIA`, capacidade que nem o gerente tem).
A pergunta que responde é a de quem confia na equipe mas confere: "o que a Ana fez hoje no
login dela?", "quem cancelou aquela venda?", "quem mexeu no preço?".

**Tudo aqui é congelado no momento em que aconteceu.** O nome e o papel de quem agiu são
copiados para a linha, não referenciados: renomear a vendedora, mudar o cargo dela ou até
desativar o login NÃO reescreve o passado. Auditoria que muda com o presente não é
auditoria. Por isso `user_id` é só uma ponte para a tela (pode virar nulo se o usuário for
removido um dia), e o que vale é `user_nome`/`user_papel` gravados na hora.

A linha nunca é editada nem apagada pela aplicação — é só INSERT e SELECT.
"""

from datetime import datetime

from sqlalchemy import BigInteger, DateTime, ForeignKey, Index, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base


class AuditLog(Base):
    __tablename__ = "audit_log"
    __table_args__ = (
        # O diário é quase sempre lido do mais novo para o mais velho, e filtrado por
        # pessoa. Estes dois índices cobrem as duas telas.
        Index("ix_audit_log_created_at", "created_at"),
        Index("ix_audit_log_user_id_created_at", "user_id", "created_at"),
        Index("ix_audit_log_acao", "acao"),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    #: Ponte para a tela (foto do usuário, link). Nulo se um dia o usuário for removido —
    #: o registro do que ele fez continua, com nome e papel congelados abaixo.
    user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )
    #: Congelados no momento do ato. Numa falha de login sem conta, guarda o e-mail digitado.
    user_nome: Mapped[str] = mapped_column(String(160), nullable=False)
    user_papel: Mapped[str | None] = mapped_column(String(20))

    #: Código estável do que aconteceu (VENDA_CRIADA, LOGIN, PRECO_EDITADO…). É por ele que
    #: a tela agrupa e filtra; a frase abaixo é só para ler.
    acao: Mapped[str] = mapped_column(String(40), nullable=False)
    #: A frase em português que o dono lê: "Cancelou a venda #87".
    descricao: Mapped[str] = mapped_column(String(300), nullable=False)

    #: O rastro cru, para quando a frase não basta: exatamente que requisição foi.
    metodo: Mapped[str | None] = mapped_column(String(8))
    caminho: Mapped[str | None] = mapped_column(String(300))
    #: A que registro o ato se refere (venda, produto…), quando dá para saber.
    entidade: Mapped[str | None] = mapped_column(String(40))
    entidade_id: Mapped[int | None] = mapped_column(BigInteger)

    ip: Mapped[str | None] = mapped_column(String(64))
    status_http: Mapped[int | None] = mapped_column()

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
