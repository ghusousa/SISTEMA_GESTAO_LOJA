import pytest
from httpx import AsyncClient


@pytest.fixture
async def categorias(client: AsyncClient, auth_admin: dict[str, str]) -> dict:
    ids = {}
    for nome in ("Aluguel", "Energia", "Fornecedores"):
        resp = await client.post(
            "/despesas/categorias", headers=auth_admin, json={"nome": nome}
        )
        assert resp.status_code == 201
        ids[nome] = resp.json()["id"]
    return ids


async def test_vendedor_nao_ve_nem_lanca_despesas(
    client: AsyncClient, auth_vendedor: dict[str, str]
) -> None:
    assert (await client.get("/despesas", headers=auth_vendedor)).status_code == 403
    assert (
        await client.get("/despesas/categorias", headers=auth_vendedor)
    ).status_code == 403
    resp = await client.post(
        "/despesas",
        headers=auth_vendedor,
        json={
            "categoria_id": 1,
            "descricao": "Aluguel",
            "valor": "2000.00",
            "data": "2026-08-05",
        },
    )
    assert resp.status_code == 403


async def test_lanca_despesa_e_calcula_competencia(
    client: AsyncClient, auth_admin: dict[str, str], categorias: dict
) -> None:
    resp = await client.post(
        "/despesas",
        headers=auth_admin,
        json={
            "categoria_id": categorias["Aluguel"],
            "descricao": "Aluguel da loja",
            "valor": "2500.00",
            "data": "2026-08-05",
            "recorrente": True,
        },
    )
    assert resp.status_code == 201, resp.text
    corpo = resp.json()
    assert corpo["competencia"] == "2026-08"
    assert corpo["categoria"] == "Aluguel"
    assert corpo["recorrente"] is True


async def test_despesa_com_valor_zero_e_recusada(
    client: AsyncClient, auth_admin: dict[str, str], categorias: dict
) -> None:
    resp = await client.post(
        "/despesas",
        headers=auth_admin,
        json={
            "categoria_id": categorias["Energia"],
            "descricao": "Conta de luz",
            "valor": "0.00",
            "data": "2026-08-10",
        },
    )
    assert resp.status_code == 422


async def test_categoria_de_despesa_duplicada_e_recusada(
    client: AsyncClient, auth_admin: dict[str, str], categorias: dict
) -> None:
    resp = await client.post(
        "/despesas/categorias", headers=auth_admin, json={"nome": "aluguel"}
    )
    assert resp.status_code == 409


async def test_categoria_com_despesa_nao_pode_ser_excluida(
    client: AsyncClient, auth_admin: dict[str, str], categorias: dict
) -> None:
    await client.post(
        "/despesas",
        headers=auth_admin,
        json={
            "categoria_id": categorias["Energia"],
            "descricao": "Luz de agosto",
            "valor": "480.00",
            "data": "2026-08-10",
        },
    )
    resp = await client.delete(
        f"/despesas/categorias/{categorias['Energia']}", headers=auth_admin
    )
    assert resp.status_code == 409


async def test_filtro_por_periodo_e_categoria(
    client: AsyncClient, auth_admin: dict[str, str], categorias: dict
) -> None:
    for data, categoria, valor in (
        ("2026-07-05", "Aluguel", "2500.00"),
        ("2026-08-05", "Aluguel", "2500.00"),
        ("2026-08-10", "Energia", "480.00"),
    ):
        await client.post(
            "/despesas",
            headers=auth_admin,
            json={
                "categoria_id": categorias[categoria],
                "descricao": f"{categoria} {data}",
                "valor": valor,
                "data": data,
            },
        )

    agosto = await client.get(
        "/despesas", headers=auth_admin, params={"inicio": "2026-08-01", "fim": "2026-08-31"}
    )
    assert agosto.json()["total"] == 2

    so_aluguel = await client.get(
        "/despesas", headers=auth_admin, params={"categoria_id": categorias["Aluguel"]}
    )
    assert so_aluguel.json()["total"] == 2


# ------------------------------------------------------------------ recorrentes
async def _lancar_fixas(client: AsyncClient, headers: dict, categorias: dict) -> None:
    await client.post(
        "/despesas",
        headers=headers,
        json={
            "categoria_id": categorias["Aluguel"],
            "descricao": "Aluguel da loja",
            "valor": "2500.00",
            "data": "2026-07-31",
            "recorrente": True,
        },
    )
    await client.post(
        "/despesas",
        headers=headers,
        json={
            "categoria_id": categorias["Energia"],
            "descricao": "Conta de luz",
            "valor": "480.00",
            "data": "2026-07-10",
            "recorrente": True,
        },
    )
    # Não recorrente: compra de mercadoria não se repete sozinha.
    await client.post(
        "/despesas",
        headers=headers,
        json={
            "categoria_id": categorias["Fornecedores"],
            "descricao": "Compra de malha",
            "valor": "3200.00",
            "data": "2026-07-15",
        },
    )


async def test_replicacao_traz_so_as_recorrentes(
    client: AsyncClient, auth_admin: dict[str, str], categorias: dict
) -> None:
    await _lancar_fixas(client, auth_admin, categorias)
    resp = await client.post(
        "/despesas/replicar-recorrentes", headers=auth_admin, params={"competencia": "2026-08"}
    )
    assert resp.status_code == 200, resp.text
    corpo = resp.json()
    assert corpo["criadas"] == 2
    assert corpo["valor_total"] == "2980.00"
    descricoes = {d["descricao"] for d in corpo["despesas"]}
    assert descricoes == {"Aluguel da loja", "Conta de luz"}
    assert all(d["competencia"] == "2026-08" for d in corpo["despesas"])


async def test_replicar_duas_vezes_nao_duplica(
    client: AsyncClient, auth_admin: dict[str, str], categorias: dict
) -> None:
    await _lancar_fixas(client, auth_admin, categorias)
    primeira = await client.post(
        "/despesas/replicar-recorrentes", headers=auth_admin, params={"competencia": "2026-08"}
    )
    segunda = await client.post(
        "/despesas/replicar-recorrentes", headers=auth_admin, params={"competencia": "2026-08"}
    )
    assert primeira.json()["criadas"] == 2
    assert segunda.json()["criadas"] == 0
    assert segunda.json()["ja_existentes"] == 2

    agosto = await client.get(
        "/despesas", headers=auth_admin, params={"inicio": "2026-08-01", "fim": "2026-08-31"}
    )
    assert agosto.json()["total"] == 2


async def test_replicacao_ajusta_dia_31_para_mes_curto(
    client: AsyncClient, auth_admin: dict[str, str], categorias: dict
) -> None:
    """Aluguel que vence dia 31 em janeiro precisa cair no dia 28 em fevereiro."""
    await client.post(
        "/despesas",
        headers=auth_admin,
        json={
            "categoria_id": categorias["Aluguel"],
            "descricao": "Aluguel",
            "valor": "2500.00",
            "data": "2026-01-31",
            "recorrente": True,
        },
    )
    resp = await client.post(
        "/despesas/replicar-recorrentes", headers=auth_admin, params={"competencia": "2026-02"}
    )
    assert resp.json()["despesas"][0]["data"] == "2026-02-28"


async def test_replicacao_usa_o_valor_mais_recente(
    client: AsyncClient, auth_admin: dict[str, str], categorias: dict
) -> None:
    """Reajustou o aluguel em julho? Agosto sai com o valor novo."""
    for data, valor in (("2026-06-05", "2500.00"), ("2026-07-05", "2700.00")):
        await client.post(
            "/despesas",
            headers=auth_admin,
            json={
                "categoria_id": categorias["Aluguel"],
                "descricao": "Aluguel da loja",
                "valor": valor,
                "data": data,
                "recorrente": True,
            },
        )
    resp = await client.post(
        "/despesas/replicar-recorrentes", headers=auth_admin, params={"competencia": "2026-08"}
    )
    assert resp.json()["criadas"] == 1
    assert resp.json()["despesas"][0]["valor"] == "2700.00"


async def test_replicacao_em_cadeia_nao_duplica_no_mes_seguinte(
    client: AsyncClient, auth_admin: dict[str, str], categorias: dict
) -> None:
    """A réplica de agosto vira modelo de setembro sem virar uma segunda origem."""
    await client.post(
        "/despesas",
        headers=auth_admin,
        json={
            "categoria_id": categorias["Aluguel"],
            "descricao": "Aluguel da loja",
            "valor": "2500.00",
            "data": "2026-07-05",
            "recorrente": True,
        },
    )
    await client.post(
        "/despesas/replicar-recorrentes", headers=auth_admin, params={"competencia": "2026-08"}
    )
    setembro = await client.post(
        "/despesas/replicar-recorrentes", headers=auth_admin, params={"competencia": "2026-09"}
    )
    assert setembro.json()["criadas"] == 1

    de_novo = await client.post(
        "/despesas/replicar-recorrentes", headers=auth_admin, params={"competencia": "2026-09"}
    )
    assert de_novo.json()["criadas"] == 0

    todas = await client.get(
        "/despesas", headers=auth_admin, params={"inicio": "2026-09-01", "fim": "2026-09-30"}
    )
    assert todas.json()["total"] == 1


async def test_competencia_em_formato_invalido_e_recusada(
    client: AsyncClient, auth_admin: dict[str, str]
) -> None:
    resp = await client.post(
        "/despesas/replicar-recorrentes", headers=auth_admin, params={"competencia": "08/2026"}
    )
    assert resp.status_code == 422
    assert resp.json()["code"] == "VALIDACAO"
