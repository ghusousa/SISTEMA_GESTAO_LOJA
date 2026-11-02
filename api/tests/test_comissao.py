"""Vendas e comissão por vendedora, e a meta do dia no PDV dela (ADR-37).

O que não pode quebrar: a comissão sai do LÍQUIDO (devolução abate, cancelada não conta),
a soma da equipe fecha com o resumo da loja, só o dono define quanto cada um ganha — nem o
gerente, que também recebe —, e a vendedora vê só o próprio número, sem custo.
"""

import uuid
from datetime import timedelta
from decimal import Decimal

import pytest
from httpx import AsyncClient
from sqlalchemy import text

from app.core.datas import hoje_na_loja
from app.core.db import engine
from app.modules.relatorios.vendedoras import comissao_de
from app.modules.usuarios.models import User

from conftest import criar_produto


async def _peca(client: AsyncClient, auth: dict[str, str], preco: str = "100.00") -> int:
    categoria = (
        await client.post("/categorias", headers=auth, json={"nome": f"Cat {uuid.uuid4().hex[:6]}"})
    ).json()["id"]
    produto = await criar_produto(client, auth, {
        "categoria_id": categoria,
        "nome": "Blusa",
        "variantes": [
            {
                "tamanho": "M",
                "cor": "Preta",
                "preco_custo": "40.00",
                "preco_venda": preco,
                "estoque_inicial": 50,
            }
        ],
    })
    return produto["variantes"][0]["id"]


async def _vender(
    client: AsyncClient, auth: dict[str, str], variante: int, quantidade: int, total: str
) -> dict:
    resp = await client.post(
        "/vendas",
        headers=auth,
        json={
            "client_uuid": str(uuid.uuid4()),
            "itens": [{"variante_id": variante, "quantidade": quantidade}],
            "pagamentos": [{"forma": "DINHEIRO", "valor": total}],
        },
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


async def _devolver(
    client: AsyncClient, auth: dict[str, str], venda: dict, quantidade: int
) -> None:
    resp = await client.post(
        f"/vendas/{venda['id']}/devolucoes",
        headers=auth,
        json={
            "client_uuid": str(uuid.uuid4()),
            "itens": [{"item_id": venda["itens"][0]["id"], "quantidade": quantidade}],
        },
    )
    assert resp.status_code == 201, resp.text


async def _relatorio(client: AsyncClient, auth: dict[str, str], inicio, fim, **extra) -> dict:
    resp = await client.get(
        "/relatorios/vendedoras",
        headers=auth,
        params={"inicio": str(inicio), "fim": str(fim), **extra},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


# ------------------------------------------------------------- cadastro da comissão
async def test_dono_define_comissao_e_meta_da_vendedora(
    client: AsyncClient, auth_admin: dict[str, str], vendedor: User
) -> None:
    resp = await client.patch(
        f"/usuarios/{vendedor.id}",
        headers=auth_admin,
        json={"comissao_percentual": "2.5", "meta_diaria": "1500.00"},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["comissao_percentual"] == "2.50"
    assert resp.json()["meta_diaria"] == "1500.00"

    # `null` tira a meta; o campo ausente não mexe na comissão.
    resp = await client.patch(
        f"/usuarios/{vendedor.id}", headers=auth_admin, json={"meta_diaria": None}
    )
    assert resp.json()["meta_diaria"] is None
    assert resp.json()["comissao_percentual"] == "2.50"


async def test_dono_cria_usuario_ja_com_comissao(
    client: AsyncClient, auth_admin: dict[str, str]
) -> None:
    resp = await client.post(
        "/usuarios",
        headers=auth_admin,
        json={
            "nome": "Júlia",
            "email": "julia@loja.com",
            "senha": "senha1234",
            "comissao_percentual": "3",
            "meta_diaria": "800",
        },
    )
    assert resp.status_code == 201, resp.text
    assert resp.json()["comissao_percentual"] == "3.00"
    assert resp.json()["meta_diaria"] == "800.00"


async def test_usuario_novo_nasce_sem_comissao_e_sem_meta(
    client: AsyncClient, auth_admin: dict[str, str]
) -> None:
    resp = await client.post(
        "/usuarios",
        headers=auth_admin,
        json={"nome": "Rita", "email": "rita@loja.com", "senha": "senha1234"},
    )
    assert resp.json()["comissao_percentual"] == "0.00"
    assert resp.json()["meta_diaria"] is None


async def test_gerente_nao_aumenta_a_propria_comissao(
    client: AsyncClient, auth_gerente: dict[str, str], gerente: User, vendedor: User
) -> None:
    """O gerente administra a equipe, mas também recebe comissão: quem recebe não decide."""
    for alvo, campos in (
        (gerente.id, {"comissao_percentual": "50"}),
        (vendedor.id, {"comissao_percentual": "10"}),
        (vendedor.id, {"meta_diaria": "100.00"}),
        # Mandar o valor de hoje também é tentativa: a tela não pode "salvar" em silêncio.
        (vendedor.id, {"comissao_percentual": "0"}),
    ):
        resp = await client.patch(f"/usuarios/{alvo}", headers=auth_gerente, json=campos)
        assert resp.status_code == 403, (campos, resp.text)

    resp = await client.post(
        "/usuarios",
        headers=auth_gerente,
        json={
            "nome": "Nova",
            "email": "nova@loja.com",
            "senha": "senha1234",
            "comissao_percentual": "5",
        },
    )
    assert resp.status_code == 403

    # O resto da administração da equipe continua com ele.
    resp = await client.patch(
        f"/usuarios/{vendedor.id}", headers=auth_gerente, json={"nome": "Ana Paula"}
    )
    assert resp.status_code == 200, resp.text

    async with engine.connect() as conn:
        linhas = (
            await conn.execute(text("SELECT comissao_percentual, meta_diaria FROM users"))
        ).all()
    assert all(c == Decimal("0") and m is None for c, m in linhas)


@pytest.mark.parametrize(
    "campos",
    [
        {"comissao_percentual": "100.01"},
        {"comissao_percentual": "-1"},
        {"comissao_percentual": "2.555"},
        {"comissao_percentual": None},
        {"meta_diaria": "0"},
        {"meta_diaria": "-50.00"},
        {"meta_diaria": "10.001"},
    ],
)
async def test_comissao_e_meta_fora_da_regra_sao_recusadas(
    client: AsyncClient, auth_admin: dict[str, str], vendedor: User, campos: dict
) -> None:
    resp = await client.patch(f"/usuarios/{vendedor.id}", headers=auth_admin, json=campos)
    assert resp.status_code == 422, resp.text


async def test_banco_recusa_comissao_acima_de_100_mesmo_por_sql() -> None:
    async with engine.begin() as conn:
        await conn.execute(
            text(
                "INSERT INTO users (name, email, password_hash, role, is_active, "
                "created_at, updated_at) "
                "VALUES ('X', 'x@loja.com', 'h', 'VENDEDOR', true, now(), now())"
            )
        )
    with pytest.raises(Exception, match="ck_users_comissao_percentual"):
        async with engine.begin() as conn:
            await conn.execute(text("UPDATE users SET comissao_percentual = 150"))


def test_comissao_arredonda_meio_centavo_para_cima() -> None:
    assert comissao_de(Decimal("33.33"), Decimal("1.5")) == Decimal("0.50")  # 0,49995
    assert comissao_de(Decimal("100.00"), Decimal("0")) == Decimal("0.00")
    assert comissao_de(Decimal("-100.00"), Decimal("5")) == Decimal("-5.00")


# -------------------------------------------------------------- relatório da equipe
async def test_comissao_sai_do_liquido_e_a_equipe_fecha_com_o_resumo(
    client: AsyncClient,
    auth_admin: dict[str, str],
    auth_vendedor: dict[str, str],
    vendedor: User,
    admin: User,
) -> None:
    """Ana (5%) vendeu 3 blusas de 100 em duas vendas; uma voltou (pela mão do dono).
    O dono vendeu 1 de 100 e uma venda dele foi cancelada. Ana: 300 - 100 = 200 de líquido,
    2 peças, ticket 150, comissão 10,00. A devolução é dela, não de quem atendeu."""
    await client.patch(
        f"/usuarios/{vendedor.id}", headers=auth_admin, json={"comissao_percentual": "5"}
    )
    peca = await _peca(client, auth_admin)
    venda_ana = await _vender(client, auth_vendedor, peca, 2, "200.00")
    await _vender(client, auth_vendedor, peca, 1, "100.00")
    await _devolver(client, auth_admin, venda_ana, 1)
    await _vender(client, auth_admin, peca, 1, "100.00")
    cancelada = await _vender(client, auth_admin, peca, 1, "100.00")
    resp = await client.post(
        f"/vendas/{cancelada['id']}/cancelamento", headers=auth_admin, json={"motivo": "errou"}
    )
    assert resp.status_code == 200, resp.text

    hoje = hoje_na_loja()
    r = await _relatorio(client, auth_admin, hoje, hoje)
    assert r["total"] == 2
    ana, dono = r["items"]
    assert ana["usuario_id"] == vendedor.id
    assert ana["quantidade_vendas"] == 2
    assert ana["faturamento"] == "300.00"
    assert ana["devolucoes"] == "100.00"
    assert ana["faturamento_liquido"] == "200.00"
    assert ana["pecas"] == 2
    assert ana["ticket_medio"] == "150.00"
    assert ana["comissao_percentual"] == "5.00"
    assert ana["comissao"] == "10.00"

    assert dono["usuario_id"] == admin.id
    assert dono["faturamento_liquido"] == "100.00"
    assert dono["quantidade_vendas"] == 1
    assert dono["comissao"] == "0.00"

    assert r["faturamento_liquido_total"] == "300.00"
    assert r["comissao_total"] == "10.00"
    resumo = (
        await client.get(
            "/relatorios/resumo",
            headers=auth_admin,
            params={"inicio": str(hoje), "fim": str(hoje)},
        )
    ).json()
    assert resumo["faturamento_liquido"] == r["faturamento_liquido_total"]


async def test_devolucao_de_venda_antiga_estorna_no_periodo_da_devolucao(
    client: AsyncClient,
    auth_admin: dict[str, str],
    auth_vendedor: dict[str, str],
    vendedor: User,
) -> None:
    """A venda foi no mês passado e a comissão dela já foi paga. A blusa voltou hoje: o
    mês passado NÃO muda (seria reescrever uma folha fechada) e hoje sai o estorno."""
    await client.patch(
        f"/usuarios/{vendedor.id}", headers=auth_admin, json={"comissao_percentual": "10"}
    )
    peca = await _peca(client, auth_admin)
    venda = await _vender(client, auth_vendedor, peca, 1, "100.00")
    async with engine.begin() as conn:
        await conn.execute(
            text("UPDATE sales SET sold_at = sold_at - interval '40 days' WHERE id = :id"),
            {"id": venda["id"]},
        )
    await _devolver(client, auth_admin, venda, 1)

    hoje = hoje_na_loja()
    passado = hoje - timedelta(days=40)
    antes = await _relatorio(client, auth_admin, passado, passado)
    assert antes["items"][0]["faturamento_liquido"] == "100.00"
    assert antes["items"][0]["comissao"] == "10.00"

    agora = await _relatorio(client, auth_admin, hoje, hoje)
    linha = agora["items"][0]
    assert linha["faturamento"] == "0.00"
    assert linha["quantidade_vendas"] == 0
    assert linha["devolucoes"] == "100.00"
    assert linha["faturamento_liquido"] == "-100.00"
    assert linha["pecas"] == -1
    assert linha["comissao"] == "-10.00"
    assert linha["ticket_medio"] == "0.00"


async def test_relatorio_da_equipe_e_paginado_com_totais_do_periodo_inteiro(
    client: AsyncClient,
    auth_admin: dict[str, str],
    auth_vendedor: dict[str, str],
    auth_gerente: dict[str, str],
) -> None:
    peca = await _peca(client, auth_admin)
    await _vender(client, auth_vendedor, peca, 3, "300.00")
    await _vender(client, auth_gerente, peca, 2, "200.00")
    await _vender(client, auth_admin, peca, 1, "100.00")

    hoje = hoje_na_loja()
    pagina = await _relatorio(client, auth_admin, hoje, hoje, page=2, size=1)
    assert pagina["total"] == 3
    assert len(pagina["items"]) == 1
    assert pagina["items"][0]["faturamento_liquido"] == "200.00"  # a 2ª que mais vendeu
    assert pagina["faturamento_liquido_total"] == "600.00"


async def test_so_quem_ve_dinheiro_ve_o_relatorio_da_equipe(
    client: AsyncClient,
    auth_vendedor: dict[str, str],
    auth_supervisora: dict[str, str],
    auth_gerente: dict[str, str],
) -> None:
    hoje = str(hoje_na_loja())
    params = {"inicio": hoje, "fim": hoje}
    for auth in (auth_vendedor, auth_supervisora):
        resp = await client.get("/relatorios/vendedoras", headers=auth, params=params)
        assert resp.status_code == 403
    resp = await client.get("/relatorios/vendedoras", headers=auth_gerente, params=params)
    assert resp.status_code == 200


async def test_periodo_invertido_no_relatorio_da_equipe_e_recusado(
    client: AsyncClient, auth_admin: dict[str, str]
) -> None:
    resp = await client.get(
        "/relatorios/vendedoras",
        headers=auth_admin,
        params={"inicio": "2026-08-10", "fim": "2026-08-01"},
    )
    assert resp.status_code == 422


# ------------------------------------------------------------------ meu dia (PDV)
async def test_meu_dia_mostra_so_o_proprio_numero_e_quanto_falta(
    client: AsyncClient,
    auth_admin: dict[str, str],
    auth_vendedor: dict[str, str],
    vendedor: User,
) -> None:
    await client.patch(
        f"/usuarios/{vendedor.id}",
        headers=auth_admin,
        json={"meta_diaria": "500.00", "comissao_percentual": "5"},
    )
    peca = await _peca(client, auth_admin)
    venda = await _vender(client, auth_vendedor, peca, 2, "200.00")
    await _devolver(client, auth_admin, venda, 1)
    await _vender(client, auth_admin, peca, 3, "300.00")

    resp = await client.get("/relatorios/meu-dia", headers=auth_vendedor)
    assert resp.status_code == 200, resp.text
    dia = resp.json()
    assert dia == {
        "data": str(hoje_na_loja()),
        "vendido": "100.00",
        "quantidade_vendas": 1,
        "pecas": 1,
        "meta": "500.00",
        "falta": "400.00",
    }
    # Nada de custo, lucro ou comissão no placar do balcão.
    assert not {"custo", "lucro", "comissao", "comissao_percentual"} & set(dia)

    dono = (await client.get("/relatorios/meu-dia", headers=auth_admin)).json()
    assert dono["vendido"] == "300.00"
    assert dono["meta"] is None
    assert dono["falta"] is None


async def test_meu_dia_com_meta_batida_falta_zero(
    client: AsyncClient,
    auth_admin: dict[str, str],
    auth_vendedor: dict[str, str],
    vendedor: User,
) -> None:
    await client.patch(
        f"/usuarios/{vendedor.id}", headers=auth_admin, json={"meta_diaria": "150.00"}
    )
    peca = await _peca(client, auth_admin)
    await _vender(client, auth_vendedor, peca, 2, "200.00")
    dia = (await client.get("/relatorios/meu-dia", headers=auth_vendedor)).json()
    assert dia["vendido"] == "200.00"
    assert dia["falta"] == "0.00"


async def test_meu_dia_nao_conta_venda_de_ontem(
    client: AsyncClient, auth_admin: dict[str, str], auth_vendedor: dict[str, str]
) -> None:
    peca = await _peca(client, auth_admin)
    venda = await _vender(client, auth_vendedor, peca, 1, "100.00")
    async with engine.begin() as conn:
        await conn.execute(
            text("UPDATE sales SET sold_at = sold_at - interval '1 day' WHERE id = :id"),
            {"id": venda["id"]},
        )
    dia = (await client.get("/relatorios/meu-dia", headers=auth_vendedor)).json()
    assert dia["vendido"] == "0.00"
    assert dia["quantidade_vendas"] == 0


async def test_meu_dia_exige_login(client: AsyncClient) -> None:
    assert (await client.get("/relatorios/meu-dia")).status_code == 401
