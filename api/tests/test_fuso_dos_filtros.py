"""O dia da loja não é o dia do servidor.

Nasceu de um chamado real: às 22h43 de 23/08 em São Paulo, o dono filtrou a tela de Vendas
em "De 16/08 Até 23/08" e viu ZERO vendas. Duas causas somadas — `fim=2026-08-23` virava
meia-noite do COMEÇO do dia 23 (o dia inteiro ficava de fora) e o valor ia sem fuso, lido
como UTC (mais 3 horas de erro).

Estes testes fixam o contrato: `inicio`/`fim` são DIAS no fuso da loja, e o intervalo é
`[inicio, fim+1dia)`.
"""

from datetime import date, datetime, time, timedelta

from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.datas import fim_exclusivo_do_dia, hoje_na_loja, inicio_do_dia

from conftest import criar_produto



# ─────────────────────────────────────────────────────── os helpers, sem banco
def test_inicio_e_meia_noite_no_fuso_da_loja() -> None:
    i = inicio_do_dia(date(2026, 8, 23))
    assert i.tzinfo is not None, "ingênuo seria lido como UTC pelo driver"
    assert (i.hour, i.minute) == (0, 0)
    assert i.utcoffset() == timedelta(hours=-3)


def test_fim_e_o_dia_seguinte_e_nao_o_comeco_do_dia_pedido() -> None:
    """O bug em uma linha: `fim=23/08` NÃO pode virar 23/08 00:00."""
    f = fim_exclusivo_do_dia(date(2026, 8, 23))
    assert f.date() == date(2026, 8, 24)
    assert (f.hour, f.minute) == (0, 0)


def test_a_venda_das_22h43_cai_dentro_da_janela_do_proprio_dia() -> None:
    """O caso exato do chamado, em aritmética pura."""
    venda = datetime.combine(date(2026, 8, 23), time(22, 43), tzinfo=settings.tz_loja)
    assert inicio_do_dia(date(2026, 8, 23)) <= venda < fim_exclusivo_do_dia(date(2026, 8, 23))
    # e o filtro de uma semana também a pega
    assert inicio_do_dia(date(2026, 8, 16)) <= venda < fim_exclusivo_do_dia(date(2026, 8, 23))


def test_a_virada_do_dia_nao_escorrega() -> None:
    fim23 = fim_exclusivo_do_dia(date(2026, 8, 23))
    quase = datetime.combine(date(2026, 8, 23), time(23, 59, 59), tzinfo=settings.tz_loja)
    depois = datetime.combine(date(2026, 8, 24), time(0, 0, 1), tzinfo=settings.tz_loja)
    assert quase < fim23, "23h59 do dia 23 é do dia 23"
    assert depois >= fim23, "00h01 do dia 24 não é do dia 23"


def test_nulo_continua_nulo() -> None:
    assert inicio_do_dia(None) is None and fim_exclusivo_do_dia(None) is None


def test_hoje_da_loja_nao_e_o_utc_do_servidor() -> None:
    hoje = hoje_na_loja()
    assert isinstance(hoje, date)
    assert abs((hoje - datetime.utcnow().date()).days) <= 1


# ─────────────────────────────────────────────── contra o banco, ponta a ponta
async def _venda_as(client: AsyncClient, auth: dict, session: AsyncSession, quando: datetime):
    """Registra uma venda e reescreve `sold_at` para o instante pedido."""
    import uuid

    cat = (await client.post("/categorias", headers=auth, json={"nome": f"C{uuid.uuid4().hex[:6]}"})).json()
    prod = await criar_produto(client, auth, {
                "categoria_id": cat["id"],
                "nome": f"P{uuid.uuid4().hex[:6]}",
                "variantes": [
                    {"tamanho": "U", "cor": "Unica", "preco_custo": "10.00",
                     "preco_venda": "50.00", "estoque_inicial": 5}
                ],
            })
    venda = (
        await client.post(
            "/vendas",
            headers=auth,
            json={
                "client_uuid": str(uuid.uuid4()),
                "itens": [{"variante_id": prod["variantes"][0]["id"], "quantidade": 1}],
                "pagamentos": [{"forma": "PIX", "valor": "50.00"}],
            },
        )
    ).json()
    await session.execute(
        text("UPDATE sales SET sold_at = :q WHERE id = :i").bindparams(q=quando, i=venda["id"])
    )
    await session.commit()
    return venda["id"]


async def test_venda_das_22h43_aparece_no_filtro_do_proprio_dia(
    client: AsyncClient, auth_admin: dict, session: AsyncSession
) -> None:
    """O chamado, ponta a ponta: era isto que devolvia lista vazia."""
    dia = hoje_na_loja()
    id_venda = await _venda_as(
        client, auth_admin, session,
        datetime.combine(dia, time(22, 43), tzinfo=settings.tz_loja),
    )

    resp = await client.get(f"/vendas?inicio={dia}&fim={dia}", headers=auth_admin)
    assert resp.status_code == 200, resp.text
    assert id_venda in [v["id"] for v in resp.json()["items"]], (
        "a venda das 22h43 sumiu do filtro do próprio dia — o bug voltou"
    )


async def test_periodo_de_varios_dias_pega_a_ultima_noite(
    client: AsyncClient, auth_admin: dict, session: AsyncSession
) -> None:
    dia = hoje_na_loja()
    id_venda = await _venda_as(
        client, auth_admin, session,
        datetime.combine(dia, time(23, 30), tzinfo=settings.tz_loja),
    )
    resp = await client.get(
        f"/vendas?inicio={dia - timedelta(days=7)}&fim={dia}", headers=auth_admin
    )
    assert id_venda in [v["id"] for v in resp.json()["items"]]


async def test_venda_do_dia_seguinte_fica_de_fora(
    client: AsyncClient, auth_admin: dict, session: AsyncSession
) -> None:
    """A outra ponta: alargar demais também é erro."""
    dia = hoje_na_loja()
    id_venda = await _venda_as(
        client, auth_admin, session,
        datetime.combine(dia + timedelta(days=1), time(0, 1), tzinfo=settings.tz_loja),
    )
    resp = await client.get(f"/vendas?inicio={dia}&fim={dia}", headers=auth_admin)
    assert id_venda not in [v["id"] for v in resp.json()["items"]]


async def test_extrato_de_estoque_tem_o_mesmo_contrato(
    client: AsyncClient, auth_admin: dict
) -> None:
    """A entrada bipada às 22h precisa aparecer no extrato do dia — é a resposta para
    'por que tenho 3 e não 5?'."""
    dia = hoje_na_loja()
    resp = await client.get(
        f"/estoque/movimentacoes?inicio={dia}&fim={dia}", headers=auth_admin
    )
    assert resp.status_code == 200, resp.text


async def test_data_com_hora_diferente_de_zero_e_recusada(
    client: AsyncClient, auth_admin: dict
) -> None:
    """O parâmetro é DIA. Aceitar hora seria deixar a ambiguidade voltar pela janela."""
    resp = await client.get("/vendas?inicio=2026-08-23T22:43:00", headers=auth_admin)
    assert resp.status_code == 422


async def test_vendas_do_periodo_vem_pela_hora_da_venda_e_nao_pelo_numero(
    client: AsyncClient, auth_admin: dict, session: AsyncSession
) -> None:
    """Mais recente primeiro é pelo INSTANTE da venda; o número só desempata.

    A listagem ordenava por id com o filtro em `sold_at`: para mostrar "março do ano
    passado" o banco descia o índice da chave desde a venda mais nova e descartava 170 mil
    linhas antes de chegar ao período. Ordenar pelo instante desce `ix_sales_sold_at` direto
    do fim do período — e é a ordem do relógio, não a da numeração.
    """
    dia = hoje_na_loja() - timedelta(days=400)
    da_tarde = await _venda_as(
        client, auth_admin, session, datetime.combine(dia, time(15, 0), tzinfo=settings.tz_loja)
    )
    # Registrada DEPOIS (número maior), mas aconteceu de manhã.
    da_manha = await _venda_as(
        client, auth_admin, session, datetime.combine(dia, time(9, 0), tzinfo=settings.tz_loja)
    )
    assert da_manha > da_tarde

    resp = await client.get(f"/vendas?inicio={dia}&fim={dia}", headers=auth_admin)
    assert resp.status_code == 200, resp.text
    assert [v["id"] for v in resp.json()["items"]] == [da_tarde, da_manha]
