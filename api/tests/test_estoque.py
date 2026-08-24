import uuid

import pytest
from httpx import AsyncClient

from conftest import criar_produto


@pytest.fixture
async def grade(client: AsyncClient, auth_admin: dict[str, str]) -> dict:
    """Um produto com duas peças: P com 5 em estoque, M sem estoque."""
    categoria_id = (
        await client.post("/categorias", headers=auth_admin, json={"nome": "Camisetas"})
    ).json()["id"]
    produto = await criar_produto(client, auth_admin, {
                "categoria_id": categoria_id,
                "nome": "Camiseta Lisa",
                "variantes": [
                    {
                        "tamanho": "P",
                        "cor": "Branca",
                        "codigo_barras": "7891111111117",
                        "preco_custo": "20.00",
                        "preco_venda": "49.90",
                        "estoque_minimo": 3,
                        "estoque_inicial": 5,
                    },
                    {
                        "tamanho": "M",
                        "cor": "Branca",
                        "codigo_barras": "7892222222224",
                        "preco_custo": "20.00",
                        "preco_venda": "49.90",
                        "estoque_minimo": 1,
                    },
                ],
            })
    por_tamanho = {v["tamanho"]: v["id"] for v in produto["variantes"]}
    return {"produto_id": produto["id"], "categoria_id": categoria_id, **por_tamanho}


# ------------------------------------------------------------------ entradas
async def test_entrada_soma_estoque_e_registra_movimentacao(
    client: AsyncClient, auth_vendedor: dict[str, str], grade: dict
) -> None:
    resp = await client.post(
        "/estoque/entradas",
        headers=auth_vendedor,
        json={
            "client_uuid": str(uuid.uuid4()),
            "fornecedor": "Malharia Nova",
            "itens": [
                {"variante_id": grade["P"], "quantidade": 10},
                {"variante_id": grade["M"], "quantidade": 4},
            ],
        },
    )
    assert resp.status_code == 201, resp.text
    corpo = resp.json()
    assert corpo["total_pecas"] == 14
    assert {i["saldo_apos"] for i in corpo["itens"]} == {15, 4}

    saldos = (await client.get("/estoque/saldos", headers=auth_vendedor)).json()
    por_variante = {s["variante_id"]: s["saldo"] for s in saldos["items"]}
    assert por_variante[grade["P"]] == 15
    assert por_variante[grade["M"]] == 4


async def test_entrada_reenviada_nao_duplica_estoque(
    client: AsyncClient, auth_vendedor: dict[str, str], grade: dict
) -> None:
    """O app pode reenviar depois de um timeout — o client_uuid impede a soma dobrada."""
    payload = {
        "client_uuid": str(uuid.uuid4()),
        "itens": [{"variante_id": grade["P"], "quantidade": 10}],
    }
    primeira = await client.post("/estoque/entradas", headers=auth_vendedor, json=payload)
    segunda = await client.post("/estoque/entradas", headers=auth_vendedor, json=payload)

    assert primeira.json()["id"] == segunda.json()["id"]
    saldos = (await client.get("/estoque/saldos", headers=auth_vendedor)).json()
    por_variante = {s["variante_id"]: s["saldo"] for s in saldos["items"]}
    assert por_variante[grade["P"]] == 15


async def test_entrada_atualiza_o_custo_da_peca(
    client: AsyncClient, auth_admin: dict[str, str], grade: dict
) -> None:
    await client.post(
        "/estoque/entradas",
        headers=auth_admin,
        json={
            "client_uuid": str(uuid.uuid4()),
            "itens": [
                {"variante_id": grade["P"], "quantidade": 5, "custo_unitario": "26.00"}
            ],
        },
    )
    produto = (
        await client.get(f"/produtos/{grade['produto_id']}", headers=auth_admin)
    ).json()
    peca_p = next(v for v in produto["variantes"] if v["id"] == grade["P"])
    assert peca_p["preco_custo"] == "26.00"


async def test_entrada_de_peca_inexistente_retorna_404(
    client: AsyncClient, auth_vendedor: dict[str, str]
) -> None:
    resp = await client.post(
        "/estoque/entradas",
        headers=auth_vendedor,
        json={
            "client_uuid": str(uuid.uuid4()),
            "itens": [{"variante_id": 9999, "quantidade": 1}],
        },
    )
    assert resp.status_code == 404


async def test_entrada_com_peca_repetida_e_recusada(
    client: AsyncClient, auth_vendedor: dict[str, str], grade: dict
) -> None:
    resp = await client.post(
        "/estoque/entradas",
        headers=auth_vendedor,
        json={
            "client_uuid": str(uuid.uuid4()),
            "itens": [
                {"variante_id": grade["P"], "quantidade": 1},
                {"variante_id": grade["P"], "quantidade": 2},
            ],
        },
    )
    assert resp.status_code == 422


# ------------------------------------------------------------------ ajustes
async def test_vendedor_nao_ajusta_estoque(
    client: AsyncClient, auth_vendedor: dict[str, str], grade: dict
) -> None:
    resp = await client.post(
        "/estoque/ajustes",
        headers=auth_vendedor,
        json={"variante_id": grade["P"], "quantidade": -1, "motivo": "peça manchada"},
    )
    assert resp.status_code == 403


async def test_ajuste_negativo_reduz_o_saldo(
    client: AsyncClient, auth_admin: dict[str, str], grade: dict
) -> None:
    resp = await client.post(
        "/estoque/ajustes",
        headers=auth_admin,
        json={"variante_id": grade["P"], "quantidade": -2, "motivo": "peças manchadas"},
    )
    assert resp.status_code == 201
    assert resp.json()["saldo_apos"] == 3
    assert resp.json()["observacao"] == "peças manchadas"


async def test_ajuste_nao_pode_deixar_estoque_negativo(
    client: AsyncClient, auth_admin: dict[str, str], grade: dict
) -> None:
    resp = await client.post(
        "/estoque/ajustes",
        headers=auth_admin,
        json={"variante_id": grade["P"], "quantidade": -99, "motivo": "erro de contagem"},
    )
    assert resp.status_code == 409
    assert resp.json()["code"] == "ESTOQUE_INSUFICIENTE"


async def test_ajuste_exige_motivo(
    client: AsyncClient, auth_admin: dict[str, str], grade: dict
) -> None:
    resp = await client.post(
        "/estoque/ajustes",
        headers=auth_admin,
        json={"variante_id": grade["P"], "quantidade": -1, "motivo": ""},
    )
    assert resp.status_code == 422


# ------------------------------------------------------------------ inventário
async def test_inventario_gera_movimentacao_so_para_as_diferencas(
    client: AsyncClient, auth_admin: dict[str, str], grade: dict
) -> None:
    resp = await client.post(
        "/estoque/inventarios",
        headers=auth_admin,
        json={
            "observacao": "Contagem de agosto",
            "contagens": [
                {"variante_id": grade["P"], "quantidade_contada": 4},  # tinha 5
                {"variante_id": grade["M"], "quantidade_contada": 0},  # tinha 0
            ],
        },
    )
    assert resp.status_code == 201
    corpo = resp.json()
    assert corpo["conferidas"] == 2
    assert corpo["ajustadas"] == 1
    assert corpo["diferenca_total"] == -1
    assert corpo["diferencas"][0]["saldo_sistema"] == 5
    assert corpo["diferencas"][0]["quantidade_contada"] == 4

    movs = (
        await client.get(
            "/estoque/movimentacoes", headers=auth_admin, params={"tipo": "INVENTARIO"}
        )
    ).json()
    assert movs["total"] == 1


async def test_inventario_pode_aumentar_saldo(
    client: AsyncClient, auth_admin: dict[str, str], grade: dict
) -> None:
    resp = await client.post(
        "/estoque/inventarios",
        headers=auth_admin,
        json={"contagens": [{"variante_id": grade["M"], "quantidade_contada": 7}]},
    )
    assert resp.json()["diferenca_total"] == 7


async def test_vendedor_nao_faz_inventario(
    client: AsyncClient, auth_vendedor: dict[str, str], grade: dict
) -> None:
    resp = await client.post(
        "/estoque/inventarios",
        headers=auth_vendedor,
        json={"contagens": [{"variante_id": grade["P"], "quantidade_contada": 1}]},
    )
    assert resp.status_code == 403


# ------------------------------------------------------------------ leitura
async def test_filtro_de_estoque_baixo(
    client: AsyncClient, auth_admin: dict[str, str], grade: dict
) -> None:
    """P tem 5 com mínimo 3 (ok); M tem 0 com mínimo 1 (baixo)."""
    resp = await client.get(
        "/estoque/saldos", headers=auth_admin, params={"somente_baixo": True}
    )
    ids = [s["variante_id"] for s in resp.json()["items"]]
    assert ids == [grade["M"]]


async def test_saldo_mostra_valor_em_custo_so_para_admin(
    client: AsyncClient, auth_admin: dict[str, str], auth_vendedor: dict[str, str], grade: dict
) -> None:
    admin = (await client.get("/estoque/saldos", headers=auth_admin)).json()
    peca = next(s for s in admin["items"] if s["variante_id"] == grade["P"])
    assert peca["valor_em_custo"] == "100.00"  # 5 peças x 20,00

    vendedor = (await client.get("/estoque/saldos", headers=auth_vendedor)).text
    assert "valor_em_custo" not in vendedor
    assert "preco_custo" not in vendedor


async def test_extrato_mostra_autor_e_produto(
    client: AsyncClient, auth_admin: dict[str, str], grade: dict
) -> None:
    resp = await client.get(
        "/estoque/movimentacoes", headers=auth_admin, params={"variante_id": grade["P"]}
    )
    assert resp.status_code == 200
    movimento = resp.json()["items"][0]
    assert movimento["tipo"] == "ENTRADA"
    assert movimento["quantidade"] == 5
    assert movimento["saldo_apos"] == 5
    assert movimento["produto"] == "Camiseta Lisa"
    assert movimento["usuario"] == "Dona Maria"
    assert movimento["codigo_barras"] == "7891111111117"
