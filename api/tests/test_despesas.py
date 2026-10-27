import pytest
from httpx import AsyncClient


@pytest.fixture
async def categorias(client: AsyncClient, auth_admin: dict[str, str]) -> dict:
    ids = {}
    for nome in ("Aluguel", "Energia", "Fornecedores"):
        resp = await client.post(
            "/despesas/categorias", headers=auth_admin, json={"nome": nome}
        )
        assert resp.status_code == 201
        ids[nome] = resp.json()["id"]
    return ids


async def test_vendedor_nao_ve_nem_lanca_despesas(
    client: AsyncClient, auth_vendedor: dict[str, str]
) -> None:
    assert (await client.get("/despesas", headers=auth_vendedor)).status_code == 403
    assert (
        await client.get("/despesas/categorias", headers=auth_vendedor)
    ).status_code == 403
    resp = await client.post(
        "/despesas",
        headers=auth_vendedor,
        json={
            "categoria_id": 1,
            "descricao": "Aluguel",
            "valor": "2000.00",
            "data": "2026-08-05",
        },
    )
    assert resp.status_code == 403


async def test_lanca_despesa_e_calcula_competencia(
    client: AsyncClient, auth_admin: dict[str, str], categorias: dict
) -> None:
    resp = await client.post(
        "/despesas",
        headers=auth_admin,
        json={
            "categoria_id": categorias["Aluguel"],
            "descricao": "Aluguel da loja",
            "valor": "2500.00",
            "data": "2026-08-05",
            "recorrente": True,
        },
    )
    assert resp.status_code == 201, resp.text
    corpo = resp.json()
    assert corpo["competencia"] == "2026-08"
    assert corpo["categoria"] == "Aluguel"
    assert corpo["recorrente"] is True


async def test_despesa_com_valor_zero_e_recusada(
    client: AsyncClient, auth_admin: dict[str, str], categorias: dict
) -> None:
    resp = await client.post(
        "/despesas",
        headers=auth_admin,
        json={
            "categoria_id": categorias["Energia"],
            "descricao": "Conta de luz",
            "valor": "0.00",
            "data": "2026-08-10",
        },
    )
    assert resp.status_code == 422


async def test_categoria_de_despesa_duplicada_e_recusada(
    client: AsyncClient, auth_admin: dict[str, str], categorias: dict
) -> None:
    resp = await client.post(
        "/despesas/categorias", headers=auth_admin, json={"nome": "aluguel"}
    )
    assert resp.status_code == 409


async def test_categoria_com_despesa_nao_pode_ser_excluida(
    client: AsyncClient, auth_admin: dict[str, str], categorias: dict
) -> None:
    await client.post(
        "/despesas",
        headers=auth_admin,
        json={
            "categoria_id": categorias["Energia"],
            "descricao": "Luz de agosto",
            "valor": "480.00",
            "data": "2026-08-10",
        },
    )
    resp = await client.delete(
        f"/despesas/categorias/{categorias['Energia']}", headers=auth_admin
    )
    assert resp.status_code == 409


async def test_filtro_por_periodo_e_categoria(
    client: AsyncClient, auth_admin: dict[str, str], categorias: dict
) -> None:
    for data, categoria, valor in (
        ("2026-07-05", "Aluguel", "2500.00"),
        ("2026-08-05", "Aluguel", "2500.00"),
        ("2026-08-10", "Energia", "480.00"),
    ):
        await client.post(
            "/despesas",
            headers=auth_admin,
            json={
                "categoria_id": categorias[categoria],
                "descricao": f"{categoria} {data}",
                "valor": valor,
                "data": data,
            },
        )

    agosto = await client.get(
        "/despesas", headers=auth_admin, params={"inicio": "2026-08-01", "fim": "2026-08-31"}
    )
    assert agosto.json()["total"] == 2

    so_aluguel = await client.get(
        "/despesas", headers=auth_admin, params={"categoria_id": categorias["Aluguel"]}
    )
    assert so_aluguel.json()["total"] == 2


# ------------------------------------------------------------------ recorrentes
async def _lancar_fixas(client: AsyncClient, headers: dict, categorias: dict) -> None:
    await client.post(
        "/despesas",
        headers=headers,
        json={
            "categoria_id": categorias["Aluguel"],
            "descricao": "Aluguel da loja",
            "valor": "2500.00",
            "data": "2026-07-31",
            "recorrente": True,
        },
    )
    await client.post(
        "/despesas",
        headers=headers,
        json={
            "categoria_id": categorias["Energia"],
            "descricao": "Conta de luz",
            "valor": "480.00",
            "data": "2026-07-10",
            "recorrente": True,
        },
    )
    # Não recorrente: compra de mercadoria não se repete sozinha.
    await client.post(
        "/despesas",
        headers=headers,
        json={
            "categoria_id": categorias["Fornecedores"],
            "descricao": "Compra de malha",
            "valor": "3200.00",
            "data": "2026-07-15",
        },
    )


async def test_replicacao_traz_so_as_recorrentes(
    client: AsyncClient, auth_admin: dict[str, str], categorias: dict
) -> None:
    await _lancar_fixas(client, auth_admin, categorias)
    resp = await client.post(
        "/despesas/replicar-recorrentes", headers=auth_admin, params={"competencia": "2026-08"}
    )
    assert resp.status_code == 200, resp.text
    corpo = resp.json()
    assert corpo["criadas"] == 2
    assert corpo["valor_total"] == "2980.00"
    descricoes = {d["descricao"] for d in corpo["despesas"]}
    assert descricoes == {"Aluguel da loja", "Conta de luz"}
    assert all(d["competencia"] == "2026-08" for d in corpo["despesas"])


async def test_replicar_duas_vezes_nao_duplica(
    client: AsyncClient, auth_admin: dict[str, str], categorias: dict
) -> None:
    await _lancar_fixas(client, auth_admin, categorias)
    primeira = await client.post(
        "/despesas/replicar-recorrentes", headers=auth_admin, params={"competencia": "2026-08"}
    )
    segunda = await client.post(
        "/despesas/replicar-recorrentes", headers=auth_admin, params={"competencia": "2026-08"}
    )
    assert primeira.json()["criadas"] == 2
    assert segunda.json()["criadas"] == 0
    assert segunda.json()["ja_existentes"] == 2

    agosto = await client.get(
        "/despesas", headers=auth_admin, params={"inicio": "2026-08-01", "fim": "2026-08-31"}
    )
    assert agosto.json()["total"] == 2


async def test_replicacao_ajusta_dia_31_para_mes_curto(
    client: AsyncClient, auth_admin: dict[str, str], categorias: dict
) -> None:
    """Aluguel que vence dia 31 em janeiro precisa cair no dia 28 em fevereiro."""
    await client.post(
        "/despesas",
        headers=auth_admin,
        json={
            "categoria_id": categorias["Aluguel"],
            "descricao": "Aluguel",
            "valor": "2500.00",
            "data": "2026-01-31",
            "recorrente": True,
        },
    )
    resp = await client.post(
        "/despesas/replicar-recorrentes", headers=auth_admin, params={"competencia": "2026-02"}
    )
    assert resp.json()["despesas"][0]["data"] == "2026-02-28"


async def test_replicacao_usa_o_valor_mais_recente(
    client: AsyncClient, auth_admin: dict[str, str], categorias: dict
) -> None:
    """Reajustou o aluguel em julho? Agosto sai com o valor novo."""
    for data, valor in (("2026-06-05", "2500.00"), ("2026-07-05", "2700.00")):
        await client.post(
            "/despesas",
            headers=auth_admin,
            json={
                "categoria_id": categorias["Aluguel"],
                "descricao": "Aluguel da loja",
                "valor": valor,
                "data": data,
                "recorrente": True,
            },
        )
    resp = await client.post(
        "/despesas/replicar-recorrentes", headers=auth_admin, params={"competencia": "2026-08"}
    )
    assert resp.json()["criadas"] == 1
    assert resp.json()["despesas"][0]["valor"] == "2700.00"


async def test_replicacao_em_cadeia_nao_duplica_no_mes_seguinte(
    client: AsyncClient, auth_admin: dict[str, str], categorias: dict
) -> None:
    """A réplica de agosto vira modelo de setembro sem virar uma segunda origem."""
    await client.post(
        "/despesas",
        headers=auth_admin,
        json={
            "categoria_id": categorias["Aluguel"],
            "descricao": "Aluguel da loja",
            "valor": "2500.00",
            "data": "2026-07-05",
            "recorrente": True,
        },
    )
    await client.post(
        "/despesas/replicar-recorrentes", headers=auth_admin, params={"competencia": "2026-08"}
    )
    setembro = await client.post(
        "/despesas/replicar-recorrentes", headers=auth_admin, params={"competencia": "2026-09"}
    )
    assert setembro.json()["criadas"] == 1

    de_novo = await client.post(
        "/despesas/replicar-recorrentes", headers=auth_admin, params={"competencia": "2026-09"}
    )
    assert de_novo.json()["criadas"] == 0

    todas = await client.get(
        "/despesas", headers=auth_admin, params={"inicio": "2026-09-01", "fim": "2026-09-30"}
    )
    assert todas.json()["total"] == 1


async def test_competencia_em_formato_invalido_e_recusada(
    client: AsyncClient, auth_admin: dict[str, str]
) -> None:
    resp = await client.post(
        "/despesas/replicar-recorrentes", headers=auth_admin, params={"competencia": "08/2026"}
    )
    assert resp.status_code == 422
    assert resp.json()["code"] == "VALIDACAO"


async def test_replicar_nao_duplica_conta_ja_lancada_a_mao(
    client: AsyncClient, auth_admin: dict[str, str], categorias: dict
) -> None:
    """O aluguel de agosto digitado à mão não pode virar dois ao clicar em "lançar fixas"."""
    await client.post(
        "/despesas",
        headers=auth_admin,
        json={
            "categoria_id": categorias["Aluguel"],
            "descricao": "Aluguel da loja",
            "valor": "2500.00",
            "data": "2026-07-05",
            "recorrente": True,
        },
    )
    # A dona lançou o de agosto na mão, sem passar pela replicação.
    await client.post(
        "/despesas",
        headers=auth_admin,
        json={
            "categoria_id": categorias["Aluguel"],
            "descricao": "Aluguel da loja",
            "valor": "2500.00",
            "data": "2026-08-05",
            "recorrente": True,
        },
    )

    resp = await client.post(
        "/despesas/replicar-recorrentes", headers=auth_admin, params={"competencia": "2026-08"}
    )
    assert resp.json()["criadas"] == 0
    assert resp.json()["ja_existentes"] == 1

    agosto = await client.get(
        "/despesas", headers=auth_admin, params={"inicio": "2026-08-01", "fim": "2026-08-31"}
    )
    assert agosto.json()["total"] == 1, "o aluguel de agosto não pode aparecer duas vezes"


# ------------------------------------------------------------ a cadeia da conta fixa
async def _recorrente(
    client: AsyncClient, headers: dict, categoria: int, descricao: str, valor: str, data: str
) -> dict:
    resp = await client.post(
        "/despesas",
        headers=headers,
        json={
            "categoria_id": categoria,
            "descricao": descricao,
            "valor": valor,
            "data": data,
            "recorrente": True,
        },
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


async def _replicar(client: AsyncClient, headers: dict, competencia: str) -> dict:
    resp = await client.post(
        "/despesas/replicar-recorrentes", headers=headers, params={"competencia": competencia}
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


async def _do_mes(client: AsyncClient, headers: dict, inicio: str, fim: str) -> list[dict]:
    resp = await client.get(
        "/despesas", headers=headers, params={"inicio": inicio, "fim": fim, "size": 100}
    )
    return resp.json()["items"]


async def test_renomear_a_replica_nao_derruba_as_fixas_do_mes_seguinte(
    client: AsyncClient, auth_admin: dict[str, str], categorias: dict
) -> None:
    """A réplica renomeada e a raiz eram dois modelos com a MESMA origem.

    O segundo INSERT batia na UNIQUE, o lote inteiro voltava e a resposta dizia "já
    estava tudo lançado" — março ficava sem aluguel e sem luz.
    """
    await _recorrente(client, auth_admin, categorias["Aluguel"], "Aluguel", "2500.00", "2026-01-05")
    await _recorrente(
        client, auth_admin, categorias["Energia"], "Conta de luz", "300.00", "2026-01-10"
    )
    fevereiro = await _replicar(client, auth_admin, "2026-02")
    aluguel = next(
        d for d in fevereiro["despesas"] if d["categoria_id"] == categorias["Aluguel"]
    )
    resp = await client.patch(
        f"/despesas/{aluguel['id']}", headers=auth_admin, json={"descricao": "Aluguel da loja"}
    )
    assert resp.status_code == 200, resp.text

    marco = await _replicar(client, auth_admin, "2026-03")
    assert (marco["criadas"], marco["ja_existentes"]) == (2, 0)
    lancadas = await _do_mes(client, auth_admin, "2026-03-01", "2026-03-31")
    assert sorted(d["descricao"] for d in lancadas) == ["Aluguel da loja", "Conta de luz"]


async def test_replica_excluida_nao_engole_as_fixas_do_mes(
    client: AsyncClient, auth_admin: dict[str, str], categorias: dict
) -> None:
    """A réplica excluída ocupava a UNIQUE (que não era parcial) e travava o mês inteiro."""
    await _recorrente(client, auth_admin, categorias["Aluguel"], "Aluguel", "2500.00", "2026-01-05")
    fevereiro = await _replicar(client, auth_admin, "2026-02")
    replica = fevereiro["despesas"][0]
    resp = await client.delete(f"/despesas/{replica['id']}", headers=auth_admin)
    assert resp.status_code == 204
    # E a conta de luz que tinha ficado de fora em janeiro.
    await _recorrente(
        client, auth_admin, categorias["Energia"], "Conta de luz", "300.00", "2026-01-10"
    )

    de_novo = await _replicar(client, auth_admin, "2026-02")
    assert (de_novo["criadas"], de_novo["ja_existentes"]) == (2, 0)
    lancadas = await _do_mes(client, auth_admin, "2026-02-01", "2026-02-28")
    assert sorted(d["descricao"] for d in lancadas) == ["Aluguel", "Conta de luz"]


async def test_desmarcar_recorrente_na_replica_para_a_conta_fixa(
    client: AsyncClient, auth_admin: dict[str, str], categorias: dict
) -> None:
    """Mudou de ponto: desmarcar fevereiro basta, sem desmarcar o histórico inteiro."""
    await _recorrente(client, auth_admin, categorias["Aluguel"], "Aluguel", "2500.00", "2026-01-05")
    fevereiro = await _replicar(client, auth_admin, "2026-02")
    replica = fevereiro["despesas"][0]
    resp = await client.patch(
        f"/despesas/{replica['id']}", headers=auth_admin, json={"recorrente": False}
    )
    assert resp.status_code == 200 and resp.json()["recorrente"] is False

    marco = await _replicar(client, auth_admin, "2026-03")
    assert (marco["criadas"], marco["ja_existentes"]) == (0, 0)


async def test_vencimento_dia_31_volta_a_31_depois_de_fevereiro(
    client: AsyncClient, auth_admin: dict[str, str], categorias: dict
) -> None:
    """O dia vem da raiz: copiado da réplica de fevereiro, ficava preso no 28 para sempre."""
    await _recorrente(client, auth_admin, categorias["Aluguel"], "Aluguel", "2500.00", "2026-01-31")
    assert (await _replicar(client, auth_admin, "2026-02"))["despesas"][0]["data"] == "2026-02-28"
    assert (await _replicar(client, auth_admin, "2026-03"))["despesas"][0]["data"] == "2026-03-31"
    assert (await _replicar(client, auth_admin, "2026-04"))["despesas"][0]["data"] == "2026-04-30"
    assert (await _replicar(client, auth_admin, "2026-05"))["despesas"][0]["data"] == "2026-05-31"


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


async def test_colisao_com_replicacao_simultanea_conta_so_ela(
    client: AsyncClient, auth_admin: dict[str, str], categorias: dict
) -> None:
    """Outra replicação gravou o aluguel do mês no meio desta: só o aluguel "já existia".

    A ordem é forçada pela trava, sem relógio: a outra sessão insere o aluguel e segura o
    commit até o Postgres dizer que esta parou esperando por ela. Antes, a colisão
    desfazia o lote inteiro e a luz de agosto sumia com ela.
    """
    import asyncio
    from datetime import date
    from decimal import Decimal

    from app.core.db import SessionLocal
    from app.modules.despesas.models import Expense

    aluguel = await _recorrente(
        client, auth_admin, categorias["Aluguel"], "Aluguel da loja", "2500.00", "2026-07-05"
    )
    await _recorrente(
        client, auth_admin, categorias["Energia"], "Conta de luz", "480.00", "2026-07-10"
    )

    async with SessionLocal() as outra:
        outra.add(
            Expense(
                category_id=categorias["Aluguel"],
                description="Aluguel da loja",
                amount=Decimal("2500.00"),
                expense_date=date(2026, 8, 5),
                is_recurring=True,
                recurring_source_id=aluguel["id"],
            )
        )
        await outra.flush()
        replicacao = asyncio.create_task(_replicar(client, auth_admin, "2026-08"))
        try:
            await asyncio.wait_for(_quando_alguem_parar_numa_trava(), timeout=15)
        finally:
            await outra.commit()
        agosto = await replicacao

    assert (agosto["criadas"], agosto["ja_existentes"]) == (1, 1)
    assert [d["descricao"] for d in agosto["despesas"]] == ["Conta de luz"]
    lancadas = await _do_mes(client, auth_admin, "2026-08-01", "2026-08-31")
    assert sorted(d["descricao"] for d in lancadas) == ["Aluguel da loja", "Conta de luz"]
