"""Condicional: a peça que vai para a casa da cliente provar (ADR-39).

O que estes testes guardam, dos dois lados:
- a peça na sacola da cliente NÃO está disponível — não se vende de novo no balcão;
- o que ficou com a cliente é venda de verdade (caixa, faturamento, recibo), registrada
  pelo caminho de sempre, e o que voltou é estoque de novo — nada a mais, nada a menos,
  nem com toque duplo, nem com dois aparelhos, nem com a resposta perdida.
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
async def loja(client: AsyncClient, auth_admin: dict[str, str]) -> dict:
    """Vestido (5 em estoque, R$ 199,90), blusa (3, R$ 89,90) e uma cliente."""
    categoria = (
        await client.post("/categorias", headers=auth_admin, json={"nome": "Vestidos"})
    ).json()["id"]
    produto = await criar_produto(
        client,
        auth_admin,
        {
            "categoria_id": categoria,
            "nome": "Vestido Midi",
            "variantes": [
                {
                    "tamanho": "M",
                    "cor": "Azul",
                    "preco_custo": "80.00",
                    "preco_venda": "199.90",
                    "estoque_inicial": 5,
                },
                {
                    "tamanho": "P",
                    "cor": "Rosa",
                    "preco_custo": "35.00",
                    "preco_venda": "89.90",
                    "estoque_inicial": 3,
                },
            ],
        },
    )
    vestido, blusa = (v["id"] for v in produto["variantes"])
    cliente = (
        await client.post(
            "/clientes", headers=auth_admin, json={"nome": "Dona Cida", "telefone": "11988887777"}
        )
    ).json()
    return {"vestido": vestido, "blusa": blusa, "cliente": cliente["id"]}


async def _saldo(client: AsyncClient, auth: dict[str, str], variante_id: int) -> int:
    pagina = (await client.get("/estoque/saldos?size=100", headers=auth)).json()
    return next(s["saldo"] for s in pagina["items"] if s["variante_id"] == variante_id)


def _abertura(loja: dict, **mais) -> dict:
    return {
        "client_uuid": str(uuid.uuid4()),
        "cliente_id": loja["cliente"],
        "prazo": (hoje_na_loja() + timedelta(days=3)).isoformat(),
        "itens": [
            {"variante_id": loja["vestido"], "quantidade": 2},
            {"variante_id": loja["blusa"], "quantidade": 1},
        ],
        **mais,
    }


async def _abrir(client: AsyncClient, auth: dict[str, str], loja: dict, **mais) -> dict:
    resposta = await client.post("/condicionais", headers=auth, json=_abertura(loja, **mais))
    assert resposta.status_code == 201, resposta.text
    return resposta.json()


async def _contar(sql: str) -> int:
    async with engine.connect() as conn:
        return int((await conn.execute(text(sql))).scalar_one())


# ------------------------------------------------------------------ abrir
async def test_condicional_tira_a_peca_do_disponivel(
    client: AsyncClient, auth_vendedor: dict[str, str], loja: dict
) -> None:
    """A vendedora abre (é atendimento de balcão) e a peça sai do saldo na mesma hora."""
    condicional = await _abrir(client, auth_vendedor, loja)

    assert condicional["status"] == "ABERTA"
    assert condicional["cliente"] == "Dona Cida"
    assert condicional["total_pecas"] == 3
    assert condicional["valor_pecas"] == "489.70"  # 2 x 199,90 + 89,90
    assert condicional["vencida"] is False
    assert await _saldo(client, auth_vendedor, loja["vestido"]) == 3
    assert await _saldo(client, auth_vendedor, loja["blusa"]) == 2

    extrato = (
        await client.get(
            f"/estoque/movimentacoes?variante_id={loja['vestido']}&tipo=CONDICIONAL_SAIDA",
            headers=auth_vendedor,
        )
    ).json()
    assert extrato["total"] == 1
    mov = extrato["items"][0]
    assert mov["quantidade"] == -2
    assert mov["condicional_id"] == condicional["id"]
    # O nome da cliente NÃO vai para o extrato append-only (LGPD): só o número.
    assert mov["observacao"] == f"Condicional #{condicional['id']}"


async def test_peca_em_condicional_nao_e_vendida_no_balcao(
    client: AsyncClient, auth_vendedor: dict[str, str], loja: dict
) -> None:
    """3 blusas, as 3 na casa da cliente: o PDV não pode vender uma quarta que não existe."""
    await _abrir(
        client, auth_vendedor, loja, itens=[{"variante_id": loja["blusa"], "quantidade": 3}]
    )
    venda = await client.post(
        "/vendas",
        headers=auth_vendedor,
        json={
            "client_uuid": str(uuid.uuid4()),
            "itens": [{"variante_id": loja["blusa"], "quantidade": 1}],
            "pagamentos": [{"forma": "PIX", "valor": "89.90"}],
        },
    )
    assert venda.status_code == 409, venda.text
    assert venda.json()["code"] == "ESTOQUE_INSUFICIENTE"


async def test_condicional_alem_do_estoque_e_recusada_sem_gravar_nada(
    client: AsyncClient, auth_vendedor: dict[str, str], loja: dict
) -> None:
    resposta = await client.post(
        "/condicionais",
        headers=auth_vendedor,
        json=_abertura(loja, itens=[{"variante_id": loja["blusa"], "quantidade": 4}]),
    )
    assert resposta.status_code == 409, resposta.text
    assert resposta.json()["code"] == "ESTOQUE_INSUFICIENTE"
    assert await _contar("SELECT count(*) FROM consignments") == 0
    assert await _saldo(client, auth_vendedor, loja["blusa"]) == 3


async def test_abertura_reenviada_nao_tira_a_peca_duas_vezes(
    client: AsyncClient, auth_vendedor: dict[str, str], loja: dict
) -> None:
    pedido = _abertura(loja)
    primeira = await client.post("/condicionais", headers=auth_vendedor, json=pedido)
    retry = await client.post("/condicionais", headers=auth_vendedor, json=pedido)

    assert primeira.status_code == 201
    assert retry.status_code == 200, retry.text
    assert retry.json()["id"] == primeira.json()["id"]
    assert await _saldo(client, auth_vendedor, loja["vestido"]) == 3


async def test_mesma_chave_com_outra_sacola_e_409(
    client: AsyncClient, auth_vendedor: dict[str, str], loja: dict
) -> None:
    """A resposta se perdeu e a vendedora pôs mais uma peça na sacola: devolver a antiga como
    sucesso deixaria a peça nova sem sair do saldo."""
    pedido = _abertura(loja)
    primeira = await client.post("/condicionais", headers=auth_vendedor, json=pedido)
    outra = await client.post(
        "/condicionais",
        headers=auth_vendedor,
        json={**pedido, "itens": [{"variante_id": loja["vestido"], "quantidade": 3}]},
    )
    assert outra.status_code == 409, outra.text
    assert outra.json()["code"] == "DUPLICADO"
    assert outra.json()["detail"]["condicional_id"] == primeira.json()["id"]
    assert await _saldo(client, auth_vendedor, loja["vestido"]) == 3


async def test_prazo_que_ja_passou_e_recusado(
    client: AsyncClient, auth_vendedor: dict[str, str], loja: dict
) -> None:
    ontem = (hoje_na_loja() - timedelta(days=1)).isoformat()
    resposta = await client.post(
        "/condicionais", headers=auth_vendedor, json=_abertura(loja, prazo=ontem)
    )
    assert resposta.status_code == 422, resposta.text
    assert await _saldo(client, auth_vendedor, loja["vestido"]) == 5


async def test_cliente_inexistente_e_404(
    client: AsyncClient, auth_vendedor: dict[str, str], loja: dict
) -> None:
    resposta = await client.post(
        "/condicionais", headers=auth_vendedor, json=_abertura(loja, cliente_id=999_999)
    )
    assert resposta.status_code == 404, resposta.text
    assert await _contar("SELECT count(*) FROM consignments") == 0


async def test_sem_login_nao_ve_condicional(client: AsyncClient) -> None:
    assert (await client.get("/condicionais")).status_code == 401


# ------------------------------------------------------------------ fechar
def _fechamento(itens: dict[int, int], pagamentos: list | None = None, **mais) -> dict:
    return {
        "client_uuid": str(uuid.uuid4()),
        "itens": [{"variante_id": v, "devolvida": d} for v, d in itens.items()],
        "pagamentos": pagamentos or [],
        **mais,
    }


async def test_tudo_voltou_devolve_o_estoque_sem_venda(
    client: AsyncClient, auth_vendedor: dict[str, str], loja: dict
) -> None:
    condicional = await _abrir(client, auth_vendedor, loja)
    resposta = await client.post(
        f"/condicionais/{condicional['id']}/fechamento",
        headers=auth_vendedor,
        json=_fechamento({loja["vestido"]: 2, loja["blusa"]: 1}),
    )
    assert resposta.status_code == 201, resposta.text
    fechada = resposta.json()
    assert fechada["status"] == "FECHADA"
    assert fechada["venda_id"] is None
    assert fechada["fechada_por"] == "Ana Vendedora"
    assert {i["variante_id"]: i["ficou"] for i in fechada["itens"]} == {
        loja["vestido"]: 0,
        loja["blusa"]: 0,
    }
    assert await _saldo(client, auth_vendedor, loja["vestido"]) == 5
    assert await _saldo(client, auth_vendedor, loja["blusa"]) == 3
    assert await _contar("SELECT count(*) FROM sales") == 0


async def test_o_que_ficou_vira_venda_comum_ligada_a_condicional(
    client: AsyncClient, auth_vendedor: dict[str, str], auth_admin: dict[str, str], loja: dict
) -> None:
    """Levou 2 vestidos e 1 blusa, ficou com 1 vestido: venda de R$ 199,90 no PIX, com a
    cliente da condicional; o resto volta para a arara."""
    condicional = await _abrir(client, auth_vendedor, loja)
    resposta = await client.post(
        f"/condicionais/{condicional['id']}/fechamento",
        headers=auth_vendedor,
        json=_fechamento(
            {loja["vestido"]: 1, loja["blusa"]: 1},
            [{"forma": "PIX", "valor": "199.90"}],
        ),
    )
    assert resposta.status_code == 201, resposta.text
    fechada = resposta.json()
    assert fechada["venda_id"] is not None

    venda = (await client.get(f"/vendas/{fechada['venda_id']}", headers=auth_admin)).json()
    assert venda["total"] == "199.90"
    assert venda["cliente_id"] == loja["cliente"]
    assert venda["vendedor"] == "Ana Vendedora"
    assert venda["observacao"].startswith(f"Condicional #{condicional['id']}")
    assert [(i["variante_id"], i["quantidade"]) for i in venda["itens"]] == [(loja["vestido"], 1)]
    # Custo congelado como em toda venda: o lucro do mês enxerga a venda da condicional.
    assert venda["custo_total"] == "80.00"

    assert await _saldo(client, auth_vendedor, loja["vestido"]) == 4
    assert await _saldo(client, auth_vendedor, loja["blusa"]) == 3

    # O extrato conta a história inteira: saiu 2, voltou 2, vendeu 1.
    extrato = (
        await client.get(
            f"/estoque/movimentacoes?variante_id={loja['vestido']}", headers=auth_vendedor
        )
    ).json()
    tipos = [(m["tipo"], m["quantidade"]) for m in reversed(extrato["items"])]
    assert tipos[-3:] == [("CONDICIONAL_SAIDA", -2), ("CONDICIONAL_RETORNO", 2), ("VENDA", -1)]


async def test_pagamento_errado_no_fechamento_nao_muda_nada(
    client: AsyncClient, auth_vendedor: dict[str, str], loja: dict
) -> None:
    """Retorno e venda são um commit só: o erro da venda desfaz o retorno também."""
    condicional = await _abrir(client, auth_vendedor, loja)
    resposta = await client.post(
        f"/condicionais/{condicional['id']}/fechamento",
        headers=auth_vendedor,
        json=_fechamento(
            {loja["vestido"]: 1, loja["blusa"]: 1}, [{"forma": "PIX", "valor": "150.00"}]
        ),
    )
    assert resposta.status_code == 422, resposta.text
    assert resposta.json()["code"] == "PAGAMENTO_DIVERGENTE"

    atual = (await client.get(f"/condicionais/{condicional['id']}", headers=auth_vendedor)).json()
    assert atual["status"] == "ABERTA"
    assert await _saldo(client, auth_vendedor, loja["vestido"]) == 3
    assert (
        await _contar(
            "SELECT count(*) FROM stock_movements WHERE movement_type = 'CONDICIONAL_RETORNO'"
        )
        == 0
    )
    assert await _contar("SELECT count(*) FROM sales") == 0


async def test_vendedora_nao_fecha_no_fiado(
    client: AsyncClient, auth_vendedor: dict[str, str], loja: dict
) -> None:
    """A condicional não é porta lateral para o fiado: a regra do PDV vale aqui também."""
    condicional = await _abrir(client, auth_vendedor, loja)
    resposta = await client.post(
        f"/condicionais/{condicional['id']}/fechamento",
        headers=auth_vendedor,
        json=_fechamento(
            {loja["vestido"]: 1, loja["blusa"]: 1}, [{"forma": "FIADO", "valor": "199.90"}]
        ),
    )
    assert resposta.status_code == 403, resposta.text
    atual = (await client.get(f"/condicionais/{condicional['id']}", headers=auth_vendedor)).json()
    assert atual["status"] == "ABERTA"
    assert await _saldo(client, auth_vendedor, loja["vestido"]) == 3


async def test_gerente_fecha_no_fiado_da_cliente_da_condicional(
    client: AsyncClient, auth_gerente: dict[str, str], loja: dict
) -> None:
    condicional = await _abrir(client, auth_gerente, loja)
    resposta = await client.post(
        f"/condicionais/{condicional['id']}/fechamento",
        headers=auth_gerente,
        json=_fechamento(
            {loja["vestido"]: 1, loja["blusa"]: 1}, [{"forma": "FIADO", "valor": "199.90"}]
        ),
    )
    assert resposta.status_code == 201, resposta.text
    cliente = (await client.get(f"/clientes/{loja['cliente']}", headers=auth_gerente)).json()
    assert cliente["deve"] == "199.90"


async def test_fechamento_tem_de_conferir_cada_peca(
    client: AsyncClient, auth_vendedor: dict[str, str], loja: dict
) -> None:
    condicional = await _abrir(client, auth_vendedor, loja)
    url = f"/condicionais/{condicional['id']}/fechamento"

    faltando = await client.post(url, headers=auth_vendedor, json=_fechamento({loja["vestido"]: 2}))
    assert faltando.status_code == 422, faltando.text
    assert faltando.json()["detail"]["faltando"] == [loja["blusa"]]

    demais = await client.post(
        url, headers=auth_vendedor, json=_fechamento({loja["vestido"]: 3, loja["blusa"]: 1})
    )
    assert demais.status_code == 422, demais.text

    sem_pagar = await client.post(
        url, headers=auth_vendedor, json=_fechamento({loja["vestido"]: 0, loja["blusa"]: 1})
    )
    assert sem_pagar.status_code == 422, sem_pagar.text

    cobrando_o_que_voltou = await client.post(
        url,
        headers=auth_vendedor,
        json=_fechamento(
            {loja["vestido"]: 2, loja["blusa"]: 1}, [{"forma": "PIX", "valor": "10.00"}]
        ),
    )
    assert cobrando_o_que_voltou.status_code == 422, cobrando_o_que_voltou.text
    assert await _saldo(client, auth_vendedor, loja["vestido"]) == 3


async def test_fechamento_reenviado_nao_cobra_duas_vezes(
    client: AsyncClient, auth_vendedor: dict[str, str], loja: dict
) -> None:
    condicional = await _abrir(client, auth_vendedor, loja)
    url = f"/condicionais/{condicional['id']}/fechamento"
    pedido = _fechamento(
        {loja["vestido"]: 1, loja["blusa"]: 1}, [{"forma": "PIX", "valor": "199.90"}]
    )
    primeira = await client.post(url, headers=auth_vendedor, json=pedido)
    retry = await client.post(url, headers=auth_vendedor, json=pedido)
    assert primeira.status_code == 201, primeira.text
    assert retry.status_code == 200, retry.text
    assert retry.json()["venda_id"] == primeira.json()["venda_id"]

    # Mesma chave, outro pagamento: a resposta se perdeu e ela trocou PIX por dinheiro.
    trocou = await client.post(
        url,
        headers=auth_vendedor,
        json={**pedido, "pagamentos": [{"forma": "DINHEIRO", "valor": "199.90"}]},
    )
    assert trocou.status_code == 409, trocou.text
    assert trocou.json()["code"] == "DUPLICADO"

    # Outra chave: é outro fechamento de algo que já fechou.
    outro = await client.post(
        url,
        headers=auth_vendedor,
        json=_fechamento({loja["vestido"]: 2, loja["blusa"]: 1}),
    )
    assert outro.status_code == 409, outro.text
    assert outro.json()["code"] == "OPERACAO_INVALIDA"

    assert await _contar("SELECT count(*) FROM sales") == 1
    assert await _saldo(client, auth_vendedor, loja["vestido"]) == 4


async def test_dois_aparelhos_fechando_ao_mesmo_tempo_so_um_fecha(
    client: AsyncClient, auth_vendedor: dict[str, str], loja: dict
) -> None:
    """Toque duplo ou dois balcões: o estoque volta UMA vez e a cliente é cobrada UMA vez."""
    condicional = await _abrir(client, auth_vendedor, loja)

    async def fechar() -> int:
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test/api/v1"
        ) as c:
            resposta = await c.post(
                f"/condicionais/{condicional['id']}/fechamento",
                headers=auth_vendedor,
                json=_fechamento(
                    {loja["vestido"]: 1, loja["blusa"]: 1}, [{"forma": "PIX", "valor": "199.90"}]
                ),
            )
            return resposta.status_code

    resultados = sorted(await asyncio.gather(fechar(), fechar()))
    assert resultados == [201, 409], resultados
    assert await _contar("SELECT count(*) FROM sales") == 1
    assert (
        await _contar(
            "SELECT count(*) FROM stock_movements WHERE movement_type = 'CONDICIONAL_RETORNO'"
        )
        == 2
    )
    assert await _saldo(client, auth_vendedor, loja["vestido"]) == 4
    assert await _saldo(client, auth_vendedor, loja["blusa"]) == 3


async def test_condicional_e_venda_disputando_a_ultima_peca(
    client: AsyncClient, auth_vendedor: dict[str, str], auth_admin: dict[str, str], loja: dict
) -> None:
    """Uma blusa sobrando: a sacola e o balcão a querem ao mesmo tempo. Uma leva; o saldo
    nunca fica negativo (CHECK)."""
    await client.post(
        "/estoque/ajustes",
        headers=auth_admin,
        json={"variante_id": loja["blusa"], "quantidade": -2, "motivo": "deixar uma só"},
    )

    async def abrir() -> int:
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test/api/v1"
        ) as c:
            r = await c.post(
                "/condicionais",
                headers=auth_vendedor,
                json=_abertura(loja, itens=[{"variante_id": loja["blusa"], "quantidade": 1}]),
            )
            return r.status_code

    async def vender() -> int:
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test/api/v1"
        ) as c:
            r = await c.post(
                "/vendas",
                headers=auth_vendedor,
                json={
                    "client_uuid": str(uuid.uuid4()),
                    "itens": [{"variante_id": loja["blusa"], "quantidade": 1}],
                    "pagamentos": [{"forma": "PIX", "valor": "89.90"}],
                },
            )
            return r.status_code

    resultados = sorted(await asyncio.gather(abrir(), vender()))
    assert resultados == [201, 409], resultados
    assert await _saldo(client, auth_vendedor, loja["blusa"]) == 0


async def test_peca_excluida_enquanto_estava_na_condicional_volta_para_o_catalogo(
    client: AsyncClient, auth_vendedor: dict[str, str], auth_admin: dict[str, str], loja: dict
) -> None:
    """As 3 blusas na casa da cliente, saldo zero, e alguém exclui a peça achando que
    esgotou. A blusa volta na sacola: não pode ser recusada nem sumir num item invisível."""
    condicional = await _abrir(
        client, auth_vendedor, loja, itens=[{"variante_id": loja["blusa"], "quantidade": 3}]
    )
    excluir = await client.delete(f"/variantes/{loja['blusa']}", headers=auth_admin)
    assert excluir.status_code == 204, excluir.text

    resposta = await client.post(
        f"/condicionais/{condicional['id']}/fechamento",
        headers=auth_vendedor,
        json=_fechamento({loja["blusa"]: 3}),
    )
    assert resposta.status_code == 201, resposta.text
    assert await _saldo(client, auth_vendedor, loja["blusa"]) == 3


async def test_cliente_com_sacola_em_casa_nao_se_exclui(
    client: AsyncClient, auth_vendedor: dict[str, str], auth_admin: dict[str, str], loja: dict
) -> None:
    """Quitada, a exclusão anonimiza (LGPD). Com peça em condicional, não: a sacola ficaria
    sem nome nem telefone para cobrar, e o fechamento venderia para uma cliente que não
    existe mais — as peças ficariam fora do saldo para sempre."""
    condicional = await _abrir(client, auth_vendedor, loja)

    recusa = await client.delete(f"/clientes/{loja['cliente']}", headers=auth_admin)
    assert recusa.status_code == 409, recusa.text
    assert recusa.json()["detail"]["condicionais_abertas"] == 1

    fechar = await client.post(
        f"/condicionais/{condicional['id']}/fechamento",
        headers=auth_vendedor,
        json=_fechamento({loja["vestido"]: 2, loja["blusa"]: 1}),
    )
    assert fechar.status_code == 201, fechar.text
    excluir = await client.delete(f"/clientes/{loja['cliente']}", headers=auth_admin)
    assert excluir.status_code == 204, excluir.text


# ------------------------------------------------------------------ listas
async def test_listas_de_abertas_vencidas_e_por_cliente(
    client: AsyncClient, auth_vendedor: dict[str, str], auth_admin: dict[str, str], loja: dict
) -> None:
    hoje = hoje_na_loja()
    no_prazo = await _abrir(
        client, auth_vendedor, loja, itens=[{"variante_id": loja["vestido"], "quantidade": 1}]
    )
    atrasada = await _abrir(
        client,
        auth_vendedor,
        loja,
        itens=[{"variante_id": loja["blusa"], "quantidade": 1}],
        prazo=hoje.isoformat(),
    )
    # Vence no dia SEGUINTE ao prazo: hoje ainda está no prazo.
    vencidas = (await client.get("/condicionais?situacao=vencidas", headers=auth_vendedor)).json()
    assert vencidas["total"] == 0

    async with engine.begin() as conn:
        await conn.execute(
            text("UPDATE consignments SET due_date = :d WHERE id = :i"),
            {"d": hoje - timedelta(days=2), "i": atrasada["id"]},
        )
    vencidas = (await client.get("/condicionais?situacao=vencidas", headers=auth_vendedor)).json()
    assert [c["id"] for c in vencidas["items"]] == [atrasada["id"]]
    assert vencidas["items"][0]["vencida"] is True
    assert vencidas["items"][0]["dias_para_vencer"] == -2
    assert vencidas["items"][0]["cliente_telefone"] == "11988887777"

    abertas = (await client.get("/condicionais", headers=auth_vendedor)).json()
    assert {"items", "total", "page", "size"} <= set(abertas)
    # A que vence primeiro em cima: é a próxima ligação a fazer.
    assert [c["id"] for c in abertas["items"]] == [atrasada["id"], no_prazo["id"]]

    outra = (
        await client.post(
            "/clientes", headers=auth_admin, json={"nome": "Bia", "telefone": "11911112222"}
        )
    ).json()
    await _abrir(
        client,
        auth_vendedor,
        loja,
        cliente_id=outra["id"],
        itens=[{"variante_id": loja["vestido"], "quantidade": 1}],
    )
    da_cida = (
        await client.get(
            f"/condicionais?situacao=todas&cliente_id={loja['cliente']}", headers=auth_vendedor
        )
    ).json()
    assert da_cida["total"] == 2
    paginada = (await client.get("/condicionais?size=1&page=2", headers=auth_vendedor)).json()
    assert paginada["total"] == 3 and len(paginada["items"]) == 1


async def test_diario_registra_abertura_e_fechamento(
    client: AsyncClient, auth_vendedor: dict[str, str], loja: dict
) -> None:
    condicional = await _abrir(client, auth_vendedor, loja)
    await client.post(
        f"/condicionais/{condicional['id']}/fechamento",
        headers=auth_vendedor,
        json=_fechamento({loja["vestido"]: 2, loja["blusa"]: 1}),
    )
    async with engine.connect() as conn:
        acoes = (await conn.execute(text("SELECT acao FROM audit_log ORDER BY id"))).scalars().all()
    assert "CONDICIONAL_ABERTA" in acoes
    assert "CONDICIONAL_FECHADA" in acoes
