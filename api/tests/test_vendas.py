import asyncio
import uuid

import pytest
from httpx import ASGITransport, AsyncClient

from app.main import app


@pytest.fixture
async def loja(client: AsyncClient, auth_admin: dict[str, str]) -> dict:
    """Camiseta P (10 peças, custo 20, venda 49,90) e Calça M (1 peça, custo 60, venda 149,90)."""
    cat_camisa = (
        await client.post("/categorias", headers=auth_admin, json={"nome": "Camisetas"})
    ).json()["id"]
    cat_calca = (
        await client.post("/categorias", headers=auth_admin, json={"nome": "Calças"})
    ).json()["id"]

    camiseta = (
        await client.post(
            "/produtos",
            headers=auth_admin,
            json={
                "categoria_id": cat_camisa,
                "nome": "Camiseta Lisa",
                "variantes": [
                    {
                        "tamanho": "P",
                        "cor": "Branca",
                        "codigo_barras": "7891111111117",
                        "preco_custo": "20.00",
                        "preco_venda": "49.90",
                        "estoque_inicial": 10,
                    }
                ],
            },
        )
    ).json()
    calca = (
        await client.post(
            "/produtos",
            headers=auth_admin,
            json={
                "categoria_id": cat_calca,
                "nome": "Calça Jeans",
                "variantes": [
                    {
                        "tamanho": "M",
                        "cor": "Azul",
                        "codigo_barras": "7892222222224",
                        "preco_custo": "60.00",
                        "preco_venda": "149.90",
                        "estoque_inicial": 1,
                    }
                ],
            },
        )
    ).json()
    return {
        "camiseta": camiseta["variantes"][0]["id"],
        "calca": calca["variantes"][0]["id"],
    }


async def _saldo(client: AsyncClient, headers: dict, variante_id: int) -> int:
    saldos = (await client.get("/estoque/saldos", headers=headers)).json()
    return next(s["saldo"] for s in saldos["items"] if s["variante_id"] == variante_id)


# ------------------------------------------------------------------ venda feliz
async def test_venda_baixa_estoque_e_registra_movimentacao(
    client: AsyncClient, auth_vendedor: dict[str, str], loja: dict
) -> None:
    resp = await client.post(
        "/vendas",
        headers=auth_vendedor,
        json={
            "client_uuid": str(uuid.uuid4()),
            "itens": [{"variante_id": loja["camiseta"], "quantidade": 2}],
            "pagamentos": [{"forma": "PIX", "valor": "99.80"}],
        },
    )
    assert resp.status_code == 201, resp.text
    venda = resp.json()
    assert venda["subtotal"] == "99.80"
    assert venda["total"] == "99.80"
    assert venda["quantidade_pecas"] == 2
    assert venda["status"] == "CONCLUIDA"

    assert await _saldo(client, auth_vendedor, loja["camiseta"]) == 8

    movs = (
        await client.get(
            "/estoque/movimentacoes", headers=auth_vendedor, params={"tipo": "VENDA"}
        )
    ).json()
    assert movs["total"] == 1
    assert movs["items"][0]["quantidade"] == -2
    assert movs["items"][0]["venda_id"] == venda["id"]


async def test_venda_com_desconto_e_pagamento_misto(
    client: AsyncClient, auth_vendedor: dict[str, str], loja: dict
) -> None:
    resp = await client.post(
        "/vendas",
        headers=auth_vendedor,
        json={
            "client_uuid": str(uuid.uuid4()),
            "desconto": "9.80",
            "itens": [
                {"variante_id": loja["camiseta"], "quantidade": 1},
                {"variante_id": loja["calca"], "quantidade": 1},
            ],
            "pagamentos": [
                {"forma": "DINHEIRO", "valor": "100.00"},
                {"forma": "PIX", "valor": "90.00"},
            ],
        },
    )
    assert resp.status_code == 201, resp.text
    venda = resp.json()
    assert venda["subtotal"] == "199.80"
    assert venda["desconto"] == "9.80"
    assert venda["total"] == "190.00"
    assert len(venda["pagamentos"]) == 2


async def test_preco_e_custo_ficam_congelados_na_venda(
    client: AsyncClient, auth_admin: dict[str, str], loja: dict
) -> None:
    """Reajustar o preço amanhã não pode reescrever o lucro de hoje."""
    venda_id = (
        await client.post(
            "/vendas",
            headers=auth_admin,
            json={
                "client_uuid": str(uuid.uuid4()),
                "itens": [{"variante_id": loja["camiseta"], "quantidade": 1}],
                "pagamentos": [{"forma": "DEBITO", "valor": "49.90"}],
            },
        )
    ).json()["id"]

    await client.patch(
        f"/variantes/{loja['camiseta']}",
        headers=auth_admin,
        json={"preco_venda": "79.90", "preco_custo": "35.00"},
    )

    venda = (await client.get(f"/vendas/{venda_id}", headers=auth_admin)).json()
    assert venda["itens"][0]["preco_unitario"] == "49.90"
    assert venda["itens"][0]["custo_unitario"] == "20.00"
    assert venda["lucro_bruto"] == "29.90"


# ------------------------------------------------------------------ validações
async def test_pagamento_que_nao_fecha_o_total_e_recusado(
    client: AsyncClient, auth_vendedor: dict[str, str], loja: dict
) -> None:
    resp = await client.post(
        "/vendas",
        headers=auth_vendedor,
        json={
            "client_uuid": str(uuid.uuid4()),
            "itens": [{"variante_id": loja["camiseta"], "quantidade": 2}],
            "pagamentos": [{"forma": "PIX", "valor": "50.00"}],
        },
    )
    assert resp.status_code == 422
    corpo = resp.json()
    assert corpo["code"] == "PAGAMENTO_DIVERGENTE"
    # O app precisa do total correto para refazer a cobrança sem adivinhar.
    assert corpo["detail"]["total_da_venda"] == "99.80"


async def test_venda_sem_estoque_e_recusada_e_nao_deixa_rastro(
    client: AsyncClient, auth_vendedor: dict[str, str], loja: dict
) -> None:
    resp = await client.post(
        "/vendas",
        headers=auth_vendedor,
        json={
            "client_uuid": str(uuid.uuid4()),
            "itens": [{"variante_id": loja["calca"], "quantidade": 5}],
            "pagamentos": [{"forma": "PIX", "valor": "749.50"}],
        },
    )
    assert resp.status_code == 409
    assert resp.json()["code"] == "ESTOQUE_INSUFICIENTE"

    vendas = (await client.get("/vendas", headers=auth_vendedor)).json()
    assert vendas["total"] == 0
    assert await _saldo(client, auth_vendedor, loja["calca"]) == 1


async def test_venda_atomica_nao_baixa_nada_se_um_item_faltar(
    client: AsyncClient, auth_vendedor: dict[str, str], loja: dict
) -> None:
    """A camiseta tem saldo; a calça não tem o suficiente. Nada pode ser baixado."""
    resp = await client.post(
        "/vendas",
        headers=auth_vendedor,
        json={
            "client_uuid": str(uuid.uuid4()),
            "itens": [
                {"variante_id": loja["camiseta"], "quantidade": 1},
                {"variante_id": loja["calca"], "quantidade": 3},
            ],
            "pagamentos": [{"forma": "PIX", "valor": "499.60"}],
        },
    )
    assert resp.status_code == 409
    assert await _saldo(client, auth_vendedor, loja["camiseta"]) == 10
    assert await _saldo(client, auth_vendedor, loja["calca"]) == 1


async def test_desconto_maior_que_a_venda_e_recusado(
    client: AsyncClient, auth_vendedor: dict[str, str], loja: dict
) -> None:
    resp = await client.post(
        "/vendas",
        headers=auth_vendedor,
        json={
            "client_uuid": str(uuid.uuid4()),
            "desconto": "999.00",
            "itens": [{"variante_id": loja["camiseta"], "quantidade": 1}],
            "pagamentos": [{"forma": "PIX", "valor": "1.00"}],
        },
    )
    assert resp.status_code == 422
    assert resp.json()["code"] == "VALIDACAO"


async def test_venda_de_peca_inexistente_retorna_404(
    client: AsyncClient, auth_vendedor: dict[str, str]
) -> None:
    resp = await client.post(
        "/vendas",
        headers=auth_vendedor,
        json={
            "client_uuid": str(uuid.uuid4()),
            "itens": [{"variante_id": 4242, "quantidade": 1}],
            "pagamentos": [{"forma": "PIX", "valor": "10.00"}],
        },
    )
    assert resp.status_code == 404


# ------------------------------------------------------------------ idempotência
async def test_reenvio_da_mesma_venda_nao_duplica(
    client: AsyncClient, auth_vendedor: dict[str, str], loja: dict
) -> None:
    payload = {
        "client_uuid": str(uuid.uuid4()),
        "itens": [{"variante_id": loja["camiseta"], "quantidade": 2}],
        "pagamentos": [{"forma": "PIX", "valor": "99.80"}],
    }
    primeira = await client.post("/vendas", headers=auth_vendedor, json=payload)
    segunda = await client.post("/vendas", headers=auth_vendedor, json=payload)

    assert primeira.json()["id"] == segunda.json()["id"]
    assert await _saldo(client, auth_vendedor, loja["camiseta"]) == 8
    assert (await client.get("/vendas", headers=auth_vendedor)).json()["total"] == 1


async def test_duas_vendas_simultaneas_da_ultima_peca_so_uma_passa(
    client: AsyncClient, auth_vendedor: dict[str, str], loja: dict
) -> None:
    """A calça tem 1 peça. Duas vendas ao mesmo tempo: uma vende, a outra recebe 409."""
    payload = lambda: {  # noqa: E731
        "client_uuid": str(uuid.uuid4()),
        "itens": [{"variante_id": loja["calca"], "quantidade": 1}],
        "pagamentos": [{"forma": "PIX", "valor": "149.90"}],
    }

    async def vender() -> int:
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test/api/v1"
        ) as c:
            resp = await c.post("/vendas", headers=auth_vendedor, json=payload())
            return resp.status_code

    resultados = await asyncio.gather(vender(), vender())
    assert sorted(resultados) == [201, 409]
    assert await _saldo(client, auth_vendedor, loja["calca"]) == 0


# ------------------------------------------------------------------ cancelamento
async def test_cancelamento_devolve_o_estoque(
    client: AsyncClient, auth_admin: dict[str, str], loja: dict
) -> None:
    venda_id = (
        await client.post(
            "/vendas",
            headers=auth_admin,
            json={
                "client_uuid": str(uuid.uuid4()),
                "itens": [{"variante_id": loja["camiseta"], "quantidade": 3}],
                "pagamentos": [{"forma": "CREDITO", "valor": "149.70"}],
            },
        )
    ).json()["id"]
    assert await _saldo(client, auth_admin, loja["camiseta"]) == 7

    resp = await client.post(
        f"/vendas/{venda_id}/cancelamento",
        headers=auth_admin,
        json={"motivo": "cliente desistiu"},
    )
    assert resp.status_code == 200
    assert resp.json()["status"] == "CANCELADA"
    assert resp.json()["motivo_cancelamento"] == "cliente desistiu"
    assert await _saldo(client, auth_admin, loja["camiseta"]) == 10

    movs = (
        await client.get(
            "/estoque/movimentacoes", headers=auth_admin, params={"tipo": "ESTORNO"}
        )
    ).json()
    assert movs["items"][0]["quantidade"] == 3


async def test_venda_cancelada_nao_pode_ser_cancelada_de_novo(
    client: AsyncClient, auth_admin: dict[str, str], loja: dict
) -> None:
    venda_id = (
        await client.post(
            "/vendas",
            headers=auth_admin,
            json={
                "client_uuid": str(uuid.uuid4()),
                "itens": [{"variante_id": loja["camiseta"], "quantidade": 1}],
                "pagamentos": [{"forma": "PIX", "valor": "49.90"}],
            },
        )
    ).json()["id"]
    await client.post(
        f"/vendas/{venda_id}/cancelamento", headers=auth_admin, json={"motivo": "erro"}
    )
    resp = await client.post(
        f"/vendas/{venda_id}/cancelamento", headers=auth_admin, json={"motivo": "de novo"}
    )
    assert resp.status_code == 409
    assert resp.json()["code"] == "OPERACAO_INVALIDA"
    assert await _saldo(client, auth_admin, loja["camiseta"]) == 10


async def test_vendedor_nao_cancela_venda_de_outro(
    client: AsyncClient,
    auth_admin: dict[str, str],
    auth_vendedor: dict[str, str],
    loja: dict,
) -> None:
    """404, não 403: dizer "não é sua" confirmaria a existência da venda alheia."""
    venda_id = (
        await client.post(
            "/vendas",
            headers=auth_admin,
            json={
                "client_uuid": str(uuid.uuid4()),
                "itens": [{"variante_id": loja["camiseta"], "quantidade": 1}],
                "pagamentos": [{"forma": "PIX", "valor": "49.90"}],
            },
        )
    ).json()["id"]
    resp = await client.post(
        f"/vendas/{venda_id}/cancelamento",
        headers=auth_vendedor,
        json={"motivo": "não foi minha"},
    )
    assert resp.status_code == 404
    assert resp.json()["code"] == "NAO_ENCONTRADO"


async def test_dois_cancelamentos_simultaneos_estornam_uma_vez_so(
    client: AsyncClient, auth_admin: dict[str, str], loja: dict
) -> None:
    """Toque duplo em "cancelar" não pode devolver a peça duas vezes ao estoque."""
    venda_id = (
        await client.post(
            "/vendas",
            headers=auth_admin,
            json={
                "client_uuid": str(uuid.uuid4()),
                "itens": [{"variante_id": loja["camiseta"], "quantidade": 3}],
                "pagamentos": [{"forma": "PIX", "valor": "149.70"}],
            },
        )
    ).json()["id"]
    assert await _saldo(client, auth_admin, loja["camiseta"]) == 7

    async def cancelar() -> int:
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test/api/v1"
        ) as c:
            resp = await c.post(
                f"/vendas/{venda_id}/cancelamento",
                headers=auth_admin,
                json={"motivo": "cliente desistiu"},
            )
            return resp.status_code

    resultados = await asyncio.gather(cancelar(), cancelar())
    assert sorted(resultados) == [200, 409]
    assert await _saldo(client, auth_admin, loja["camiseta"]) == 10

    movs = (
        await client.get(
            "/estoque/movimentacoes", headers=auth_admin, params={"tipo": "ESTORNO"}
        )
    ).json()
    assert movs["total"] == 1, "o estorno não pode acontecer duas vezes"


async def test_replay_de_venda_alheia_e_recusado(
    client: AsyncClient,
    auth_admin: dict[str, str],
    auth_vendedor: dict[str, str],
    loja: dict,
) -> None:
    """O atalho de idempotência não pode virar porta de leitura de venda de outro."""
    client_uuid = str(uuid.uuid4())
    await client.post(
        "/vendas",
        headers=auth_admin,
        json={
            "client_uuid": client_uuid,
            "itens": [{"variante_id": loja["camiseta"], "quantidade": 1}],
            "pagamentos": [{"forma": "PIX", "valor": "49.90"}],
        },
    )
    resp = await client.post(
        "/vendas",
        headers=auth_vendedor,
        json={
            "client_uuid": client_uuid,
            "itens": [{"variante_id": loja["camiseta"], "quantidade": 1}],
            "pagamentos": [{"forma": "PIX", "valor": "49.90"}],
        },
    )
    assert resp.status_code == 403


# ------------------------------------------------------------------ visibilidade
async def test_vendedor_nao_ve_custo_nem_lucro_da_venda(
    client: AsyncClient, auth_vendedor: dict[str, str], loja: dict
) -> None:
    venda_id = (
        await client.post(
            "/vendas",
            headers=auth_vendedor,
            json={
                "client_uuid": str(uuid.uuid4()),
                "itens": [{"variante_id": loja["camiseta"], "quantidade": 1}],
                "pagamentos": [{"forma": "PIX", "valor": "49.90"}],
            },
        )
    ).json()
    assert "lucro_bruto" not in venda_id
    assert "custo_unitario" not in venda_id["itens"][0]

    detalhe = (await client.get(f"/vendas/{venda_id['id']}", headers=auth_vendedor)).text
    assert "custo" not in detalhe


async def test_vendedor_lista_apenas_as_proprias_vendas(
    client: AsyncClient,
    auth_admin: dict[str, str],
    auth_vendedor: dict[str, str],
    loja: dict,
) -> None:
    for headers in (auth_admin, auth_vendedor):
        await client.post(
            "/vendas",
            headers=headers,
            json={
                "client_uuid": str(uuid.uuid4()),
                "itens": [{"variante_id": loja["camiseta"], "quantidade": 1}],
                "pagamentos": [{"forma": "PIX", "valor": "49.90"}],
            },
        )

    assert (await client.get("/vendas", headers=auth_admin)).json()["total"] == 2
    minhas = (await client.get("/vendas", headers=auth_vendedor)).json()
    assert minhas["total"] == 1
    assert minhas["items"][0]["vendedor"] == "João Vendedor"


async def test_vendedor_nao_abre_venda_de_outro_pelo_id(
    client: AsyncClient,
    auth_admin: dict[str, str],
    auth_vendedor: dict[str, str],
    loja: dict,
) -> None:
    venda_id = (
        await client.post(
            "/vendas",
            headers=auth_admin,
            json={
                "client_uuid": str(uuid.uuid4()),
                "itens": [{"variante_id": loja["camiseta"], "quantidade": 1}],
                "pagamentos": [{"forma": "PIX", "valor": "49.90"}],
            },
        )
    ).json()["id"]
    resp = await client.get(f"/vendas/{venda_id}", headers=auth_vendedor)
    assert resp.status_code == 404
