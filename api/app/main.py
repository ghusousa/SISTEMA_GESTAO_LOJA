import logging
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import text

from app.core.config import settings
from app.core.eventos import registrar_avisos_automaticos
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
    # A documentação interativa (Swagger) desenha o mapa inteiro da API: toda rota, todo
    # campo, todo formato de erro. Ótimo para quem desenvolve, presente de bandeja para
    # quem sonda o servidor. Fora de desenvolvimento ela não existe (rota 404).
    docs_url="/docs" if not settings.producao else None,
    redoc_url="/redoc" if not settings.producao else None,
    openapi_url="/openapi.json" if not settings.producao else None,
)


@app.middleware("http")
async def _cabecalhos_de_seguranca(request, call_next):
    """Instrui o navegador a se defender, em toda resposta.

    São três recados curtos que fecham brechas clássicas do lado do cliente: não adivinhe o
    tipo do arquivo (impede um upload ser tratado como script), não me coloque dentro de um
    iframe de outro site (clickjacking), e não vaze o endereço interno como referer.
    """
    resposta = await call_next(request)
    resposta.headers.setdefault("X-Content-Type-Options", "nosniff")
    resposta.headers.setdefault("X-Frame-Options", "DENY")
    resposta.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    return resposta


app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

registrar_handlers(app)

# Toda mutação bem-sucedida vira uma linha no diário de auditoria (só o dono lê).
from app.modules.auditoria.middleware import AuditoriaMiddleware  # noqa: E402

app.add_middleware(AuditoriaMiddleware)


@app.get("/health", tags=["infra"], summary="Healthcheck (verifica o banco)")
async def health() -> dict[str, str]:
    async with engine.connect() as conn:
        await conn.execute(text("SELECT 1"))
    return {"status": "ok", "ambiente": settings.ambiente}


def _montar_rotas() -> None:
    from app.modules.auditoria.router import router as auditoria_router
    from app.modules.backup.router import router as backup_router
    from app.modules.configuracao.router import router as configuracao_router
    from app.modules.auth.router import router as auth_router
    from app.modules.caixa.router import router as caixa_router
    from app.modules.catalogo.router import router as catalogo_router
    from app.modules.despesas.router import router as despesas_router
    from app.modules.estoque.router import router as estoque_router
    from app.modules.fiscal.router import router as fiscal_router
    from app.modules.relatorios.router import router as relatorios_router
    from app.modules.tempo_real.router import router as tempo_real_router
    from app.modules.usuarios.router import router as usuarios_router
    from app.modules.clientes.router import router as clientes_router
    from app.modules.condicionais.router import router as condicionais_router
    from app.modules.contas_pagar.router import router as contas_pagar_router
    from app.modules.sistema.router import router as sistema_router
    from app.modules.taxas.router import router as taxas_router
    from app.modules.vendas.router import router as vendas_router

    for r in (
        auth_router,
        usuarios_router,
        catalogo_router,
        estoque_router,
        vendas_router,
        fiscal_router,
        despesas_router,
        caixa_router,
        relatorios_router,
        tempo_real_router,
        sistema_router,
        clientes_router,
        auditoria_router,
        configuracao_router,
        backup_router,
        taxas_router,
        condicionais_router,
        contas_pagar_router,
    ):
        app.include_router(r, prefix="/api/v1")


_montar_rotas()

# Toda escrita que passa pelo ORM vira aviso para as telas abertas (ver core/eventos.py).
registrar_avisos_automaticos()
# NFC-e sozinha depois da venda, quando FISCAL_EMITIR_AUTOMATICO=1 (ADR-41).
from app.modules.fiscal.automatico import registrar_emissao_automatica  # noqa: E402

registrar_emissao_automatica()

# Fotos de produto. Em produção o Nginx serve /media direto do disco.
_media = Path(settings.media_dir)
_media.mkdir(parents=True, exist_ok=True)
app.mount("/media", StaticFiles(directory=str(_media)), name="media")

# O sistema web é HTML e módulos ES, sem build: o próprio FastAPI entrega os arquivos e a
# loja não precisa de um segundo processo no servidor. Em produção o Nginx pode servir a
# mesma pasta direto, mas nada quebra se ele não fizer isso. A pasta vem da config: `web/` ao
# lado de `api/` (repositório e Docker), ou a cópia que o build da Vercel faz (ADR-42).
_web = Path(settings.web_dir)
if _web.is_dir():
    app.mount("/app", StaticFiles(directory=str(_web), html=True), name="web")

    # Páginas legais em URL própria e SEM login. As duas lojas de app exigem que a política
    # de privacidade e a página de exclusão de dados abram para qualquer pessoa — inclusive
    # para o robô que valida a ficha, que não faz login em lugar nenhum. Ficam fora de /app
    # de propósito: /app é uma SPA por hash, e um endereço com # não serve para essa
    # validação nem para colar no formulário da loja.
    _legal = _web / "legal"

    def _pagina_legal(arquivo: str):
        async def _servir() -> FileResponse:
            caminho = _legal / arquivo
            if not caminho.is_file():
                raise HTTPException(status_code=404, detail="Página não encontrada.")
            return FileResponse(caminho, media_type="text/html")

        return _servir

    if _legal.is_dir():
        app.mount("/legal", StaticFiles(directory=str(_legal)), name="legal")
        app.get("/privacidade", include_in_schema=False)(_pagina_legal("privacidade.html"))
        app.get("/exclusao-de-dados", include_in_schema=False)(_pagina_legal("exclusao-de-dados.html"))

    @app.get("/", include_in_schema=False)
    async def _abrir_sistema() -> RedirectResponse:
        return RedirectResponse("/app/")
