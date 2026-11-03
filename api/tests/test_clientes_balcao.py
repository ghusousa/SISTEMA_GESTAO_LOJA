"""Cliente em qualquer venda (ADR-36).

O balcão busca e cadastra cliente (`ATENDER_CLIENTE`) sem enxergar saldo, limite ou a
observação do crediário; o fiado continua sendo de quem cuida do crediário. O que não
pode quebrar: o schema do balcão nunca carrega dinheiro, o cadastro repetido pela rede não
duplica a cliente, a chave reaproveitada não devolve a cliente errada, e excluir leva
junto o aniversário e as preferências (LGPD).
"""

import uuid
from datetime import date, timedelta
from decimal import Decimal

import pytest
from conftest import criar_produto
from httpx import AsyncClient

from app.core.datas import hoje_na_loja

PROIBIDOS_NO_BALCAO = {"deve", "limite", "acima_do_limite", "observacao", "documento"}


async def _peca(client: AsyncClient, auth: dict[str, str]) -> int:
    cat = await client.post("/categorias", headers=auth, json={"nome": "Blusas"})
    produto = await criar_produto(
        client,
        auth,
        {
            "categoria_id": cat.json()["id"],
            "nome": "Blusa de Linho",
            "variantes": [
                {
                    "tamanho": "M",
                    "cor": "Cru",
                    "preco_custo": "30.00",
                    "preco_venda": "80.00",
                    "estoque_inicial": 10,
                }
            ],
        },
    )
    return produto["variantes"][0]["id"]


async def _cadastrar(client, auth, **dados):
    corpo = {"client_uuid": str(uuid.uuid4()), **dados}
    return await client.post("/clientes/balcao", headers=auth, json=corpo)


# ------------------------------------------------------------------ a porta do balcão


async def test_vendedora_busca_e_cadastra_sem_ver_dinheiro(
    client, auth_admin, auth_vendedor
):
    # Uma cliente do crediário, devendo, com limite e observação de cobrança.
    crediario = await client.post(
        "/clientes",
        headers=auth_admin,
        json={
            "nome": "Joana Prado",
            "telefone": "11988887777",
            "documento": "12345678909",
            "limite": "300.00",
            "observacao": "Paga todo dia 10",
            "preferencias": "Veste G",
        },
    )
    assert crediario.status_code == 201

    nova = await _cadastrar(
        client, auth_vendedor, nome="  Marina Souza ", telefone="(11) 97777-6666",
        nascimento="1990-03-14", preferencias="Veste M, gosta de linho",
    )
    assert nova.status_code == 201, nova.text
    assert nova.json()["nome"] == "Marina Souza"
    assert nova.json()["telefone"] == "11977776666"
    assert not PROIBIDOS_NO_BALCAO & set(nova.json())

    achadas = await client.get("/clientes/balcao", headers=auth_vendedor, params={"q": "joana"})
    assert achadas.status_code == 200
    assert achadas.json()["total"] == 1
    joana = achadas.json()["items"][0]
    assert joana["preferencias"] == "Veste G"
    assert not PROIBIDOS_NO_BALCAO & set(joana)

    # Pelo CPF também acha — sem devolvê-lo.
    por_cpf = await client.get(
        "/clientes/balcao", headers=auth_vendedor, params={"q": "123.456.789-09"}
    )
    assert [c["nome"] for c in por_cpf.json()["items"]] == ["Joana Prado"]

    # O crediário continua fechado para ela: lista, ficha, extrato e cadastro com limite.
    assert (await client.get("/clientes", headers=auth_vendedor)).status_code == 403
    cid = crediario.json()["id"]
    assert (await client.get(f"/clientes/{cid}", headers=auth_vendedor)).status_code == 403
    assert (
        await client.get(f"/clientes/{cid}/extrato", headers=auth_vendedor)
    ).status_code == 403
    assert (
        await client.post(
            "/clientes", headers=auth_vendedor, json={"nome": "Outra", "limite": "999"}
        )
    ).status_code == 403


async def test_balcao_so_acha_pelo_documento_inteiro(client, auth_admin, auth_gerente,
                                                     auth_vendedor):
    """O balcão não devolve o CPF, e por trecho "a Maria aparece?" era um oráculo: um
    dígito por vez, a vendedora remontava o documento que a resposta esconde (ADR-36)."""
    cpf = "52998224725"
    r = await client.post(
        "/clientes", headers=auth_admin, json={"nome": "Maria Sigilo", "documento": cpf}
    )
    assert r.status_code == 201, r.text
    alvo = r.json()["id"]

    async def achou(porta: str, auth: dict[str, str], q: str) -> bool:
        resp = await client.get(porta, headers=auth, params={"q": q})
        assert resp.status_code == 200, resp.text
        return any(c["id"] == alvo for c in resp.json()["items"])

    for trecho in (cpf[:1], cpf[:3], cpf[4:9], cpf[:10], cpf[1:]):
        assert not await achou("/clientes/balcao", auth_vendedor, trecho), trecho
    assert await achou("/clientes/balcao", auth_vendedor, cpf)
    assert await achou("/clientes/balcao", auth_vendedor, "529.982.247-25")
    # O crediário já vê o documento: lá o trecho continua achando.
    assert await achou("/clientes", auth_gerente, cpf[4:9])


async def test_balcao_acha_documento_inteiro_que_nao_e_cpf(client, auth_admin, auth_vendedor):
    """O cadastro aceita qualquer documento (RG, CPF sem o zero da frente): só dígitos, até
    20. Casar só com 11 ou 14 dígitos deixava o RG inteiro sem achar ninguém no balcão — a
    igualdade já fecha o oráculo, o tamanho não protegia nada (ADR-36)."""
    ids = {}
    for nome, documento in (("Rita Geral", "12.345.678-9"), ("Rosa Zero", "1234567890")):
        r = await client.post(
            "/clientes", headers=auth_admin, json={"nome": nome, "documento": documento}
        )
        assert r.status_code == 201, r.text
        ids[nome] = r.json()["id"]

    async def achou(q: str, alvo: int) -> bool:
        resp = await client.get("/clientes/balcao", headers=auth_vendedor, params={"q": q})
        assert resp.status_code == 200, resp.text
        return any(c["id"] == alvo for c in resp.json()["items"])

    rg = ids["Rita Geral"]
    assert await achou("123456789", rg)
    assert await achou("12.345.678-9", rg)
    assert await achou("1234567890", ids["Rosa Zero"])
    # Trecho continua sem achar, de qualquer tamanho.
    for trecho in ("12345678", "2345678", "23456789"):
        assert not await achou(trecho, rg), trecho


async def test_todo_papel_atende_cliente(
    client, auth_admin, auth_gerente, auth_supervisora, auth_vendedor
):
    for auth in (auth_admin, auth_gerente, auth_supervisora, auth_vendedor):
        assert (await client.get("/clientes/balcao", headers=auth)).status_code == 200
        assert (await client.get("/clientes/aniversariantes", headers=auth)).status_code == 200


async def test_sem_login_nao_ha_balcao(client):
    assert (await client.get("/clientes/balcao")).status_code == 401
    assert (await _cadastrar(client, {}, nome="Ninguém")).status_code == 401


async def test_cadastro_reenviado_nao_duplica_a_cliente(client, auth_vendedor, auth_admin):
    chave = str(uuid.uuid4())
    corpo = {"client_uuid": chave, "nome": "Lívia Reis"}
    primeira = await client.post("/clientes/balcao", headers=auth_vendedor, json=corpo)
    assert primeira.status_code == 201
    de_novo = await client.post("/clientes/balcao", headers=auth_vendedor, json=corpo)
    assert de_novo.status_code == 200
    assert de_novo.json()["id"] == primeira.json()["id"]

    # A MESMA chave com OUTRA cliente é 409 — nunca a Lívia como sucesso para a Maria.
    outra = await client.post(
        "/clientes/balcao", headers=auth_vendedor, json={"client_uuid": chave, "nome": "Maria"}
    )
    assert outra.status_code == 409
    assert outra.json()["code"] == "DUPLICADO"

    todas = (await client.get("/clientes/balcao", headers=auth_admin)).json()
    assert todas["total"] == 1


async def test_telefone_repetido_e_recusado_no_balcao(client, auth_vendedor):
    primeira = await _cadastrar(client, auth_vendedor, nome="Ana", telefone="11911112222")
    assert primeira.status_code == 201
    repetido = await _cadastrar(client, auth_vendedor, nome="Ana B.", telefone="(11) 91111-2222")
    assert repetido.status_code == 422
    assert repetido.json()["code"] == "VALIDACAO"


@pytest.mark.parametrize(
    "nascimento", [(date.today() + timedelta(days=40)).isoformat(), "1850-01-01"]
)
async def test_nascimento_impossivel_e_recusado(client, auth_vendedor, nascimento):
    resp = await _cadastrar(client, auth_vendedor, nome="Ana", nascimento=nascimento)
    assert resp.status_code == 422


async def test_balcao_nao_grava_campo_do_crediario(client, auth_vendedor, auth_gerente):
    """Limite e observação mandados pelo balcão não chegam ao banco: o schema nem os conhece."""
    resp = await _cadastrar(
        client, auth_vendedor, nome="Ana", limite="500.00", observacao="Pode fiado à vontade"
    )
    assert resp.status_code == 201
    assert "limite" not in resp.json()
    ficha = (await client.get(f"/clientes/{resp.json()['id']}", headers=auth_gerente)).json()
    assert ficha["limite"] is None
    assert ficha["observacao"] is None


# ------------------------------------------------------------------ a venda com nome


async def test_vendedora_poe_cliente_em_venda_no_pix_mas_nao_vende_fiado(
    client, auth_admin, auth_vendedor, auth_gerente
):
    variante = await _peca(client, auth_admin)
    cliente = (await _cadastrar(client, auth_vendedor, nome="Bruna Lima")).json()

    venda = await client.post(
        "/vendas",
        headers=auth_vendedor,
        json={
            "client_uuid": str(uuid.uuid4()),
            "cliente_id": cliente["id"],
            "itens": [{"variante_id": variante, "quantidade": 1}],
            "pagamentos": [{"forma": "PIX", "valor": "80.00"}],
        },
    )
    assert venda.status_code == 201, venda.text
    assert venda.json()["cliente"] == "Bruna Lima"
    assert venda.json()["cliente_id"] == cliente["id"]

    fiado = await client.post(
        "/vendas",
        headers=auth_vendedor,
        json={
            "client_uuid": str(uuid.uuid4()),
            "cliente_id": cliente["id"],
            "itens": [{"variante_id": variante, "quantidade": 1}],
            "pagamentos": [{"forma": "FIADO", "valor": "80.00"}],
        },
    )
    assert fiado.status_code == 403

    # Venda com nome não é dívida: a cliente segue em dia no crediário.
    ficha = (await client.get(f"/clientes/{cliente['id']}", headers=auth_gerente)).json()
    assert Decimal(ficha["deve"]) == 0


async def test_historico_de_compras_da_cliente(client, auth_admin, auth_vendedor, auth_gerente):
    """A ficha lista as compras dela por `GET /vendas?cliente_id=`, com o escopo de sempre."""
    variante = await _peca(client, auth_admin)
    cliente = (await _cadastrar(client, auth_vendedor, nome="Carla Dias")).json()
    outra = (await _cadastrar(client, auth_vendedor, nome="Outra Pessoa")).json()

    async def vender(auth, cliente_id):
        resp = await client.post(
            "/vendas",
            headers=auth,
            json={
                "client_uuid": str(uuid.uuid4()),
                "cliente_id": cliente_id,
                "itens": [{"variante_id": variante, "quantidade": 1}],
                "pagamentos": [{"forma": "DINHEIRO", "valor": "80.00"}],
            },
        )
        assert resp.status_code == 201, resp.text
        return resp.json()["id"]

    da_vendedora = await vender(auth_vendedor, cliente["id"])
    do_gerente = await vender(auth_gerente, cliente["id"])
    await vender(auth_gerente, outra["id"])
    await vender(auth_gerente, None)

    todas = await client.get("/vendas", headers=auth_gerente, params={"cliente_id": cliente["id"]})
    assert todas.status_code == 200
    assert {v["id"] for v in todas.json()["items"]} == {da_vendedora, do_gerente}
    assert todas.json()["total"] == 2

    # A vendedora, como em toda lista de vendas, só vê as que ela mesma fez.
    dela = await client.get("/vendas", headers=auth_vendedor, params={"cliente_id": cliente["id"]})
    assert [v["id"] for v in dela.json()["items"]] == [da_vendedora]


async def test_cliente_excluida_nao_entra_em_venda(client, auth_admin, auth_vendedor):
    variante = await _peca(client, auth_admin)
    cliente = (await _cadastrar(client, auth_vendedor, nome="Some Daqui")).json()
    excluida = await client.delete(f"/clientes/{cliente['id']}", headers=auth_admin)
    assert excluida.status_code == 204
    venda = await client.post(
        "/vendas",
        headers=auth_vendedor,
        json={
            "client_uuid": str(uuid.uuid4()),
            "cliente_id": cliente["id"],
            "itens": [{"variante_id": variante, "quantidade": 1}],
            "pagamentos": [{"forma": "PIX", "valor": "80.00"}],
        },
    )
    assert venda.status_code == 404
    # E não sai da busca do balcão.
    busca = await client.get("/clientes/balcao", headers=auth_vendedor, params={"q": "some"})
    assert busca.json()["total"] == 0


# ------------------------------------------------------------------ aniversário e LGPD


async def test_aniversariantes_do_mes_na_ordem_do_calendario(client, auth_admin, auth_vendedor):
    await _cadastrar(client, auth_vendedor, nome="Zélia", nascimento="1980-07-25")
    await _cadastrar(client, auth_vendedor, nome="Alice", nascimento="1995-07-03")
    await _cadastrar(client, auth_vendedor, nome="Beatriz", nascimento="2001-07-03")
    await _cadastrar(client, auth_vendedor, nome="Agosto", nascimento="1990-08-01")
    await _cadastrar(client, auth_vendedor, nome="Sem Data")
    removida = (
        await _cadastrar(client, auth_vendedor, nome="Removida", nascimento="1970-07-01")
    ).json()
    await client.delete(f"/clientes/{removida['id']}", headers=auth_admin)

    julho = await client.get("/clientes/aniversariantes", headers=auth_vendedor, params={"mes": 7})
    assert julho.status_code == 200
    assert [c["nome"] for c in julho.json()["items"]] == ["Alice", "Beatriz", "Zélia"]
    assert julho.json()["total"] == 3
    assert not PROIBIDOS_NO_BALCAO & set(julho.json()["items"][0])

    pagina2 = await client.get(
        "/clientes/aniversariantes", headers=auth_vendedor, params={"mes": 7, "size": 2, "page": 2}
    )
    assert [c["nome"] for c in pagina2.json()["items"]] == ["Zélia"]

    assert (
        await client.get("/clientes/aniversariantes", headers=auth_vendedor, params={"mes": 13})
    ).status_code == 422


async def test_aniversariantes_sem_mes_e_o_mes_da_loja(client, auth_vendedor):
    hoje = hoje_na_loja()
    nascimento = date(1990, hoje.month, min(hoje.day, 28)).isoformat()
    await _cadastrar(client, auth_vendedor, nome="Faz Hoje", nascimento=nascimento)
    resp = await client.get("/clientes/aniversariantes", headers=auth_vendedor)
    assert [c["nome"] for c in resp.json()["items"]] == ["Faz Hoje"]


async def test_ficha_do_crediario_le_e_muda_nascimento_e_preferencias(client, auth_gerente):
    criada = await client.post(
        "/clientes",
        headers=auth_gerente,
        json={"nome": "Paula", "nascimento": "1988-11-30", "preferencias": "Tamanho 40"},
    )
    assert criada.status_code == 201
    assert criada.json()["nascimento"] == "1988-11-30"
    cid = criada.json()["id"]
    mudou = await client.patch(
        f"/clientes/{cid}", headers=auth_gerente, json={"preferencias": "Tamanho 42, sem amarelo"}
    )
    assert mudou.status_code == 200
    assert mudou.json()["preferencias"] == "Tamanho 42, sem amarelo"
    assert mudou.json()["nascimento"] == "1988-11-30"


async def test_excluir_apaga_aniversario_e_preferencias(client, auth_admin, auth_vendedor, session):
    from app.modules.clientes.models import Customer

    cliente = (
        await _cadastrar(
            client, auth_vendedor, nome="Rita", telefone="11955554444",
            nascimento="1975-05-05", preferencias="Veste P",
        )
    ).json()
    excluida = await client.delete(f"/clientes/{cliente['id']}", headers=auth_admin)
    assert excluida.status_code == 204
    linha = await session.get(Customer, cliente["id"])
    await session.refresh(linha)
    assert linha.nascimento is None
    assert linha.preferencias is None
    assert linha.phone is None
    assert linha.name == f"Cliente removido #{cliente['id']}"
