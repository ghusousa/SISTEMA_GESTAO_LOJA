"""Engine, sessão e Base declarativa."""

from collections.abc import AsyncGenerator
from datetime import datetime

from sqlalchemy import DateTime, MetaData, func
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

from app.core.config import settings

# Nomes previsíveis de constraint: sem isso o Alembic gera migrations não determinísticas
# e um `downgrade` não encontra a constraint que criou.
NAMING_CONVENTION = {
    "ix": "ix_%(table_name)s_%(column_0_N_name)s",
    "uq": "uq_%(table_name)s_%(column_0_N_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_N_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
}


class Base(DeclarativeBase):
    metadata = MetaData(naming_convention=NAMING_CONVENTION)


class TimestampMixin:
    """Timestamps sempre timezone-aware: o banco guarda UTC, o fuso da loja é aplicado na leitura."""

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )


engine = create_async_engine(
    settings.database_url,
    echo=settings.db_echo,
    pool_pre_ping=True,
    pool_size=10,
    max_overflow=20,
    # `statement_timeout` por CONEXÃO (vai no startup do asyncpg, antes do primeiro
    # comando): consulta que passa do teto é cancelada pelo próprio Postgres e volta como
    # erro, em vez de seguir ocupando o banco depois que o celular já desistiu dela.
    connect_args={
        "server_settings": {"statement_timeout": str(settings.db_statement_timeout_ms)}
    },
)

SessionLocal = async_sessionmaker(engine, expire_on_commit=False, autoflush=False)


async def get_session() -> AsyncGenerator[AsyncSession, None]:
    """Uma sessão por request. Commit explícito no service; rollback em qualquer erro."""
    async with SessionLocal() as session:
        try:
            yield session
        except Exception:
            await session.rollback()
            raise
