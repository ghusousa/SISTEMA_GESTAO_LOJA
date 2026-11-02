"""Contas a pagar do fornecedor (ADR-40).

A coleção comprada em 30/60/90 é a maior saída de dinheiro da loja. O que estes testes
guardam:
- a nota entra JUNTO com a mercadoria, na mesma transação e com a mesma chave de reenvio;
- a vendedora dá entrada, mas não vê nem lança a nota (é dinheiro da loja);
- pagar é uma vez só, e o boleto não vira despesa: o Resultado não muda (o CMV já conta).
"""

import asyncio
import uuid
from datetime import timedelta

import pytest
from conftest import criar_produto
from httpx import ASGITransport, AsyncClient
from sqlalchemy import text

from app.core.datas import hoje_na_loja
from app.core.db import engine
from app.main import app


@pytest.fixture
async def pecas(client: AsyncClient, auth_admin: dict[str, str]) -> dict:
    categoria = (
        await client.post("/categorias", headers=auth_admin, json={"nome": "Calças"})
    ).json()["id"]
    produto = await criar_produto(
        client,
        auth_admin,
        {
            "categoria_id": categoria,
            "nome": "Calça Jeans",
            "variantes": [
                {"tamanho": "38", "cor": "Azul", "preco_custo": "60.00", "preco_venda": "159.90"},
                {"tamanho": "40", "cor": "Azul", "preco_custo": "60.00", "preco_venda": "159.90"},
            ],
        },
    )
    return {v["tamanho"]: v["id"] for v in produto["variantes"]}


def _dia(dias: int) -> str:
    return (hoje_na_loja() + timedelta(days=dias)).isoformat()


def _nota(total: str = "900.00", parcelas: list[tuple[int, str]] | None = None) -> dict:
    parcelas = parcelas or [(30, "300.00"), (60, "300.00"), (90, "300.00")]
    return {
        "numero": "NF 4512",
        "valor_total": total,
        "parcelas": [{"vencimento": _dia(d), "valor": v} for d, v in parcelas],
    }


def _entrada(pecas: dict, nota: dict | None = None, **mais) -> dict:
    corpo = {
        "client_uuid": str(uuid.uuid4()),
        "fornecedor": "Jeans & Cia",
        "itens": [
            {"variante_id": pecas["38"], "quantidade": 10},
            {"variante_id": pecas["40"], "quantidade": 5},
        ],
        **mais,
    }
    if nota is not None:
        corpo["nota"] = nota
    return corpo


async def _contar(sql: str) -> int:
    async with engine.connect() as conn:
        return int((await conn.execute(text(sql))).scalar_one())


# ------------------------------------------------------------------ na Entrada
async def test_entrada_com_nota_cria_as_parcelas_ligadas_a_ela(
    client: AsyncClient, auth_admin: dict[str, str], pecas: dict
) -> None:
    resposta = await client.post(
        "/estoque/entradas", headers=auth_admin, json=_entrada(pecas, _nota())
    )
    assert resposta.status_code == 201, resposta.text
    entrada = resposta.json()
    assert entrada["contas_a_pagar"] == 3
    assert entrada["total_pecas"] == 15

    contas = (
        await client.get(f"/contas-pagar?entrada_id={entrada['id']}", headers=auth_admin)
    ).json()
    assert contas["total"] == 3
    assert [(c["parcela"], c["parcelas"], c["valor"]) for c in contas["items"]] == [
        (1, 3, "300.00"),
        (2, 3, "300.00"),
        (3, 3, "300.00"),
    ]
    primeira = contas["items"][0]
    assert primeira["fornecedor"] == "Jeans & Cia"
    assert primeira["numero_nota"] == "NF 4512"
    assert primeira["vencimento"] == _dia(30)
    assert primeira["situacao"] == "ABERTA"
    assert primeira["entrada_id"] == entrada["id"]


async def test_parcelas_que_nao_fecham_com_a_nota_recusam_a_entrada_inteira(
    client: AsyncClient, auth_admin: dict[str, str], pecas: dict
) -> None:
    """Nota digitada errada não entra pela metade: nem a dívida, nem a mercadoria."""
    resposta = await client.post(
        "/estoque/entradas",
        headers=auth_admin,
        json=_entrada(pecas, _nota("900.00", [(30, "300.00"), (60, "300.00")])),
    )
    assert resposta.status_code == 422, resposta.text
    assert await _contar("SELECT count(*) FROM stock_entries") == 0
    assert await _contar("SELECT count(*) FROM payables") == 0


async def test_nota_sem_fornecedor_e_recusada(
    client: AsyncClient, auth_admin: dict[str, str], pecas: dict
) -> None:
    resposta = await client.post(
        "/estoque/entradas", headers=auth_admin, json=_entrada(pecas, _nota(), fornecedor="  ")
    )
    assert resposta.status_code == 422, resposta.text


async def test_vendedora_da_entrada_sem_a_nota_mas_nao_com_ela(
    client: AsyncClient, auth_vendedor: dict[str, str], pecas: dict
) -> None:
    sem_nota = await client.post("/estoque/entradas", headers=auth_vendedor, json=_entrada(pecas))
    assert sem_nota.status_code == 201, sem_nota.text
    assert sem_nota.json()["contas_a_pagar"] == 0

    # Recusa (não ignora): ignorar faria a loja achar que o boleto foi lançado.
    com_nota = await client.post(
        "/estoque/entradas", headers=auth_vendedor, json=_entrada(pecas, _nota())
    )
    assert com_nota.status_code == 403, com_nota.text
    assert await _contar("SELECT count(*) FROM stock_entries") == 1
    assert await _contar("SELECT count(*) FROM payables") == 0


async def test_entrada_com_nota_reenviada_nao_duplica_a_divida(
    client: AsyncClient, auth_admin: dict[str, str], pecas: dict
) -> None:
    pedido = _entrada(pecas, _nota())
    primeira = await client.post("/estoque/entradas", headers=auth_admin, json=pedido)
    retry = await client.post("/estoque/entradas", headers=auth_admin, json=pedido)
    assert primeira.status_code == 201
    assert retry.status_code == 200, retry.text
    assert retry.json()["contas_a_pagar"] == 3
    assert await _contar("SELECT count(*) FROM payables") == 3

    # Mesma chave, outra nota: a resposta se perdeu e a pessoa corrigiu um vencimento.
    outra = await client.post(
        "/estoque/entradas",
        headers=auth_admin,
        json={**pedido, "nota": _nota("900.00", [(28, "300.00"), (60, "300.00"), (90, "300.00")])},
    )
    assert outra.status_code == 409, outra.text
    assert outra.json()["code"] == "DUPLICADO"
    assert await _contar("SELECT count(*) FROM payables") == 3

    # E a mesma chave SEM a nota que foi gravada também não é o mesmo pedido.
    sem = {k: v for k, v in pedido.items() if k != "nota"}
    assert (await client.post("/estoque/entradas", headers=auth_admin, json=sem)).status_code == 409


# ------------------------------------------------------------------ quem vê
async def _barrado(client: AsyncClient, auth: dict[str, str]) -> None:
    assert (await client.get("/contas-pagar", headers=auth)).status_code == 403
    assert (await client.get("/contas-pagar/resumo", headers=auth)).status_code == 403
    lancar = await client.post(
        "/contas-pagar",
        headers=auth,
        json={
            "client_uuid": str(uuid.uuid4()),
            "fornecedor": "Jeans & Cia",
            "descricao": "Boleto",
            "nota": _nota(),
        },
    )
    assert lancar.status_code == 403, lancar.text
    assert await _contar("SELECT count(*) FROM payables") == 0


async def test_vendedora_nao_ve_nem_lanca_conta(
    client: AsyncClient, auth_vendedor: dict[str, str]
) -> None:
    await _barrado(client, auth_vendedor)


async def test_supervisora_nao_ve_nem_lanca_conta(
    client: AsyncClient, auth_supervisora: dict[str, str]
) -> None:
    """Toma conta do chão de loja, não do dinheiro: a dívida com o fornecedor é resultado."""
    await _barrado(client, auth_supervisora)


async def test_gerente_ve_e_paga(client: AsyncClient, auth_gerente: dict[str, str]) -> None:
    lancamento = await _lancar(client, auth_gerente)
    conta = lancamento["contas"][0]
    paga = await client.post(
        f"/contas-pagar/{conta['id']}/pagamento", headers=auth_gerente, json={"forma": "BOLETO"}
    )
    assert paga.status_code == 200, paga.text
    assert paga.json()["situacao"] == "PAGA"
    assert paga.json()["paga_em"] == hoje_na_loja().isoformat()


# ------------------------------------------------------------------ avulsa
async def _lancar(client: AsyncClient, auth: dict[str, str], **mais) -> dict:
    corpo = {
        "client_uuid": str(uuid.uuid4()),
        "fornecedor": "Malharia Sul",
        "descricao": "Coleção de inverno",
        "nota": _nota("500.00", [(10, "250.00"), (40, "250.00")]),
        **mais,
    }
    resposta = await client.post("/contas-pagar", headers=auth, json=corpo)
    assert resposta.status_code == 201, resposta.text
    return resposta.json()


async def test_lancamento_avulso_e_idempotente(
    client: AsyncClient, auth_admin: dict[str, str]
) -> None:
    corpo = {
        "client_uuid": str(uuid.uuid4()),
        "fornecedor": "Malharia Sul",
        "descricao": "Coleção de inverno",
        "nota": _nota("500.00", [(40, "250.00"), (10, "250.00")]),
    }
    primeira = await client.post("/contas-pagar", headers=auth_admin, json=corpo)
    assert primeira.status_code == 201, primeira.text
    lancamento = primeira.json()
    assert lancamento["valor_total"] == "500.00"
    # Parcela 1 é a que vence primeiro, não a primeira digitada.
    assert [c["vencimento"] for c in lancamento["contas"]] == [_dia(10), _dia(40)]

    retry = await client.post("/contas-pagar", headers=auth_admin, json=corpo)
    assert retry.status_code == 200, retry.text
    outra = await client.post(
        "/contas-pagar", headers=auth_admin, json={**corpo, "fornecedor": "Outro"}
    )
    assert outra.status_code == 409, outra.text
    assert await _contar("SELECT count(*) FROM payables") == 2


# ------------------------------------------------------------------ listas e resumo
async def test_resumo_e_listas_por_situacao(
    client: AsyncClient, auth_admin: dict[str, str]
) -> None:
    await _lancar(
        client,
        auth_admin,
        nota=_nota("600.00", [(-3, "100.00"), (0, "200.00"), (7, "100.00"), (8, "200.00")]),
    )
    resumo = (await client.get("/contas-pagar/resumo", headers=auth_admin)).json()
    assert resumo["hoje"] == hoje_na_loja().isoformat()
    assert resumo["vencidas"] == {"quantidade": 1, "valor": "100.00"}
    # Hoje e daqui a 7 dias entram; daqui a 8, não.
    assert resumo["proximos_7_dias"] == {"quantidade": 2, "valor": "300.00"}
    assert resumo["em_aberto"] == {"quantidade": 4, "valor": "600.00"}

    vencidas = (await client.get("/contas-pagar?situacao=vencidas", headers=auth_admin)).json()
    assert [c["dias_para_vencer"] for c in vencidas["items"]] == [-3]
    assert vencidas["items"][0]["situacao"] == "VENCIDA"
    semana = (await client.get("/contas-pagar?situacao=proximos_7_dias", headers=auth_admin)).json()
    assert [c["dias_para_vencer"] for c in semana["items"]] == [0, 7]
    abertas = (await client.get("/contas-pagar?size=2", headers=auth_admin)).json()
    assert abertas["total"] == 4 and len(abertas["items"]) == 2

    conta = vencidas["items"][0]
    await client.post(
        f"/contas-pagar/{conta['id']}/pagamento", headers=auth_admin, json={"forma": "PIX"}
    )
    resumo = (await client.get("/contas-pagar/resumo", headers=auth_admin)).json()
    assert resumo["vencidas"]["quantidade"] == 0
    pagas = (await client.get("/contas-pagar?situacao=pagas", headers=auth_admin)).json()
    assert [c["id"] for c in pagas["items"]] == [conta["id"]]


# ------------------------------------------------------------------ pagar
async def test_pagar_uma_vez_so(client: AsyncClient, auth_admin: dict[str, str]) -> None:
    conta = (await _lancar(client, auth_admin))["contas"][0]
    url = f"/contas-pagar/{conta['id']}/pagamento"
    ontem = (hoje_na_loja() - timedelta(days=1)).isoformat()

    primeira = await client.post(url, headers=auth_admin, json={"forma": "PIX", "pago_em": ontem})
    assert primeira.status_code == 200, primeira.text
    assert primeira.json()["paga_em"] == ontem
    assert primeira.json()["forma_pagamento"] == "PIX"

    retry = await client.post(url, headers=auth_admin, json={"forma": "PIX", "pago_em": ontem})
    assert retry.status_code == 200, retry.text
    de_novo = await client.post(url, headers=auth_admin, json={"forma": "BOLETO"})
    assert de_novo.status_code == 409, de_novo.text

    # Conta paga não se edita nem se apaga: sumiria uma saída de dinheiro do histórico.
    editar = await client.patch(
        f"/contas-pagar/{conta['id']}", headers=auth_admin, json={"valor": "1.00"}
    )
    assert editar.status_code == 409, editar.text
    assert (
        await client.delete(f"/contas-pagar/{conta['id']}", headers=auth_admin)
    ).status_code == 409

    desfeito = await client.delete(url, headers=auth_admin)
    assert desfeito.status_code == 200, desfeito.text
    assert desfeito.json()["situacao"] == "ABERTA"
    assert desfeito.json()["forma_pagamento"] is None


async def test_pagamento_com_data_futura_e_recusado(
    client: AsyncClient, auth_admin: dict[str, str]
) -> None:
    conta = (await _lancar(client, auth_admin))["contas"][0]
    resposta = await client.post(
        f"/contas-pagar/{conta['id']}/pagamento",
        headers=auth_admin,
        json={"forma": "PIX", "pago_em": _dia(1)},
    )
    assert resposta.status_code == 422, resposta.text


async def test_dois_cliques_pagando_com_formas_diferentes_so_um_vale(
    client: AsyncClient, auth_admin: dict[str, str]
) -> None:
    conta = (await _lancar(client, auth_admin))["contas"][0]

    async def pagar(forma: str) -> int:
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test/api/v1"
        ) as c:
            r = await c.post(
                f"/contas-pagar/{conta['id']}/pagamento", headers=auth_admin, json={"forma": forma}
            )
            return r.status_code

    resultados = sorted(await asyncio.gather(pagar("PIX"), pagar("BOLETO")))
    assert resultados == [200, 409], resultados


async def test_corrigir_e_excluir_conta_aberta(
    client: AsyncClient, auth_admin: dict[str, str]
) -> None:
    conta = (await _lancar(client, auth_admin))["contas"][0]
    editada = await client.patch(
        f"/contas-pagar/{conta['id']}",
        headers=auth_admin,
        json={"valor": "260.00", "vencimento": _dia(12), "numero_nota": "NF 9"},
    )
    assert editada.status_code == 200, editada.text
    assert (editada.json()["valor"], editada.json()["vencimento"]) == ("260.00", _dia(12))

    assert (
        await client.delete(f"/contas-pagar/{conta['id']}", headers=auth_admin)
    ).status_code == 204
    assert (await client.get(f"/contas-pagar/{conta['id']}", headers=auth_admin)).status_code == 404
    abertas = (await client.get("/contas-pagar", headers=auth_admin)).json()
    assert conta["id"] not in [c["id"] for c in abertas["items"]]


# ------------------------------------------------------------------ fora do Resultado
async def test_conta_a_pagar_nao_entra_no_resultado(
    client: AsyncClient, auth_admin: dict[str, str], pecas: dict
) -> None:
    """O CMV já desconta a mercadoria quando ela é vendida. Se o boleto do fornecedor
    entrasse também, o mesmo custo sairia duas vezes do lucro do mês."""
    hoje = hoje_na_loja().isoformat()
    url = f"/relatorios/resumo?inicio={hoje}&fim={hoje}"
    antes = (await client.get(url, headers=auth_admin)).json()

    await client.post(
        "/estoque/entradas",
        headers=auth_admin,
        json=_entrada(pecas, _nota("900.00", [(0, "900.00")])),
    )
    conta = (await client.get("/contas-pagar", headers=auth_admin)).json()["items"][0]
    await client.post(
        f"/contas-pagar/{conta['id']}/pagamento", headers=auth_admin, json={"forma": "BOLETO"}
    )

    depois = (await client.get(url, headers=auth_admin)).json()
    for campo in ("despesas", "resultado", "custo_mercadoria_vendida", "lucro_bruto"):
        assert depois[campo] == antes[campo], campo
