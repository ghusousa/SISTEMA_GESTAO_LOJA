import asyncio
import uuid

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import text

from app.core.config import settings
from app.core.db import SessionLocal
from app.core.pagination import Paginacao
from app.main import app
from app.modules.clientes.service import ClienteService
from app.modules.vendas.repository import VendaRepository

from conftest import criar_produto
from planos import capturar_sql, planos


@pytest.fixture
async def loja(client: AsyncClient, auth_admin: dict[str, str]) -> dict:
    """Camiseta P (10 peças, custo 20, venda 49,90) e Calça M (1 peça, custo 60, venda 149,90)."""
    cat_camisa = (
        await client.post("/categorias", headers=auth_admin, json={"nome": "Camisetas"})
    ).json()["id"]
    cat_calca = (
        await client.post("/categorias", headers=auth_admin, json={"nome": "Calças"})
    ).json()["id"]

    camiseta = await criar_produto(client, auth_admin, {
                "categoria_id": cat_camisa,
                "nome": "Camiseta Lisa",
                "variantes": [
                    {
                        "tamanho": "P",
                        "cor": "Branca",
                        "codigo_barras": "7891111111117",
                        "preco_custo": "20.00",
                        "preco_venda": "49.90",
                        "estoque_inicial": 10,
                    }
                ],
            })
    calca = await criar_produto(client, auth_admin, {
                "categoria_id": cat_calca,
                "nome": "Calça Jeans",
                "variantes": [
                    {
                        "tamanho": "M",
                        "cor": "Azul",
                        "codigo_barras": "7892222222224",
                        "preco_custo": "60.00",
                        "preco_venda": "149.90",
                        "estoque_inicial": 1,
                    }
                ],
            })
    return {
        "camiseta": camiseta["variantes"][0]["id"],
        "calca": calca["variantes"][0]["id"],
    }


async def _saldo(client: AsyncClient, headers: dict, variante_id: int) -> int:
    saldos = (await client.get("/estoque/saldos", headers=headers)).json()
    return next(s["saldo"] for s in saldos["items"] if s["variante_id"] == variante_id)


# ------------------------------------------------------------------ venda feliz
async def test_venda_baixa_estoque_e_registra_movimentacao(
    client: AsyncClient, auth_vendedor: dict[str, str], loja: dict
) -> None:
    resp = await client.post(
        "/vendas",
        headers=auth_vendedor,
        json={
            "client_uuid": str(uuid.uuid4()),
            "itens": [{"variante_id": loja["camiseta"], "quantidade": 2}],
            "pagamentos": [{"forma": "PIX", "valor": "99.80"}],
        },
    )
    assert resp.status_code == 201, resp.text
    venda = resp.json()
    assert venda["subtotal"] == "99.80"
    assert venda["total"] == "99.80"
    assert venda["quantidade_pecas"] == 2
    assert venda["status"] == "CONCLUIDA"

    assert await _saldo(client, auth_vendedor, loja["camiseta"]) == 8

    movs = (
        await client.get(
            "/estoque/movimentacoes", headers=auth_vendedor, params={"tipo": "VENDA"}
        )
    ).json()
    assert movs["total"] == 1
    assert movs["items"][0]["quantidade"] == -2
    assert movs["items"][0]["venda_id"] == venda["id"]


async def test_venda_com_desconto_e_pagamento_misto(
    client: AsyncClient, auth_vendedor: dict[str, str], loja: dict
) -> None:
    resp = await client.post(
        "/vendas",
        headers=auth_vendedor,
        json={
            "client_uuid": str(uuid.uuid4()),
            "desconto": "9.80",
            "itens": [
                {"variante_id": loja["camiseta"], "quantidade": 1},
                {"variante_id": loja["calca"], "quantidade": 1},
            ],
            "pagamentos": [
                {"forma": "DINHEIRO", "valor": "100.00"},
                {"forma": "PIX", "valor": "90.00"},
            ],
        },
    )
    assert resp.status_code == 201, resp.text
    venda = resp.json()
    assert venda["subtotal"] == "199.80"
    assert venda["desconto"] == "9.80"
    assert venda["total"] == "190.00"
    assert len(venda["pagamentos"]) == 2


async def test_preco_e_custo_ficam_congelados_na_venda(
    client: AsyncClient, auth_admin: dict[str, str], loja: dict
) -> None:
    """Reajustar o preço amanhã não pode reescrever o lucro de hoje."""
    venda_id = (
        await client.post(
            "/vendas",
            headers=auth_admin,
            json={
                "client_uuid": str(uuid.uuid4()),
                "itens": [{"variante_id": loja["camiseta"], "quantidade": 1}],
                "pagamentos": [{"forma": "DEBITO", "valor": "49.90"}],
            },
        )
    ).json()["id"]

    await client.patch(
        f"/variantes/{loja['camiseta']}",
        headers=auth_admin,
        json={"preco_venda": "79.90", "preco_custo": "35.00"},
    )

    venda = (await client.get(f"/vendas/{venda_id}", headers=auth_admin)).json()
    assert venda["itens"][0]["preco_unitario"] == "49.90"
    assert venda["itens"][0]["custo_unitario"] == "20.00"
    assert venda["lucro_bruto"] == "29.90"


# ------------------------------------------------------------------ validações
async def test_pagamento_que_nao_fecha_o_total_e_recusado(
    client: AsyncClient, auth_vendedor: dict[str, str], loja: dict
) -> None:
    resp = await client.post(
        "/vendas",
        headers=auth_vendedor,
        json={
            "client_uuid": str(uuid.uuid4()),
            "itens": [{"variante_id": loja["camiseta"], "quantidade": 2}],
            "pagamentos": [{"forma": "PIX", "valor": "50.00"}],
        },
    )
    assert resp.status_code == 422
    corpo = resp.json()
    assert corpo["code"] == "PAGAMENTO_DIVERGENTE"
    # O app precisa do total correto para refazer a cobrança sem adivinhar.
    assert corpo["detail"]["total_da_venda"] == "99.80"


async def test_venda_sem_estoque_e_recusada_e_nao_deixa_rastro(
    client: AsyncClient, auth_vendedor: dict[str, str], loja: dict
) -> None:
    resp = await client.post(
        "/vendas",
        headers=auth_vendedor,
        json={
            "client_uuid": str(uuid.uuid4()),
            "itens": [{"variante_id": loja["calca"], "quantidade": 5}],
            "pagamentos": [{"forma": "PIX", "valor": "749.50"}],
        },
    )
    assert resp.status_code == 409
    assert resp.json()["code"] == "ESTOQUE_INSUFICIENTE"

    vendas = (await client.get("/vendas", headers=auth_vendedor)).json()
    assert vendas["total"] == 0
    assert await _saldo(client, auth_vendedor, loja["calca"]) == 1


async def test_venda_atomica_nao_baixa_nada_se_um_item_faltar(
    client: AsyncClient, auth_vendedor: dict[str, str], loja: dict
) -> None:
    """A camiseta tem saldo; a calça não tem o suficiente. Nada pode ser baixado."""
    resp = await client.post(
        "/vendas",
        headers=auth_vendedor,
        json={
            "client_uuid": str(uuid.uuid4()),
            "itens": [
                {"variante_id": loja["camiseta"], "quantidade": 1},
                {"variante_id": loja["calca"], "quantidade": 3},
            ],
            "pagamentos": [{"forma": "PIX", "valor": "499.60"}],
        },
    )
    assert resp.status_code == 409
    assert await _saldo(client, auth_vendedor, loja["camiseta"]) == 10
    assert await _saldo(client, auth_vendedor, loja["calca"]) == 1


async def test_desconto_maior_que_a_venda_e_recusado(
    client: AsyncClient, auth_vendedor: dict[str, str], loja: dict
) -> None:
    resp = await client.post(
        "/vendas",
        headers=auth_vendedor,
        json={
            "client_uuid": str(uuid.uuid4()),
            "desconto": "999.00",
            "itens": [{"variante_id": loja["camiseta"], "quantidade": 1}],
            "pagamentos": [{"forma": "PIX", "valor": "1.00"}],
        },
    )
    assert resp.status_code == 422
    assert resp.json()["code"] == "VALIDACAO"


async def test_venda_de_peca_inexistente_retorna_404(
    client: AsyncClient, auth_vendedor: dict[str, str]
) -> None:
    resp = await client.post(
        "/vendas",
        headers=auth_vendedor,
        json={
            "client_uuid": str(uuid.uuid4()),
            "itens": [{"variante_id": 4242, "quantidade": 1}],
            "pagamentos": [{"forma": "PIX", "valor": "10.00"}],
        },
    )
    assert resp.status_code == 404


# ------------------------------------------------------------------ idempotência
async def test_reenvio_da_mesma_venda_nao_duplica(
    client: AsyncClient, auth_vendedor: dict[str, str], loja: dict
) -> None:
    payload = {
        "client_uuid": str(uuid.uuid4()),
        "itens": [{"variante_id": loja["camiseta"], "quantidade": 2}],
        "pagamentos": [{"forma": "PIX", "valor": "99.80"}],
    }
    primeira = await client.post("/vendas", headers=auth_vendedor, json=payload)
    segunda = await client.post("/vendas", headers=auth_vendedor, json=payload)

    # ADR-2: o reenvio responde 200 com a venda que já existia — 201 é só de quem criou.
    assert (primeira.status_code, segunda.status_code) == (201, 200)
    assert primeira.json()["id"] == segunda.json()["id"]
    assert await _saldo(client, auth_vendedor, loja["camiseta"]) == 8
    assert (await client.get("/vendas", headers=auth_vendedor)).json()["total"] == 1


async def test_reenvio_que_perde_a_corrida_devolve_a_vencedora_sem_500(
    client: AsyncClient, auth_vendedor: dict[str, str], loja: dict, monkeypatch
) -> None:
    """Os dois POSTs da mesma venda passam juntos pela checagem do `client_uuid`.

    O perdedor só descobre no INSERT (IntegrityError), faz rollback e responde a vencedora.
    O rollback expira o `usuario` da sessão, e ler `usuario.role` depois dele em sessão
    async é MissingGreenlet: o ramo que existe para a corrida dava 500 justo nela. Aqui a
    corrida é forçada sem relógio: a primeira checagem "não vê" a venda que já existe.
    """
    from app.modules.vendas.repository import VendaRepository

    payload = {
        "client_uuid": str(uuid.uuid4()),
        "itens": [{"variante_id": loja["camiseta"], "quantidade": 1}],
        "pagamentos": [{"forma": "PIX", "valor": "49.90"}],
    }
    primeira = await client.post("/vendas", headers=auth_vendedor, json=payload)
    assert primeira.status_code == 201, primeira.text

    original = VendaRepository.por_client_uuid
    chamadas = 0

    async def cega_na_primeira(self, client_uuid):
        nonlocal chamadas
        chamadas += 1
        return None if chamadas == 1 else await original(self, client_uuid)

    monkeypatch.setattr(VendaRepository, "por_client_uuid", cega_na_primeira)
    perdedora = await client.post("/vendas", headers=auth_vendedor, json=payload)

    assert chamadas == 2, "a corrida tem de passar pelo ramo do IntegrityError"
    assert perdedora.status_code == 200, perdedora.text
    assert perdedora.json()["id"] == primeira.json()["id"]
    assert await _saldo(client, auth_vendedor, loja["camiseta"]) == 9


async def test_reenvio_com_outro_carrinho_e_recusado_e_nao_devolve_a_venda_antiga(
    client: AsyncClient, auth_vendedor: dict[str, str], loja: dict
) -> None:
    """A resposta se perdeu e a moça mudou a cobrança antes de mandar de novo.

    Com o mesmo `client_uuid`, o servidor devolvia a venda antiga como sucesso: a tela
    mostrava o recibo de uma cobrança que não aconteceu — a peça a mais saía sem baixa de
    estoque, e a gaveta esperava PIX onde entrou dinheiro. Agora é 409, com o número da
    venda que já existe; o reenvio idêntico continua sendo replay.
    """
    chave = str(uuid.uuid4())
    primeira = await client.post(
        "/vendas",
        headers=auth_vendedor,
        json={
            "client_uuid": chave,
            "itens": [{"variante_id": loja["camiseta"], "quantidade": 1}],
            "pagamentos": [{"forma": "PIX", "valor": "49.90"}],
        },
    )
    assert primeira.status_code == 201, primeira.text

    outra_forma = await client.post(
        "/vendas",
        headers=auth_vendedor,
        json={
            "client_uuid": chave,
            "itens": [{"variante_id": loja["camiseta"], "quantidade": 1}],
            "pagamentos": [{"forma": "DINHEIRO", "valor": "49.90"}],
        },
    )
    mais_pecas = await client.post(
        "/vendas",
        headers=auth_vendedor,
        json={
            "client_uuid": chave,
            "itens": [
                {"variante_id": loja["camiseta"], "quantidade": 1},
                {"variante_id": loja["calca"], "quantidade": 1},
            ],
            "pagamentos": [{"forma": "PIX", "valor": "199.80"}],
        },
    )
    for resposta in (outra_forma, mais_pecas):
        assert resposta.status_code == 409, resposta.text
        assert resposta.json()["code"] == "DUPLICADO"
        assert resposta.json()["detail"]["venda_id"] == primeira.json()["id"]

    assert await _saldo(client, auth_vendedor, loja["camiseta"]) == 9
    assert await _saldo(client, auth_vendedor, loja["calca"]) == 1
    venda = (await client.get(f"/vendas/{primeira.json()['id']}", headers=auth_vendedor)).json()
    assert venda["pagamentos"] == [{"forma": "PIX", "valor": "49.90"}]


async def test_duas_vendas_simultaneas_da_ultima_peca_so_uma_passa(
    client: AsyncClient, auth_vendedor: dict[str, str], loja: dict
) -> None:
    """A calça tem 1 peça. Duas vendas ao mesmo tempo: uma vende, a outra recebe 409."""
    payload = lambda: {  # noqa: E731
        "client_uuid": str(uuid.uuid4()),
        "itens": [{"variante_id": loja["calca"], "quantidade": 1}],
        "pagamentos": [{"forma": "PIX", "valor": "149.90"}],
    }

    async def vender() -> int:
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test/api/v1"
        ) as c:
            resp = await c.post("/vendas", headers=auth_vendedor, json=payload())
            return resp.status_code

    resultados = await asyncio.gather(vender(), vender())
    assert sorted(resultados) == [201, 409]
    assert await _saldo(client, auth_vendedor, loja["calca"]) == 0


# ------------------------------------------------------------------ cancelamento
async def test_cancelamento_devolve_o_estoque(
    client: AsyncClient, auth_admin: dict[str, str], loja: dict
) -> None:
    venda_id = (
        await client.post(
            "/vendas",
            headers=auth_admin,
            json={
                "client_uuid": str(uuid.uuid4()),
                "itens": [{"variante_id": loja["camiseta"], "quantidade": 3}],
                "pagamentos": [{"forma": "CREDITO", "valor": "149.70"}],
            },
        )
    ).json()["id"]
    assert await _saldo(client, auth_admin, loja["camiseta"]) == 7

    resp = await client.post(
        f"/vendas/{venda_id}/cancelamento",
        headers=auth_admin,
        json={"motivo": "cliente desistiu"},
    )
    assert resp.status_code == 200
    assert resp.json()["status"] == "CANCELADA"
    assert resp.json()["motivo_cancelamento"] == "cliente desistiu"
    assert await _saldo(client, auth_admin, loja["camiseta"]) == 10

    movs = (
        await client.get(
            "/estoque/movimentacoes", headers=auth_admin, params={"tipo": "ESTORNO"}
        )
    ).json()
    assert movs["items"][0]["quantidade"] == 3


async def test_venda_cancelada_nao_pode_ser_cancelada_de_novo(
    client: AsyncClient, auth_admin: dict[str, str], loja: dict
) -> None:
    venda_id = (
        await client.post(
            "/vendas",
            headers=auth_admin,
            json={
                "client_uuid": str(uuid.uuid4()),
                "itens": [{"variante_id": loja["camiseta"], "quantidade": 1}],
                "pagamentos": [{"forma": "PIX", "valor": "49.90"}],
            },
        )
    ).json()["id"]
    await client.post(
        f"/vendas/{venda_id}/cancelamento", headers=auth_admin, json={"motivo": "erro"}
    )
    resp = await client.post(
        f"/vendas/{venda_id}/cancelamento", headers=auth_admin, json={"motivo": "de novo"}
    )
    assert resp.status_code == 409
    assert resp.json()["code"] == "OPERACAO_INVALIDA"
    assert await _saldo(client, auth_admin, loja["camiseta"]) == 10


async def test_vendedor_nao_cancela_venda_nenhuma(
    client: AsyncClient,
    auth_admin: dict[str, str],
    auth_vendedor: dict[str, str],
    loja: dict,
) -> None:
    """Estorno é do dono e do gerente — nem a própria venda a vendedora desfaz.

    Antes ela cancelava a própria venda do dia, e a de outra pessoa vinha como 404 para
    não confirmar que existia. Agora a porta fecha antes da busca: a resposta é 403 e é a
    mesma para venda própria, alheia ou inexistente, então não sobra o que deduzir.
    """
    venda_alheia = (
        await client.post(
            "/vendas",
            headers=auth_admin,
            json={
                "client_uuid": str(uuid.uuid4()),
                "itens": [{"variante_id": loja["camiseta"], "quantidade": 1}],
                "pagamentos": [{"forma": "PIX", "valor": "49.90"}],
            },
        )
    ).json()["id"]
    venda_propria = (
        await client.post(
            "/vendas",
            headers=auth_vendedor,
            json={
                "client_uuid": str(uuid.uuid4()),
                "itens": [{"variante_id": loja["camiseta"], "quantidade": 1}],
                "pagamentos": [{"forma": "PIX", "valor": "49.90"}],
            },
        )
    ).json()["id"]

    for venda_id in (venda_alheia, venda_propria, 999_999):
        resp = await client.post(
            f"/vendas/{venda_id}/cancelamento",
            headers=auth_vendedor,
            json={"motivo": "cliente desistiu"},
        )
        assert resp.status_code == 403, f"venda {venda_id}: {resp.status_code}"


async def test_dois_cancelamentos_simultaneos_estornam_uma_vez_so(
    client: AsyncClient, auth_admin: dict[str, str], loja: dict
) -> None:
    """Toque duplo em "cancelar" não pode devolver a peça duas vezes ao estoque."""
    venda_id = (
        await client.post(
            "/vendas",
            headers=auth_admin,
            json={
                "client_uuid": str(uuid.uuid4()),
                "itens": [{"variante_id": loja["camiseta"], "quantidade": 3}],
                "pagamentos": [{"forma": "PIX", "valor": "149.70"}],
            },
        )
    ).json()["id"]
    assert await _saldo(client, auth_admin, loja["camiseta"]) == 7

    async def cancelar() -> int:
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test/api/v1"
        ) as c:
            resp = await c.post(
                f"/vendas/{venda_id}/cancelamento",
                headers=auth_admin,
                json={"motivo": "cliente desistiu"},
            )
            return resp.status_code

    resultados = await asyncio.gather(cancelar(), cancelar())
    assert sorted(resultados) == [200, 409]
    assert await _saldo(client, auth_admin, loja["camiseta"]) == 10

    movs = (
        await client.get(
            "/estoque/movimentacoes", headers=auth_admin, params={"tipo": "ESTORNO"}
        )
    ).json()
    assert movs["total"] == 1, "o estorno não pode acontecer duas vezes"


async def test_replay_de_venda_alheia_e_recusado(
    client: AsyncClient,
    auth_admin: dict[str, str],
    auth_vendedor: dict[str, str],
    loja: dict,
) -> None:
    """O atalho de idempotência não pode virar porta de leitura de venda de outro."""
    client_uuid = str(uuid.uuid4())
    await client.post(
        "/vendas",
        headers=auth_admin,
        json={
            "client_uuid": client_uuid,
            "itens": [{"variante_id": loja["camiseta"], "quantidade": 1}],
            "pagamentos": [{"forma": "PIX", "valor": "49.90"}],
        },
    )
    resp = await client.post(
        "/vendas",
        headers=auth_vendedor,
        json={
            "client_uuid": client_uuid,
            "itens": [{"variante_id": loja["camiseta"], "quantidade": 1}],
            "pagamentos": [{"forma": "PIX", "valor": "49.90"}],
        },
    )
    assert resp.status_code == 403


# ------------------------------------------------------------------ visibilidade
async def test_vendedor_nao_ve_custo_nem_lucro_da_venda(
    client: AsyncClient, auth_vendedor: dict[str, str], loja: dict
) -> None:
    venda_id = (
        await client.post(
            "/vendas",
            headers=auth_vendedor,
            json={
                "client_uuid": str(uuid.uuid4()),
                "itens": [{"variante_id": loja["camiseta"], "quantidade": 1}],
                "pagamentos": [{"forma": "PIX", "valor": "49.90"}],
            },
        )
    ).json()
    assert "lucro_bruto" not in venda_id
    assert "custo_unitario" not in venda_id["itens"][0]

    detalhe = (await client.get(f"/vendas/{venda_id['id']}", headers=auth_vendedor)).text
    assert "custo" not in detalhe


async def test_vendedor_lista_apenas_as_proprias_vendas(
    client: AsyncClient,
    auth_admin: dict[str, str],
    auth_vendedor: dict[str, str],
    loja: dict,
) -> None:
    for headers in (auth_admin, auth_vendedor):
        await client.post(
            "/vendas",
            headers=headers,
            json={
                "client_uuid": str(uuid.uuid4()),
                "itens": [{"variante_id": loja["camiseta"], "quantidade": 1}],
                "pagamentos": [{"forma": "PIX", "valor": "49.90"}],
            },
        )

    assert (await client.get("/vendas", headers=auth_admin)).json()["total"] == 2
    minhas = (await client.get("/vendas", headers=auth_vendedor)).json()
    assert minhas["total"] == 1
    assert minhas["items"][0]["vendedor"] == "Ana Vendedora"


async def test_vendedor_nao_abre_venda_de_outro_pelo_id(
    client: AsyncClient,
    auth_admin: dict[str, str],
    auth_vendedor: dict[str, str],
    loja: dict,
) -> None:
    venda_id = (
        await client.post(
            "/vendas",
            headers=auth_admin,
            json={
                "client_uuid": str(uuid.uuid4()),
                "itens": [{"variante_id": loja["camiseta"], "quantidade": 1}],
                "pagamentos": [{"forma": "PIX", "valor": "49.90"}],
            },
        )
    ).json()["id"]
    resp = await client.get(f"/vendas/{venda_id}", headers=auth_vendedor)
    assert resp.status_code == 404


# ------------------------------------------------- desempenho: o banco não pode travar


async def test_conexao_da_api_tem_teto_de_tempo_por_consulta() -> None:
    """O app desiste em 15 s e o retry manda a MESMA consulta de novo.

    Sem teto no banco, a primeira continuava rodando sozinha — a lista de Clientes sem
    índice prendia o Postgres por 70 s a cada abertura, duas vezes. Com o teto, o próprio
    Postgres cancela o que passou do limite.
    """
    async with SessionLocal() as s:
        teto = await s.scalar(text("SHOW statement_timeout"))
    assert teto == f"{settings.db_statement_timeout_ms // 1000}s"
    assert teto != "0", "sem teto, uma consulta lenta segura o banco depois que o app desistiu"


async def test_divida_das_clientes_acha_as_vendas_pelo_indice_da_cliente(session) -> None:
    """A lista "quem está devendo" calcula a dívida de cada cliente somando as vendas DELA.

    O único índice com customer_id era o UNIQUE (id, customer_id), onde ele é a 2ª
    coluna: cada cliente varria o índice inteiro, e a tela levava 49 s com 20 mil
    clientes. O plano da consulta real tem de achar as vendas pelo índice da cliente.
    """
    resultado = await planos(
        session, lambda: ClienteService(session).listar(Paginacao(1, 20), None, True)
    )
    contagem = resultado[0][1]
    assert "ix_sales_customer_id" in contagem, contagem


async def test_contagem_da_lista_de_vendas_nao_monta_o_join_do_vendedor(
    session, loja: dict
) -> None:
    """O vendedor entra por FK obrigatória, um para um: não muda o total.

    Contar o JOIN fazia o banco montá-lo para o histórico inteiro a cada página.
    """
    consultas = await capturar_sql(
        lambda: VendaRepository(session).listar(Paginacao(1, 20), None, None, None, None)
    )
    contagem = next(sql for sql, _ in consultas if "count(" in sql.lower())
    assert "users" not in contagem and "JOIN" not in contagem.upper(), contagem
