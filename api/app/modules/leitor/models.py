"""O celular como leitor de código de barras do computador (ADR-43).

Duas tabelas pequenas e de vida curta. Nada aqui é histórico da loja: o pareamento é uma
ligação de expediente (no máximo 12 h depois do aceite) e o bipe é uma tecla do leitor que
o computador retira em segundos. Por isso a faxina apaga sem dó (bipe com mais de um dia,
pareamento terminado há mais de 30) e os FKs para `users` são `CASCADE`, como os do refresh
token: excluir a conta de alguém (LGPD) não pode travar num pareamento de ontem.

**O status não é coluna.** AGUARDANDO, ATIVO, EXPIRADO e ENCERRADO saem das datas, no
servidor (`service.status_do_pareamento`): coluna de status precisaria de alguém para virar
EXPIRADO na hora certa, e o relógio não avisa ninguém.
"""

import uuid
from datetime import datetime
from enum import StrEnum

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    String,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import UUID as PgUUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base


class MotivoEncerramento(StrEnum):
    COMPUTADOR = "COMPUTADOR"
    """Desligado no computador (botão, ou a pessoa saiu do sistema lá)."""

    CELULAR = "CELULAR"
    """Desligado no celular."""

    TROCOU = "TROCOU"
    """O mesmo celular aceitou o código de outro computador: um celular, um computador."""

    SUBSTITUIDO = "SUBSTITUIDO"
    """O computador gerou um código novo no lugar deste (ou passou do teto de abertos)."""


_MOTIVOS = "','".join(MotivoEncerramento)


class LeitorPareamento(Base):
    """Um computador e (depois do aceite) o celular que lê por ele."""

    __tablename__ = "leitor_pareamentos"
    __table_args__ = (
        CheckConstraint(f"motivo_encerramento IN ('{_MOTIVOS}')", name="motivo_encerramento"),
        # Encerrado é encerrado por inteiro: a hora e o porquê andam juntos.
        CheckConstraint(
            "(encerrado_em IS NULL) = (motivo_encerramento IS NULL)", name="encerramento"
        ),
        # Aceito é aceito por inteiro: quem aceitou, quando, e até quando vale.
        CheckConstraint(
            "(aceito_em IS NULL) = (aparelho_user_id IS NULL)"
            " AND (aceito_em IS NULL) = (expira_em IS NULL)",
            name="aceite",
        ),
        # O código só precisa ser único enquanto alguém pode digitá-lo. Depois do aceite (ou
        # do encerramento) ele pode voltar a sair do sorteio sem confundir ninguém.
        Index(
            "uq_leitor_pareamentos_codigo_aguardando",
            "codigo",
            unique=True,
            postgresql_where=text("aceito_em IS NULL AND encerrado_em IS NULL"),
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    #: 6 caracteres de `ALFABETO` (sem 0/O/1/I, que se confundem lidos em voz alta).
    codigo: Mapped[str] = mapped_column(String(8), nullable=False)
    computador_user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    aparelho_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE")
    )
    criado_em: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    #: Criado + 5 min: o código na tela só serve para ser digitado (ou lido) agora.
    codigo_expira_em: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    aceito_em: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    #: Aceito + 12 h, fixo: usar o leitor não estica o prazo.
    expira_em: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    encerrado_em: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    motivo_encerramento: Mapped[str | None] = mapped_column(String(20))


class LeitorBipe(Base):
    """Uma leitura feita no celular, esperando o computador retirar."""

    __tablename__ = "leitor_bipes"
    __table_args__ = (
        # A fila de cada pareamento, na ordem em que foi bipada: é exatamente o que o
        # `retirar` percorre a cada 2 s. Só os pendentes — os consumidos só esperam a faxina.
        Index(
            "ix_leitor_bipes_pendentes",
            "pareamento_id",
            "id",
            postgresql_where=text("consumido_em IS NULL"),
        ),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    pareamento_id: Mapped[int] = mapped_column(
        ForeignKey("leitor_pareamentos.id", ondelete="CASCADE"), nullable=False
    )
    #: Idempotência: o celular reenvia o mesmo bipe depois de uma rede ruim sem bipar duas vezes.
    client_uuid: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), nullable=False, unique=True
    )
    codigo: Mapped[str] = mapped_column(String(64), nullable=False)
    criado_em: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    #: Retirado pelo computador (entregue ou descartado por velho). Uma vez só.
    consumido_em: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
