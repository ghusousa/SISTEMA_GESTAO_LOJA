"""Infra de testes: banco real, migrations aplicadas, tabelas limpas entre testes.

Rodar contra Postgres de verdade (e não SQLite) é o que garante que CHECK, UNIQUE parcial,
coluna gerada e concorrência sejam realmente exercitados.
"""

import os
from collections.abc import AsyncGenerator

os.environ.setdefault(
    "DATABASE_URL", "postgresql+asyncpg://postgres:postgres@localhost:5432/loja_test"
)
os.environ.setdefault("JWT_SECRET", "chave-de-teste")

import pytest  # noqa: E402
from alembic import command  # noqa: E402
from alembic.config import Config  # noqa: E402
from httpx import ASGITransport, AsyncClient  # noqa: E402
from sqlalchemy import text  # noqa: E402
from sqlalchemy.ext.asyncio import AsyncSession  # noqa: E402

from app.core.config import settings  # noqa: E402
from app.core.db import SessionLocal, engine, get_session  # noqa: E402
from app.core.security import hash_senha  # noqa: E402
from app.main import app  # noqa: E402
from app.modules.usuarios.models import Papel, User  # noqa: E402

TABELAS = [
    "cash_closing_lines",
    "cash_closings",
    # Tabela nova que não entra aqui vaza entre os testes, e o sintoma é uma falha
    # aleatória num teste que não tem nada a ver — foi assim que este comentário nasceu.
    "sale_return_payments",
    "sale_return_items",
    "sale_returns",
    "vouchers",
    "customer_payments",
    "customers",
    "sale_payments",
    "sale_items",
    "stock_movements",
    "sales",
    "stock_entries",
    "stock_balances",
    "product_variants",
    "products",
    "categories",
    "expenses",
    "expense_categories",
    "audit_log",
    "login_attempts",
    "refresh_tokens",
    "users",
]


@pytest.fixture(scope="session", autouse=True)
def _migrations() -> None:
    cfg = Config("alembic.ini")
    cfg.set_main_option("sqlalchemy.url", settings.database_url)
    command.upgrade(cfg, "head")


@pytest.fixture(autouse=True)
async def _limpar_banco() -> AsyncGenerator[None, None]:
    yield
    async with engine.begin() as conn:
        await conn.execute(text(f"TRUNCATE {', '.join(TABELAS)} RESTART IDENTITY CASCADE"))
        await conn.execute(text("ALTER SEQUENCE internal_barcode_seq RESTART WITH 1"))
        await conn.execute(text("ALTER SEQUENCE voucher_code_seq RESTART WITH 1"))


@pytest.fixture
async def session() -> AsyncGenerator[AsyncSession, None]:
    async with SessionLocal() as s:
        yield s


@pytest.fixture
async def client() -> AsyncGenerator[AsyncClient, None]:
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test/api/v1"
    ) as c:
        yield c


async def _criar_usuario(session: AsyncSession, nome: str, email: str, papel: Papel) -> User:
    user = User(
        name=nome,
        email=email,
        password_hash=hash_senha("senha1234"),
        role=papel,
        is_active=True,
    )
    session.add(user)
    await session.commit()
    await session.refresh(user)
    return user


@pytest.fixture
async def admin(session: AsyncSession) -> User:
    return await _criar_usuario(session, "Dona Maria", "admin@loja.com", Papel.ADMIN)


@pytest.fixture
async def vendedor(session: AsyncSession) -> User:
    return await _criar_usuario(session, "Ana Vendedora", "ana@loja.com", Papel.VENDEDOR)


@pytest.fixture
async def gerente(session: AsyncSession) -> User:
    return await _criar_usuario(session, "Carla Gerente", "carla@loja.com", Papel.GERENTE)


@pytest.fixture
async def supervisora(session: AsyncSession) -> User:
    return await _criar_usuario(session, "Bia Supervisora", "bia@loja.com", Papel.SUPERVISORA)


async def _login(client: AsyncClient, email: str) -> dict[str, str]:
    resp = await client.post("/auth/login", json={"email": email, "senha": "senha1234"})
    assert resp.status_code == 200, resp.text
    return {"Authorization": f"Bearer {resp.json()['access_token']}"}


@pytest.fixture
async def auth_admin(client: AsyncClient, admin: User) -> dict[str, str]:
    return await _login(client, admin.email)


@pytest.fixture
async def auth_vendedor(client: AsyncClient, vendedor: User) -> dict[str, str]:
    return await _login(client, vendedor.email)


@pytest.fixture
async def auth_gerente(client: AsyncClient, gerente: User) -> dict[str, str]:
    return await _login(client, gerente.email)


@pytest.fixture
async def auth_supervisora(client: AsyncClient, supervisora: User) -> dict[str, str]:
    return await _login(client, supervisora.email)


@pytest.fixture(autouse=True)
def _override_session() -> AsyncGenerator[None, None]:
    """A app de teste usa a mesma engine das fixtures (o override é trivial mas explícito)."""

    async def _get_session() -> AsyncGenerator[AsyncSession, None]:
        async with SessionLocal() as s:
            yield s

    app.dependency_overrides[get_session] = _get_session
    yield
    app.dependency_overrides.clear()
