"""Taxa da maquininha e crédito parcelado (ADR-35).

O que não pode quebrar: a taxa é FOTOGRAFADA na venda (mudar a tabela não reescreve o
passado), o Resultado desconta a taxa (senão sai inflado todo mês), a parte devolvida
devolve a taxa dela, só o crédito parcela, a agenda de recebíveis cai nas datas certas com
o centavo da divisão na 1ª parcela, e custo de receber é dinheiro: só quem vê dinheiro lê.
"""

import uuid
from datetime import timedelta
from decimal import Decimal

import pytest
from conftest import criar_produto
from httpx import AsyncClient

from app.core.datas import hoje_na_loja


async def _peca(client: AsyncClient, auth: dict[str, str], preco: str = "100.00") -> int:
    cat = await client.post("/categorias", headers=auth, json={"nome": "Vestidos"})
    produto = await criar_produto(
        client,
        auth,
        {
            "categoria_id": cat.json()["id"],
            "nome": "Vestido Midi",
            "variantes": [
                {
                    "tamanho": "M",
                    "cor": "Verde",
                    "preco_custo": "40.00",
                    "preco_venda": preco,
                    "estoque_inicial": 20,
                }
            ],
        },
    )
    return produto["variantes"][0]["id"]


async def _vender(
    client: AsyncClient,
    auth: dict[str, str],
    variante: int,
    pagamentos: list[dict],
    quantidade: int = 1,
    chave: str | None = None,
):
    return await client.post(
        "/vendas",
        headers=auth,
        json={
            "client_uuid": chave or str(uuid.uuid4()),
            "itens": [{"variante_id": variante, "quantidade": quantidade}],
            "pagamentos": pagamentos,
        },
    )


async def _taxa(client, auth, **dados) -> dict:
    resp = await client.post("/taxas-cartao", headers=auth, json=dados)
    assert resp.status_code == 201, resp.text
    return resp.json()


def _hoje() -> str:
    return hoje_na_loja().isoformat()


# ------------------------------------------------------------------ a tabela


async def test_so_quem_ve_dinheiro_le_e_so_o_dono_muda_a_taxa(
    client, auth_admin, auth_gerente, auth_supervisora, auth_vendedor
):
    criada = await _taxa(
        client, auth_admin, forma="DEBITO", percentual="1.99", prazo_dias=1
    )
    assert criada["percentual"] == "1.99"

    assert (await client.get("/taxas-cartao", headers=auth_gerente)).status_code == 200
    for auth in (auth_supervisora, auth_vendedor):
        assert (await client.get("/taxas-cartao", headers=auth)).status_code == 403

    # O gerente lê o Resultado, mas o contrato com a credenciadora é do dono.
    for auth in (auth_gerente, auth_supervisora, auth_vendedor):
        nova = await client.post(
            "/taxas-cartao",
            headers=auth,
            json={"forma": "CREDITO", "percentual": "3.00", "prazo_dias": 30},
        )
        assert nova.status_code == 403
        mexer = await client.patch(
            f"/taxas-cartao/{criada['id']}", headers=auth, json={"percentual": "0.10"}
        )
        assert mexer.status_code == 403
        assert (
            await client.delete(f"/taxas-cartao/{criada['id']}", headers=auth)
        ).status_code == 403

    lista = (await client.get("/taxas-cartao", headers=auth_admin)).json()
    assert lista["total"] == 1 and lista["page"] == 1
    assert lista["items"][0]["percentual"] == "1.99"


async def test_faixas_da_mesma_forma_nao_se_sobrepoem(client, auth_admin):
    """Duas taxas para o mesmo '5x' deixariam a venda escolher uma ao acaso."""
    await _taxa(
        client, auth_admin, forma="CREDITO", parcelas_de=2, parcelas_ate=6,
        percentual="4.99", prazo_dias=30,
    )
    encosta = await client.post(
        "/taxas-cartao",
        headers=auth_admin,
        json={"forma": "CREDITO", "parcelas_de": 6, "parcelas_ate": 12,
              "percentual": "6.99", "prazo_dias": 30},
    )
    assert encosta.status_code == 422
    assert encosta.json()["code"] == "VALIDACAO"

    # A faixa vizinha, sem encostar, entra; e o débito não briga com o crédito.
    await _taxa(
        client, auth_admin, forma="CREDITO", parcelas_de=7, parcelas_ate=12,
        percentual="6.99", prazo_dias=30,
    )
    await _taxa(client, auth_admin, forma="DEBITO", percentual="1.50", prazo_dias=1)

    # Esticar uma faixa por cima da outra no PATCH também é recusado.
    lista = (await client.get("/taxas-cartao", headers=auth_admin)).json()["items"]
    de_2_a_6 = next(t for t in lista if t["parcelas_de"] == 2)
    esticar = await client.patch(
        f"/taxas-cartao/{de_2_a_6['id']}", headers=auth_admin, json={"parcelas_ate": 8}
    )
    assert esticar.status_code == 422


@pytest.mark.parametrize(
    "pedido",
    [
        {"forma": "DEBITO", "parcelas_ate": 3, "percentual": "2", "prazo_dias": 1},
        {"forma": "CREDITO", "parcelas_de": 5, "parcelas_ate": 2, "percentual": "2",
         "prazo_dias": 30},
        {"forma": "PIX", "percentual": "1", "prazo_dias": 0},
        {"forma": "CREDITO", "percentual": "100", "prazo_dias": 30},
        {"forma": "CREDITO", "percentual": "-1", "prazo_dias": 30},
        {"forma": "CREDITO", "parcelas_ate": 13, "percentual": "3", "prazo_dias": 30},
        {"forma": "CREDITO", "percentual": "3", "prazo_dias": 3000},
    ],
)
async def test_taxa_absurda_e_recusada(client, auth_admin, pedido):
    assert (
        await client.post("/taxas-cartao", headers=auth_admin, json=pedido)
    ).status_code == 422


# ------------------------------------------------------------------ a venda


async def test_taxa_e_fotografada_na_venda_e_nao_muda_com_a_tabela(client, auth_admin):
    variante = await _peca(client, auth_admin)
    taxa = await _taxa(
        client, auth_admin, forma="CREDITO", parcelas_de=2, parcelas_ate=6,
        percentual="4.99", prazo_dias=30,
    )
    venda = await _vender(
        client, auth_admin, variante,
        [{"forma": "CREDITO", "valor": "100.00", "parcelas": 3, "bandeira": " Visa "}],
    )
    assert venda.status_code == 201, venda.text
    pagamento = venda.json()["pagamentos"][0]
    assert pagamento["parcelas"] == 3
    assert pagamento["bandeira"] == "Visa"
    assert pagamento["taxa_percentual"] == "4.99"
    assert pagamento["taxa"] == "4.99"
    assert venda.json()["taxas_cartao"] == "4.99"

    # O contrato foi renegociado. A venda de antes continua com a taxa do dia dela.
    patch = await client.patch(
        f"/taxas-cartao/{taxa['id']}", headers=auth_admin, json={"percentual": "1.00"}
    )
    assert patch.status_code == 200
    relida = (await client.get(f"/vendas/{venda.json()['id']}", headers=auth_admin)).json()
    assert relida["pagamentos"][0]["taxa_percentual"] == "4.99"
    resumo = (
        await client.get(
            "/relatorios/resumo", headers=auth_admin, params={"inicio": _hoje(), "fim": _hoje()}
        )
    ).json()
    assert resumo["taxas_cartao"] == "4.99"

    # Apagar a linha da tabela também não mexe no passado.
    assert (
        await client.delete(f"/taxas-cartao/{taxa['id']}", headers=auth_admin)
    ).status_code == 204
    relida = (await client.get(f"/vendas/{venda.json()['id']}", headers=auth_admin)).json()
    assert relida["pagamentos"][0]["taxa"] == "4.99"


async def test_vendedora_ve_parcelas_mas_nao_a_taxa(client, auth_admin, auth_vendedor):
    variante = await _peca(client, auth_admin)
    await _taxa(client, auth_admin, forma="CREDITO", parcelas_ate=12, percentual="3.50",
                prazo_dias=30)
    venda = await _vender(
        client, auth_vendedor, variante,
        [{"forma": "CREDITO", "valor": "100.00", "parcelas": 2}],
    )
    assert venda.status_code == 201, venda.text
    corpo = venda.json()
    assert corpo["pagamentos"][0]["parcelas"] == 2
    assert "taxa" not in corpo["pagamentos"][0]
    assert "taxa_percentual" not in corpo["pagamentos"][0]
    assert "taxas_cartao" not in corpo


@pytest.mark.parametrize(
    "pagamento",
    [
        {"forma": "DEBITO", "valor": "100.00", "parcelas": 2},
        {"forma": "PIX", "valor": "100.00", "parcelas": 3},
        {"forma": "CREDITO", "valor": "100.00", "parcelas": 13},
        {"forma": "CREDITO", "valor": "100.00", "parcelas": 0},
        {"forma": "DINHEIRO", "valor": "100.00", "bandeira": "Visa"},
    ],
)
async def test_so_o_credito_parcela_e_bandeira_e_so_do_cartao(client, auth_admin, pagamento):
    variante = await _peca(client, auth_admin)
    resp = await _vender(client, auth_admin, variante, [pagamento])
    assert resp.status_code == 422
    # E nada saiu do estoque: a venda inteira foi recusada.
    saldos = (await client.get("/estoque/saldos", headers=auth_admin)).json()["items"]
    assert saldos[0]["saldo"] == 20


async def test_sem_taxa_cadastrada_a_venda_passa_com_zero(client, auth_admin):
    """A taxa é gestão, nunca trava de balcão: sem tabela, vale o que valia antes."""
    variante = await _peca(client, auth_admin)
    venda = await _vender(
        client, auth_admin, variante, [{"forma": "CREDITO", "valor": "100.00", "parcelas": 4}]
    )
    assert venda.status_code == 201, venda.text
    assert venda.json()["pagamentos"][0]["taxa_percentual"] == "0.00"
    assert venda.json()["taxas_cartao"] == "0.00"


async def test_reenvio_com_outras_parcelas_e_outra_cobranca(client, auth_admin):
    """'Crédito 1x' reenviado como '3x' não pode devolver a venda antiga como sucesso."""
    variante = await _peca(client, auth_admin)
    chave = str(uuid.uuid4())
    primeira = await _vender(
        client, auth_admin, variante, [{"forma": "CREDITO", "valor": "100.00"}], chave=chave
    )
    assert primeira.status_code == 201

    igual = await _vender(
        client, auth_admin, variante, [{"forma": "CREDITO", "valor": "100.00"}], chave=chave
    )
    assert igual.status_code == 200
    assert igual.json()["id"] == primeira.json()["id"]

    outra = await _vender(
        client, auth_admin, variante,
        [{"forma": "CREDITO", "valor": "100.00", "parcelas": 3}], chave=chave,
    )
    assert outra.status_code == 409
    assert outra.json()["code"] == "DUPLICADO"
    # Outra bandeira também é outro cartão: confere com outro extrato da credenciadora.
    outro_cartao = await _vender(
        client, auth_admin, variante,
        [{"forma": "CREDITO", "valor": "100.00", "bandeira": "Elo"}], chave=chave,
    )
    assert outro_cartao.status_code == 409
    assert outro_cartao.json()["code"] == "DUPLICADO"
    # Uma venda só, uma baixa só.
    saldos = (await client.get("/estoque/saldos", headers=auth_admin)).json()["items"]
    assert saldos[0]["saldo"] == 19


# ------------------------------------------------------------------ o resultado


async def test_resultado_desconta_a_taxa_e_a_devolucao_devolve_a_taxa(client, auth_admin):
    """Vendeu R$ 200 no crédito a 5%: R$ 10 de taxa. Voltou metade: a taxa vira R$ 5."""
    variante = await _peca(client, auth_admin)
    await _taxa(client, auth_admin, forma="CREDITO", parcelas_ate=12, percentual="5.00",
                prazo_dias=30)
    await _taxa(client, auth_admin, forma="DEBITO", percentual="2.00", prazo_dias=1)
    venda = await _vender(
        client, auth_admin, variante,
        [{"forma": "CREDITO", "valor": "200.00", "parcelas": 2}], quantidade=2,
    )
    assert venda.status_code == 201
    # PIX e dinheiro não pagam taxa.
    pix = await _vender(client, auth_admin, variante, [{"forma": "PIX", "valor": "100.00"}])
    assert pix.status_code == 201
    debito = await _vender(client, auth_admin, variante, [{"forma": "DEBITO", "valor": "100.00"}])
    assert debito.status_code == 201

    periodo = {"inicio": _hoje(), "fim": _hoje()}
    resumo = (await client.get("/relatorios/resumo", headers=auth_admin, params=periodo)).json()
    assert resumo["taxas_cartao"] == "12.00"  # 10,00 do crédito + 2,00 do débito
    assert Decimal(resumo["resultado"]) == (
        Decimal(resumo["lucro_bruto"]) - Decimal(resumo["despesas"]) - Decimal("12.00")
    )

    item = venda.json()["itens"][0]["id"]
    devolucao = await client.post(
        f"/vendas/{venda.json()['id']}/devolucoes",
        headers=auth_admin,
        json={"itens": [{"item_id": item, "quantidade": 1}], "client_uuid": str(uuid.uuid4())},
    )
    assert devolucao.status_code == 201, devolucao.text
    assert devolucao.json()["pagamentos"] == [
        {"forma": "CREDITO", "valor": "100.00", "codigo_vale": None}
    ]

    resumo = (await client.get("/relatorios/resumo", headers=auth_admin, params=periodo)).json()
    assert resumo["taxas_cartao"] == "7.00"  # 5,00 do crédito que ficou + 2,00 do débito
    assert Decimal(resumo["resultado"]) == (
        Decimal(resumo["lucro_bruto"]) - Decimal(resumo["despesas"]) - Decimal("7.00")
    )


async def test_venda_cancelada_nao_paga_taxa(client, auth_admin):
    variante = await _peca(client, auth_admin)
    await _taxa(client, auth_admin, forma="DEBITO", percentual="2.00", prazo_dias=1)
    venda = await _vender(client, auth_admin, variante, [{"forma": "DEBITO", "valor": "100.00"}])
    cancelar = await client.post(
        f"/vendas/{venda.json()['id']}/cancelamento",
        headers=auth_admin,
        json={"motivo": "Cliente desistiu"},
    )
    assert cancelar.status_code == 200, cancelar.text
    periodo = {"inicio": _hoje(), "fim": _hoje()}
    resumo = (await client.get("/relatorios/resumo", headers=auth_admin, params=periodo)).json()
    assert resumo["taxas_cartao"] == "0.00"
    agenda = (
        await client.get(
            "/relatorios/recebiveis",
            headers=auth_admin,
            params={"inicio": _hoje(), "fim": (hoje_na_loja() + timedelta(days=5)).isoformat()},
        )
    ).json()
    assert agenda["total"] == 0


async def _devolver(client, auth, venda, quantidade: int = 1) -> None:
    resp = await client.post(
        f"/vendas/{venda.json()['id']}/devolucoes",
        headers=auth,
        json={
            "itens": [{"item_id": venda.json()["itens"][0]["id"], "quantidade": quantidade}],
            "client_uuid": str(uuid.uuid4()),
        },
    )
    assert resp.status_code == 201, resp.text


async def _taxa_liquida_na_agenda(client, auth) -> Decimal:
    """Σ da taxa na agenda, da devolução (hoje) até a parcela (D+30)."""
    hoje = hoje_na_loja()
    agenda = await client.get(
        "/relatorios/recebiveis",
        headers=auth,
        params={"inicio": hoje.isoformat(), "fim": (hoje + timedelta(days=30)).isoformat()},
    )
    return sum((Decimal(i["taxa"]) for i in agenda.json()["items"]), Decimal("0.00"))


async def test_devolucoes_parciais_nao_devolvem_mais_taxa_do_que_a_venda_pagou(
    client, auth_admin
):
    """R$ 10,00 no crédito a 2,5% pagam R$ 0,25. Arredondando cada devolução sozinha, duas
    de R$ 5,00 devolviam 0,13 + 0,13 = 0,26: a maquininha "pagava" 1 centavo à loja e o
    Resultado subia. Acumulada, a 2ª devolve só o que falta da taxa paga."""
    variante = await _peca(client, auth_admin, preco="5.00")
    await _taxa(client, auth_admin, forma="CREDITO", parcelas_ate=12, percentual="2.50",
                prazo_dias=30)
    venda = await _vender(
        client, auth_admin, variante, [{"forma": "CREDITO", "valor": "10.00"}], quantidade=2
    )
    assert venda.status_code == 201, venda.text
    periodo = {"inicio": _hoje(), "fim": _hoje()}

    async def taxas_do_dia() -> str:
        resumo = await client.get("/relatorios/resumo", headers=auth_admin, params=periodo)
        return resumo.json()["taxas_cartao"]

    assert await taxas_do_dia() == "0.25"
    depois = []
    for _ in range(2):
        await _devolver(client, auth_admin, venda)
        depois.append(await taxas_do_dia())
    assert depois == ["0.12", "0.00"]  # 0,13 na 1ª; 0,12 na 2ª — nunca negativo
    # A agenda fecha com o resumo: os estornos debitam o mesmo que a parcela pagou.
    assert await _taxa_liquida_na_agenda(client, auth_admin) == Decimal("0.00")


async def test_dois_cartoes_devolvidos_devolvem_a_taxa_que_pagaram(client, auth_admin):
    """Dois cartões de R$ 5,00 a 2,08%: cada um paga round(0,104) = 0,10, e a venda paga
    0,20. Pela taxa média sobre o total, a devolução de tudo devolvia round(0,208) = 0,21.
    A taxa devolvida sai da taxa que a forma PAGOU, então tudo de volta é zero, cravado."""
    variante = await _peca(client, auth_admin, preco="5.00")
    await _taxa(client, auth_admin, forma="CREDITO", parcelas_ate=12, percentual="2.08",
                prazo_dias=30)
    venda = await _vender(
        client, auth_admin, variante,
        [{"forma": "CREDITO", "valor": "5.00"}, {"forma": "CREDITO", "valor": "5.00"}],
        quantidade=2,
    )
    assert venda.status_code == 201, venda.text
    await _devolver(client, auth_admin, venda, quantidade=2)
    periodo = {"inicio": _hoje(), "fim": _hoje()}
    resumo = (await client.get("/relatorios/resumo", headers=auth_admin, params=periodo)).json()
    assert resumo["taxas_cartao"] == "0.00"
    assert await _taxa_liquida_na_agenda(client, auth_admin) == Decimal("0.00")


# ------------------------------------------------------------------ a agenda


async def test_agenda_de_recebiveis_parcela_e_poe_o_centavo_na_primeira(client, auth_admin):
    variante = await _peca(client, auth_admin)
    await _taxa(client, auth_admin, forma="CREDITO", parcelas_ate=12, percentual="4.99",
                prazo_dias=30)
    await _taxa(client, auth_admin, forma="DEBITO", percentual="2.00", prazo_dias=1)
    venda = await _vender(
        client, auth_admin, variante, [{"forma": "CREDITO", "valor": "100.00", "parcelas": 3}]
    )
    assert venda.status_code == 201
    debito = await _vender(client, auth_admin, variante, [{"forma": "DEBITO", "valor": "100.00"}])
    assert debito.status_code == 201
    await _vender(client, auth_admin, variante, [{"forma": "PIX", "valor": "100.00"}])

    hoje = hoje_na_loja()
    params = {"inicio": hoje.isoformat(), "fim": (hoje + timedelta(days=120)).isoformat()}
    agenda = (await client.get("/relatorios/recebiveis", headers=auth_admin, params=params)).json()
    assert agenda["total"] == 4  # D+1 do débito e as três parcelas do crédito; PIX não entra
    por_dia = {i["data"]: i for i in agenda["items"]}

    def dia(d: int) -> str:
        return (hoje + timedelta(days=d)).isoformat()

    def linha(d: int, bruto: str, taxa: str, liquido: str) -> dict:
        return {"data": dia(d), "bruto": bruto, "taxa": taxa, "liquido": liquido}

    assert por_dia[dia(1)] == linha(1, "100.00", "2.00", "98.00")
    # 100,00 / 3 = 33,33 + 33,33 + 33,34; taxa 4,99 = 1,66 + 1,66 + 1,67. A sobra é da 1ª.
    assert por_dia[dia(30)] == linha(30, "33.34", "1.67", "31.67")
    assert por_dia[dia(60)] == linha(60, "33.33", "1.66", "31.67")
    assert por_dia[dia(90)] == linha(90, "33.33", "1.66", "31.67")
    # A soma das parcelas é exatamente o pagamento e a taxa do resumo — nem um centavo a mais.
    assert sum(Decimal(i["bruto"]) for i in agenda["items"]) == Decimal("200.00")
    assert sum(Decimal(i["taxa"]) for i in agenda["items"]) == Decimal("6.99")

    # Paginada por data: a 2ª página de 2 traz as duas últimas datas.
    pagina = (
        await client.get(
            "/relatorios/recebiveis", headers=auth_admin, params={**params, "size": 2, "page": 2}
        )
    ).json()
    assert [i["data"] for i in pagina["items"]] == [dia(60), dia(90)]
    assert pagina["total"] == 4

    # O período é o da DATA PREVISTA: só dezembro do crédito pega só aquela parcela.
    so_a_terceira = (
        await client.get(
            "/relatorios/recebiveis",
            headers=auth_admin,
            params={"inicio": dia(61), "fim": dia(120)},
        )
    ).json()
    assert [i["data"] for i in so_a_terceira["items"]] == [dia(90)]


async def test_estorno_no_cartao_sai_da_agenda_no_dia_da_devolucao(client, auth_admin):
    variante = await _peca(client, auth_admin)
    await _taxa(client, auth_admin, forma="DEBITO", percentual="2.00", prazo_dias=1)
    venda = await _vender(client, auth_admin, variante, [{"forma": "DEBITO", "valor": "100.00"}])
    item = venda.json()["itens"][0]["id"]
    devolucao = await client.post(
        f"/vendas/{venda.json()['id']}/devolucoes",
        headers=auth_admin,
        json={"itens": [{"item_id": item, "quantidade": 1}], "client_uuid": str(uuid.uuid4())},
    )
    assert devolucao.status_code == 201, devolucao.text

    hoje = hoje_na_loja()
    agenda = (
        await client.get(
            "/relatorios/recebiveis",
            headers=auth_admin,
            params={"inicio": hoje.isoformat(), "fim": (hoje + timedelta(days=5)).isoformat()},
        )
    ).json()
    por_dia = {i["data"]: i for i in agenda["items"]}
    assert por_dia[hoje.isoformat()]["bruto"] == "-100.00"
    assert por_dia[hoje.isoformat()]["taxa"] == "-2.00"
    assert por_dia[(hoje + timedelta(days=1)).isoformat()]["liquido"] == "98.00"
    assert sum(Decimal(i["liquido"]) for i in agenda["items"]) == Decimal("0.00")


async def test_agenda_e_so_de_quem_ve_dinheiro(
    client, auth_supervisora, auth_vendedor, auth_gerente
):
    params = {"inicio": _hoje(), "fim": _hoje()}
    for auth in (auth_supervisora, auth_vendedor):
        assert (
            await client.get("/relatorios/recebiveis", headers=auth, params=params)
        ).status_code == 403
    assert (
        await client.get("/relatorios/recebiveis", headers=auth_gerente, params=params)
    ).status_code == 200
