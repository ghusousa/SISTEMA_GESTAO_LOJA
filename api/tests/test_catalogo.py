import pytest
from httpx import AsyncClient

from app.modules.catalogo.barcode import ean13_valido, montar_codigo_interno


@pytest.fixture
async def categoria(client: AsyncClient, auth_admin: dict[str, str]) -> int:
    resp = await client.post("/categorias", headers=auth_admin, json={"nome": "Camisetas"})
    assert resp.status_code == 201
    return resp.json()["id"]


def _produto_payload(categoria_id: int) -> dict:
    return {
        "categoria_id": categoria_id,
        "nome": "Camiseta Básica Gola V",
        "descricao": "Algodão penteado",
        "variantes": [
            {
                "tamanho": "P",
                "cor": "Preta",
                "codigo_barras": "7891234567895",
                "preco_custo": "22.50",
                "preco_venda": "59.90",
                "estoque_minimo": 2,
                "estoque_inicial": 5,
            },
            {
                "tamanho": "M",
                "cor": "Preta",
                "preco_custo": "22.50",
                "preco_venda": "59.90",
                "estoque_inicial": 3,
            },
            {
                "tamanho": "G",
                "cor": "Preta",
                "preco_custo": "22.50",
                "preco_venda": "59.90",
            },
        ],
    }


# ------------------------------------------------------------------ código interno
def test_codigo_interno_gerado_e_um_ean13_valido() -> None:
    codigo = montar_codigo_interno(1)
    assert len(codigo) == 13
    assert codigo.startswith("2")
    assert ean13_valido(codigo)


def test_codigos_internos_de_sequencias_diferentes_nao_colidem() -> None:
    assert montar_codigo_interno(1) != montar_codigo_interno(2)


# ------------------------------------------------------------------ categorias
async def test_categoria_duplicada_e_recusada(
    client: AsyncClient, auth_admin: dict[str, str], categoria: int
) -> None:
    resp = await client.post("/categorias", headers=auth_admin, json={"nome": "camisetas"})
    assert resp.status_code == 409


async def test_vendedor_nao_cria_categoria(
    client: AsyncClient, auth_vendedor: dict[str, str]
) -> None:
    resp = await client.post("/categorias", headers=auth_vendedor, json={"nome": "Calças"})
    assert resp.status_code == 403


async def test_categoria_com_produto_nao_pode_ser_excluida(
    client: AsyncClient, auth_admin: dict[str, str], categoria: int
) -> None:
    await client.post("/produtos", headers=auth_admin, json=_produto_payload(categoria))
    resp = await client.delete(f"/categorias/{categoria}", headers=auth_admin)
    assert resp.status_code == 409
    assert resp.json()["code"] == "OPERACAO_INVALIDA"


# ------------------------------------------------------------------ produtos
async def test_cadastro_gera_codigo_interno_para_peca_sem_etiqueta(
    client: AsyncClient, auth_admin: dict[str, str], categoria: int
) -> None:
    resp = await client.post("/produtos", headers=auth_admin, json=_produto_payload(categoria))
    assert resp.status_code == 201, resp.text
    corpo = resp.json()
    assert len(corpo["variantes"]) == 3

    por_tamanho = {v["tamanho"]: v for v in corpo["variantes"]}
    assert por_tamanho["P"]["codigo_barras"] == "7891234567895"
    assert por_tamanho["P"]["tipo_codigo"] == "EAN"
    assert por_tamanho["M"]["tipo_codigo"] == "INTERNO"
    assert ean13_valido(por_tamanho["M"]["codigo_barras"])
    assert por_tamanho["M"]["codigo_barras"] != por_tamanho["G"]["codigo_barras"]


async def test_estoque_inicial_vira_saldo_e_movimentacao(
    client: AsyncClient, auth_admin: dict[str, str], categoria: int
) -> None:
    corpo = (
        await client.post("/produtos", headers=auth_admin, json=_produto_payload(categoria))
    ).json()
    por_tamanho = {v["tamanho"]: v for v in corpo["variantes"]}
    assert por_tamanho["P"]["saldo"] == 5
    assert por_tamanho["M"]["saldo"] == 3
    assert por_tamanho["G"]["saldo"] == 0
    assert corpo["saldo_total"] == 8


async def test_admin_ve_preco_de_custo_e_vendedor_nao(
    client: AsyncClient,
    auth_admin: dict[str, str],
    auth_vendedor: dict[str, str],
    categoria: int,
) -> None:
    produto_id = (
        await client.post("/produtos", headers=auth_admin, json=_produto_payload(categoria))
    ).json()["id"]

    visao_admin = (await client.get(f"/produtos/{produto_id}", headers=auth_admin)).json()
    assert "preco_custo" in visao_admin["variantes"][0]

    visao_vendedor = (
        await client.get(f"/produtos/{produto_id}", headers=auth_vendedor)
    ).json()
    assert "preco_custo" not in visao_vendedor["variantes"][0]
    assert "preco_venda" in visao_vendedor["variantes"][0]


async def test_custo_nao_vaza_em_nenhum_endpoint_de_leitura(
    client: AsyncClient,
    auth_admin: dict[str, str],
    auth_vendedor: dict[str, str],
    categoria: int,
) -> None:
    await client.post("/produtos", headers=auth_admin, json=_produto_payload(categoria))
    for rota in ("/produtos", "/variantes"):
        corpo = (await client.get(rota, headers=auth_vendedor)).text
        assert "preco_custo" not in corpo, f"custo vazou em {rota}"


async def test_grade_com_tamanho_e_cor_repetidos_e_recusada(
    client: AsyncClient, auth_admin: dict[str, str], categoria: int
) -> None:
    payload = _produto_payload(categoria)
    payload["variantes"][1]["tamanho"] = "P"
    payload["variantes"][1]["cor"] = "Preta"
    resp = await client.post("/produtos", headers=auth_admin, json=payload)
    assert resp.status_code == 422


async def test_codigo_de_barras_ja_usado_e_recusado(
    client: AsyncClient, auth_admin: dict[str, str], categoria: int
) -> None:
    await client.post("/produtos", headers=auth_admin, json=_produto_payload(categoria))
    segundo = _produto_payload(categoria)
    segundo["nome"] = "Outra Camiseta"
    resp = await client.post("/produtos", headers=auth_admin, json=segundo)
    assert resp.status_code == 409
    assert resp.json()["code"] == "DUPLICADO"


async def test_preco_de_venda_zero_e_recusado(
    client: AsyncClient, auth_admin: dict[str, str], categoria: int
) -> None:
    payload = _produto_payload(categoria)
    payload["variantes"][0]["preco_venda"] = "0.00"
    resp = await client.post("/produtos", headers=auth_admin, json=payload)
    assert resp.status_code == 422


async def test_vendedor_pode_cadastrar_produto(
    client: AsyncClient, auth_vendedor: dict[str, str], categoria: int
) -> None:
    resp = await client.post("/produtos", headers=auth_vendedor, json=_produto_payload(categoria))
    assert resp.status_code == 201


async def test_produto_com_estoque_nao_pode_ser_excluido(
    client: AsyncClient, auth_admin: dict[str, str], categoria: int
) -> None:
    produto_id = (
        await client.post("/produtos", headers=auth_admin, json=_produto_payload(categoria))
    ).json()["id"]
    resp = await client.delete(f"/produtos/{produto_id}", headers=auth_admin)
    assert resp.status_code == 409


# ------------------------------------------------------------------ lookup do PDV
async def test_lookup_por_codigo_devolve_tudo_que_o_pdv_precisa(
    client: AsyncClient, auth_vendedor: dict[str, str], auth_admin: dict[str, str], categoria: int
) -> None:
    await client.post("/produtos", headers=auth_admin, json=_produto_payload(categoria))
    resp = await client.get("/variantes/codigo-barras/7891234567895", headers=auth_vendedor)
    assert resp.status_code == 200
    corpo = resp.json()
    assert corpo["produto"] == "Camiseta Básica Gola V"
    assert corpo["tamanho"] == "P"
    assert corpo["preco_venda"] == "59.90"
    assert corpo["saldo"] == 5
    assert "preco_custo" not in corpo


async def test_lookup_de_codigo_inexistente_retorna_404_com_o_codigo(
    client: AsyncClient, auth_vendedor: dict[str, str]
) -> None:
    resp = await client.get("/variantes/codigo-barras/0000000000000", headers=auth_vendedor)
    assert resp.status_code == 404
    assert resp.json()["detail"]["codigo_barras"] == "0000000000000"


async def test_gerar_codigo_interno_nunca_repete(
    client: AsyncClient, auth_vendedor: dict[str, str]
) -> None:
    codigos = set()
    for _ in range(5):
        resp = await client.post("/variantes/gerar-codigo-interno", headers=auth_vendedor)
        assert resp.status_code == 200
        codigos.add(resp.json()["codigo"])
    assert len(codigos) == 5


async def test_adiciona_peca_a_grade_existente(
    client: AsyncClient, auth_admin: dict[str, str], categoria: int
) -> None:
    produto_id = (
        await client.post("/produtos", headers=auth_admin, json=_produto_payload(categoria))
    ).json()["id"]
    resp = await client.post(
        f"/produtos/{produto_id}/variantes",
        headers=auth_admin,
        json={
            "tamanho": "GG",
            "cor": "Preta",
            "preco_custo": "24.00",
            "preco_venda": "64.90",
            "estoque_inicial": 2,
        },
    )
    assert resp.status_code == 201
    tamanhos = {v["tamanho"] for v in resp.json()["variantes"]}
    assert tamanhos == {"P", "M", "G", "GG"}
    assert resp.json()["saldo_total"] == 10


async def test_busca_produto_por_codigo_de_barras(
    client: AsyncClient, auth_admin: dict[str, str], categoria: int
) -> None:
    await client.post("/produtos", headers=auth_admin, json=_produto_payload(categoria))
    resp = await client.get(
        "/produtos", headers=auth_admin, params={"q": "7891234567895"}
    )
    assert resp.json()["total"] == 1


# ------------------------------------------------- achar a peça sem bipar


async def _peca(client, auth_admin, categoria_id: int, nome: str, cor: str, codigo: str) -> int:
    resposta = await client.post(
        "/produtos",
        headers=auth_admin,
        json={
            "categoria_id": categoria_id,
            "nome": nome,
            "variantes": [
                {
                    "tamanho": "M",
                    "cor": cor,
                    "codigo_barras": codigo,
                    "preco_custo": "20.00",
                    "preco_venda": "59.90",
                    "estoque_inicial": 2,
                }
            ],
        },
    )
    assert resposta.status_code == 201, resposta.text
    return resposta.json()["variantes"][0]["id"]


async def test_busca_peca_pelo_nome_do_produto(client, auth_admin) -> None:
    """A peça que chega do fornecedor não tem a NOSSA etiqueta colada.

    O código interno nasceu aqui dentro, então na entrada de mercadoria não existe o que
    bipar. Sem achar pelo nome, a reposição não tinha como ser registrada.
    """
    categoria = (
        await client.post("/categorias", headers=auth_admin, json={"nome": "Camisas"})
    ).json()
    await _peca(client, auth_admin, categoria["id"], "Camiseta Lisa", "Preta", "7891000000017")

    achou = await client.get("/variantes", headers=auth_admin, params={"q": "camiseta"})
    assert achou.status_code == 200
    assert [i["produto"] for i in achou.json()["items"]] == ["Camiseta Lisa"]
    assert achou.json()["items"][0]["saldo"] == 2, "a busca precisa dizer quanto tem"


async def test_busca_ignora_acento_e_caixa(client, auth_admin) -> None:
    """Ninguém digita "calça" com cedilha às pressas — e a peça não pode sumir por isso."""
    categoria = (
        await client.post("/categorias", headers=auth_admin, json={"nome": "Baixo"})
    ).json()
    await _peca(client, auth_admin, categoria["id"], "Calça Jeans", "Índigo", "7891000000024")

    for termo in ("calca", "CALÇA", "Calca Jeans", "indigo"):
        achou = await client.get("/variantes", headers=auth_admin, params={"q": termo})
        assert achou.status_code == 200, termo
        assert achou.json()["total"] == 1, f"'{termo}' não achou a peça"


async def test_codigo_exato_vem_primeiro(client, auth_admin) -> None:
    """Quem digitou os treze dígitos quer AQUELA peça no topo, não a primeira do alfabeto."""
    categoria = (
        await client.post("/categorias", headers=auth_admin, json={"nome": "Mistura"})
    ).json()
    await _peca(client, auth_admin, categoria["id"], "Aaa Primeira", "Branca", "7891000000031")
    alvo = await _peca(client, auth_admin, categoria["id"], "Zzz Ultima", "Preta", "7891000000048")

    achou = await client.get("/variantes", headers=auth_admin, params={"q": "7891000000048"})
    assert achou.json()["items"][0]["id"] == alvo


async def test_busca_por_nome_nao_vaza_custo_para_vendedora(client, auth_vendedor) -> None:
    """A busca é caminho novo para os mesmos dados: o filtro por papel vale aqui também."""
    achou = await client.get("/variantes", headers=auth_vendedor, params={"q": "a"})
    assert achou.status_code == 200
    for item in achou.json()["items"]:
        assert "preco_custo" not in item
