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
    "notas_fiscais",
    "sale_payments",
    "sale_items",
    "stock_movements",
    "consignment_items",
    "consignments",
    "payables",
    "sales",
    "stock_entries",
    "stock_balances",
    "product_variants",
    "products",
    "categories",
    "expenses",
    "expense_categories",
    "store_config",
    "backup_config",
    "card_fees",
    "leitor_bipes",
    "leitor_pareamentos",
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


async def criar_produto(client: AsyncClient, auth: dict[str, str], payload: dict) -> dict:
    """Cria o produto e, se o payload pedir estoque, dá a entrada — pelo caminho de verdade.

    O cadastro deixou de criar estoque (ADR-29): mercadoria entra por UMA porta, a Entrada.
    Este helper existe para os testes continuarem legíveis (`"estoque_inicial": 5` no
    payload diz o que o cenário precisa) sem mentir sobre o fluxo: por baixo ele faz as
    DUAS chamadas que a loja faz, e é a Entrada de verdade que põe o saldo. Se ela quebrar,
    quebra aqui — que é o ponto.
    """
    import uuid as _uuid

    pedido = {**payload, "variantes": [dict(v) for v in payload.get("variantes", [])]}
    quantidades = [v.pop("estoque_inicial", 0) for v in pedido["variantes"]]

    resp = await client.post("/produtos", headers=auth, json=pedido)
    assert resp.status_code == 201, resp.text
    produto = resp.json()

    itens = [
        {"variante_id": variante["id"], "quantidade": qtd}
        for variante, qtd in zip(produto["variantes"], quantidades, strict=False)
        if qtd > 0
    ]
    if itens:
        entrada = await client.post(
            "/estoque/entradas",
            headers=auth,
            json={
                "client_uuid": str(_uuid.uuid4()),
                "fornecedor": "Fornecedor de teste",
                "itens": itens,
            },
        )
        assert entrada.status_code in (200, 201), entrada.text
        produto = (await client.get(f"/produtos/{produto['id']}", headers=auth)).json()
    return produto


async def dar_entrada(client: AsyncClient, auth: dict[str, str], **quantidades: int) -> None:
    """Põe estoque numa peça pela porta de verdade. Chave = id da variante, em texto."""
    import uuid as _uuid

    resp = await client.post(
        "/estoque/entradas",
        headers=auth,
        json={
            "client_uuid": str(_uuid.uuid4()),
            "fornecedor": "Fornecedor de teste",
            "itens": [
                {"variante_id": int(vid), "quantidade": qtd}
                for vid, qtd in quantidades.items()
                if qtd > 0
            ],
        },
    )
    assert resp.status_code in (200, 201), resp.text
