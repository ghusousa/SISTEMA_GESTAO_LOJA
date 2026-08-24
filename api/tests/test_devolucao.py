"""Devolução, troca e vale — o dinheiro tem de fechar dos dois lados.

Cada teste aqui existe por um erro concreto que um painel de revisão apontou antes do
código ser escrito: devolver o preço cheio de uma venda com desconto, devolver em espécie
o que entrou no cartão, deixar duas devoluções simultâneas passarem, cancelar uma venda
que já teve peça devolvida, e o vale pagar duas vendas ao mesmo tempo.
"""

import uuid
from decimal import Decimal

import pytest

from conftest import criar_produto

pytestmark = pytest.mark.anyio


async def _peca(client, auth_admin, nome: str, preco: str, custo: str, estoque: int = 10):
    categoria = (
        await client.post("/categorias", headers=auth_admin, json={"nome": f"Cat {nome}"})
    ).json()
    produto = await criar_produto(client, auth_admin, {
                "categoria_id": categoria["id"],
                "nome": nome,
                "variantes": [
                    {
                        "tamanho": "M",
                        "cor": "Preta",
                        "preco_custo": custo,
                        "preco_venda": preco,
                        "estoque_inicial": estoque,
                    }
                ],
            })
    return produto["variantes"][0]["id"]


async def _vender(client, auth, variante_id: int, quantidade: int, pagamentos, desconto="0"):
    resposta = await client.post(
        "/vendas",
        headers=auth,
        json={
            "client_uuid": str(uuid.uuid4()),
            "desconto": desconto,
            "itens": [{"variante_id": variante_id, "quantidade": quantidade}],
            "pagamentos": pagamentos,
        },
    )
    assert resposta.status_code == 201, resposta.text
    return resposta.json()


async def _devolver(client, auth, venda_id: int, itens, motivo="Não serviu"):
    return await client.post(
        f"/vendas/{venda_id}/devolucoes",
        headers=auth,
        json={"itens": itens, "motivo": motivo, "client_uuid": str(uuid.uuid4())},
    )


# --------------------------------------------------------------- o caminho feliz


async def test_devolucao_devolve_peca_ao_estoque_e_dinheiro_a_cliente(
    client, auth_admin
) -> None:
    variante = await _peca(client, auth_admin, "Blusa Simples", "100.00", "40.00")
    venda = await _vender(
        client, auth_admin, variante, 2, [{"forma": "DINHEIRO", "valor": "200.00"}]
    )

    saldo_antes = (
        await client.get(f"/variantes?q={venda['itens'][0]['codigo_barras']}", headers=auth_admin)
    ).json()["items"][0]["saldo"]

    resposta = await _devolver(
        client, auth_admin, venda["id"], [{"item_id": venda["itens"][0]["id"], "quantidade": 1}]
    )
    assert resposta.status_code == 201, resposta.text
    devolucao = resposta.json()

    assert Decimal(devolucao["total"]) == Decimal("100.00")
    assert devolucao["pagamentos"] == [
        {"forma": "DINHEIRO", "valor": "100.00", "codigo_vale": None}
    ]

    saldo_depois = (
        await client.get(f"/variantes?q={venda['itens'][0]['codigo_barras']}", headers=auth_admin)
    ).json()["items"][0]["saldo"]
    assert saldo_depois == saldo_antes + 1, "a peça tem de voltar para a arara"


async def test_peca_com_defeito_nao_volta_ao_estoque(client, auth_admin) -> None:
    """Devolver não é sinônimo de revender: a peça rasgada não pode voltar para a arara."""
    variante = await _peca(client, auth_admin, "Camisa Rasgada", "80.00", "30.00")
    venda = await _vender(
        client, auth_admin, variante, 1, [{"forma": "DINHEIRO", "valor": "80.00"}]
    )
    codigo = venda["itens"][0]["codigo_barras"]
    antes = (await client.get(f"/variantes?q={codigo}", headers=auth_admin)).json()["items"][0][
        "saldo"
    ]

    resposta = await _devolver(
        client,
        auth_admin,
        venda["id"],
        [{"item_id": venda["itens"][0]["id"], "quantidade": 1, "voltar_ao_estoque": False}],
        motivo="Costura aberta",
    )
    assert resposta.status_code == 201

    depois = (await client.get(f"/variantes?q={codigo}", headers=auth_admin)).json()["items"][0][
        "saldo"
    ]
    assert depois == antes, "peça com defeito não volta ao estoque"
    assert Decimal(resposta.json()["total"]) == Decimal("80.00"), "mas o dinheiro volta"


# ------------------------------------------------------------------- o dinheiro


async def test_venda_com_desconto_devolve_o_que_a_cliente_pagou(client, auth_admin) -> None:
    """O desconto é do total da venda (ADR-3), então a devolução tem de ratear.

    Sem isso a loja devolve o preço de etiqueta de uma peça que saiu com desconto — e paga
    a diferença do próprio bolso em toda troca de venda negociada.
    """
    variante = await _peca(client, auth_admin, "Vestido Longo", "100.00", "40.00")
    # Duas peças de 100, com 40 de desconto: a cliente pagou 80 por peça.
    venda = await _vender(
        client,
        auth_admin,
        variante,
        2,
        [{"forma": "DINHEIRO", "valor": "160.00"}],
        desconto="40.00",
    )

    resposta = await _devolver(
        client, auth_admin, venda["id"], [{"item_id": venda["itens"][0]["id"], "quantidade": 1}]
    )
    assert resposta.status_code == 201
    assert Decimal(resposta.json()["total"]) == Decimal("80.00"), (
        "devolveu o preço de etiqueta em vez do que foi pago"
    )


async def test_devolver_tudo_devolve_exatamente_o_total_da_venda(client, auth_admin) -> None:
    """O resíduo dos arredondamentos não pode ficar com a loja nem com a cliente."""
    variante = await _peca(client, auth_admin, "Saia Plissada", "33.33", "10.00")
    venda = await _vender(
        client,
        auth_admin,
        variante,
        3,
        [{"forma": "DINHEIRO", "valor": "90.00"}],
        desconto="9.99",
    )
    item = venda["itens"][0]["id"]

    total_devolvido = Decimal("0.00")
    for _ in range(3):
        resposta = await _devolver(client, auth_admin, venda["id"], [{"item_id": item, "quantidade": 1}])
        assert resposta.status_code == 201, resposta.text
        total_devolvido += Decimal(resposta.json()["total"])

    assert total_devolvido == Decimal(venda["total"]), (
        f"devolveu {total_devolvido} de uma venda de {venda['total']}"
    )


async def test_nao_devolve_em_dinheiro_o_que_entrou_no_cartao(client, auth_admin) -> None:
    """Venda mista devolve na mesma proporção — o resto vira vale, não espécie.

    Devolver tudo em dinheiro esvaziaria a gaveta de um valor que nunca entrou nela, e o
    caixa do dia fecharia negativo sem nada na tela explicando.
    """
    variante = await _peca(client, auth_admin, "Casaco Pesado", "300.00", "120.00")
    venda = await _vender(
        client,
        auth_admin,
        variante,
        1,
        [
            {"forma": "DINHEIRO", "valor": "50.00"},
            {"forma": "CREDITO", "valor": "250.00"},
        ],
    )

    resposta = await _devolver(
        client, auth_admin, venda["id"], [{"item_id": venda["itens"][0]["id"], "quantidade": 1}]
    )
    assert resposta.status_code == 201
    por_forma = {p["forma"]: Decimal(p["valor"]) for p in resposta.json()["pagamentos"]}
    assert por_forma.get("DINHEIRO", Decimal(0)) <= Decimal("50.00"), (
        "saiu da gaveta mais do que entrou nela"
    )
    assert sum(por_forma.values()) == Decimal("300.00")


# --------------------------------------------------------------- as travas


async def test_nao_devolve_mais_do_que_foi_vendido(client, auth_admin) -> None:
    variante = await _peca(client, auth_admin, "Regata Basica", "50.00", "20.00")
    venda = await _vender(
        client, auth_admin, variante, 1, [{"forma": "DINHEIRO", "valor": "50.00"}]
    )
    item = venda["itens"][0]["id"]

    assert (await _devolver(client, auth_admin, venda["id"], [{"item_id": item, "quantidade": 1}])).status_code == 201
    segunda = await _devolver(client, auth_admin, venda["id"], [{"item_id": item, "quantidade": 1}])
    assert segunda.status_code == 409, segunda.text


async def test_duas_devolucoes_simultaneas_da_mesma_peca_so_uma_passa(
    client, auth_admin
) -> None:
    """A trava é o UPDATE condicional, não uma leitura antes — como o saldo de estoque."""
    import asyncio

    variante = await _peca(client, auth_admin, "Short Jeans", "70.00", "25.00")
    venda = await _vender(
        client, auth_admin, variante, 1, [{"forma": "DINHEIRO", "valor": "70.00"}]
    )
    item = venda["itens"][0]["id"]

    respostas = await asyncio.gather(
        _devolver(client, auth_admin, venda["id"], [{"item_id": item, "quantidade": 1}]),
        _devolver(client, auth_admin, venda["id"], [{"item_id": item, "quantidade": 1}]),
        return_exceptions=True,
    )
    ok = [r for r in respostas if not isinstance(r, Exception) and r.status_code == 201]
    assert len(ok) == 1, f"passaram {len(ok)} devoluções da mesma peça"


async def test_cancelar_venda_com_devolucao_e_recusado(client, auth_admin) -> None:
    """Senão o estoque volta duas vezes e o dinheiro fica sem caminho."""
    variante = await _peca(client, auth_admin, "Calca Social", "150.00", "60.00")
    venda = await _vender(
        client, auth_admin, variante, 2, [{"forma": "DINHEIRO", "valor": "300.00"}]
    )
    await _devolver(client, auth_admin, venda["id"], [{"item_id": venda["itens"][0]["id"], "quantidade": 1}])

    cancelamento = await client.post(
        f"/vendas/{venda['id']}/cancelamento",
        headers=auth_admin,
        json={"motivo": "Cliente desistiu de tudo"},
    )
    assert cancelamento.status_code == 409, cancelamento.text
    assert "devolv" in cancelamento.json()["message"].lower()


async def test_devolver_venda_cancelada_e_recusado(client, auth_admin) -> None:
    variante = await _peca(client, auth_admin, "Blusa Cancelada", "90.00", "30.00")
    venda = await _vender(
        client, auth_admin, variante, 1, [{"forma": "DINHEIRO", "valor": "90.00"}]
    )
    await client.post(
        f"/vendas/{venda['id']}/cancelamento", headers=auth_admin, json={"motivo": "Erro no caixa"}
    )
    resposta = await _devolver(
        client, auth_admin, venda["id"], [{"item_id": venda["itens"][0]["id"], "quantidade": 1}]
    )
    assert resposta.status_code == 409


async def test_devolucao_e_idempotente(client, auth_admin) -> None:
    """Retry de rede não pode devolver a peça duas vezes."""
    variante = await _peca(client, auth_admin, "Camiseta Retry", "60.00", "20.00")
    venda = await _vender(
        client, auth_admin, variante, 2, [{"forma": "DINHEIRO", "valor": "120.00"}]
    )
    corpo = {
        "itens": [{"item_id": venda["itens"][0]["id"], "quantidade": 1}],
        "motivo": "Trocou de ideia",
        "client_uuid": str(uuid.uuid4()),
    }
    primeira = await client.post(f"/vendas/{venda['id']}/devolucoes", headers=auth_admin, json=corpo)
    segunda = await client.post(f"/vendas/{venda['id']}/devolucoes", headers=auth_admin, json=corpo)
    assert primeira.status_code == 201
    assert segunda.status_code in (200, 201)
    assert segunda.json()["id"] == primeira.json()["id"]


async def test_vendedora_nao_devolve(client, auth_vendedor, auth_admin) -> None:
    """Quem vende não desfaz a própria venda — mesma regra do cancelamento."""
    variante = await _peca(client, auth_admin, "Blusa Vendedora", "40.00", "15.00")
    venda = await _vender(
        client, auth_vendedor, variante, 1, [{"forma": "DINHEIRO", "valor": "40.00"}]
    )
    resposta = await _devolver(
        client, auth_vendedor, venda["id"], [{"item_id": venda["itens"][0]["id"], "quantidade": 1}]
    )
    assert resposta.status_code == 403


async def test_acha_a_venda_pela_peca(client, auth_admin) -> None:
    """A cliente chega com a blusa e sem nota. Sem este filtro, a devolução não acontece."""
    variante = await _peca(client, auth_admin, "Peca Procurada", "55.00", "20.00")
    venda = await _vender(
        client, auth_admin, variante, 1, [{"forma": "DINHEIRO", "valor": "55.00"}]
    )
    achou = await client.get(f"/vendas?variante_id={variante}", headers=auth_admin)
    assert achou.status_code == 200
    assert venda["id"] in [v["id"] for v in achou.json()["items"]]
