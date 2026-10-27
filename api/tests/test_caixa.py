import uuid
from datetime import UTC, datetime, timedelta

import pytest
from httpx import AsyncClient

from app.core.config import settings

from conftest import criar_produto


def _hoje_loja():
    return datetime.now(UTC).astimezone(settings.tz_loja).date()


@pytest.fixture
async def vendas_do_dia(client: AsyncClient, auth_admin: dict[str, str]) -> dict:
    """Vendas de hoje: 100,00 em PIX e 90,00 dinheiro + 100,00 débito."""
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
                        "estoque_inicial": 20,
                    }
                ],
            })
    variante = produto["variantes"][0]["id"]

    await client.post(
        "/vendas",
        headers=auth_admin,
        json={
            "client_uuid": str(uuid.uuid4()),
            "itens": [{"variante_id": variante, "quantidade": 2}],
            "pagamentos": [{"forma": "PIX", "valor": "100.00"}],
        },
    )
    await client.post(
        "/vendas",
        headers=auth_admin,
        json={
            "client_uuid": str(uuid.uuid4()),
            "desconto": "10.00",
            "itens": [{"variante_id": variante, "quantidade": 4}],
            "pagamentos": [
                {"forma": "DINHEIRO", "valor": "90.00"},
                {"forma": "DEBITO", "valor": "100.00"},
            ],
        },
    )
    return {"variante": variante}


async def test_dia_mostra_o_esperado_por_forma_de_pagamento(
    client: AsyncClient, auth_admin: dict[str, str], vendas_do_dia: dict
) -> None:
    resp = await client.get("/caixa/dia", headers=auth_admin)
    assert resp.status_code == 200, resp.text
    corpo = resp.json()
    por_forma = {linha["forma"]: linha["esperado"] for linha in corpo["linhas"]}
    assert por_forma["PIX"] == "100.00"
    assert por_forma["DINHEIRO"] == "90.00"
    assert por_forma["DEBITO"] == "100.00"
    assert por_forma["CREDITO"] == "0.00"
    assert corpo["total_esperado"] == "290.00"
    assert corpo["quantidade_vendas"] == 2
    assert corpo["fechado"] is False


async def test_venda_cancelada_sai_do_esperado(
    client: AsyncClient, auth_admin: dict[str, str], vendas_do_dia: dict
) -> None:
    venda_pix = next(
        v
        for v in (await client.get("/vendas", headers=auth_admin)).json()["items"]
        if v["formas_pagamento"] == ["PIX"]
    )
    await client.post(
        f"/vendas/{venda_pix['id']}/cancelamento",
        headers=auth_admin,
        json={"motivo": "cliente desistiu"},
    )
    corpo = (await client.get("/caixa/dia", headers=auth_admin)).json()
    assert corpo["total_esperado"] == "190.00"
    assert corpo["quantidade_canceladas"] == 1


async def test_fechamento_registra_a_diferenca(
    client: AsyncClient, auth_admin: dict[str, str], vendas_do_dia: dict
) -> None:
    """Faltaram 10 reais na gaveta: a diferença precisa aparecer, não ser escondida."""
    resp = await client.post(
        "/caixa/fechamentos",
        headers=auth_admin,
        json={
            "data": _hoje_loja().isoformat(),
            "contagens": [
                {"forma": "DINHEIRO", "valor_contado": "80.00"},
                {"forma": "PIX", "valor_contado": "100.00"},
                {"forma": "DEBITO", "valor_contado": "100.00"},
            ],
            "observacao": "faltou troco",
        },
    )
    assert resp.status_code == 201, resp.text
    corpo = resp.json()
    assert corpo["total_esperado"] == "290.00"
    assert corpo["total_contado"] == "280.00"
    assert corpo["diferenca"] == "-10.00"
    dinheiro = next(linha for linha in corpo["linhas"] if linha["forma"] == "DINHEIRO")
    assert dinheiro["diferenca"] == "-10.00"
    assert corpo["fechado_por"] == "Dona Maria"


async def test_refechar_o_mesmo_dia_atualiza_em_vez_de_duplicar(
    client: AsyncClient, auth_admin: dict[str, str], vendas_do_dia: dict
) -> None:
    hoje = _hoje_loja().isoformat()
    primeiro = await client.post(
        "/caixa/fechamentos",
        headers=auth_admin,
        json={
            "data": hoje,
            "contagens": [
                {"forma": "DINHEIRO", "valor_contado": "80.00"},
                {"forma": "PIX", "valor_contado": "100.00"},
                {"forma": "DEBITO", "valor_contado": "100.00"},
            ],
        },
    )
    segundo = await client.post(
        "/caixa/fechamentos",
        headers=auth_admin,
        json={
            "data": hoje,
            "contagens": [
                {"forma": "DINHEIRO", "valor_contado": "90.00"},
                {"forma": "PIX", "valor_contado": "100.00"},
                {"forma": "DEBITO", "valor_contado": "100.00"},
            ],
        },
    )
    assert primeiro.json()["id"] == segundo.json()["id"]
    assert segundo.json()["diferenca"] == "0.00"

    historico = await client.get("/caixa/fechamentos", headers=auth_admin)
    assert historico.json()["total"] == 1


async def test_dia_aponta_o_fechamento_existente(
    client: AsyncClient, auth_admin: dict[str, str], vendas_do_dia: dict
) -> None:
    hoje = _hoje_loja().isoformat()
    fechamento_id = (
        await client.post(
            "/caixa/fechamentos",
            headers=auth_admin,
            json={
                "data": hoje,
                "contagens": [
                    {"forma": "PIX", "valor_contado": "100.00"},
                    {"forma": "DINHEIRO", "valor_contado": "90.00"},
                    {"forma": "DEBITO", "valor_contado": "100.00"},
                ],
            },
        )
    ).json()["id"]

    corpo = (await client.get("/caixa/dia", headers=auth_admin)).json()
    assert corpo["fechado"] is True
    assert corpo["fechamento_id"] == fechamento_id
    pix = next(linha for linha in corpo["linhas"] if linha["forma"] == "PIX")
    assert pix["contado"] == "100.00"


async def test_nao_fecha_caixa_de_dia_futuro(
    client: AsyncClient, auth_admin: dict[str, str]
) -> None:
    amanha = (_hoje_loja() + timedelta(days=1)).isoformat()
    resp = await client.post(
        "/caixa/fechamentos",
        headers=auth_admin,
        json={"data": amanha, "contagens": [{"forma": "PIX", "valor_contado": "0.00"}]},
    )
    assert resp.status_code == 422


async def test_vendedor_nao_acessa_o_caixa(
    client: AsyncClient, auth_vendedor: dict[str, str]
) -> None:
    assert (await client.get("/caixa/dia", headers=auth_vendedor)).status_code == 403
    resp = await client.post(
        "/caixa/fechamentos",
        headers=auth_vendedor,
        json={
            "data": _hoje_loja().isoformat(),
            "contagens": [{"forma": "PIX", "valor_contado": "10.00"}],
        },
    )
    assert resp.status_code == 403


async def test_fechar_sem_conferir_uma_forma_com_valor_e_recusado(
    client: AsyncClient, auth_admin: dict[str, str], vendas_do_dia: dict
) -> None:
    """Deixar o PIX de fora não pode virar "contado zero": inventaria um rombo."""
    resp = await client.post(
        "/caixa/fechamentos",
        headers=auth_admin,
        json={
            "data": _hoje_loja().isoformat(),
            "contagens": [{"forma": "DINHEIRO", "valor_contado": "90.00"}],
        },
    )
    assert resp.status_code == 422
    assert resp.json()["code"] == "VALIDACAO"
    assert "PIX" in resp.json()["detail"]["formas"]


async def _quando_alguem_parar_numa_trava() -> None:
    """Espera, sem relógio, até outra sessão estar parada numa trava do banco.

    `pg_stat_activity` é uma foto tirada uma vez por transação, por isso cada volta do
    laço abre a sua — senão a pergunta repetiria a mesma resposta para sempre.
    """
    from sqlalchemy import text

    from app.core.db import engine

    async with engine.connect() as conexao:
        while True:
            parada = await conexao.scalar(
                text(
                    "SELECT EXISTS (SELECT 1 FROM pg_stat_activity"
                    " WHERE datname = current_database() AND wait_event_type = 'Lock'"
                    " AND pid <> pg_backend_pid())"
                )
            )
            await conexao.rollback()
            if parada:
                return


async def test_fechamento_simultaneo_do_mesmo_dia_vira_atualizacao(
    client: AsyncClient, auth_admin: dict[str, str], gerente, vendas_do_dia: dict
) -> None:
    """PC e celular fecham o mesmo dia juntos: o que chega depois atualiza, não dá 500.

    O ramo de recuperação fazia rollback e lia `usuario.id` em seguida — atributo expirado,
    MissingGreenlet em sessão async. A ordem é forçada pela trava, sem relógio: o outro
    aparelho grava o fechamento e só faz commit quando o Postgres diz que este parou
    esperando na UNIQUE de `closing_date`.
    """
    import asyncio

    from app.core.db import SessionLocal
    from app.modules.caixa.models import CashClosing

    corpo = {
        "data": _hoje_loja().isoformat(),
        "contagens": [
            {"forma": "DINHEIRO", "valor_contado": "90.00"},
            {"forma": "PIX", "valor_contado": "100.00"},
            {"forma": "DEBITO", "valor_contado": "100.00"},
        ],
    }
    async with SessionLocal() as outro_aparelho:
        outro_aparelho.add(CashClosing(closing_date=_hoje_loja(), user_id=gerente.id))
        await outro_aparelho.flush()
        fechar = asyncio.create_task(
            client.post("/caixa/fechamentos", headers=auth_admin, json=corpo)
        )
        try:
            await asyncio.wait_for(_quando_alguem_parar_numa_trava(), timeout=15)
        finally:
            await outro_aparelho.commit()
        resp = await fechar

    assert resp.status_code == 201, resp.text
    assert resp.json()["fechado_por"] == "Dona Maria"
    assert resp.json()["total_contado"] == "290.00"
    assert resp.json()["diferenca"] == "0.00"
    historico = await client.get("/caixa/fechamentos", headers=auth_admin)
    assert historico.json()["total"] == 1
