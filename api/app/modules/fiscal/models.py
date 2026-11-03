"""A NFC-e de cada venda (ADR-41).

**Uma nota por venda, garantida pelo banco** (`sale_id` UNIQUE). É o que impede o duplo
clique em "Emitir" de autorizar duas notas para a mesma venda — imposto pago duas vezes
e uma nota a mais para explicar ao fisco.

**A referência nasce antes de qualquer chamada ao emissor e nunca muda.** O emissor
identifica a nota pela referência; reenviar a MESMA referência é seguro (ele responde que
já autorizou), reenviar com outra é uma segunda nota. Por isso a linha é gravada e
confirmada (commit) antes do primeiro envio: se o processo cair no meio da chamada, a
referência continua aqui para a próxima tentativa encontrar o que já foi feito.
"""

from datetime import datetime
from enum import StrEnum

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base


class StatusNota(StrEnum):
    #: Gravada, ainda sem resposta definitiva: nunca enviada, sem rede, emissor ocupado ou
    #: fora do ar (429, 5xx, 4xx que ele não documenta), ou a SEFAZ ainda processando.
    #: "Tentar de novo" consulta antes de reenviar.
    PENDENTE = "PENDENTE"
    AUTORIZADA = "AUTORIZADA"
    #: A SEFAZ (ou o emissor, numa recusa documentada do pedido) recusou: resposta
    #: definitiva, e por isso libera cancelar a venda sem falar com o emissor. Corrige-se o
    #: que a mensagem diz e emite-se de novo, com a mesma referência.
    REJEITADA = "REJEITADA"
    #: Era autorizada e foi cancelada junto com a venda.
    CANCELADA = "CANCELADA"


class Ambiente(StrEnum):
    HOMOLOGACAO = "homologacao"
    PRODUCAO = "producao"


_STATUS = "','".join(StatusNota)
_AMBIENTES = "','".join(Ambiente)


class NotaFiscal(Base):
    __tablename__ = "notas_fiscais"
    __table_args__ = (
        CheckConstraint(f"status IN ('{_STATUS}')", name="status"),
        CheckConstraint(f"ambiente IN ('{_AMBIENTES}')", name="ambiente"),
        CheckConstraint("tentativas >= 0", name="tentativas"),
        # Nota autorizada sem chave é nota que ninguém consegue consultar nem cancelar.
        CheckConstraint(
            "status NOT IN ('AUTORIZADA','CANCELADA') OR chave IS NOT NULL",
            name="autorizada_tem_chave",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    sale_id: Mapped[int] = mapped_column(
        ForeignKey("sales.id", ondelete="RESTRICT"), nullable=False, unique=True
    )
    status: Mapped[str] = mapped_column(String(12), nullable=False, default=StatusNota.PENDENTE)
    ambiente: Mapped[str] = mapped_column(String(12), nullable=False)
    #: Qual adaptador emitiu. Consultar e cancelar falam com ESTE, mesmo que o .env troque.
    emissor: Mapped[str] = mapped_column(String(20), nullable=False)
    #: Identificador da nota no emissor (`ref` da Focus NFe). Ver docstring do módulo.
    referencia: Mapped[str] = mapped_column(String(60), nullable=False, unique=True)
    numero: Mapped[int | None] = mapped_column(Integer)
    serie: Mapped[int | None] = mapped_column(Integer)
    #: Chave de acesso de 44 dígitos: é ela que o consumidor consulta na SEFAZ.
    chave: Mapped[str | None] = mapped_column(String(44))
    protocolo: Mapped[str | None] = mapped_column(String(30))
    url_danfe: Mapped[str | None] = mapped_column(Text)
    url_xml: Mapped[str | None] = mapped_column(Text)
    #: Última palavra do emissor ou da SEFAZ, para a tela mostrar o porquê.
    mensagem: Mapped[str | None] = mapped_column(Text)
    #: Contada e commitada ANTES de cada envio (com status PENDENTE): 0 quer dizer que esta
    #: referência nunca saiu daqui; mais que isso, que pode ter saído — pergunta-se ao emissor.
    tentativas: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    autorizada_em: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    cancelada_em: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )
