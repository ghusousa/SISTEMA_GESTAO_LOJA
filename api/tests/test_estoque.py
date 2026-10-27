import asyncio
import time
import uuid

import pytest
from httpx import AsyncClient
from sqlalchemy import text

from app.core.db import SessionLocal, engine
from app.modules.estoque import movimentos
from app.modules.estoque.models import TipoMovimento

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


async def test_vendedora_nao_altera_custo_pela_entrada(
    client: AsyncClient,
    auth_admin: dict[str, str],
    auth_vendedor: dict[str, str],
    grade: dict,
) -> None:
    """A mercadoria entra; o custo que veio junto, não — é número de quem vê dinheiro.

    A tela da vendedora nem mostra o campo, mas a API aceitava: um `custo_unitario` de
    R$ 0,01 numa peça de R$ 20,00 inflava o lucro do mês sem ninguém ver de onde.
    """
    resp = await client.post(
        "/estoque/entradas",
        headers=auth_vendedor,
        json={
            "client_uuid": str(uuid.uuid4()),
            "itens": [{"variante_id": grade["P"], "quantidade": 1, "custo_unitario": "0.01"}],
        },
    )
    assert resp.status_code == 201, resp.text
    assert resp.json()["total_pecas"] == 1

    produto = (
        await client.get(f"/produtos/{grade['produto_id']}", headers=auth_admin)
    ).json()
    peca_p = next(v for v in produto["variantes"] if v["id"] == grade["P"])
    assert peca_p["preco_custo"] == "20.00"


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


# ------------------------------------------------------------ idempotência (ADR-2)
async def test_reenvio_identico_da_entrada_responde_200(
    client: AsyncClient, auth_vendedor: dict[str, str], grade: dict
) -> None:
    """ADR-2: o replay devolve 200 com o que já existe. Com 201 nas duas, o app não tinha
    como saber que foi replay."""
    payload = {
        "client_uuid": str(uuid.uuid4()),
        "itens": [{"variante_id": grade["M"], "quantidade": 1}],
    }
    primeira = await client.post("/estoque/entradas", headers=auth_vendedor, json=payload)
    segunda = await client.post("/estoque/entradas", headers=auth_vendedor, json=payload)
    assert (primeira.status_code, segunda.status_code) == (201, 200)
    assert segunda.json()["id"] == primeira.json()["id"]


async def test_mesma_chave_com_outras_pecas_e_recusada_e_nao_some_em_silencio(
    client: AsyncClient, auth_admin: dict[str, str], grade: dict
) -> None:
    """A resposta se perde, a pessoa bipa mais 7 peças M e reenvia com a mesma chave.

    Antes: 201 com a entrada antiga, as 7 M não entravam e a tela oferecia etiqueta para
    elas. Agora: 409 com o número da entrada que já existe; e o reenvio idêntico segue 200.
    """
    chave = str(uuid.uuid4())
    primeira = await client.post(
        "/estoque/entradas",
        headers=auth_admin,
        json={"client_uuid": chave, "itens": [{"variante_id": grade["P"], "quantidade": 2}]},
    )
    assert primeira.status_code == 201

    divergentes = [
        # mais uma peça na lista
        {"itens": [
            {"variante_id": grade["P"], "quantidade": 2},
            {"variante_id": grade["M"], "quantidade": 7},
        ]},
        # outra quantidade
        {"itens": [{"variante_id": grade["P"], "quantidade": 3}]},
        # outro fornecedor
        {"fornecedor": "Malharia Nova", "itens": [{"variante_id": grade["P"], "quantidade": 2}]},
        # outro custo (a peça custa 20,00)
        {"itens": [{"variante_id": grade["P"], "quantidade": 2, "custo_unitario": "26.00"}]},
    ]
    for corpo in divergentes:
        resp = await client.post(
            "/estoque/entradas", headers=auth_admin, json={"client_uuid": chave, **corpo}
        )
        assert resp.status_code == 409, (corpo, resp.status_code, resp.text)
        assert resp.json()["code"] == "DUPLICADO"
        assert resp.json()["detail"]["entrada_id"] == primeira.json()["id"]
        # O que JÁ entrou vai junto: a tela tira da lista antes de trocar a chave, senão o
        # reenvio somava de novo as 2 P gravadas.
        assert resp.json()["detail"]["itens"] == [{"variante_id": grade["P"], "quantidade": 2}]

    saldos = (await client.get("/estoque/saldos", headers=auth_admin)).json()
    por_variante = {s["variante_id"]: s for s in saldos["items"]}
    assert por_variante[grade["P"]]["saldo"] == 7  # 5 + 2, uma vez só
    assert por_variante[grade["M"]]["saldo"] == 0
    assert por_variante[grade["P"]]["preco_custo"] == "20.00"

    identica = await client.post(
        "/estoque/entradas",
        headers=auth_admin,
        json={"client_uuid": chave, "itens": [{"variante_id": grade["P"], "quantidade": 2}]},
    )
    assert identica.status_code == 200
    assert identica.json()["id"] == primeira.json()["id"]


# ------------------------------------------------------------ concorrência (ADR-30)
async def _esperar_alguem_na_trava(tarefa: asyncio.Task, limite: float = 10.0) -> None:
    """Espera a requisição ficar PARADA numa trava do banco (ou terminar sem parar).

    A ordem é forçada pela trava, não por relógio: a outra sessão segura a linha e só
    confirma depois de ver a requisição esperando por ela. Cada volta abre conexão nova
    porque `pg_stat_activity` é uma foto por transação. Se a tarefa terminar antes, é o
    defeito: ela não esperou ninguém.
    """
    prazo = time.monotonic() + limite
    while not tarefa.done():
        async with engine.connect() as observador:
            esperando = await observador.scalar(
                text(
                    "SELECT count(*) FROM pg_stat_activity "
                    "WHERE datname = current_database() AND wait_event_type = 'Lock'"
                )
            )
        if esperando:
            return
        assert time.monotonic() < prazo, "a requisição nunca chegou à trava"
        await asyncio.sleep(0.01)  # intervalo da consulta, não da ordem


async def test_inventario_simultaneo_nao_aplica_a_diferenca_duas_vezes(
    client: AsyncClient, auth_admin: dict[str, str], admin, grade: dict
) -> None:
    """Duas contagens iguais (toque duplo, dois aparelhos): P tem 5, as duas contaram 3.

    A primeira já aplicou o seu -2 e ainda não confirmou. Antes, a segunda lia o saldo
    sem trava (5), calculava -2 também e, quando a primeira soltava a linha, aplicava por
    cima: saldo 1. O inventário SUBSTITUI — contou 3, o saldo é 3.
    """
    corpo = {"contagens": [{"variante_id": grade["P"], "quantidade_contada": 3}]}
    async with SessionLocal() as primeira:
        await movimentos.aplicar_movimento(
            primeira,
            variante_id=grade["P"],
            delta=-2,
            tipo=TipoMovimento.INVENTARIO,
            user_id=admin.id,
            observacao="Acerto por contagem física",
        )
        segunda = asyncio.create_task(
            client.post("/estoque/inventarios", headers=auth_admin, json=corpo)
        )
        try:
            await _esperar_alguem_na_trava(segunda)
        finally:
            await primeira.commit()
    resp = await segunda

    assert resp.status_code == 201, resp.text
    assert resp.json()["ajustadas"] == 0, resp.json()
    saldos = (await client.get("/estoque/saldos", headers=auth_admin)).json()
    por_variante = {s["variante_id"]: s["saldo"] for s in saldos["items"]}
    assert por_variante[grade["P"]] == 3


# ------------------------------------------------------------ busca
async def test_busca_de_saldos_ignora_acento(
    client: AsyncClient, auth_admin: dict[str, str], grade: dict
) -> None:
    """O mesmo achatamento de `/variantes?q=`: "calca" acha a "Calça" também no Estoque."""
    await criar_produto(client, auth_admin, {
        "categoria_id": grade["categoria_id"],
        "nome": "Calça Jeans",
        "variantes": [
            {"tamanho": "38", "cor": "Índigo", "preco_custo": "50.00", "preco_venda": "129.90"},
            {"tamanho": "40", "cor": "Índigo", "preco_custo": "50.00", "preco_venda": "129.90"},
        ],
    })
    for termo in ("calca", "CALÇA", "Calca Jeans"):
        resp = await client.get("/estoque/saldos", headers=auth_admin, params={"q": termo})
        assert resp.status_code == 200
        assert resp.json()["total"] == 2, f"'{termo}' não achou a calça"
