"""Erros do banco que chegam à borda da API: o que vira resposta e o que nunca vai ao log.

Duas regras:

- **Número que não cabe no banco é pedido inválido (422), não erro do servidor (500).** Um
  id 99999999999 numa rota `/{id}`, um `?page=` gigante (o OFFSET estoura o BIGINT), um
  `substitui_id` enorme no corpo: o asyncpg recusa o valor ANTES de mandar o comando, e isso
  subia como 500 com traceback no log — em toda rota com número, desde sempre.
- **O erro do banco não repete os valores do comando.** O traceback que o uvicorn escreve
  levaria os parâmetros: token de push, e-mail, hash de senha, a credencial do backup.
"""

import uuid

import pytest
from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from app.core.db import engine
from app.main import app

#: Um a mais que o maior INTEGER do Postgres, e um a mais que o maior BIGINT.
NAO_CABEM = (2**31, 2**63)
PREFIXO = "/api/v1"


async def test_erro_do_banco_nao_repete_os_parametros_do_comando() -> None:
    segredo = "ExponentPushToken[nao-repete-no-erro]"
    async with engine.connect() as conn:
        with pytest.raises(DBAPIError) as erro:
            await conn.execute(text("SELECT CAST(:s AS text), 1 / 0"), {"s": segredo})
    assert "division by zero" in str(erro.value), "a causa do erro tem de continuar"
    assert "nao-repete-no-erro" not in str(erro.value)


async def test_numero_que_nao_cabe_no_banco_e_422_nas_rotas_do_leitor(
    client: AsyncClient, auth_admin: dict[str, str]
) -> None:
    casos = [
        ("POST", "/leitor/chamados/99999999999/atender", {"instalacao": str(uuid.uuid4())}),
        (
            "POST",
            "/leitor/chamados",
            {"client_uuid": str(uuid.uuid4()), "substitui_id": 99_999_999_999},
        ),
        ("POST", "/leitor/pareamentos", {"substitui_id": 99_999_999_999}),
        ("GET", "/leitor/chamados/abertos?page=1000000000000000000", None),
        ("GET", "/leitor/pareamentos/99999999999", None),
        ("DELETE", "/leitor/pareamentos/99999999999?ponta=celular", None),
        ("POST", "/leitor/pareamentos/99999999999/retirar", None),
        (
            "POST",
            "/leitor/bipes",
            {"client_uuid": str(uuid.uuid4()), "pareamento_id": 99_999_999_999, "codigo": "789"},
        ),
        # O mesmo defeito, de antes do leitor: a regra vale para a API inteira.
        ("GET", "/vendas/99999999999", None),
        ("GET", "/vendas?cliente_id=99999999999", None),
    ]
    for metodo, caminho, corpo in casos:
        r = await client.request(metodo, caminho, headers=auth_admin, json=corpo)
        assert r.status_code == 422, (metodo, caminho, r.status_code, r.text)
        assert r.json()["code"] == "VALIDACAO", r.text
    # Nada foi criado pelo caminho: o chamado com o `substitui_id` torto não nasceu.
    abertos = await client.get("/leitor/chamados/abertos", headers=auth_admin)
    assert abertos.json()["items"] == []


def _rotas_com_numero() -> list[tuple[str, str, list[str], list[str]]]:
    """(método, caminho sem o prefixo, parâmetros inteiros do caminho, inteiros da query)."""
    rotas = []
    for caminho, operacoes in app.openapi()["paths"].items():
        for metodo, op in operacoes.items():
            no_caminho, na_query = [], []
            for p in op.get("parameters", []):
                esquema = p.get("schema", {})
                tipos = {esquema.get("type")} | {s.get("type") for s in esquema.get("anyOf", [])}
                if "integer" not in tipos:
                    continue
                (no_caminho if p["in"] == "path" else na_query).append(p["name"])
            if no_caminho or na_query:
                rotas.append((metodo.upper(), caminho.removeprefix(PREFIXO), no_caminho, na_query))
    return rotas


def _montar(caminho: str, valores: dict[str, int]) -> str:
    for nome, valor in valores.items():
        caminho = caminho.replace("{" + nome + "}", str(valor))
    return caminho


async def test_nenhuma_rota_da_500_com_numero_que_nao_cabe_no_banco(
    client: AsyncClient, auth_admin: dict[str, str]
) -> None:
    """A guarda da regra, para a rota que ainda vai nascer: toda rota com número no caminho
    (e toda consulta com número na query) responde 4xx a um número que não cabe no banco."""
    rotas = _rotas_com_numero()
    assert any("{pareamento_id}" in c for _, c, _, _ in rotas), "a varredura não achou as rotas"
    vistas = 0
    for metodo, caminho, no_caminho, na_query in rotas:
        com_corpo = metodo in ("POST", "PUT", "PATCH")
        for grande in NAO_CABEM:
            pedidos = []
            if no_caminho:
                pedidos.append(_montar(caminho, dict.fromkeys(no_caminho, grande)))
            if metodo == "GET":
                base = _montar(caminho, dict.fromkeys(no_caminho, 1))
                pedidos += [f"{base}?{nome}={grande}" for nome in na_query]
            for url in pedidos:
                r = await client.request(
                    metodo, url, headers=auth_admin, json={} if com_corpo else None
                )
                assert r.status_code < 500, (metodo, url, r.status_code, r.text)
                vistas += 1
    assert vistas > 100, vistas
