import logging
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from sqlalchemy import text

from app.core.config import settings
from app.core.db import engine
from app.core.exceptions import registrar_handlers

logging.basicConfig(
    level=logging.DEBUG if settings.debug else logging.INFO,
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
)

app = FastAPI(
    title=settings.app_name,
    version="1.0.0",
    description="Gestão de loja de roupas: estoque, PDV, despesas e relatórios.",
    docs_url="/docs",
    openapi_url="/openapi.json",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

registrar_handlers(app)


@app.get("/health", tags=["infra"], summary="Healthcheck (verifica o banco)")
async def health() -> dict[str, str]:
    async with engine.connect() as conn:
        await conn.execute(text("SELECT 1"))
    return {"status": "ok", "ambiente": settings.ambiente}


def _montar_rotas() -> None:
    from app.modules.auth.router import router as auth_router
    from app.modules.caixa.router import router as caixa_router
    from app.modules.catalogo.router import router as catalogo_router
    from app.modules.despesas.router import router as despesas_router
    from app.modules.estoque.router import router as estoque_router
    from app.modules.relatorios.router import router as relatorios_router
    from app.modules.usuarios.router import router as usuarios_router
    from app.modules.vendas.router import router as vendas_router

    for r in (
        auth_router,
        usuarios_router,
        catalogo_router,
        estoque_router,
        vendas_router,
        despesas_router,
        caixa_router,
        relatorios_router,
    ):
        app.include_router(r, prefix="/api/v1")


_montar_rotas()

# Fotos de produto. Em produção o Nginx serve /media direto do disco.
_media = Path(settings.media_dir)
_media.mkdir(parents=True, exist_ok=True)
app.mount("/media", StaticFiles(directory=str(_media)), name="media")
