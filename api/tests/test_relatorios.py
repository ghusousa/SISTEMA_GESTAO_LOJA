import uuid
from datetime import UTC, datetime

import pytest
from httpx import AsyncClient

from sqlalchemy import text

from app.core.config import settings
from app.core.datas import hoje_na_loja
from app.core.db import engine
from app.modules.caixa.service import CaixaService
from app.modules.relatorios.service import RelatorioService

from conftest import criar_produto
from planos import planos


def _hoje_loja() -> str:
    return datetime.now(UTC).astimezone(settings.tz_loja).date().isoformat()


@pytest.fixture
async def loja_com_movimento(client: AsyncClient, auth_admin: dict[str, str]) -> dict:
    """Duas peças cadastradas, duas vendas concluídas e uma despesa lançada.

    Camiseta: custo 20,00 / venda 50,00 — vendidas 3
    Calça:    custo 60,00 / venda 150,00 — vendida 1
    Faturamento bruto 300,00, com 10,00 de desconto numa venda -> 290,00
    CMV 120,00  ->  lucro bruto 170,00; despesa 100,00  ->  resultado 70,00
    """
    categoria = (
        await client.post("/categorias", headers=auth_admin, json={"nome": "Roupas"})
    ).json()["id"]
    produto = await criar_produto(client, auth_admin, {
                "categoria_id": categoria,
                "nome": "Camiseta",
                "variantes": [
                    {
                        "tamanho": "M",
                        "cor": "Branca",
                        "codigo_barras": "7891111111117",
                        "preco_custo": "20.00",
                        "preco_venda": "50.00",
                        "estoque_minimo": 5,
                        "estoque_inicial": 10,
                    },
                    {
                        "tamanho": "G",
                        "cor": "Azul",
                        "codigo_barras": "7892222222224",
                        "preco_custo": "60.00",
                        "preco_venda": "150.00",
                        "estoque_minimo": 2,
                        "estoque_inicial": 3,
                    },
                ],
            })
    camiseta = produto["variantes"][0]["id"]
    calca = produto["variantes"][1]["id"]

    # Venda 1: 2 camisetas = 100,00 no PIX
    await client.post(
        "/vendas",
        headers=auth_admin,
        json={
            "client_uuid": str(uuid.uuid4()),
            "itens": [{"variante_id": camiseta, "quantidade": 2}],
            "pagamentos": [{"forma": "PIX", "valor": "100.00"}],
        },
    )
    # Venda 2: 1 camiseta + 1 calça = 200,00 - 10,00 = 190,00 (dinheiro + débito)
    await client.post(
        "/vendas",
        headers=auth_admin,
        json={
            "client_uuid": str(uuid.uuid4()),
            "desconto": "10.00",
            "itens": [
                {"variante_id": camiseta, "quantidade": 1},
                {"variante_id": calca, "quantidade": 1},
            ],
            "pagamentos": [
                {"forma": "DINHEIRO", "valor": "90.00"},
                {"forma": "DEBITO", "valor": "100.00"},
            ],
        },
    )

    categoria_despesa = (
        await client.post(
            "/despesas/categorias", headers=auth_admin, json={"nome": "Energia"}
        )
    ).json()["id"]
    await client.post(
        "/despesas",
        headers=auth_admin,
        json={
            "categoria_id": categoria_despesa,
            "descricao": "Conta de luz",
            "valor": "100.00",
            "data": _hoje_loja(),
        },
    )
    return {"camiseta": camiseta, "calca": calca, "categoria_despesa": categoria_despesa}


# ------------------------------------------------------------------ resumo
async def test_resumo_fecha_a_conta_do_periodo(
    client: AsyncClient, auth_admin: dict[str, str], loja_com_movimento: dict
) -> None:
    hoje = _hoje_loja()
    resp = await client.get(
        "/relatorios/resumo", headers=auth_admin, params={"inicio": hoje, "fim": hoje}
    )
    assert resp.status_code == 200, resp.text
    r = resp.json()
    assert r["faturamento"] == "290.00"
    assert r["custo_mercadoria_vendida"] == "120.00"
    assert r["lucro_bruto"] == "170.00"
    assert r["despesas"] == "100.00"
    assert r["resultado"] == "70.00"
    assert r["quantidade_vendas"] == 2
    assert r["quantidade_pecas"] == 4
    assert r["ticket_medio"] == "145.00"


async def test_venda_cancelada_sai_do_faturamento(
    client: AsyncClient, auth_admin: dict[str, str], loja_com_movimento: dict
) -> None:
    hoje = _hoje_loja()
    venda_id = (await client.get("/vendas", headers=auth_admin)).json()["items"][0]["id"]
    await client.post(
        f"/vendas/{venda_id}/cancelamento", headers=auth_admin, json={"motivo": "devolução"}
    )
    r = (
        await client.get(
            "/relatorios/resumo", headers=auth_admin, params={"inicio": hoje, "fim": hoje}
        )
    ).json()
    assert r["faturamento"] == "100.00"
    assert r["custo_mercadoria_vendida"] == "40.00"
    assert r["quantidade_vendas"] == 1
    assert r["vendas_canceladas"] == 1


async def test_vendedor_nao_acessa_relatorios(
    client: AsyncClient, auth_vendedor: dict[str, str]
) -> None:
    hoje = _hoje_loja()
    for rota in (
        "/relatorios/resumo",
        "/relatorios/vendas-por-dia",
        "/relatorios/mais-vendidos",
        "/relatorios/despesas-por-categoria",
    ):
        resp = await client.get(
            rota, headers=auth_vendedor, params={"inicio": hoje, "fim": hoje}
        )
        assert resp.status_code == 403, rota
    assert (
        await client.get("/relatorios/estoque-baixo", headers=auth_vendedor)
    ).status_code == 403


async def test_periodo_invertido_e_recusado(
    client: AsyncClient, auth_admin: dict[str, str]
) -> None:
    resp = await client.get(
        "/relatorios/resumo",
        headers=auth_admin,
        params={"inicio": "2026-08-31", "fim": "2026-08-01"},
    )
    assert resp.status_code == 422
    assert resp.json()["code"] == "VALIDACAO"


async def test_periodo_longo_demais_e_recusado(
    client: AsyncClient, auth_admin: dict[str, str]
) -> None:
    resp = await client.get(
        "/relatorios/resumo",
        headers=auth_admin,
        params={"inicio": "2020-01-01", "fim": "2026-12-31"},
    )
    assert resp.status_code == 422


# ------------------------------------------------------------------ séries e rankings
async def test_vendas_por_dia_preenche_dias_sem_venda(
    client: AsyncClient, auth_admin: dict[str, str], loja_com_movimento: dict
) -> None:
    hoje = datetime.now(UTC).astimezone(settings.tz_loja).date()
    inicio = hoje.replace(day=1) if hoje.day > 3 else hoje
    resp = await client.get(
        "/relatorios/vendas-por-dia",
        headers=auth_admin,
        params={"inicio": inicio.isoformat(), "fim": hoje.isoformat()},
    )
    serie = resp.json()
    assert len(serie) == (hoje - inicio).days + 1
    hoje_str = hoje.isoformat()
    dia_de_hoje = next(d for d in serie if d["data"] == hoje_str)
    assert dia_de_hoje["faturamento"] == "290.00"
    assert dia_de_hoje["quantidade_vendas"] == 2
    assert all(d["faturamento"] == "0.00" for d in serie if d["data"] != hoje_str)


async def test_mais_vendidos_ordena_por_quantidade(
    client: AsyncClient, auth_admin: dict[str, str], loja_com_movimento: dict
) -> None:
    hoje = _hoje_loja()
    resp = await client.get(
        "/relatorios/mais-vendidos", headers=auth_admin, params={"inicio": hoje, "fim": hoje}
    )
    ranking = resp.json()
    assert ranking[0]["produto"] == "Camiseta"
    assert ranking[0]["tamanho"] == "M"
    assert ranking[0]["quantidade"] == 3
    assert ranking[0]["faturamento"] == "150.00"
    assert ranking[0]["lucro_bruto"] == "90.00"
    assert ranking[1]["quantidade"] == 1


async def test_despesas_por_categoria_traz_percentual(
    client: AsyncClient, auth_admin: dict[str, str], loja_com_movimento: dict
) -> None:
    hoje = _hoje_loja()
    resp = await client.get(
        "/relatorios/despesas-por-categoria",
        headers=auth_admin,
        params={"inicio": hoje, "fim": hoje},
    )
    linhas = resp.json()
    assert len(linhas) == 1
    assert linhas[0]["categoria"] == "Energia"
    assert linhas[0]["total"] == "100.00"
    assert linhas[0]["percentual"] == "100.00"


async def test_estoque_baixo_lista_o_que_precisa_repor(
    client: AsyncClient, auth_admin: dict[str, str], loja_com_movimento: dict
) -> None:
    """Camiseta: 10-3=7 acima do mínimo 5. Calça: 3-1=2, igual ao mínimo 2 -> entra."""
    resp = await client.get("/relatorios/estoque-baixo", headers=auth_admin)
    pagina = resp.json()
    assert pagina["total"] == 1
    linhas = pagina["items"]
    assert [linha["variante_id"] for linha in linhas] == [loja_com_movimento["calca"]]
    assert linhas[0]["saldo"] == 2
    assert linhas[0]["estoque_minimo"] == 2
    assert linhas[0]["faltam"] == 0


async def test_margem_bruta_e_sobre_o_faturamento_liquido(
    client: AsyncClient, auth_admin: dict[str, str]
) -> None:
    """Duas blusas de 100,00 (custo 50,00), uma voltou: a margem é 50%, não 25%.

    O lucro já sai do líquido; dividir pelo faturamento bruto encolhia a margem na
    proporção da devolução.
    """
    categoria = (
        await client.post("/categorias", headers=auth_admin, json={"nome": "Blusas"})
    ).json()["id"]
    produto = await criar_produto(client, auth_admin, {
        "categoria_id": categoria,
        "nome": "Blusa",
        "variantes": [
            {
                "tamanho": "M",
                "cor": "Preta",
                "preco_custo": "50.00",
                "preco_venda": "100.00",
                "estoque_inicial": 5,
            }
        ],
    })
    variante = produto["variantes"][0]["id"]
    vendas = []
    for _ in range(2):
        resp = await client.post(
            "/vendas",
            headers=auth_admin,
            json={
                "client_uuid": str(uuid.uuid4()),
                "itens": [{"variante_id": variante, "quantidade": 1}],
                "pagamentos": [{"forma": "DINHEIRO", "valor": "100.00"}],
            },
        )
        assert resp.status_code == 201, resp.text
        vendas.append(resp.json())
    resp = await client.post(
        f"/vendas/{vendas[1]['id']}/devolucoes",
        headers=auth_admin,
        json={
            "client_uuid": str(uuid.uuid4()),
            "itens": [{"item_id": vendas[1]["itens"][0]["id"], "quantidade": 1}],
        },
    )
    assert resp.status_code == 201, resp.text

    hoje = _hoje_loja()
    r = (
        await client.get(
            "/relatorios/resumo", headers=auth_admin, params={"inicio": hoje, "fim": hoje}
        )
    ).json()
    assert r["faturamento_liquido"] == "100.00"
    assert r["lucro_bruto"] == "50.00"
    assert r["margem_bruta_pct"] == "50.00"


async def test_estoque_baixo_e_paginado_e_contado_no_servidor(
    client: AsyncClient, auth_admin: dict[str, str]
) -> None:
    """Toda listagem pagina: eram 7 mil peças e 1,5 MB a CADA venda numa loja de anos.

    A aba Financeiro só quer "N peças no mínimo": pede `size=1` e lê o `total`. A tela de
    relatório pagina, as mais urgentes primeiro — e nenhuma peça repete ou some entre
    uma página e outra.
    """
    categoria = (
        await client.post("/categorias", headers=auth_admin, json={"nome": "Repor"})
    ).json()["id"]
    produto = await criar_produto(client, auth_admin, {
        "categoria_id": categoria,
        "nome": "Blusa",
        "variantes": [
            # Sem estoque inicial: todas zeradas. Só a G tem mínimo — é a mais urgente.
            {"tamanho": t, "cor": "Preta", "preco_custo": "10.00", "preco_venda": "30.00",
             "estoque_minimo": 3 if t == "G" else 0}
            for t in ("PP", "P", "M", "G", "GG")
        ],
    })
    ids = {v["tamanho"]: v["id"] for v in produto["variantes"]}

    contagem = (
        await client.get("/relatorios/estoque-baixo", headers=auth_admin, params={"size": 1})
    ).json()
    assert contagem["total"] == 5
    assert len(contagem["items"]) == 1
    assert contagem["items"][0]["variante_id"] == ids["G"], "a mais urgente vem primeiro"

    vistas = []
    for page in (1, 2, 3):
        resp = await client.get(
            "/relatorios/estoque-baixo", headers=auth_admin, params={"page": page, "size": 2}
        )
        assert resp.status_code == 200, resp.text
        corpo = resp.json()
        assert (corpo["total"], corpo["page"], corpo["size"]) == (5, page, 2)
        vistas += [item["variante_id"] for item in corpo["items"]]
    assert sorted(vistas) == sorted(ids.values()), "nenhuma peça repete nem some entre páginas"


async def _vacuum(*tabelas: str) -> None:
    """Index Only Scan depende do mapa de visibilidade, que só o VACUUM preenche."""
    async with engine.connect() as conn:
        conn = await conn.execution_options(isolation_level="AUTOCOMMIT")
        for tabela in tabelas:
            await conn.execute(text(f"VACUUM ANALYZE {tabela}"))


async def test_resumo_do_mes_soma_os_itens_e_o_fiado_pelos_indices(
    session, loja_com_movimento: dict
) -> None:
    """O CMV do mês lia os anos de `sale_items`, e o "vendido a prazo" todos os pagamentos.

    Com as colunas que o relatório lê dentro do índice, a soma sai do índice (Index Only
    Scan); o fiado tem índice próprio, parcial.
    """
    await _vacuum("sale_items", "sale_payments", "sales")
    hoje = hoje_na_loja()
    resultado = await planos(
        session, lambda: RelatorioService(session).resumo(hoje, hoje), generico=False
    )
    cmv = next(
        p for sql, p in resultado if "sale_items.unit_cost" in sql and "sale_return" not in sql
    )
    a_prazo = next(p for sql, p in resultado if "sum(sale_payments.amount)" in sql)
    assert "Index Only Scan using ix_sale_items_sale_id" in cmv, cmv
    assert "ix_sale_payments_fiado" in a_prazo, a_prazo


async def test_recebimentos_do_dia_saem_do_indice_do_dia_da_loja(
    session, loja_com_movimento: dict
) -> None:
    """O caixa de hoje lia TODOS os recebimentos de fiado já feitos para achar os de hoje.

    Mesmo desenho de `ix_sales_business_date`: índice sobre a expressão exata de
    `dia_da_loja(paid_at)`.
    """
    hoje = hoje_na_loja()
    resultado = await planos(session, lambda: CaixaService(session).dia(hoje), generico=False)
    resultado += await planos(
        session, lambda: RelatorioService(session).resumo(hoje, hoje), generico=False
    )
    recebimentos = [p for sql, p in resultado if "FROM customer_payments" in sql]
    assert recebimentos, "o caixa e o resumo consultam os recebimentos do dia"
    for plano in recebimentos:
        assert "ix_customer_payments_business_date" in plano, plano
