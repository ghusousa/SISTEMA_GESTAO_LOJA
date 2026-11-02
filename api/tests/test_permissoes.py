"""A matriz de permissões, verificada porta por porta.

Este arquivo é a tradução em teste do que a loja decidiu. Se alguém mexer em
`core/permissoes.py` sem querer, é aqui que estoura — e não no caixa, com a vendedora
lendo a margem da peça.

A leitura é a própria tabela:

                        dono   gerente  supervisora  vendedora
    ver custo/lucro       ✓       ✓          ✗           ✗
    despesas              ✓       ✓          ✗           ✗
    relatórios            ✓       ✓          ✗           ✗
    cancelar venda        ✓       ✓          ✗           ✗
    usuários              ✓       ✓          ✗           ✗
    corrigir estoque      ✓       ✓          ✓           ✗
    editar catálogo       ✓       ✓          ✓           ✗
    fechar caixa          ✓       ✓          ✓           ✗
    vendas de todos       ✓       ✓          ✓           ✗
    vender e bipar        ✓       ✓          ✓           ✓
"""

from decimal import Decimal

import pytest
from httpx import AsyncClient

from app.core.permissoes import PERMISSOES, Pode, pode
from app.modules.usuarios.models import Papel

from conftest import criar_produto



# --------------------------------------------------------------- a tabela, sem HTTP

TODOS = [Papel.ADMIN, Papel.GERENTE, Papel.SUPERVISORA, Papel.VENDEDOR]


@pytest.mark.parametrize(
    ("capacidade", "quem_pode"),
    [
        (Pode.VER_DINHEIRO, {Papel.ADMIN, Papel.GERENTE}),
        (Pode.LANCAR_DESPESA, {Papel.ADMIN, Papel.GERENTE}),
        (Pode.CANCELAR_VENDA, {Papel.ADMIN, Papel.GERENTE}),
        (Pode.GERIR_USUARIOS, {Papel.ADMIN, Papel.GERENTE}),
        # Auditoria é só do dono — nem o gerente lê, porque a auditoria audita o gerente também.
        (Pode.VER_AUDITORIA, {Papel.ADMIN}),
        # Comissão e meta: só o dono. O gerente recebe comissão também (ADR-37).
        (Pode.DEFINIR_COMISSAO, {Papel.ADMIN}),
        (Pode.VER_VENDAS_DE_TODOS, {Papel.ADMIN, Papel.GERENTE, Papel.SUPERVISORA}),
        (Pode.CORRIGIR_ESTOQUE, {Papel.ADMIN, Papel.GERENTE, Papel.SUPERVISORA}),
        (Pode.EDITAR_CATALOGO, {Papel.ADMIN, Papel.GERENTE, Papel.SUPERVISORA}),
        (Pode.FECHAR_CAIXA, {Papel.ADMIN, Papel.GERENTE, Papel.SUPERVISORA}),
    ],
)
def test_tabela_de_permissoes(capacidade: Pode, quem_pode: set[Papel]) -> None:
    for papel in TODOS:
        assert pode(papel, capacidade) is (papel in quem_pode), f"{papel} x {capacidade}"


def test_vendedora_nao_tem_capacidade_nenhuma() -> None:
    """O papel mais baixo vende e consulta; qualquer poder além disso é engano."""
    assert PERMISSOES[Papel.VENDEDOR] == frozenset()


def test_a_hierarquia_nao_tem_buraco() -> None:
    """Cada degrau contém o de baixo. Um gerente que não pode o que a supervisora pode
    seria um bug de tabela, não uma decisão — e ninguém repararia até alguém reclamar."""
    assert PERMISSOES[Papel.VENDEDOR] <= PERMISSOES[Papel.SUPERVISORA]
    assert PERMISSOES[Papel.SUPERVISORA] <= PERMISSOES[Papel.GERENTE]
    assert PERMISSOES[Papel.GERENTE] <= PERMISSOES[Papel.ADMIN]


def test_papel_desconhecido_nao_recebe_nada() -> None:
    """Falha fechada: papel estranho no banco não vira dono por acidente."""
    for capacidade in Pode:
        with pytest.raises(ValueError):
            pode("DIRETOR", capacidade)


# --------------------------------------------------------------- as portas, via HTTP


async def _catalogo(client: AsyncClient, auth: dict[str, str]) -> tuple[int, int]:
    """Uma categoria e um produto com uma variante, para ter no que esbarrar."""
    cat = await client.post("/categorias", headers=auth, json={"nome": "Camisetas"})
    assert cat.status_code == 201, cat.text
    prod = await criar_produto(
        client,
        auth,
        {
            "categoria_id": cat.json()["id"],
            "nome": "Camiseta Básica",
            "variantes": [
                {
                    "tamanho": "M",
                    "cor": "Preta",
                    "preco_custo": "16.00",
                    "preco_venda": "39.90",
                    "estoque_inicial": 10,
                }
            ],
        },
    )
    return prod["id"], prod["variantes"][0]["id"]


@pytest.fixture
async def cada_papel(
    auth_admin: dict[str, str],
    auth_gerente: dict[str, str],
    auth_supervisora: dict[str, str],
    auth_vendedor: dict[str, str],
) -> dict[Papel, dict[str, str]]:
    return {
        Papel.ADMIN: auth_admin,
        Papel.GERENTE: auth_gerente,
        Papel.SUPERVISORA: auth_supervisora,
        Papel.VENDEDOR: auth_vendedor,
    }


async def test_custo_da_peca_so_chega_a_quem_ve_dinheiro(
    client: AsyncClient, cada_papel: dict[Papel, dict[str, str]]
) -> None:
    produto_id, _ = await _catalogo(client, cada_papel[Papel.ADMIN])

    for papel, auth in cada_papel.items():
        detalhe = await client.get(f"/produtos/{produto_id}", headers=auth)
        assert detalhe.status_code == 200
        variante = detalhe.json()["variantes"][0]
        # O preço de venda é de todos: a vendedora precisa dele para vender.
        assert variante["preco_venda"] == "39.90"
        tem_custo = "preco_custo" in variante
        assert tem_custo is pode(papel, Pode.VER_DINHEIRO), f"{papel} viu custo? {tem_custo}"

        saldos = await client.get("/estoque/saldos", headers=auth)
        assert saldos.status_code == 200
        linha = saldos.json()["items"][0]
        assert ("preco_custo" in linha) is pode(papel, Pode.VER_DINHEIRO)


@pytest.mark.parametrize(
    ("metodo", "caminho", "corpo", "capacidade"),
    [
        ("GET", "/despesas", None, Pode.LANCAR_DESPESA),
        ("GET", "/despesas/categorias", None, Pode.LANCAR_DESPESA),
        ("GET", "/relatorios/estoque-baixo", None, Pode.VER_DINHEIRO),
        (
            "GET",
            "/relatorios/resumo?inicio=2026-01-01&fim=2026-12-31",
            None,
            Pode.VER_DINHEIRO,
        ),
        ("GET", "/caixa/dia", None, Pode.FECHAR_CAIXA),
        ("GET", "/usuarios", None, Pode.GERIR_USUARIOS),
        (
            "GET",
            "/relatorios/vendedoras?inicio=2026-01-01&fim=2026-12-31",
            None,
            Pode.VER_DINHEIRO,
        ),
        (
            "GET",
            "/relatorios/curva-abc?inicio=2026-01-01&fim=2026-12-31",
            None,
            Pode.VER_DINHEIRO,
        ),
        ("GET", "/relatorios/estoque-parado", None, Pode.VER_DINHEIRO),
        ("GET", "/relatorios/valor-do-estoque", None, Pode.VER_DINHEIRO),
    ],
)
async def test_portas_de_leitura(
    client: AsyncClient,
    cada_papel: dict[Papel, dict[str, str]],
    metodo: str,
    caminho: str,
    corpo: dict | None,
    capacidade: Pode,
) -> None:
    for papel, auth in cada_papel.items():
        resp = await client.request(metodo, caminho, headers=auth, json=corpo)
        permitido = pode(papel, capacidade)
        if permitido:
            assert resp.status_code == 200, f"{papel} em {caminho}: {resp.text}"
        else:
            assert resp.status_code == 403, f"{papel} em {caminho}: {resp.status_code}"


async def test_corrigir_estoque_para_a_na_vendedora(
    client: AsyncClient, cada_papel: dict[Papel, dict[str, str]]
) -> None:
    _, variante_id = await _catalogo(client, cada_papel[Papel.ADMIN])

    for papel, auth in cada_papel.items():
        ajuste = await client.post(
            "/estoque/ajustes",
            headers=auth,
            json={"variante_id": variante_id, "quantidade": 1, "motivo": "conferência"},
        )
        if pode(papel, Pode.CORRIGIR_ESTOQUE):
            assert ajuste.status_code == 201, f"{papel}: {ajuste.text}"
        else:
            assert ajuste.status_code == 403


async def test_editar_catalogo_para_na_vendedora(
    client: AsyncClient, cada_papel: dict[Papel, dict[str, str]]
) -> None:
    produto_id, _ = await _catalogo(client, cada_papel[Papel.ADMIN])

    for papel, auth in cada_papel.items():
        resp = await client.patch(
            f"/produtos/{produto_id}", headers=auth, json={"nome": f"Editado por {papel}"}
        )
        if pode(papel, Pode.EDITAR_CATALOGO):
            assert resp.status_code == 200, f"{papel}: {resp.text}"
        else:
            assert resp.status_code == 403


async def test_todo_mundo_cadastra_peca_e_da_entrada(
    client: AsyncClient, cada_papel: dict[Papel, dict[str, str]]
) -> None:
    """Cadastrar e dar entrada é trabalho de balcão, não privilégio.

    A peça que chega sem etiqueta precisa entrar no sistema na hora em que chega, por
    quem estiver na loja. Travar isso na chefia deixaria a mercadoria parada.
    """
    categoria = await client.post(
        "/categorias", headers=cada_papel[Papel.ADMIN], json={"nome": "Blusas"}
    )
    categoria_id = categoria.json()["id"]

    for indice, (papel, auth) in enumerate(cada_papel.items()):
        criado = await criar_produto(client, auth, {
                "categoria_id": categoria_id,
                "nome": f"Blusa de {papel}",
                "variantes": [
                    {
                        "tamanho": "M",
                        "cor": "Off White",
                        "preco_custo": "20.00",
                        "preco_venda": "69.90",
                        "estoque_inicial": 3,
                    }
                ],
            })

        entrada = await client.post(
            "/estoque/entradas",
            headers=auth,
            json={
                "client_uuid": f"00000000-0000-4000-8000-00000000000{indice}",
                "fornecedor": "Malharia Nova",
                "itens": [
                    {"variante_id": criado["variantes"][0]["id"], "quantidade": 5}
                ],
            },
        )
        assert entrada.status_code == 201, f"{papel} não deu entrada: {entrada.text}"


async def _vender(client: AsyncClient, auth: dict[str, str], variante_id: int, uuid: str) -> int:
    venda = await client.post(
        "/vendas",
        headers=auth,
        json={
            "client_uuid": uuid,
            "itens": [{"variante_id": variante_id, "quantidade": 1}],
            "desconto": "0.00",
            "pagamentos": [{"forma": "DINHEIRO", "valor": "39.90"}],
        },
    )
    assert venda.status_code == 201, venda.text
    return venda.json()["id"]


async def test_estorno_e_de_dono_e_gerente(
    client: AsyncClient, cada_papel: dict[Papel, dict[str, str]]
) -> None:
    """A vendedora não desfaz nem a própria venda — decisão explícita da loja."""
    _, variante_id = await _catalogo(client, cada_papel[Papel.ADMIN])

    for indice, (papel, auth) in enumerate(cada_papel.items()):
        venda_id = await _vender(
            client, auth, variante_id, f"11111111-0000-4000-8000-00000000000{indice}"
        )
        cancelar = await client.post(
            f"/vendas/{venda_id}/cancelamento",
            headers=auth,
            json={"motivo": "cliente desistiu"},
        )
        if pode(papel, Pode.CANCELAR_VENDA):
            assert cancelar.status_code == 200, f"{papel}: {cancelar.text}"
        else:
            assert cancelar.status_code == 403, f"{papel} cancelou a própria venda!"


async def test_vendedora_so_enxerga_as_proprias_vendas(
    client: AsyncClient, cada_papel: dict[Papel, dict[str, str]]
) -> None:
    _, variante_id = await _catalogo(client, cada_papel[Papel.ADMIN])
    await _vender(
        client, cada_papel[Papel.ADMIN], variante_id, "22222222-0000-4000-8000-000000000001"
    )
    await _vender(
        client, cada_papel[Papel.VENDEDOR], variante_id, "22222222-0000-4000-8000-000000000002"
    )

    for papel, auth in cada_papel.items():
        lista = await client.get("/vendas", headers=auth)
        assert lista.status_code == 200
        total = lista.json()["total"]
        if pode(papel, Pode.VER_VENDAS_DE_TODOS):
            assert total == 2, f"{papel} deveria ver as duas vendas, viu {total}"
        else:
            assert total == 1, f"{papel} deveria ver só a própria, viu {total}"


async def test_lucro_da_venda_so_aparece_para_quem_ve_dinheiro(
    client: AsyncClient, cada_papel: dict[Papel, dict[str, str]]
) -> None:
    _, variante_id = await _catalogo(client, cada_papel[Papel.ADMIN])
    venda_id = await _vender(
        client, cada_papel[Papel.ADMIN], variante_id, "33333333-0000-4000-8000-000000000001"
    )

    for papel, auth in cada_papel.items():
        if not pode(papel, Pode.VER_VENDAS_DE_TODOS):
            continue  # a vendedora nem enxerga esta venda; coberto no teste acima
        detalhe = await client.get(f"/vendas/{venda_id}", headers=auth)
        assert detalhe.status_code == 200
        item = detalhe.json()["itens"][0]
        assert ("custo_unitario" in item) is pode(papel, Pode.VER_DINHEIRO), papel


# ------------------------------------------------------- a trava contra promoção


async def test_gerente_nao_cria_dono(
    client: AsyncClient, auth_gerente: dict[str, str]
) -> None:
    resp = await client.post(
        "/usuarios",
        headers=auth_gerente,
        json={
            "nome": "Dono Falso",
            "email": "falso@loja.com",
            "senha": "senha1234",
            "papel": "ADMIN",
        },
    )
    assert resp.status_code == 403, resp.text


async def test_gerente_nao_se_promove_a_dono(
    client: AsyncClient, auth_gerente: dict[str, str], gerente
) -> None:
    """O buraco óbvio: com GERIR_USUARIOS na mão, um PATCH no próprio id bastaria."""
    resp = await client.patch(
        f"/usuarios/{gerente.id}", headers=auth_gerente, json={"papel": "ADMIN"}
    )
    assert resp.status_code == 403, resp.text


async def test_gerente_nao_mexe_na_conta_do_dono(
    client: AsyncClient, auth_gerente: dict[str, str], admin
) -> None:
    desativar = await client.patch(
        f"/usuarios/{admin.id}", headers=auth_gerente, json={"ativo": False}
    )
    assert desativar.status_code == 403, desativar.text

    # Trocar a senha do dono é entrar como ele: mesma porta, mesma tranca.
    senha = await client.patch(
        f"/usuarios/{admin.id}/senha", headers=auth_gerente, json={"nova_senha": "outrasenha"}
    )
    assert senha.status_code == 403, senha.text


async def test_gerente_cria_e_gerencia_a_equipe(
    client: AsyncClient, auth_gerente: dict[str, str]
) -> None:
    """A permissão precisa servir para o que ela existe: contratar e desligar."""
    criada = await client.post(
        "/usuarios",
        headers=auth_gerente,
        json={
            "nome": "Nova Vendedora",
            "email": "nova@loja.com",
            "senha": "senha1234",
            "papel": "VENDEDOR",
        },
    )
    assert criada.status_code == 201, criada.text

    promovida = await client.patch(
        f"/usuarios/{criada.json()['id']}", headers=auth_gerente, json={"papel": "SUPERVISORA"}
    )
    assert promovida.status_code == 200, promovida.text
    assert promovida.json()["papel"] == "SUPERVISORA"

    desligada = await client.patch(
        f"/usuarios/{criada.json()['id']}", headers=auth_gerente, json={"ativo": False}
    )
    assert desligada.status_code == 200, desligada.text


async def test_dono_promove_a_dono(client: AsyncClient, auth_admin: dict[str, str]) -> None:
    """A trava é para o gerente, não para o dono: ele precisa poder passar o bastão."""
    resp = await client.post(
        "/usuarios",
        headers=auth_admin,
        json={
            "nome": "Sócio",
            "email": "socio@loja.com",
            "senha": "senha1234",
            "papel": "ADMIN",
        },
    )
    assert resp.status_code == 201, resp.text
    assert resp.json()["papel"] == "ADMIN"


async def test_editar_peca_nao_devolve_custo_para_quem_nao_ve_dinheiro(
    client: AsyncClient, auth_supervisora: dict[str, str], auth_admin: dict[str, str]
) -> None:
    """A supervisora edita o catálogo E não vê dinheiro — as duas coisas ao mesmo tempo.

    A rota de edição respondia sempre com o schema de admin, e o custo voltava para ela na
    resposta do próprio PATCH. Era a única porta por onde o número escapava: toda rota de
    leitura já escolhia o schema pela capacidade.
    """
    categoria = (
        await client.post("/categorias", headers=auth_admin, json={"nome": "Cat Custo"})
    ).json()
    produto = await criar_produto(client, auth_admin, {
                "categoria_id": categoria["id"],
                "nome": "Peca Do Custo",
                "variantes": [
                    {
                        "tamanho": "U",
                        "cor": "Unica",
                        "preco_custo": "40.00",
                        "preco_venda": "99.90",
                        "estoque_inicial": 3,
                    }
                ],
            })
    variante_id = produto["variantes"][0]["id"]

    resposta = await client.patch(
        f"/variantes/{variante_id}", headers=auth_supervisora, json={"estoque_minimo": 2}
    )
    assert resposta.status_code == 200, resposta.text
    assert "preco_custo" not in resposta.json(), resposta.text

    # E o custo não pode ser MEXIDO por ela, mesmo mandando o campo.
    await client.patch(
        f"/variantes/{variante_id}", headers=auth_supervisora, json={"preco_custo": "1.00"}
    )
    depois = (
        await client.get(f"/produtos/{produto['id']}", headers=auth_admin)
    ).json()["variantes"][0]
    assert Decimal(depois["preco_custo"]) == Decimal("40.00"), "a supervisora mexeu no custo"


async def test_vendedora_cadastra_peca_mas_nao_grava_custo(
    client: AsyncClient, auth_vendedor: dict[str, str], auth_admin: dict[str, str]
) -> None:
    """Cadastrar é o trabalho dela; o custo é número de dono.

    Ela não recebe o custo em resposta nenhuma, então não teria como conferir o que
    digitou — e o erro só apareceria no lucro do mês. A dona preenche depois, na edição.
    """
    categoria = (
        await client.post("/categorias", headers=auth_admin, json={"nome": "Cat Vendedora"})
    ).json()
    resposta = await criar_produto(client, auth_vendedor, {
            "categoria_id": categoria["id"],
            "nome": "Peca Da Vendedora",
            "variantes": [
                {
                    "tamanho": "M",
                    "cor": "Azul",
                    "preco_custo": "77.77",
                    "preco_venda": "199.90",
                    "estoque_inicial": 2,
                }
            ],
        })
    assert "preco_custo" not in resposta["variantes"][0]

    visto_pela_dona = (
        await client.get(f"/produtos/{resposta['id']}", headers=auth_admin)
    ).json()["variantes"][0]
    assert Decimal(visto_pela_dona["preco_custo"]) == Decimal("0.00"), (
        "o custo digitado pela vendedora foi gravado"
    )
    # Mas a peça entrou no estoque: o cadastro dela vale.
    assert visto_pela_dona["saldo"] == 2


async def test_supervisora_nao_gerencia_usuarios(
    client: AsyncClient, auth_supervisora: dict[str, str]
) -> None:
    resp = await client.post(
        "/usuarios",
        headers=auth_supervisora,
        json={
            "nome": "Alguém",
            "email": "alguem@loja.com",
            "senha": "senha1234",
            "papel": "VENDEDOR",
        },
    )
    assert resp.status_code == 403


async def test_supervisora_fecha_o_caixa_sem_ver_a_margem(
    client: AsyncClient, cada_papel: dict[Papel, dict[str, str]]
) -> None:
    """O par que a loja pediu: ela confere o dinheiro do dia, mas não sabe o lucro dele."""
    _, variante_id = await _catalogo(client, cada_papel[Papel.ADMIN])
    await _vender(
        client, cada_papel[Papel.SUPERVISORA], variante_id, "44444444-0000-4000-8000-000000000001"
    )

    auth = cada_papel[Papel.SUPERVISORA]
    dia = await client.get("/caixa/dia", headers=auth)
    assert dia.status_code == 200
    assert Decimal(dia.json()["total_esperado"]) == Decimal("39.90")

    fechamento = await client.post(
        "/caixa/fechamentos",
        headers=auth,
        json={
            "data": dia.json()["data"],
            "contagens": [{"forma": "DINHEIRO", "valor_contado": "39.90"}],
            "observacao": None,
        },
    )
    assert fechamento.status_code in (200, 201), fechamento.text

    # E o relatório, que traz margem, continua fechado para ela.
    assert (await client.get("/relatorios/estoque-baixo", headers=auth)).status_code == 403
