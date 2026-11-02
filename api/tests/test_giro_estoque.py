"""Estoque parado, curva ABC e valor do estoque (ADR-38).

O que não pode quebrar: a peça parada é contada pela última VENDA (ou, sem venda, pela
última ENTRADA), os totais valem para a loja inteira e não para a página, a curva ABC sai
do líquido com o desconto rateado, e nada disto chega a quem não vê dinheiro.
"""

import uuid
from decimal import Decimal

import pytest
from httpx import AsyncClient
from sqlalchemy import text

from app.core.datas import hoje_na_loja
from app.core.db import engine
from app.modules.relatorios.giro import classe_abc

from conftest import criar_produto


async def _produto(
    client: AsyncClient,
    auth: dict[str, str],
    nome: str,
    variantes: list[tuple[str, str, str, int]],
) -> list[int]:
    """Cria um produto com variantes (tamanho, custo, venda, estoque); devolve os ids."""
    categoria = (
        await client.post("/categorias", headers=auth, json={"nome": f"Cat {uuid.uuid4().hex[:6]}"})
    ).json()["id"]
    produto = await criar_produto(client, auth, {
        "categoria_id": categoria,
        "nome": nome,
        "variantes": [
            {
                "tamanho": tamanho,
                "cor": "Única",
                "preco_custo": custo,
                "preco_venda": venda,
                "estoque_inicial": estoque,
            }
            for tamanho, custo, venda, estoque in variantes
        ],
    })
    return [v["id"] for v in produto["variantes"]]


async def _vender(
    client: AsyncClient,
    auth: dict[str, str],
    itens: list[tuple[int, int]],
    total: str,
    desconto: str = "0",
) -> dict:
    resp = await client.post(
        "/vendas",
        headers=auth,
        json={
            "client_uuid": str(uuid.uuid4()),
            "desconto": desconto,
            "itens": [{"variante_id": v, "quantidade": q} for v, q in itens],
            "pagamentos": [{"forma": "PIX", "valor": total}],
        },
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


async def _envelhecer(variante: int, tipo: str, dias: int) -> None:
    """Empurra para trás os movimentos de um tipo desta peça (o relógio do teste é hoje)."""
    async with engine.begin() as conn:
        await conn.execute(
            text(
                "UPDATE stock_movements SET created_at = now() - make_interval(days => :dias) "
                "WHERE variant_id = :v AND movement_type = :tipo"
            ),
            {"dias": dias, "v": variante, "tipo": tipo},
        )


async def _parado(client: AsyncClient, auth: dict[str, str], **params) -> dict:
    resp = await client.get("/relatorios/estoque-parado", headers=auth, params=params)
    assert resp.status_code == 200, resp.text
    return resp.json()


# ------------------------------------------------------------------ estoque parado
async def test_estoque_parado_pela_ultima_venda_ou_pela_ultima_entrada(
    client: AsyncClient, auth_admin: dict[str, str]
) -> None:
    vendeu_ha_100, nunca_vendeu_ha_120, vendeu_ha_10, chegou_ha_10, esgotou = await _produto(
        client,
        auth_admin,
        "Vestido",
        [
            ("P", "40.00", "100.00", 10),
            ("M", "30.00", "90.00", 5),
            ("G", "40.00", "100.00", 5),
            ("GG", "40.00", "100.00", 5),
            ("XG", "40.00", "100.00", 1),
        ],
    )
    await _vender(
        client,
        auth_admin,
        [(vendeu_ha_100, 1), (vendeu_ha_10, 1), (esgotou, 1)],
        "300.00",
    )
    await _envelhecer(vendeu_ha_100, "ENTRADA", 150)
    await _envelhecer(vendeu_ha_100, "VENDA", 100)
    await _envelhecer(nunca_vendeu_ha_120, "ENTRADA", 120)
    await _envelhecer(vendeu_ha_10, "ENTRADA", 150)
    await _envelhecer(vendeu_ha_10, "VENDA", 10)
    # Saldo zero não é estoque parado, por mais antiga que seja a venda.
    await _envelhecer(esgotou, "ENTRADA", 300)
    await _envelhecer(esgotou, "VENDA", 200)

    r = await _parado(client, auth_admin, dias=90)
    assert r["total"] == 2
    assert r["dias"] == 90
    primeira, segunda = r["items"]
    # A mais antiga primeiro: nunca vendeu, chegou há 120 dias.
    assert primeira["variante_id"] == nunca_vendeu_ha_120
    assert primeira["dias_parada"] == 120
    assert primeira["ultima_venda"] is None
    assert primeira["saldo"] == 5
    assert primeira["valor_em_custo"] == "150.00"
    assert primeira["valor_em_venda"] == "450.00"

    assert segunda["variante_id"] == vendeu_ha_100
    assert segunda["dias_parada"] == 100
    assert segunda["ultima_venda"] is not None
    assert segunda["saldo"] == 9
    assert segunda["valor_em_custo"] == "360.00"

    assert r["pecas_total"] == 14
    assert r["valor_em_custo_total"] == "510.00"
    assert r["valor_em_venda_total"] == "1350.00"

    # Com 7 dias de corte, as recém-chegadas continuam fora (chegaram hoje), mas a que
    # vendeu há 10 dias entra.
    r = await _parado(client, auth_admin, dias=7)
    assert {i["variante_id"] for i in r["items"]} == {
        nunca_vendeu_ha_120,
        vendeu_ha_100,
        vendeu_ha_10,
    }


async def test_estoque_parado_conta_dias_inteiros_e_a_borda_fica_de_fora(
    client: AsyncClient, auth_admin: dict[str, str]
) -> None:
    """"Mais antiga que 90 dias": a que vendeu há exatamente 90 dias ainda não entra."""
    ha_90, ha_91 = await _produto(
        client, auth_admin, "Saia", [("P", "10.00", "30.00", 3), ("M", "10.00", "30.00", 3)]
    )
    await _vender(client, auth_admin, [(ha_90, 1), (ha_91, 1)], "60.00")
    await _envelhecer(ha_90, "ENTRADA", 200)
    await _envelhecer(ha_91, "ENTRADA", 200)
    await _envelhecer(ha_90, "VENDA", 90)
    await _envelhecer(ha_91, "VENDA", 91)

    r = await _parado(client, auth_admin, dias=90)
    assert [i["variante_id"] for i in r["items"]] == [ha_91]
    assert r["items"][0]["dias_parada"] == 91


async def test_peca_sem_venda_e_sem_entrada_conta_desde_o_cadastro(
    client: AsyncClient, auth_admin: dict[str, str]
) -> None:
    """Saldo que veio de ajuste (ou do cadastro antigo, antes da ADR-29) não pode sumir do
    relatório só porque nunca teve uma ENTRADA registrada."""
    (peca,) = await _produto(client, auth_admin, "Casaco", [("U", "80.00", "200.00", 0)])
    resp = await client.post(
        "/estoque/ajustes",
        headers=auth_admin,
        json={"variante_id": peca, "quantidade": 2, "motivo": "achado no depósito"},
    )
    assert resp.status_code == 201, resp.text
    async with engine.begin() as conn:
        await conn.execute(
            text(
                "UPDATE product_variants SET created_at = now() - interval '200 days' "
                "WHERE id = :v"
            ),
            {"v": peca},
        )
    r = await _parado(client, auth_admin, dias=90)
    assert r["total"] == 1
    assert r["items"][0]["ultima_entrada"] is None
    assert r["items"][0]["dias_parada"] == 200


async def test_estoque_parado_e_paginado_com_totais_de_todas_as_paginas(
    client: AsyncClient, auth_admin: dict[str, str]
) -> None:
    ids = await _produto(
        client,
        auth_admin,
        "Bermuda",
        [("P", "10.00", "25.00", 1), ("M", "10.00", "25.00", 2), ("G", "10.00", "25.00", 3)],
    )
    for dias, v in zip((300, 200, 100), ids, strict=True):
        await _envelhecer(v, "ENTRADA", dias)

    r = await _parado(client, auth_admin, dias=90, page=2, size=1)
    assert r["total"] == 3
    assert [i["variante_id"] for i in r["items"]] == [ids[1]]
    assert r["pecas_total"] == 6
    assert r["valor_em_custo_total"] == "60.00"


async def test_dias_do_estoque_parado_tem_limite(
    client: AsyncClient, auth_admin: dict[str, str]
) -> None:
    for dias in (0, -5, 4000):
        resp = await client.get(
            "/relatorios/estoque-parado", headers=auth_admin, params={"dias": dias}
        )
        assert resp.status_code == 422


# ------------------------------------------------------------------- curva ABC
async def _curva(client: AsyncClient, auth: dict[str, str], **params) -> dict:
    hoje = str(hoje_na_loja())
    resp = await client.get(
        "/relatorios/curva-abc",
        headers=auth,
        params={"inicio": hoje, "fim": hoje, **params},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


async def test_curva_abc_classifica_pelo_acumulado(
    client: AsyncClient, auth_admin: dict[str, str]
) -> None:
    """50 + 30 + 15 + 5 = 100: acumulados 50, 80, 95, 100 -> A, A, B, C."""
    ids = []
    precos = (("Pouco", "5.00"), ("Muito", "50.00"), ("Médio", "15.00"), ("Bom", "30.00"))
    for nome, preco in precos:
        (v,) = await _produto(client, auth_admin, nome, [("U", "1.00", preco, 5)])
        ids.append(v)
        await _vender(client, auth_admin, [(v, 1)], preco)

    r = await _curva(client, auth_admin)
    assert r["total"] == 4
    assert [(i["produto"], i["classe"]) for i in r["items"]] == [
        ("Muito", "A"),
        ("Bom", "A"),
        ("Médio", "B"),
        ("Pouco", "C"),
    ]
    assert [i["percentual_acumulado"] for i in r["items"]] == ["50.00", "80.00", "95.00", "100.00"]
    assert [i["percentual"] for i in r["items"]] == ["50.00", "30.00", "15.00", "5.00"]

    # Paginado: a 2ª página continua o acumulado de onde a 1ª parou.
    r = await _curva(client, auth_admin, page=2, size=2)
    assert r["total"] == 4
    assert [(i["produto"], i["percentual_acumulado"], i["classe"]) for i in r["items"]] == [
        ("Médio", "95.00", "B"),
        ("Pouco", "100.00", "C"),
    ]


async def test_campeao_que_sozinho_passa_de_80_por_cento_e_classe_a(
    client: AsyncClient, auth_admin: dict[str, str]
) -> None:
    for nome, preco in (("Campeão", "90.00"), ("Resto", "10.00")):
        (v,) = await _produto(client, auth_admin, nome, [("U", "1.00", preco, 5)])
        await _vender(client, auth_admin, [(v, 1)], preco)
    r = await _curva(client, auth_admin)
    assert [(i["produto"], i["classe"]) for i in r["items"]] == [("Campeão", "A"), ("Resto", "B")]


def test_classe_abc_pelo_acumulado_antes_do_produto() -> None:
    cem = Decimal("100")
    assert classe_abc(Decimal("0"), cem) == "A"
    assert classe_abc(Decimal("79.99"), cem) == "A"
    assert classe_abc(Decimal("80"), cem) == "B"
    assert classe_abc(Decimal("94.99"), cem) == "B"
    assert classe_abc(Decimal("95"), cem) == "C"
    assert classe_abc(Decimal("0"), Decimal("0")) == "C"


async def test_curva_abc_rateia_o_desconto_e_abate_a_devolucao(
    client: AsyncClient, auth_admin: dict[str, str]
) -> None:
    """2 blusas de 100 + 1 calça de 100 com 30 de desconto: 270 pagos, 90 por peça.
    Uma blusa volta (90 de reembolso): blusa 90 líquido, calça 90. Somar o preço cheio
    deixaria a blusa com 100 — 10 a mais do que entrou."""
    (blusa,) = await _produto(client, auth_admin, "Blusa", [("U", "40.00", "100.00", 5)])
    (calca,) = await _produto(client, auth_admin, "Calça", [("U", "40.00", "100.00", 5)])
    venda = await _vender(client, auth_admin, [(blusa, 2), (calca, 1)], "270.00", desconto="30.00")
    item_blusa = next(i for i in venda["itens"] if i["variante_id"] == blusa)
    resp = await client.post(
        f"/vendas/{venda['id']}/devolucoes",
        headers=auth_admin,
        json={
            "client_uuid": str(uuid.uuid4()),
            "itens": [{"item_id": item_blusa["id"], "quantidade": 1}],
        },
    )
    assert resp.status_code == 201, resp.text

    r = await _curva(client, auth_admin)
    assert [(i["produto"], i["pecas"], i["faturamento_liquido"]) for i in r["items"]] == [
        ("Blusa", 1, "90.00"),
        ("Calça", 1, "90.00"),
    ]
    resumo = (
        await client.get(
            "/relatorios/resumo",
            headers=auth_admin,
            params={"inicio": str(hoje_na_loja()), "fim": str(hoje_na_loja())},
        )
    ).json()
    assert resumo["faturamento_liquido"] == "180.00"


async def test_produto_so_com_devolucao_no_periodo_fica_fora_da_curva(
    client: AsyncClient, auth_admin: dict[str, str]
) -> None:
    (velha,) = await _produto(client, auth_admin, "Velha", [("U", "10.00", "50.00", 5)])
    (nova,) = await _produto(client, auth_admin, "Nova", [("U", "10.00", "50.00", 5)])
    venda = await _vender(client, auth_admin, [(velha, 1)], "50.00")
    async with engine.begin() as conn:
        await conn.execute(
            text("UPDATE sales SET sold_at = sold_at - interval '30 days' WHERE id = :id"),
            {"id": venda["id"]},
        )
    await client.post(
        f"/vendas/{venda['id']}/devolucoes",
        headers=auth_admin,
        json={
            "client_uuid": str(uuid.uuid4()),
            "itens": [{"item_id": venda["itens"][0]["id"], "quantidade": 1}],
        },
    )
    await _vender(client, auth_admin, [(nova, 1)], "50.00")
    r = await _curva(client, auth_admin)
    assert [(i["produto"], i["percentual_acumulado"]) for i in r["items"]] == [("Nova", "100.00")]


# -------------------------------------------------------------- valor do estoque
async def test_valor_do_estoque_e_a_loja_inteira(
    client: AsyncClient, auth_admin: dict[str, str]
) -> None:
    await _produto(
        client,
        auth_admin,
        "Camiseta",
        [("M", "20.00", "50.00", 3), ("G", "60.00", "150.00", 2), ("GG", "60.00", "150.00", 0)],
    )
    resp = await client.get("/relatorios/valor-do-estoque", headers=auth_admin)
    assert resp.status_code == 200, resp.text
    assert resp.json() == {
        "pecas": 5,
        "variantes": 2,
        "valor_em_custo": "180.00",
        "valor_em_venda": "450.00",
    }


async def test_valor_do_estoque_vazio_e_zero(
    client: AsyncClient, auth_admin: dict[str, str]
) -> None:
    resp = await client.get("/relatorios/valor-do-estoque", headers=auth_admin)
    assert resp.json() == {
        "pecas": 0,
        "variantes": 0,
        "valor_em_custo": "0.00",
        "valor_em_venda": "0.00",
    }


# ------------------------------------------------------------------- permissão
@pytest.mark.parametrize(
    ("rota", "params"),
    [
        ("/relatorios/estoque-parado", {}),
        ("/relatorios/curva-abc", {"inicio": "2026-08-01", "fim": "2026-08-31"}),
        ("/relatorios/valor-do-estoque", {}),
    ],
)
async def test_giro_do_estoque_e_so_de_quem_ve_dinheiro(
    client: AsyncClient,
    auth_vendedor: dict[str, str],
    auth_supervisora: dict[str, str],
    auth_gerente: dict[str, str],
    rota: str,
    params: dict,
) -> None:
    for auth in (auth_vendedor, auth_supervisora):
        assert (await client.get(rota, headers=auth, params=params)).status_code == 403
    assert (await client.get(rota, headers=auth_gerente, params=params)).status_code == 200
