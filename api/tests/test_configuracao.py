"""A identidade da loja: quem lê, quem muda, e o que as palavras viram.

O que não pode quebrar: a tela de login precisa do nome SEM sessão; só o dono muda; e
trocar o ramo não pode encostar em nenhum dado.
"""

from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.permissoes import Pode, pode
from app.core.segmentos import Segmento, vocabulario
from app.modules.usuarios.models import Papel

from conftest import criar_produto



async def test_nome_da_loja_e_lido_sem_login(client: AsyncClient) -> None:
    """A tela de login mostra o nome antes de existir sessão — se isto exigisse token,
    a primeira tela do sistema não teria como se desenhar."""
    resp = await client.get("/configuracao")
    assert resp.status_code == 200, resp.text
    corpo = resp.json()
    assert corpo["nome"]
    assert corpo["vocabulario"]["eixo1"]


async def test_dono_muda_o_nome_e_o_ramo(client: AsyncClient, auth_admin: dict) -> None:
    resp = await client.patch(
        "/configuracao",
        json={"nome": "Boutique da Ana", "segmento": "ROUPAS"},
        headers=auth_admin,
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["nome"] == "Boutique da Ana"
    assert resp.json()["vocabulario"]["eixo1"] == "Tamanho"

    # e ficou gravado para a próxima leitura, inclusive sem login
    de_novo = await client.get("/configuracao")
    assert de_novo.json()["nome"] == "Boutique da Ana"


async def test_so_o_dono_muda_a_loja(
    client: AsyncClient,
    auth_gerente: dict,
    auth_supervisora: dict,
    auth_vendedor: dict,
) -> None:
    """Nem o gerente: o nome da loja é a identidade do negócio, sai no recibo do cliente."""
    for headers in (auth_gerente, auth_supervisora, auth_vendedor):
        resp = await client.patch(
            "/configuracao", json={"nome": "Loja do Fulano"}, headers=headers
        )
        assert resp.status_code == 403, resp.text
        assert resp.json()["code"] == "SEM_PERMISSAO"

    # e nada mudou de verdade
    assert (await client.get("/configuracao")).json()["nome"] != "Loja do Fulano"


async def test_configurar_loja_e_capacidade_so_do_dono() -> None:
    assert pode(Papel.ADMIN, Pode.CONFIGURAR_LOJA)
    for papel in (Papel.GERENTE, Papel.SUPERVISORA, Papel.VENDEDOR):
        assert not pode(papel, Pode.CONFIGURAR_LOJA)


async def test_ramo_troca_as_palavras_da_tela(client: AsyncClient, auth_admin: dict) -> None:
    """O mesmo sistema, palavras diferentes: é isto que faz ele servir a uma autopeças."""
    await client.patch("/configuracao", json={"segmento": "AUTOPECAS"}, headers=auth_admin)
    vocab = (await client.get("/configuracao")).json()["vocabulario"]
    assert vocab["eixo1"] == "Aplicação"
    assert vocab["eixo2"] == "Posição"

    await client.patch("/configuracao", json={"segmento": "INFORMATICA"}, headers=auth_admin)
    vocab = (await client.get("/configuracao")).json()["vocabulario"]
    assert vocab["eixo1"] == "Capacidade"
    assert vocab["item"] == "produto"


async def test_trocar_de_ramo_nao_encosta_nos_dados(
    client: AsyncClient, auth_admin: dict, session: AsyncSession
) -> None:
    """Mudar o ramo é trocar rótulo, não migrar banco. Uma peça cadastrada como roupa
    continua exatamente a mesma peça depois que a loja vira autopeças."""
    cat = await client.post("/categorias", json={"nome": "Geral"}, headers=auth_admin)
    produto = await criar_produto(
        client,
        auth_admin,
        {
            "categoria_id": cat.json()["id"],
            "nome": "Item de teste",
            "variantes": [
                {
                    "tamanho": "M",
                    "cor": "Preto",
                    "preco_custo": "10.00",
                    "preco_venda": "25.00",
                    "estoque_inicial": 3,
                }
            ],
        },
    )
    antes = produto["variantes"][0]

    await client.patch("/configuracao", json={"segmento": "AUTOPECAS"}, headers=auth_admin)

    depois = (await client.get(f"/produtos/{produto['id']}", headers=auth_admin)).json()
    assert depois["variantes"][0]["tamanho"] == antes["tamanho"]
    assert depois["variantes"][0]["codigo_barras"] == antes["codigo_barras"]

    saldo = await session.scalar(
        text("SELECT quantity FROM stock_balances WHERE variant_id = :v").bindparams(
            v=antes["id"]
        )
    )
    assert saldo == 3


async def test_nome_vazio_e_recusado(client: AsyncClient, auth_admin: dict) -> None:
    resp = await client.patch("/configuracao", json={"nome": "   "}, headers=auth_admin)
    assert resp.status_code == 422


async def test_segmento_invalido_e_recusado(client: AsyncClient, auth_admin: dict) -> None:
    resp = await client.patch(
        "/configuracao", json={"segmento": "PADARIA_ESPACIAL"}, headers=auth_admin
    )
    assert resp.status_code == 422


async def test_segmento_desconhecido_no_banco_cai_no_neutro() -> None:
    """Linha estranha no banco (edição na mão, restauração antiga) não pode derrubar a
    tela de login — o vocabulário neutro atende."""
    v = vocabulario("RAMO_QUE_NAO_EXISTE")
    assert v == vocabulario(Segmento.OUTRO)


async def test_lista_de_ramos_serve_a_tela(client: AsyncClient) -> None:
    resp = await client.get("/configuracao/segmentos")
    assert resp.status_code == 200
    ramos = resp.json()
    assert {r["valor"] for r in ramos} == {s.value for s in Segmento}
    roupas = next(r for r in ramos if r["valor"] == "ROUPAS")
    assert roupas["eixo1"] == "Tamanho"


async def test_contato_apagado_vira_nulo_e_nao_string_vazia(
    client: AsyncClient, auth_admin: dict
) -> None:
    """Recibo com linha em branco no lugar do telefone é pior que recibo sem telefone."""
    await client.patch(
        "/configuracao", json={"telefone": "(11) 90000-0000"}, headers=auth_admin
    )
    resp = await client.patch("/configuracao", json={"telefone": ""}, headers=auth_admin)
    assert resp.json()["telefone"] is None


async def test_mudanca_da_loja_entra_no_diario(client: AsyncClient, auth_admin: dict) -> None:
    await client.patch("/configuracao", json={"nome": "Nome Novo"}, headers=auth_admin)
    diario = await client.get("/auditoria", headers=auth_admin)
    acoes = [linha["acao"] for linha in diario.json()["items"]]
    assert "LOJA_CONFIGURADA" in acoes
