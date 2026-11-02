"""A identidade da loja: como ela se chama e o que ela vende.

**Por que no banco e não no `.env`:** o nome da loja não é configuração de máquina, é
dado do negócio. No `.env` ele exigiria acesso ao servidor para corrigir um acento, não
entraria no backup junto com o resto, e cada ponta (web, app) precisaria de uma cópia.
Aqui é uma linha: o dono corrige na tela, o `pg_dump` leva junto, e as duas telas leem
da mesma rota.

**Uma linha só, garantida pelo banco.** `CHECK (id = 1)` é o que impede duas
configurações de loja existirem — a alternativa (confiar que o código sempre pega a
primeira) é o tipo de coisa que fura no dia em que alguém roda o seed duas vezes.
"""

from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, Integer, SmallInteger, String, func, text
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base
from app.core.segmentos import Segmento


class StoreConfig(Base):
    __tablename__ = "store_config"
    __table_args__ = (
        # A linha é única por construção, não por convenção.
        CheckConstraint("id = 1", name="singleton"),
        # Dados fiscais (ADR-41): o código do regime é o CRT da NF-e (1, 2 ou 3).
        CheckConstraint("regime_tributario IN (1, 2, 3)", name="regime_tributario"),
        CheckConstraint("inscricao_estadual ~ '^[0-9]{2,14}$'", name="inscricao_estadual"),
        # 0 a 889: 890+ são séries reservadas da SEFAZ (avulsa, SCAN).
        CheckConstraint("serie_nfce BETWEEN 0 AND 889", name="serie_nfce"),
    )

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=False, default=1)
    nome: Mapped[str] = mapped_column(String(120), nullable=False)
    #: Guardado como texto e validado na borda: segmento novo é uma linha em
    #: `core/segmentos.py`, nunca uma migration.
    segmento: Mapped[str] = mapped_column(
        String(30), nullable=False, default=Segmento.OUTRO.value
    )
    #: Aparecem no recibo quando preenchidos. Opcionais: loja pequena não tem CNPJ.
    documento: Mapped[str | None] = mapped_column(String(24))
    telefone: Mapped[str | None] = mapped_column(String(32))
    endereco: Mapped[str | None] = mapped_column(String(200))

    #: Para a NFC-e (ADR-41). Quem escolhe é o contador; a tela só guarda. Nulo até o dono
    #: preencher — e a emissão recusa dizendo que falta, em vez de chutar um regime.
    #: 1 = Simples Nacional · 2 = Simples, excesso de sublimite · 3 = Regime Normal.
    regime_tributario: Mapped[int | None] = mapped_column(SmallInteger)
    #: Só dígitos. Quem emite NFC-e é contribuinte do ICMS: tem IE.
    inscricao_estadual: Mapped[str | None] = mapped_column(String(14))
    #: Série das NFC-e desta loja. Tem de ser a mesma cadastrada no painel do emissor.
    serie_nfce: Mapped[int] = mapped_column(
        Integer, nullable=False, default=1, server_default=text("1")
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )
