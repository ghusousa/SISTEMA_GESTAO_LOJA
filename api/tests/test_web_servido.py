"""O que mora em `web/` é público.

A API serve a pasta inteira em `/app` (a imagem Docker copia `web/` inteira, e o build da
Vercel também). Teste, rascunho e ferramenta de quem desenvolve ficam FORA dela — o teste
do canal de tempo real do web chegou a morar em `web/testes/` e saía pelo site da loja.
"""

from __future__ import annotations

from pathlib import Path

from httpx import ASGITransport, AsyncClient

from app.main import app

WEB = Path(__file__).resolve().parents[2] / "web"
PASTAS_DE_TESTE = {"testes", "tests", "__tests__", "teste", "test"}


def _parece_teste(arquivo: Path) -> bool:
    relativo = arquivo.relative_to(WEB)
    return (
        ".test." in arquivo.name
        or ".spec." in arquivo.name
        or bool(PASTAS_DE_TESTE & {parte.lower() for parte in relativo.parts[:-1]})
    )


def test_pasta_web_servida_nao_tem_teste() -> None:
    assert WEB.is_dir()
    sobras = sorted(
        str(p.relative_to(WEB)) for p in WEB.rglob("*") if p.is_file() and _parece_teste(p)
    )
    assert sobras == [], f"teste dentro da pasta servida em /app: {sobras}"


async def test_teste_do_web_nao_sai_pelo_site() -> None:
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as cliente:
        r = await cliente.get("/app/testes/tempo-real.test.mjs")
        assert r.status_code == 404
        # E a página continua saindo: o 404 acima não é a pasta inteira fora do ar.
        assert (await cliente.get("/app/js/canal.js")).status_code == 200
