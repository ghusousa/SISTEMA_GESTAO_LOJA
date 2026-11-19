"""Os aparelhos que o computador consegue chamar (ADR-47).

Uma linha por INSTALAÇÃO do app neste servidor, ligada ao login que está nela agora. É a base
de duas perguntas do chamado do leitor: existe app atualizado com este login? (`SEM_CELULAR`
só diz a verdade porque o app novo se registra a cada sessão, com ou sem permissão de
notificação, e o token é opcional) e para onde vai o push?

**O token é credencial ao portador.** Com o `ExponentPushToken` de alguém, qualquer pessoa
manda pela API pública da Expo uma notificação com o nome e o ícone do app — sem segredo
nenhum. Por isso ele nunca sai em rota, em log, em `repr` nem em backup (os `pg_dump` levam
só a estrutura desta tabela), e some no logout, na troca de senha, na desativação, na
exclusão da conta e depois de 30 dias sem o app se registrar.

FK `CASCADE` para `users`, como o refresh token: não é histórico da loja, e um RESTRICT faria
a exclusão de conta (ADR-45) tratar a pessoa como "com histórico" por causa de um celular.
"""

import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, String, func
from sqlalchemy.dialects.postgresql import UUID as PgUUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base


class AparelhoDeNotificacao(Base):
    """Uma instalação do app que o chamado do leitor alcança.

    Sem `__repr__` próprio, de propósito: o padrão não mostra coluna nenhuma, e é assim que o
    token fica fora de log e de traceback. Quem lê e escreve é o repositório, em SQL Core.
    """

    __tablename__ = "notificacao_aparelhos"
    __table_args__ = (CheckConstraint("plataforma IN ('ios','android')", name="plataforma"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    #: UUID v4 sorteado pelo app e guardado no aparelho; refeito quando o app troca de
    #: servidor. É a chave do registro: um aparelho é de um login por vez.
    instalacao: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), nullable=False, unique=True
    )
    plataforma: Mapped[str] = mapped_column(String(10), nullable=False)
    #: O `ExponentPushToken[...]`. NULL: o app está lá, mas não recebe push (sem permissão,
    #: Android sem FCM, Expo Go) — o chamado chega a ele só com o app aberto.
    token: Mapped[str | None] = mapped_column(String(200), unique=True)
    criado_em: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    #: Renovado a cada registro. Base da faxina de 30 dias e do teto de 10 aparelhos por login.
    visto_em: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
