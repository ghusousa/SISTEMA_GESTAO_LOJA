import asyncio
import time
import uuid
from decimal import Decimal

import pytest
from httpx import AsyncClient
from sqlalchemy import text

from app.core.db import SessionLocal, engine
from app.modules.catalogo.barcode import ean13_valido, montar_codigo_interno
from app.modules.estoque import movimentos
from app.modules.estoque.models import TipoMovimento

from conftest import criar_produto, dar_entrada


@pytest.fixture
async def categoria(client: AsyncClient, auth_admin: dict[str, str]) -> int:
    resp = await client.post("/categorias", headers=auth_admin, json={"nome": "Camisetas"})
    assert resp.status_code == 201
    return resp.json()["id"]


def _produto_payload(categoria_id: int) -> dict:
    return {
        "categoria_id": categoria_id,
        "nome": "Camiseta Básica Gola V",
        "descricao": "Algodão penteado",
        "variantes": [
            {
                "tamanho": "P",
                "cor": "Preta",
                "codigo_barras": "7891234567895",
                "preco_custo": "22.50",
                "preco_venda": "59.90",
                "estoque_minimo": 2,
                "estoque_inicial": 5,
            },
            {
                "tamanho": "M",
                "cor": "Preta",
                "preco_custo": "22.50",
                "preco_venda": "59.90",
                "estoque_inicial": 3,
            },
            {
                "tamanho": "G",
                "cor": "Preta",
                "preco_custo": "22.50",
                "preco_venda": "59.90",
            },
        ],
    }


# ------------------------------------------------------------------ código interno
def test_codigo_interno_gerado_e_um_ean13_valido() -> None:
    codigo = montar_codigo_interno(1)
    assert len(codigo) == 13
    assert codigo.startswith("2")
    assert ean13_valido(codigo)


def test_codigos_internos_de_sequencias_diferentes_nao_colidem() -> None:
    assert montar_codigo_interno(1) != montar_codigo_interno(2)


# ------------------------------------------------------------------ categorias
async def test_categoria_duplicada_e_recusada(
    client: AsyncClient, auth_admin: dict[str, str], categoria: int
) -> None:
    resp = await client.post("/categorias", headers=auth_admin, json={"nome": "camisetas"})
    assert resp.status_code == 409


async def test_vendedor_nao_cria_categoria(
    client: AsyncClient, auth_vendedor: dict[str, str]
) -> None:
    resp = await client.post("/categorias", headers=auth_vendedor, json={"nome": "Calças"})
    assert resp.status_code == 403


async def test_categoria_com_produto_nao_pode_ser_excluida(
    client: AsyncClient, auth_admin: dict[str, str], categoria: int
) -> None:
    await client.post("/produtos", headers=auth_admin, json=_produto_payload(categoria))
    resp = await client.delete(f"/categorias/{categoria}", headers=auth_admin)
    assert resp.status_code == 409
    assert resp.json()["code"] == "OPERACAO_INVALIDA"


# ------------------------------------------------------------------ produtos
async def test_cadastro_gera_codigo_interno_para_peca_sem_etiqueta(
    client: AsyncClient, auth_admin: dict[str, str], categoria: int
) -> None:
    resp = await client.post("/produtos", headers=auth_admin, json=_produto_payload(categoria))
    assert resp.status_code == 201, resp.text
    corpo = resp.json()
    assert len(corpo["variantes"]) == 3

    por_tamanho = {v["tamanho"]: v for v in corpo["variantes"]}
    assert por_tamanho["P"]["codigo_barras"] == "7891234567895"
    assert por_tamanho["P"]["tipo_codigo"] == "EAN"
    assert por_tamanho["M"]["tipo_codigo"] == "INTERNO"
    assert ean13_valido(por_tamanho["M"]["codigo_barras"])
    assert por_tamanho["M"]["codigo_barras"] != por_tamanho["G"]["codigo_barras"]


async def test_estoque_inicial_vira_saldo_e_movimentacao(
    client: AsyncClient, auth_admin: dict[str, str], categoria: int
) -> None:
    corpo = await criar_produto(client, auth_admin, _produto_payload(categoria))
    por_tamanho = {v["tamanho"]: v for v in corpo["variantes"]}
    assert por_tamanho["P"]["saldo"] == 5
    assert por_tamanho["M"]["saldo"] == 3
    assert por_tamanho["G"]["saldo"] == 0
    assert corpo["saldo_total"] == 8


async def test_admin_ve_preco_de_custo_e_vendedor_nao(
    client: AsyncClient,
    auth_admin: dict[str, str],
    auth_vendedor: dict[str, str],
    categoria: int,
) -> None:
    produto_id = (await criar_produto(client, auth_admin, _produto_payload(categoria)))["id"]

    visao_admin = (await client.get(f"/produtos/{produto_id}", headers=auth_admin)).json()
    assert "preco_custo" in visao_admin["variantes"][0]

    visao_vendedor = (
        await client.get(f"/produtos/{produto_id}", headers=auth_vendedor)
    ).json()
    assert "preco_custo" not in visao_vendedor["variantes"][0]
    assert "preco_venda" in visao_vendedor["variantes"][0]


async def test_custo_nao_vaza_em_nenhum_endpoint_de_leitura(
    client: AsyncClient,
    auth_admin: dict[str, str],
    auth_vendedor: dict[str, str],
    categoria: int,
) -> None:
    await client.post("/produtos", headers=auth_admin, json=_produto_payload(categoria))
    for rota in ("/produtos", "/variantes"):
        corpo = (await client.get(rota, headers=auth_vendedor)).text
        assert "preco_custo" not in corpo, f"custo vazou em {rota}"


async def test_grade_com_tamanho_e_cor_repetidos_e_recusada(
    client: AsyncClient, auth_admin: dict[str, str], categoria: int
) -> None:
    payload = _produto_payload(categoria)
    payload["variantes"][1]["tamanho"] = "P"
    payload["variantes"][1]["cor"] = "Preta"
    resp = await client.post("/produtos", headers=auth_admin, json=payload)
    assert resp.status_code == 422


async def test_codigo_de_barras_ja_usado_e_recusado(
    client: AsyncClient, auth_admin: dict[str, str], categoria: int
) -> None:
    await client.post("/produtos", headers=auth_admin, json=_produto_payload(categoria))
    segundo = _produto_payload(categoria)
    segundo["nome"] = "Outra Camiseta"
    resp = await client.post("/produtos", headers=auth_admin, json=segundo)
    assert resp.status_code == 409
    assert resp.json()["code"] == "DUPLICADO"


async def test_preco_de_venda_zero_e_recusado(
    client: AsyncClient, auth_admin: dict[str, str], categoria: int
) -> None:
    payload = _produto_payload(categoria)
    payload["variantes"][0]["preco_venda"] = "0.00"
    resp = await client.post("/produtos", headers=auth_admin, json=payload)
    assert resp.status_code == 422


async def test_vendedor_pode_cadastrar_produto(
    client: AsyncClient, auth_vendedor: dict[str, str], categoria: int
) -> None:
    resp = await client.post("/produtos", headers=auth_vendedor, json=_produto_payload(categoria))
    assert resp.status_code == 201


async def test_produto_com_estoque_nao_pode_ser_excluido(
    client: AsyncClient, auth_admin: dict[str, str], categoria: int
) -> None:
    produto_id = (await criar_produto(client, auth_admin, _produto_payload(categoria)))["id"]
    resp = await client.delete(f"/produtos/{produto_id}", headers=auth_admin)
    assert resp.status_code == 409


# ------------------------------------------------------------------ lookup do PDV
async def test_lookup_por_codigo_devolve_tudo_que_o_pdv_precisa(
    client: AsyncClient, auth_vendedor: dict[str, str], auth_admin: dict[str, str], categoria: int
) -> None:
    await criar_produto(client, auth_admin, _produto_payload(categoria))
    resp = await client.get("/variantes/codigo-barras/7891234567895", headers=auth_vendedor)
    assert resp.status_code == 200
    corpo = resp.json()
    assert corpo["produto"] == "Camiseta Básica Gola V"
    assert corpo["tamanho"] == "P"
    assert corpo["preco_venda"] == "59.90"
    assert corpo["saldo"] == 5
    assert "preco_custo" not in corpo


async def test_lookup_de_codigo_inexistente_retorna_404_com_o_codigo(
    client: AsyncClient, auth_vendedor: dict[str, str]
) -> None:
    resp = await client.get("/variantes/codigo-barras/0000000000000", headers=auth_vendedor)
    assert resp.status_code == 404
    assert resp.json()["detail"]["codigo_barras"] == "0000000000000"


async def test_gerar_codigo_interno_nunca_repete(
    client: AsyncClient, auth_vendedor: dict[str, str]
) -> None:
    codigos = set()
    for _ in range(5):
        resp = await client.post("/variantes/gerar-codigo-interno", headers=auth_vendedor)
        assert resp.status_code == 200
        codigos.add(resp.json()["codigo"])
    assert len(codigos) == 5


async def test_adiciona_peca_a_grade_existente(
    client: AsyncClient, auth_admin: dict[str, str], categoria: int
) -> None:
    produto_id = (await criar_produto(client, auth_admin, _produto_payload(categoria)))["id"]
    resp = await client.post(
        f"/produtos/{produto_id}/variantes",
        headers=auth_admin,
        json={
            "tamanho": "GG",
            "cor": "Preta",
            "preco_custo": "24.00",
            "preco_venda": "64.90",
        },
    )
    assert resp.status_code == 201
    tamanhos = {v["tamanho"] for v in resp.json()["variantes"]}
    assert tamanhos == {"P", "M", "G", "GG"}
    # A peça acrescentada nasce ZERADA (ADR-29): o total é o das outras três.
    assert resp.json()["saldo_total"] == 8

    # E o estoque dela entra pela mesma porta de sempre.
    nova = next(v for v in resp.json()["variantes"] if v["tamanho"] == "GG")
    await dar_entrada(client, auth_admin, **{str(nova["id"]): 2})
    depois = await client.get(f"/produtos/{produto_id}", headers=auth_admin)
    assert depois.json()["saldo_total"] == 10


async def test_busca_produto_por_codigo_de_barras(
    client: AsyncClient, auth_admin: dict[str, str], categoria: int
) -> None:
    await client.post("/produtos", headers=auth_admin, json=_produto_payload(categoria))
    resp = await client.get(
        "/produtos", headers=auth_admin, params={"q": "7891234567895"}
    )
    assert resp.json()["total"] == 1


# ------------------------------------------------- achar a peça sem bipar


async def _peca(client, auth_admin, categoria_id: int, nome: str, cor: str, codigo: str) -> int:
    resposta = await criar_produto(
        client,
        auth_admin,
        {
            "categoria_id": categoria_id,
            "nome": nome,
            "variantes": [
                {
                    "tamanho": "M",
                    "cor": cor,
                    "codigo_barras": codigo,
                    "preco_custo": "20.00",
                    "preco_venda": "59.90",
                    "estoque_inicial": 2,
                }
            ],
        },
    )
    return resposta["variantes"][0]["id"]


async def test_busca_peca_pelo_nome_do_produto(client, auth_admin) -> None:
    """A peça que chega do fornecedor não tem a NOSSA etiqueta colada.

    O código interno nasceu aqui dentro, então na entrada de mercadoria não existe o que
    bipar. Sem achar pelo nome, a reposição não tinha como ser registrada.
    """
    categoria = (
        await client.post("/categorias", headers=auth_admin, json={"nome": "Camisas"})
    ).json()
    await _peca(client, auth_admin, categoria["id"], "Camiseta Lisa", "Preta", "7891000000017")

    achou = await client.get("/variantes", headers=auth_admin, params={"q": "camiseta"})
    assert achou.status_code == 200
    assert [i["produto"] for i in achou.json()["items"]] == ["Camiseta Lisa"]
    assert achou.json()["items"][0]["saldo"] == 2, "a busca precisa dizer quanto tem"


async def test_busca_ignora_acento_e_caixa(client, auth_admin) -> None:
    """Ninguém digita "calça" com cedilha às pressas — e a peça não pode sumir por isso."""
    categoria = (
        await client.post("/categorias", headers=auth_admin, json={"nome": "Baixo"})
    ).json()
    await _peca(client, auth_admin, categoria["id"], "Calça Jeans", "Índigo", "7891000000024")

    for termo in ("calca", "CALÇA", "Calca Jeans", "indigo"):
        achou = await client.get("/variantes", headers=auth_admin, params={"q": termo})
        assert achou.status_code == 200, termo
        assert achou.json()["total"] == 1, f"'{termo}' não achou a peça"


async def test_codigo_exato_vem_primeiro(client, auth_admin) -> None:
    """Quem digitou os treze dígitos quer AQUELA peça no topo, não a primeira do alfabeto."""
    categoria = (
        await client.post("/categorias", headers=auth_admin, json={"nome": "Mistura"})
    ).json()
    await _peca(client, auth_admin, categoria["id"], "Aaa Primeira", "Branca", "7891000000031")
    alvo = await _peca(client, auth_admin, categoria["id"], "Zzz Ultima", "Preta", "7891000000048")

    achou = await client.get("/variantes", headers=auth_admin, params={"q": "7891000000048"})
    assert achou.json()["items"][0]["id"] == alvo


async def test_busca_por_nome_nao_vaza_custo_para_vendedora(client, auth_vendedor) -> None:
    """A busca é caminho novo para os mesmos dados: o filtro por papel vale aqui também."""
    achou = await client.get("/variantes", headers=auth_vendedor, params={"q": "a"})
    assert achou.status_code == 200
    for item in achou.json()["items"]:
        assert "preco_custo" not in item


async def test_busca_de_produtos_ignora_acento(
    client: AsyncClient, auth_admin: dict[str, str], categoria: int
) -> None:
    """`/produtos?q=` achata como `/variantes?q=`: "basica" acha a "Básica"."""
    await client.post("/produtos", headers=auth_admin, json=_produto_payload(categoria))
    for termo in ("basica", "BÁSICA", "camiseta basica"):
        resp = await client.get("/produtos", headers=auth_admin, params={"q": termo})
        assert resp.status_code == 200
        assert resp.json()["total"] == 1, f"'{termo}' não achou o produto"


# ------------------------------------------- peça que volta de produto excluído (ADR-30)


async def _vender_tudo(client, auth, variante_id: int, quantidade: int, preco: str) -> dict:
    total = f"{Decimal(preco) * quantidade:.2f}"
    resp = await client.post("/vendas", headers=auth, json={
        "client_uuid": str(uuid.uuid4()),
        "itens": [{"variante_id": variante_id, "quantidade": quantidade}],
        "pagamentos": [{"forma": "PIX", "valor": total}],
    })
    assert resp.status_code == 201, resp.text
    return resp.json()


async def _extrato(client, auth, variante_id: int) -> list[dict]:
    resp = await client.get(
        "/estoque/movimentacoes", headers=auth, params={"variante_id": variante_id}
    )
    return resp.json()["items"]


async def test_cancelar_venda_de_produto_excluido_traz_a_peca_de_volta(
    client: AsyncClient, auth_admin: dict[str, str], categoria: int
) -> None:
    """A peça esgota, a dona tira do catálogo, a venda é cancelada.

    Antes, as 2 peças voltavam para uma peça excluída: fora da tela de Estoque, o bipe
    dava 404 e nenhuma Entrada, Ajuste ou Inventário a alcançava. Peça devolvida está de
    volta na arara: a peça (e o produto) voltam ao catálogo.
    """
    variante = await _peca(client, auth_admin, categoria, "Calça Linho", "Areia", "7891000000055")
    produto_id = (
        await client.get("/variantes/codigo-barras/7891000000055", headers=auth_admin)
    ).json()["produto_id"]
    venda = await _vender_tudo(client, auth_admin, variante, 2, "59.90")
    assert (await client.delete(f"/produtos/{produto_id}", headers=auth_admin)).status_code == 204

    cancelamento = await client.post(
        f"/vendas/{venda['id']}/cancelamento", headers=auth_admin, json={"motivo": "desistiu"}
    )
    assert cancelamento.status_code == 200, cancelamento.text

    bipe = await client.get("/variantes/codigo-barras/7891000000055", headers=auth_admin)
    assert bipe.status_code == 200, "a peça devolvida não pode sumir do bipe"
    assert bipe.json()["saldo"] == 2
    saldos = await client.get("/estoque/saldos", headers=auth_admin, params={"q": "7891000000055"})
    assert saldos.json()["total"] == 1
    assert (await client.get(f"/produtos/{produto_id}", headers=auth_admin)).status_code == 200
    movimento = (await _extrato(client, auth_admin, variante))[0]
    assert movimento["tipo"] == "ESTORNO"
    assert "excluída do catálogo" in movimento["observacao"]


async def test_devolucao_de_peca_recadastrada_entra_na_peca_ativa_com_a_mesma_etiqueta(
    client: AsyncClient, auth_admin: dict[str, str], categoria: int
) -> None:
    """A dona excluiu o produto e recadastrou a peça com a MESMA etiqueta. A cliente devolve.

    Mesma etiqueta é a mesma peça: ela entra na peça ativa (a que o bipe acha), em vez de
    reativar a antiga — que nem caberia, o código já está em uso. O extrato diz por quê.
    """
    antiga = await _peca(client, auth_admin, categoria, "Vestido Floral", "Azul", "7891000000062")
    produto_antigo = (
        await client.get("/variantes/codigo-barras/7891000000062", headers=auth_admin)
    ).json()["produto_id"]
    venda = await _vender_tudo(client, auth_admin, antiga, 2, "59.90")
    assert (
        await client.delete(f"/produtos/{produto_antigo}", headers=auth_admin)
    ).status_code == 204
    recadastrada = (
        await client.post("/produtos", headers=auth_admin, json={
            "categoria_id": categoria,
            "nome": "Vestido Floral Midi",
            "variantes": [{"tamanho": "M", "cor": "Azul", "codigo_barras": "7891000000062",
                           "preco_custo": "20.00", "preco_venda": "59.90"}],
        })
    ).json()["variantes"][0]["id"]

    devolucao = await client.post(f"/vendas/{venda['id']}/devolucoes", headers=auth_admin, json={
        "client_uuid": str(uuid.uuid4()),
        "motivo": "não serviu",
        "itens": [{"item_id": venda["itens"][0]["id"], "quantidade": 1, "voltar_ao_estoque": True}],
    })
    assert devolucao.status_code == 201, devolucao.text

    bipe = await client.get("/variantes/codigo-barras/7891000000062", headers=auth_admin)
    assert bipe.json()["variante_id"] == recadastrada
    assert bipe.json()["saldo"] == 1
    movimento = (await _extrato(client, auth_admin, recadastrada))[0]
    assert movimento["tipo"] == "DEVOLUCAO"
    assert movimento["quantidade"] == 1
    assert "mesma etiqueta" in movimento["observacao"]
    # A antiga continua fora do catálogo: não há duas peças com a mesma etiqueta.
    assert (
        await client.get(f"/produtos/{produto_antigo}", headers=auth_admin)
    ).status_code == 404


async def test_peca_excluida_e_refeita_na_grade_recebe_a_devolucao_na_nova(
    client: AsyncClient, auth_admin: dict[str, str], categoria: int
) -> None:
    """Excluiu só a peça M e criou outra M/Preta no mesmo produto (código novo).

    O UNIQUE da grade diz que é a mesma peça: reativar a antiga estouraria esse UNIQUE e
    derrubaria o cancelamento. A mercadoria entra na M que está ativa.
    """
    antiga = await _peca(client, auth_admin, categoria, "Saia Plissada", "Preta", "7891000000079")
    produto_id = (
        await client.get("/variantes/codigo-barras/7891000000079", headers=auth_admin)
    ).json()["produto_id"]
    venda = await _vender_tudo(client, auth_admin, antiga, 2, "59.90")
    assert (await client.delete(f"/variantes/{antiga}", headers=auth_admin)).status_code == 204
    grade = await client.post(f"/produtos/{produto_id}/variantes", headers=auth_admin, json={
        "tamanho": "M", "cor": "Preta", "preco_custo": "20.00", "preco_venda": "59.90",
    })
    nova = grade.json()["variantes"][0]["id"]

    cancelamento = await client.post(
        f"/vendas/{venda['id']}/cancelamento", headers=auth_admin, json={"motivo": "desistiu"}
    )
    assert cancelamento.status_code == 200, cancelamento.text
    produto = (await client.get(f"/produtos/{produto_id}", headers=auth_admin)).json()
    assert [(v["id"], v["saldo"]) for v in produto["variantes"]] == [(nova, 2)]


# ------------------------------------------- excluir confere o saldo travado (ADR-30)


async def _esperar_alguem_na_trava(tarefa: asyncio.Task, limite: float = 10.0) -> None:
    """Espera a requisição ficar PARADA numa trava do banco (ou terminar sem parar).

    A ordem é forçada pela trava, não por relógio. Cada volta abre conexão nova porque
    `pg_stat_activity` é uma foto por transação. Se a tarefa terminar antes, é o defeito:
    ela não esperou ninguém.
    """
    prazo = time.monotonic() + limite
    while not tarefa.done():
        async with engine.connect() as observador:
            esperando = await observador.scalar(
                text(
                    "SELECT count(*) FROM pg_stat_activity "
                    "WHERE datname = current_database() AND wait_event_type = 'Lock'"
                )
            )
        if esperando:
            return
        assert time.monotonic() < prazo, "a requisição nunca chegou à trava"
        await asyncio.sleep(0.01)  # intervalo da consulta, não da ordem


async def test_excluir_peca_espera_a_entrada_em_andamento(
    client: AsyncClient, auth_admin: dict[str, str], admin, categoria: int
) -> None:
    """Uma Entrada da peça zerada está gravando; a dona exclui a peça no mesmo instante.

    Antes, a exclusão lia o saldo solto (0), excluía, e as 5 peças da Entrada caíam numa
    peça invisível. Agora ela espera a Entrada confirmar, vê as 5 e recusa.
    """
    produto = (
        await client.post("/produtos", headers=auth_admin, json=_produto_payload(categoria))
    ).json()
    peca_g = next(v["id"] for v in produto["variantes"] if v["tamanho"] == "G")

    async with SessionLocal() as entrada:
        await movimentos.aplicar_movimento(
            entrada, variante_id=peca_g, delta=5, tipo=TipoMovimento.ENTRADA, user_id=admin.id
        )
        excluir = asyncio.create_task(client.delete(f"/variantes/{peca_g}", headers=auth_admin))
        try:
            await _esperar_alguem_na_trava(excluir)
        finally:
            await entrada.commit()
    resp = await excluir

    assert resp.status_code == 409, resp.text
    depois = (await client.get(f"/produtos/{produto['id']}", headers=auth_admin)).json()
    assert {v["id"]: v["saldo"] for v in depois["variantes"]}[peca_g] == 5


async def _entrada(client, auth, variante_id: int, quantidade: int):
    return await client.post("/estoque/entradas", headers=auth, json={
        "client_uuid": str(uuid.uuid4()),
        "itens": [{"variante_id": variante_id, "quantidade": quantidade}],
    })


async def test_entrada_de_peca_excluida_no_meio_da_conferencia_e_recusada(
    client: AsyncClient, auth_admin: dict[str, str], categoria: int
) -> None:
    """A ordem inversa: a exclusão já marcou a peça e ainda não confirmou; chega a Entrada.

    Antes, a Entrada passava (a exclusão ainda não era visível) e somava 5 numa peça que
    saía do catálogo. Agora ela espera a peça, vê que foi excluída e recusa — nada entra.
    """
    produto = (
        await client.post("/produtos", headers=auth_admin, json=_produto_payload(categoria))
    ).json()
    peca_g = next(v["id"] for v in produto["variantes"] if v["tamanho"] == "G")

    async with SessionLocal() as exclusao:
        await exclusao.execute(
            text("UPDATE product_variants SET deleted_at = now() WHERE id = :id"), {"id": peca_g}
        )
        entrada = asyncio.create_task(_entrada(client, auth_admin, peca_g, 5))
        try:
            await _esperar_alguem_na_trava(entrada)
        finally:
            await exclusao.commit()
    resp = await entrada

    assert resp.status_code == 404, resp.text
    async with SessionLocal() as s:
        saldo = await s.scalar(
            text("SELECT quantity FROM stock_balances WHERE variant_id = :id"), {"id": peca_g}
        )
    assert not saldo, "a mercadoria entrou numa peça que saiu do catálogo"
