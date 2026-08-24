"""A configuração do backup para a nuvem, e o retrato de como foi a última vez.

**Quem faz o backup é o `backup.sh`, na máquina — não a API.** É a mesma separação do
`atualizar.sh` (ADR-18): a credencial do Google não entra no contêiner que serve a loja.
A API só GUARDA a configuração e LÊ o estado; quem tem `pg_dump`, `rclone` e o disco é o
script lá fora, que lê esta linha pelo banco e escreve o resultado de volta nela.

Uma linha só, garantida por `CHECK (id = 1)`, como `store_config`.
"""

from datetime import datetime

from sqlalchemy import BigInteger, Boolean, CheckConstraint, DateTime, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base


class BackupConfig(Base):
    __tablename__ = "backup_config"
    __table_args__ = (
        CheckConstraint("id = 1", name="singleton"),
        CheckConstraint("manter >= 2", name="manter_minimo"),
        CheckConstraint("intervalo_min >= 5", name="intervalo_minimo"),
    )

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=False, default=1)

    #: Liga e desliga sem perder o token — quem desliga geralmente quer religar.
    ativo: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    #: O token do `rclone authorize "drive"`, em JSON. É uma CREDENCIAL do Google:
    #: **nunca sai por rota nenhuma**, nem para o dono. A tela mostra "configurado" ou
    #: "não configurado", e para trocar manda um token novo por cima.
    rclone_token: Mapped[str | None] = mapped_column(Text)

    #: Pasta dentro do Drive. Nasce da própria loja, para duas lojas não se misturarem.
    pasta: Mapped[str] = mapped_column(String(120), nullable=False, default="backups-loja")

    #: Quantas cópias ficam no Drive. Ao gravar a 11ª, a 1ª é apagada.
    manter: Mapped[int] = mapped_column(Integer, nullable=False, default=10)

    #: De quantos em quantos minutos. Vira o `OnUnitActiveSec` do timer do systemd.
    intervalo_min: Mapped[int] = mapped_column(Integer, nullable=False, default=30)

    # ------------------------------------------------------- o retrato da última vez
    # Sem isto a tela só saberia dizer "está ligado", que é justamente o que uma
    # configuração quebrada também diz. O que dá confiança é "há 12 minutos, 4,2 MB".
    ultimo_em: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    ultimo_ok: Mapped[bool | None] = mapped_column(Boolean)
    ultimo_erro: Mapped[str | None] = mapped_column(Text)
    ultimo_bytes: Mapped[int | None] = mapped_column(BigInteger)
    #: Quantas cópias existem no Drive agora, contadas pelo script depois da faxina.
    copias_na_nuvem: Mapped[int | None] = mapped_column(Integer)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )
