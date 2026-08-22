import uuid
from datetime import UTC, datetime, timedelta

import pytest
from httpx import AsyncClient

from app.core.config import settings


def _hoje_loja():
    return datetime.now(UTC).astimezone(settings.tz_loja).date()


@pytest.fixture
async def vendas_do_dia(client: AsyncClient, auth_admin: dict[str, str]) -> dict:
    """Vendas de hoje: 100,00 em PIX e 90,00 dinheiro + 100,00 débito."""
    categoria = (
        await client.post("/categorias", headers=auth_admin, json={"nome": "Roupas"})
    ).json()["id"]
    produto = (
        await client.post(
            "/produtos",
            headers=auth_admin,
            json={
                "categoria_id": categoria,
                "nome": "Camiseta",
                "variantes": [
                    {
                        "tamanho": "M",
                        "cor": "Branca",
                        "codigo_barras": "7891111111117",
                        "preco_custo": "20.00",
                        "preco_venda": "50.00",
                        "estoque_inicial": 20,
                    }
                ],
            },
        )
    ).json()
    variante = produto["variantes"][0]["id"]

    await client.post(
        "/vendas",
        headers=auth_admin,
        json={
            "client_uuid": str(uuid.uuid4()),
            "itens": [{"variante_id": variante, "quantidade": 2}],
            "pagamentos": [{"forma": "PIX", "valor": "100.00"}],
        },
    )
    await client.post(
        "/vendas",
        headers=auth_admin,
        json={
            "client_uuid": str(uuid.uuid4()),
            "desconto": "10.00",
            "itens": [{"variante_id": variante, "quantidade": 4}],
            "pagamentos": [
                {"forma": "DINHEIRO", "valor": "90.00"},
                {"forma": "DEBITO", "valor": "100.00"},
            ],
        },
    )
    return {"variante": variante}


async def test_dia_mostra_o_esperado_por_forma_de_pagamento(
    client: AsyncClient, auth_admin: dict[str, str], vendas_do_dia: dict
) -> None:
    resp = await client.get("/caixa/dia", headers=auth_admin)
    assert resp.status_code == 200, resp.text
    corpo = resp.json()
    por_forma = {linha["forma"]: linha["esperado"] for linha in corpo["linhas"]}
    assert por_forma["PIX"] == "100.00"
    assert por_forma["DINHEIRO"] == "90.00"
    assert por_forma["DEBITO"] == "100.00"
    assert por_forma["CREDITO"] == "0.00"
    assert corpo["total_esperado"] == "290.00"
    assert corpo["quantidade_vendas"] == 2
    assert corpo["fechado"] is False


async def test_venda_cancelada_sai_do_esperado(
    client: AsyncClient, auth_admin: dict[str, str], vendas_do_dia: dict
) -> None:
    venda_pix = next(
        v
        for v in (await client.get("/vendas", headers=auth_admin)).json()["items"]
        if v["formas_pagamento"] == ["PIX"]
    )
    await client.post(
        f"/vendas/{venda_pix['id']}/cancelamento",
        headers=auth_admin,
        json={"motivo": "cliente desistiu"},
    )
    corpo = (await client.get("/caixa/dia", headers=auth_admin)).json()
    assert corpo["total_esperado"] == "190.00"
    assert corpo["quantidade_canceladas"] == 1


async def test_fechamento_registra_a_diferenca(
    client: AsyncClient, auth_admin: dict[str, str], vendas_do_dia: dict
) -> None:
    """Faltaram 10 reais na gaveta: a diferença precisa aparecer, não ser escondida."""
    resp = await client.post(
        "/caixa/fechamentos",
        headers=auth_admin,
        json={
            "data": _hoje_loja().isoformat(),
            "contagens": [
                {"forma": "DINHEIRO", "valor_contado": "80.00"},
                {"forma": "PIX", "valor_contado": "100.00"},
                {"forma": "DEBITO", "valor_contado": "100.00"},
            ],
            "observacao": "faltou troco",
        },
    )
    assert resp.status_code == 201, resp.text
    corpo = resp.json()
    assert corpo["total_esperado"] == "290.00"
    assert corpo["total_contado"] == "280.00"
    assert corpo["diferenca"] == "-10.00"
    dinheiro = next(linha for linha in corpo["linhas"] if linha["forma"] == "DINHEIRO")
    assert dinheiro["diferenca"] == "-10.00"
    assert corpo["fechado_por"] == "Dona Maria"


async def test_refechar_o_mesmo_dia_atualiza_em_vez_de_duplicar(
    client: AsyncClient, auth_admin: dict[str, str], vendas_do_dia: dict
) -> None:
    hoje = _hoje_loja().isoformat()
    primeiro = await client.post(
        "/caixa/fechamentos",
        headers=auth_admin,
        json={
            "data": hoje,
            "contagens": [
                {"forma": "DINHEIRO", "valor_contado": "80.00"},
                {"forma": "PIX", "valor_contado": "100.00"},
                {"forma": "DEBITO", "valor_contado": "100.00"},
            ],
        },
    )
    segundo = await client.post(
        "/caixa/fechamentos",
        headers=auth_admin,
        json={
            "data": hoje,
            "contagens": [
                {"forma": "DINHEIRO", "valor_contado": "90.00"},
                {"forma": "PIX", "valor_contado": "100.00"},
                {"forma": "DEBITO", "valor_contado": "100.00"},
            ],
        },
    )
    assert primeiro.json()["id"] == segundo.json()["id"]
    assert segundo.json()["diferenca"] == "0.00"

    historico = await client.get("/caixa/fechamentos", headers=auth_admin)
    assert historico.json()["total"] == 1


async def test_dia_aponta_o_fechamento_existente(
    client: AsyncClient, auth_admin: dict[str, str], vendas_do_dia: dict
) -> None:
    hoje = _hoje_loja().isoformat()
    fechamento_id = (
        await client.post(
            "/caixa/fechamentos",
            headers=auth_admin,
            json={
                "data": hoje,
                "contagens": [
                    {"forma": "PIX", "valor_contado": "100.00"},
                    {"forma": "DINHEIRO", "valor_contado": "90.00"},
                    {"forma": "DEBITO", "valor_contado": "100.00"},
                ],
            },
        )
    ).json()["id"]

    corpo = (await client.get("/caixa/dia", headers=auth_admin)).json()
    assert corpo["fechado"] is True
    assert corpo["fechamento_id"] == fechamento_id
    pix = next(linha for linha in corpo["linhas"] if linha["forma"] == "PIX")
    assert pix["contado"] == "100.00"


async def test_nao_fecha_caixa_de_dia_futuro(
    client: AsyncClient, auth_admin: dict[str, str]
) -> None:
    amanha = (_hoje_loja() + timedelta(days=1)).isoformat()
    resp = await client.post(
        "/caixa/fechamentos",
        headers=auth_admin,
        json={"data": amanha, "contagens": [{"forma": "PIX", "valor_contado": "0.00"}]},
    )
    assert resp.status_code == 422


async def test_vendedor_nao_acessa_o_caixa(
    client: AsyncClient, auth_vendedor: dict[str, str]
) -> None:
    assert (await client.get("/caixa/dia", headers=auth_vendedor)).status_code == 403
    resp = await client.post(
        "/caixa/fechamentos",
        headers=auth_vendedor,
        json={
            "data": _hoje_loja().isoformat(),
            "contagens": [{"forma": "PIX", "valor_contado": "10.00"}],
        },
    )
    assert resp.status_code == 403


async def test_fechar_sem_conferir_uma_forma_com_valor_e_recusado(
    client: AsyncClient, auth_admin: dict[str, str], vendas_do_dia: dict
) -> None:
    """Deixar o PIX de fora não pode virar "contado zero": inventaria um rombo."""
    resp = await client.post(
        "/caixa/fechamentos",
        headers=auth_admin,
        json={
            "data": _hoje_loja().isoformat(),
            "contagens": [{"forma": "DINHEIRO", "valor_contado": "90.00"}],
        },
    )
    assert resp.status_code == 422
    assert resp.json()["code"] == "VALIDACAO"
    assert "PIX" in resp.json()["detail"]["formas"]
