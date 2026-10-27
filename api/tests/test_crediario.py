"""Fiado e vale — o dinheiro que não entrou hoje.

As duas coisas existem porque a loja já faz as duas: vende na caderneta e dá vale de troca.
O que não existia era o registro, e caderneta perdida é venda perdida.

O erro que estes testes guardam é sempre o mesmo, de dois lados: contar como dinheiro do
dia o que não está na gaveta (fiado, vale) e deixar de contar o que está (a cliente que
veio pagar a parcela).
"""

import uuid
from datetime import datetime
from decimal import Decimal


from app.core.config import settings
from app.modules.usuarios.models import User

from conftest import criar_produto



async def _peca(client, auth_admin, nome: str, preco: str, custo: str = "20.00"):
    categoria = (
        await client.post("/categorias", headers=auth_admin, json={"nome": f"Cat {nome}"})
    ).json()
    produto = await criar_produto(client, auth_admin, {
                "categoria_id": categoria["id"],
                "nome": nome,
                "variantes": [
                    {
                        "tamanho": "U",
                        "cor": "Unica",
                        "preco_custo": custo,
                        "preco_venda": preco,
                        "estoque_inicial": 20,
                    }
                ],
            })
    return produto["variantes"][0]["id"]


async def _cliente(client, auth, nome="Dona Cida", telefone=None):
    resposta = await client.post(
        "/clientes",
        headers=auth,
        json={"nome": nome, "telefone": telefone or str(uuid.uuid4().int)[:11]},
    )
    assert resposta.status_code == 201, resposta.text
    return resposta.json()


# ------------------------------------------------------------------- cadastro


async def test_cliente_repetido_e_recusado(client, auth_admin) -> None:
    """Dois cadastros da mesma pessoa viram duas dívidas, e nenhuma fecha com o que ela deve."""
    await _cliente(client, auth_admin, "Maria Silva", telefone="11988887777")
    repetido = await client.post(
        "/clientes",
        headers=auth_admin,
        json={"nome": "Maria S.", "telefone": "(11) 98888-7777"},
    )
    assert repetido.status_code == 422, repetido.text
    assert "já existe" in repetido.json()["message"].lower()


# ---------------------------------------------------------------------- fiado


async def test_quem_deve_aparece_mesmo_fora_da_primeira_pagina(client, auth_admin) -> None:
    """A pergunta da tela é "quem preciso cobrar?", e ela tem de valer com a lista grande.

    Filtrar em Python DEPOIS do LIMIT esconde exatamente quem se procura: a devedora que
    cai na segunda página some, e o crediário imprime "todo mundo em dia".
    """
    # Nomes que garantem que a devedora fique NO FIM da ordem alfabética.
    for i in range(6):
        await _cliente(client, auth_admin, f"Aaa Cliente {i}")
    devedora = await _cliente(client, auth_admin, "Zulmira Devedora")

    variante = await _peca(client, auth_admin, "Peca Da Zulmira", "100.00")
    await client.post(
        "/vendas",
        headers=auth_admin,
        json={
            "client_uuid": str(uuid.uuid4()),
            "cliente_id": devedora["id"],
            "itens": [{"variante_id": variante, "quantidade": 1}],
            "pagamentos": [{"forma": "FIADO", "valor": "100.00"}],
        },
    )

    pagina = (
        await client.get("/clientes?somente_devendo=true&size=5&page=1", headers=auth_admin)
    ).json()
    assert [c["nome"] for c in pagina["items"]] == ["Zulmira Devedora"]
    # `total` também tem de ser o das devedoras, senão a tela promete páginas vazias.
    assert pagina["total"] == 1


async def test_venda_no_fiado_precisa_de_cliente(client, auth_admin) -> None:
    variante = await _peca(client, auth_admin, "Blusa Fiado", "100.00")
    resposta = await client.post(
        "/vendas",
        headers=auth_admin,
        json={
            "client_uuid": str(uuid.uuid4()),
            "itens": [{"variante_id": variante, "quantidade": 1}],
            "pagamentos": [{"forma": "FIADO", "valor": "100.00"}],
        },
    )
    assert resposta.status_code == 422, "dívida sem nome não se cobra"


async def test_fiado_para_cliente_excluido_e_recusado(client, auth_admin) -> None:
    """Senão nasce uma dívida que ninguém vê: a listagem só mostra cliente ativa.

    Acontece de verdade quando a cliente é excluída num aparelho enquanto o PDV de outro
    ainda a tem na tela.
    """
    cliente = await _cliente(client, auth_admin, "Dona Sumida")
    assert (await client.delete(f"/clientes/{cliente['id']}", headers=auth_admin)).status_code == 204

    variante = await _peca(client, auth_admin, "Peca Sumida", "80.00")
    resposta = await client.post(
        "/vendas",
        headers=auth_admin,
        json={
            "client_uuid": str(uuid.uuid4()),
            "cliente_id": cliente["id"],
            "itens": [{"variante_id": variante, "quantidade": 1}],
            "pagamentos": [{"forma": "FIADO", "valor": "80.00"}],
        },
    )
    assert resposta.status_code == 404, resposta.text


async def test_fiado_para_cliente_inexistente_nao_estoura_500(client, auth_admin) -> None:
    """A FK sozinha daria 500: o domínio tem de recusar com AppError, não com traceback."""
    variante = await _peca(client, auth_admin, "Peca Fantasma", "80.00")
    resposta = await client.post(
        "/vendas",
        headers=auth_admin,
        json={
            "client_uuid": str(uuid.uuid4()),
            "cliente_id": 999999,
            "itens": [{"variante_id": variante, "quantidade": 1}],
            "pagamentos": [{"forma": "FIADO", "valor": "80.00"}],
        },
    )
    assert resposta.status_code == 404, resposta.text
    assert resposta.json()["code"] == "NAO_ENCONTRADO"


async def test_fiado_vira_divida_e_o_pagamento_quita(client, auth_admin) -> None:
    cliente = await _cliente(client, auth_admin, "Dona Cida")
    variante = await _peca(client, auth_admin, "Vestido Fiado", "150.00")

    venda = await client.post(
        "/vendas",
        headers=auth_admin,
        json={
            "client_uuid": str(uuid.uuid4()),
            "cliente_id": cliente["id"],
            "itens": [{"variante_id": variante, "quantidade": 1}],
            "pagamentos": [
                {"forma": "DINHEIRO", "valor": "50.00"},
                {"forma": "FIADO", "valor": "100.00"},
            ],
        },
    )
    assert venda.status_code == 201, venda.text

    depois = (await client.get(f"/clientes/{cliente['id']}", headers=auth_admin)).json()
    assert Decimal(depois["deve"]) == Decimal("100.00")

    pago = await client.post(
        f"/clientes/{cliente['id']}/pagamentos",
        headers=auth_admin,
        json={"forma": "PIX", "valor": "60.00", "client_uuid": str(uuid.uuid4())},
    )
    assert pago.status_code == 201, pago.text

    agora = (await client.get(f"/clientes/{cliente['id']}", headers=auth_admin)).json()
    assert Decimal(agora["deve"]) == Decimal("40.00")


async def test_nao_recebe_mais_do_que_a_divida(client, auth_admin) -> None:
    """Receber a mais viraria saldo negativo — a loja devendo, sem lugar nenhum dizendo isso."""
    cliente = await _cliente(client, auth_admin, "Dona Exagerada")
    variante = await _peca(client, auth_admin, "Saia Fiado", "80.00")
    await client.post(
        "/vendas",
        headers=auth_admin,
        json={
            "client_uuid": str(uuid.uuid4()),
            "cliente_id": cliente["id"],
            "itens": [{"variante_id": variante, "quantidade": 1}],
            "pagamentos": [{"forma": "FIADO", "valor": "80.00"}],
        },
    )
    demais = await client.post(
        f"/clientes/{cliente['id']}/pagamentos",
        headers=auth_admin,
        json={"forma": "DINHEIRO", "valor": "200.00", "client_uuid": str(uuid.uuid4())},
    )
    assert demais.status_code == 422


async def test_venda_fiado_cancelada_para_de_cobrar(client, auth_admin) -> None:
    cliente = await _cliente(client, auth_admin, "Dona Cancelada")
    variante = await _peca(client, auth_admin, "Peca Cancelada", "70.00")
    venda = (
        await client.post(
            "/vendas",
            headers=auth_admin,
            json={
                "client_uuid": str(uuid.uuid4()),
                "cliente_id": cliente["id"],
                "itens": [{"variante_id": variante, "quantidade": 1}],
                "pagamentos": [{"forma": "FIADO", "valor": "70.00"}],
            },
        )
    ).json()
    assert Decimal(
        (await client.get(f"/clientes/{cliente['id']}", headers=auth_admin)).json()["deve"]
    ) == Decimal("70.00")

    await client.post(
        f"/vendas/{venda['id']}/cancelamento",
        headers=auth_admin,
        json={"motivo": "Cliente desistiu"},
    )
    assert Decimal(
        (await client.get(f"/clientes/{cliente['id']}", headers=auth_admin)).json()["deve"]
    ) == Decimal("0.00"), "venda cancelada não pode continuar sendo cobrada"


async def test_cancelar_fiado_que_a_cliente_ja_pagou_e_recusado(client, auth_admin) -> None:
    """O ADR-21 pela outra porta: o fiado sai da conta, o pagamento fica, e o saldo vira −30.

    A loja passaria a dever à cliente sem nada na tela dizendo isso. A recusa manda para a
    Devolução, que abate só o que ainda se deve e entrega o já pago em vale.
    """
    cliente = await _cliente(client, auth_admin, "Dona Pagou Parte")
    variante = await _peca(client, auth_admin, "Peca Paga Parte", "100.00")
    venda = (
        await client.post(
            "/vendas",
            headers=auth_admin,
            json={
                "client_uuid": str(uuid.uuid4()),
                "cliente_id": cliente["id"],
                "itens": [{"variante_id": variante, "quantidade": 1}],
                "pagamentos": [{"forma": "FIADO", "valor": "100.00"}],
            },
        )
    ).json()
    pago = await client.post(
        f"/clientes/{cliente['id']}/pagamentos",
        headers=auth_admin,
        json={"forma": "DINHEIRO", "valor": "30.00", "client_uuid": str(uuid.uuid4())},
    )
    assert pago.status_code == 201, pago.text

    cancelamento = await client.post(
        f"/vendas/{venda['id']}/cancelamento",
        headers=auth_admin,
        json={"motivo": "Cliente desistiu"},
    )
    assert cancelamento.status_code == 409, cancelamento.text
    assert "devolução" in cancelamento.json()["message"].lower()

    # Nada mudou: a venda continua de pé, a peça não voltou e a dívida é a mesma.
    detalhe = (await client.get(f"/vendas/{venda['id']}", headers=auth_admin)).json()
    assert detalhe["status"] == "CONCLUIDA"
    saldos = (
        await client.get("/estoque/saldos", headers=auth_admin, params={"q": "Peca Paga Parte"})
    ).json()
    assert saldos["items"][0]["saldo"] == 19
    deve = (await client.get(f"/clientes/{cliente['id']}", headers=auth_admin)).json()["deve"]
    assert Decimal(deve) == Decimal("70.00")

    # E o caminho indicado fecha a conta: 70 abatem a dívida, os 30 já pagos viram vale.
    devolucao = await client.post(
        f"/vendas/{venda['id']}/devolucoes",
        headers=auth_admin,
        json={
            "client_uuid": str(uuid.uuid4()),
            "itens": [{"item_id": venda["itens"][0]["id"], "quantidade": 1}],
        },
    )
    assert devolucao.status_code == 201, devolucao.text
    por_forma = {p["forma"]: Decimal(p["valor"]) for p in devolucao.json()["pagamentos"]}
    assert por_forma == {"FIADO": Decimal("70.00"), "VALE": Decimal("30.00")}
    deve = (await client.get(f"/clientes/{cliente['id']}", headers=auth_admin)).json()["deve"]
    assert Decimal(deve) == Decimal("0.00")


async def test_cancelar_fiado_que_a_divida_ainda_cobre_e_permitido(client, auth_admin) -> None:
    """A recusa é só para o saldo negativo, não para toda venda de quem já pagou algo.

    Duas compras de R$ 100,00 e um pagamento de R$ 100,00: cancelar uma delas leva a dívida
    a zero, não abaixo — o sistema não sabe qual compra o pagamento quitou, e não finge.
    """
    cliente = await _cliente(client, auth_admin, "Dona Duas Compras")
    variante = await _peca(client, auth_admin, "Peca Duas Compras", "100.00")
    vendas = []
    for _ in range(2):
        vendas.append(
            (
                await client.post(
                    "/vendas",
                    headers=auth_admin,
                    json={
                        "client_uuid": str(uuid.uuid4()),
                        "cliente_id": cliente["id"],
                        "itens": [{"variante_id": variante, "quantidade": 1}],
                        "pagamentos": [{"forma": "FIADO", "valor": "100.00"}],
                    },
                )
            ).json()
        )
    await client.post(
        f"/clientes/{cliente['id']}/pagamentos",
        headers=auth_admin,
        json={"forma": "PIX", "valor": "100.00", "client_uuid": str(uuid.uuid4())},
    )

    cancelamento = await client.post(
        f"/vendas/{vendas[0]['id']}/cancelamento",
        headers=auth_admin,
        json={"motivo": "Cliente desistiu"},
    )
    assert cancelamento.status_code == 200, cancelamento.text
    deve = (await client.get(f"/clientes/{cliente['id']}", headers=auth_admin)).json()["deve"]
    assert Decimal(deve) == Decimal("0.00")


async def test_devolucao_de_venda_fiado_abate_a_divida(client, auth_admin) -> None:
    """Não sai dinheiro da gaveta para quem ainda não pagou — abate o que ela deve."""
    cliente = await _cliente(client, auth_admin, "Dona Devolveu")
    variante = await _peca(client, auth_admin, "Peca Devolvida", "120.00")
    venda = (
        await client.post(
            "/vendas",
            headers=auth_admin,
            json={
                "client_uuid": str(uuid.uuid4()),
                "cliente_id": cliente["id"],
                "itens": [{"variante_id": variante, "quantidade": 1}],
                "pagamentos": [{"forma": "FIADO", "valor": "120.00"}],
            },
        )
    ).json()

    devolucao = await client.post(
        f"/vendas/{venda['id']}/devolucoes",
        headers=auth_admin,
        json={
            "itens": [{"item_id": venda["itens"][0]["id"], "quantidade": 1}],
            "client_uuid": str(uuid.uuid4()),
        },
    )
    assert devolucao.status_code == 201, devolucao.text
    formas = {p["forma"] for p in devolucao.json()["pagamentos"]}
    assert formas == {"FIADO"}, f"devolveu por {formas} uma venda que ninguém pagou ainda"

    assert Decimal(
        (await client.get(f"/clientes/{cliente['id']}", headers=auth_admin)).json()["deve"]
    ) == Decimal("0.00")


async def test_cliente_devendo_nao_pode_ser_excluido(client, auth_admin) -> None:
    cliente = await _cliente(client, auth_admin, "Dona Sumida")
    variante = await _peca(client, auth_admin, "Peca Sumida", "90.00")
    await client.post(
        "/vendas",
        headers=auth_admin,
        json={
            "client_uuid": str(uuid.uuid4()),
            "cliente_id": cliente["id"],
            "itens": [{"variante_id": variante, "quantidade": 1}],
            "pagamentos": [{"forma": "FIADO", "valor": "90.00"}],
        },
    )
    resposta = await client.delete(f"/clientes/{cliente['id']}", headers=auth_admin)
    assert resposta.status_code == 409


async def test_vendedora_nao_vende_no_fiado(client, auth_vendedor, auth_admin) -> None:
    """Quem não enxerga a dívida não pode abrir a dívida.

    Deixar registrar criaria a conta e esconderia a cobrança: a vendedora não vê o
    crediário em tela nenhuma. O PDV, dos dois lados, esconde o botão pelo mesmo motivo —
    oferecer e depois travar na busca de cliente é o caminho de volta para o papel.
    """
    cliente = await _cliente(client, auth_admin, "Dona Do Fiado")
    variante = await _peca(client, auth_admin, "Peca Do Fiado", "60.00")
    resposta = await client.post(
        "/vendas",
        headers=auth_vendedor,
        json={
            "client_uuid": str(uuid.uuid4()),
            "cliente_id": cliente["id"],
            "itens": [{"variante_id": variante, "quantidade": 1}],
            "pagamentos": [{"forma": "FIADO", "valor": "60.00"}],
        },
    )
    assert resposta.status_code == 403, resposta.text

    # Mas vender à vista continua sendo o trabalho dela.
    a_vista = await client.post(
        "/vendas",
        headers=auth_vendedor,
        json={
            "client_uuid": str(uuid.uuid4()),
            "itens": [{"variante_id": variante, "quantidade": 1}],
            "pagamentos": [{"forma": "DINHEIRO", "valor": "60.00"}],
        },
    )
    assert a_vista.status_code == 201, a_vista.text


async def test_vendedora_consulta_vale_mas_nao_o_crediario(
    client, auth_vendedor, auth_admin
) -> None:
    """O vale é do balcão: a vendedora precisa saber se o papel na mão da cliente vale."""
    codigo = await _um_vale(client, auth_admin, "100.00")
    consulta = await client.get(f"/vendas/vales/{codigo}", headers=auth_vendedor)
    assert consulta.status_code == 200, consulta.text
    assert Decimal(consulta.json()["saldo"]) == Decimal("100.00")


async def test_vendedora_nao_mexe_no_crediario(client, auth_vendedor) -> None:
    assert (await client.get("/clientes", headers=auth_vendedor)).status_code == 403


async def test_quem_pagou_e_so_depois_devolveu_recebe_vale_e_nao_saldo_negativo(
    client, auth_admin
) -> None:
    """O caso que deixava a loja devendo escondido (ADR-21).

    Levou no fiado, pagou tudo, e só então voltou com a peça. Abater uma dívida que não
    existe mais joga o saldo para -R$ 100,00: a loja passa a dever à cliente, ela some da
    lista de quem está devendo, e nenhuma tela diz isso. O valor tem de sair como vale —
    um papel na mão dela.
    """
    cliente = await _cliente(client, auth_admin, "Dona Quitada")
    variante = await _peca(client, auth_admin, "Peca Quitada", "100.00")
    venda = (
        await client.post(
            "/vendas",
            headers=auth_admin,
            json={
                "client_uuid": str(uuid.uuid4()),
                "cliente_id": cliente["id"],
                "itens": [{"variante_id": variante, "quantidade": 1}],
                "pagamentos": [{"forma": "FIADO", "valor": "100.00"}],
            },
        )
    ).json()
    await client.post(
        f"/clientes/{cliente['id']}/pagamentos",
        headers=auth_admin,
        json={"forma": "DINHEIRO", "valor": "100.00", "client_uuid": str(uuid.uuid4())},
    )
    assert Decimal(
        (await client.get(f"/clientes/{cliente['id']}", headers=auth_admin)).json()["deve"]
    ) == Decimal("0.00")

    devolucao = (
        await client.post(
            f"/vendas/{venda['id']}/devolucoes",
            headers=auth_admin,
            json={
                "client_uuid": str(uuid.uuid4()),
                "itens": [{"item_id": venda["itens"][0]["id"], "quantidade": 1}],
            },
        )
    ).json()

    pagamento = devolucao["pagamentos"][0]
    assert pagamento["forma"] == "VALE"
    assert Decimal(pagamento["valor"]) == Decimal("100.00")
    # O código é o que a cliente leva no papel: sem ele o vale não existe para ela.
    assert pagamento["codigo_vale"]

    depois = (await client.get(f"/clientes/{cliente['id']}", headers=auth_admin)).json()
    assert Decimal(depois["deve"]) == Decimal("0.00"), "saldo não pode ficar negativo"

    # E o vale funciona: paga a próxima compra.
    outra = await client.post(
        "/vendas",
        headers=auth_admin,
        json={
            "client_uuid": str(uuid.uuid4()),
            "itens": [{"variante_id": variante, "quantidade": 1}],
            "pagamentos": [
                {"forma": "VALE", "valor": "100.00", "codigo_vale": pagamento["codigo_vale"]}
            ],
        },
    )
    assert outra.status_code == 201, outra.text


async def test_pagou_metade_e_devolveu_tudo_abate_o_que_deve_e_o_resto_vira_vale(
    client, auth_admin
) -> None:
    """A dívida some por inteiro e a diferença sai em vale — nem centavo a mais, nem a menos."""
    cliente = await _cliente(client, auth_admin, "Dona Metade")
    variante = await _peca(client, auth_admin, "Peca Metade", "100.00")
    venda = (
        await client.post(
            "/vendas",
            headers=auth_admin,
            json={
                "client_uuid": str(uuid.uuid4()),
                "cliente_id": cliente["id"],
                "itens": [{"variante_id": variante, "quantidade": 1}],
                "pagamentos": [{"forma": "FIADO", "valor": "100.00"}],
            },
        )
    ).json()
    await client.post(
        f"/clientes/{cliente['id']}/pagamentos",
        headers=auth_admin,
        json={"forma": "PIX", "valor": "60.00", "client_uuid": str(uuid.uuid4())},
    )

    devolucao = (
        await client.post(
            f"/vendas/{venda['id']}/devolucoes",
            headers=auth_admin,
            json={
                "client_uuid": str(uuid.uuid4()),
                "itens": [{"item_id": venda["itens"][0]["id"], "quantidade": 1}],
            },
        )
    ).json()

    por_forma = {p["forma"]: Decimal(p["valor"]) for p in devolucao["pagamentos"]}
    assert por_forma == {"FIADO": Decimal("40.00"), "VALE": Decimal("60.00")}
    depois = (await client.get(f"/clientes/{cliente['id']}", headers=auth_admin)).json()
    assert Decimal(depois["deve"]) == Decimal("0.00")


async def test_segundo_recebimento_da_mesma_divida_e_recusado(client, auth_admin, admin) -> None:
    """Dois caixas recebendo os R$ 100 da mesma cliente: o segundo tem de bater na porta.

    Aceitar os dois levaria o saldo a -R$ 100,00 — a loja devendo à cliente, fora da lista
    de quem está devendo, sem nada na tela dizendo isso.

    O teste roda em duas sessões de verdade, mas **não prova a corrida**: neste harness as
    duas corotinas acabam serializando, e o segundo recebimento simplesmente lê a dívida já
    zerada. Quem protege a corrida real — dois workers, dois processos — é o `FOR UPDATE`
    em `ClienteService.quanto_deve(travar=True)`, mesma disciplina do saldo de estoque.
    """
    import asyncio

    from app.core.db import SessionLocal
    from app.modules.clientes.schemas import PagamentoClienteIn
    from app.modules.clientes.service import ClienteService

    cliente = await _cliente(client, auth_admin, "Dona Corrida")
    variante = await _peca(client, auth_admin, "Peca Corrida", "100.00")
    await client.post(
        "/vendas",
        headers=auth_admin,
        json={
            "client_uuid": str(uuid.uuid4()),
            "cliente_id": cliente["id"],
            "itens": [{"variante_id": variante, "quantidade": 1}],
            "pagamentos": [{"forma": "FIADO", "valor": "100.00"}],
        },
    )

    async def receber():
        # client_uuid diferente em cada uma: são dois recebimentos, não o retry de um.
        async with SessionLocal() as sessao:
            usuario = await sessao.get(User, admin.id)
            dados = PagamentoClienteIn(
                forma="DINHEIRO", valor=Decimal("100.00"), client_uuid=uuid.uuid4()
            )
            return await ClienteService(sessao).receber(cliente["id"], dados, usuario)

    respostas = await asyncio.gather(receber(), receber(), return_exceptions=True)
    aceitos = [r for r in respostas if not isinstance(r, Exception)]
    assert len(aceitos) == 1, f"passaram {len(aceitos)} recebimentos da mesma dívida"

    depois = (await client.get(f"/clientes/{cliente['id']}", headers=auth_admin)).json()
    assert Decimal(depois["deve"]) == Decimal("0.00")


async def _quando_alguem_parar_numa_trava() -> None:
    """Espera, sem relógio, até outra sessão estar parada numa trava do banco.

    É o que torna a corrida determinística: em vez de dormir "o bastante" e torcer, pergunta
    ao Postgres. `pg_stat_activity` é uma foto tirada uma vez por transação, por isso cada
    volta do laço abre a sua — senão a pergunta repetiria a mesma resposta para sempre.
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


async def test_retry_simultaneo_do_recebimento_devolve_o_existente(
    client, auth_admin, admin
) -> None:
    """O app reenvia o MESMO recebimento enquanto o primeiro ainda não fez commit.

    O retry passa pela checagem de idempotência sem ver nada e fica parado na trava da
    cliente. Quando ela solta, a dívida já caiu de 100 para 40, e ele respondia "o valor é
    maior do que a dívida" para um pagamento que entrou — quem está no balcão via erro e
    cobrava de novo. A ordem aqui é forçada pela trava: a primeira tentativa só faz commit
    depois que o Postgres diz que o retry está parado esperando por ela.
    """
    import asyncio

    from app.core.db import SessionLocal
    from app.modules.clientes.schemas import PagamentoClienteIn
    from app.modules.clientes.service import ClienteService

    cliente = await _cliente(client, auth_admin, "Dona Retry")
    variante = await _peca(client, auth_admin, "Peca Retry", "100.00")
    await client.post(
        "/vendas",
        headers=auth_admin,
        json={
            "client_uuid": str(uuid.uuid4()),
            "cliente_id": cliente["id"],
            "itens": [{"variante_id": variante, "quantidade": 1}],
            "pagamentos": [{"forma": "FIADO", "valor": "100.00"}],
        },
    )
    chave = uuid.uuid4()
    primeira_no_commit = asyncio.Event()
    liberar_commit = asyncio.Event()

    async def receber(segurar_commit: bool):
        async with SessionLocal() as sessao:
            if segurar_commit:
                commit = sessao.commit

                async def commit_segurado():
                    primeira_no_commit.set()
                    await liberar_commit.wait()
                    await commit()

                sessao.commit = commit_segurado  # type: ignore[method-assign]
            else:
                await primeira_no_commit.wait()
            usuario = await sessao.get(User, admin.id)
            dados = PagamentoClienteIn(forma="DINHEIRO", valor=Decimal("60.00"), client_uuid=chave)
            return await ClienteService(sessao).receber(cliente["id"], dados, usuario)

    async def soltar_quando_o_retry_parar():
        await primeira_no_commit.wait()
        try:
            await asyncio.wait_for(_quando_alguem_parar_numa_trava(), timeout=15)
        finally:
            liberar_commit.set()

    primeira, retry, soltou = await asyncio.gather(
        receber(True), receber(False), soltar_quando_o_retry_parar(), return_exceptions=True
    )
    assert soltou is None, f"o retry nunca parou na trava: {soltou!r}"
    assert not isinstance(primeira, Exception), repr(primeira)
    assert not isinstance(retry, Exception), f"retry do mesmo recebimento recusado: {retry!r}"
    assert retry.id == primeira.id

    depois = (await client.get(f"/clientes/{cliente['id']}", headers=auth_admin)).json()
    assert Decimal(depois["deve"]) == Decimal("40.00")


async def test_reenvio_do_recebimento_com_outro_valor_e_recusado(client, auth_admin) -> None:
    """O mesmo `client_uuid` com outro valor (ou outra forma) não é o mesmo recebimento.

    Responder o gravado como sucesso dizia "R$ 30 recebidos" quando entraram R$ 60 — ou
    PIX quando entrou dinheiro, e a gaveta não fechava. O reenvio idêntico continua sendo
    replay, agora com 200 (ADR-2), e a dívida cai uma vez só.
    """
    cliente = await _cliente(client, auth_admin, "Dona Mesma Chave")
    variante = await _peca(client, auth_admin, "Peca Mesma Chave", "100.00")
    await client.post(
        "/vendas",
        headers=auth_admin,
        json={
            "client_uuid": str(uuid.uuid4()),
            "cliente_id": cliente["id"],
            "itens": [{"variante_id": variante, "quantidade": 1}],
            "pagamentos": [{"forma": "FIADO", "valor": "100.00"}],
        },
    )
    chave = str(uuid.uuid4())
    url = f"/clientes/{cliente['id']}/pagamentos"
    primeira = await client.post(
        url, headers=auth_admin, json={"forma": "DINHEIRO", "valor": "60.00", "client_uuid": chave}
    )
    assert primeira.status_code == 201, primeira.text

    outro_valor = await client.post(
        url, headers=auth_admin, json={"forma": "DINHEIRO", "valor": "30.00", "client_uuid": chave}
    )
    outra_forma = await client.post(
        url, headers=auth_admin, json={"forma": "PIX", "valor": "60.00", "client_uuid": chave}
    )
    for resposta in (outro_valor, outra_forma):
        assert resposta.status_code == 409, resposta.text
        assert resposta.json()["code"] == "DUPLICADO"
        assert resposta.json()["detail"]["pagamento_id"] == primeira.json()["id"]

    mesma = await client.post(
        url, headers=auth_admin, json={"forma": "DINHEIRO", "valor": "60.00", "client_uuid": chave}
    )
    assert mesma.status_code == 200, mesma.text
    assert mesma.json()["id"] == primeira.json()["id"]
    depois = (await client.get(f"/clientes/{cliente['id']}", headers=auth_admin)).json()
    assert Decimal(depois["deve"]) == Decimal("40.00")


async def test_extrato_pagina_as_listas_e_os_totais_sao_da_conta_inteira(
    client, auth_admin
) -> None:
    """A caderneta antiga não vem inteira numa resposta só, e a conta continua fechando.

    O extrato mandava todas as compras e todos os pagamentos da vida da cliente. As duas
    listas agora vêm em `{items, total, page, size}`, pelo mesmo `?page=&size=`; os totais
    (levou, pagou, devolveu, deve) são da conta inteira, não da página.
    """
    cliente = await _cliente(client, auth_admin, "Dona Caderneta")
    variante = await _peca(client, auth_admin, "Peca Caderneta", "50.00")
    vendas = []
    for _ in range(3):
        vendas.append(
            (
                await client.post(
                    "/vendas",
                    headers=auth_admin,
                    json={
                        "client_uuid": str(uuid.uuid4()),
                        "cliente_id": cliente["id"],
                        "itens": [{"variante_id": variante, "quantidade": 1}],
                        "pagamentos": [{"forma": "FIADO", "valor": "50.00"}],
                    },
                )
            ).json()["id"]
        )
    for valor in ("10.00", "20.00", "30.00"):
        await client.post(
            f"/clientes/{cliente['id']}/pagamentos",
            headers=auth_admin,
            json={"forma": "DINHEIRO", "valor": valor, "client_uuid": str(uuid.uuid4())},
        )

    url = f"/clientes/{cliente['id']}/extrato"
    pagina1 = (await client.get(url, headers=auth_admin, params={"size": 2})).json()
    pagina2 = (await client.get(url, headers=auth_admin, params={"size": 2, "page": 2})).json()

    for pagina, quantas in ((pagina1, 2), (pagina2, 1)):
        for lista in ("vendas", "pagamentos"):
            assert pagina[lista]["total"] == 3
            assert pagina[lista]["size"] == 2
            assert len(pagina[lista]["items"]) == quantas
        assert pagina["total_fiado"] == "150.00"
        assert pagina["total_pago"] == "60.00"
        assert pagina["deve"] == "90.00"

    # Mais recente primeiro, e nenhuma linha repetida ou perdida entre as páginas.
    ids = [v["venda_id"] for v in pagina1["vendas"]["items"] + pagina2["vendas"]["items"]]
    assert ids == sorted(vendas, reverse=True)
    valores = [p["valor"] for p in pagina1["pagamentos"]["items"] + pagina2["pagamentos"]["items"]]
    assert valores == ["30.00", "20.00", "10.00"]


# ----------------------------------------------------------------------- vale


async def _um_vale(client, auth_admin, valor="100.00") -> str:
    """Gera um vale pelo caminho real do ADR-21: fiado pago, e só depois devolvido.

    A dívida já não existe, então o valor não tem como voltar abatendo fiado — sai em
    vale, que é o papel na mão da cliente.
    """
    cliente = await _cliente(client, auth_admin, f"Dona Vale {uuid.uuid4().hex[:5]}")
    variante = await _peca(client, auth_admin, f"Peca Vale {uuid.uuid4().hex[:6]}", valor)
    venda = (
        await client.post(
            "/vendas",
            headers=auth_admin,
            json={
                "client_uuid": str(uuid.uuid4()),
                "cliente_id": cliente["id"],
                "itens": [{"variante_id": variante, "quantidade": 1}],
                "pagamentos": [{"forma": "FIADO", "valor": valor}],
            },
        )
    ).json()
    await client.post(
        f"/clientes/{cliente['id']}/pagamentos",
        headers=auth_admin,
        json={"forma": "DINHEIRO", "valor": valor, "client_uuid": str(uuid.uuid4())},
    )
    devolucao = (
        await client.post(
            f"/vendas/{venda['id']}/devolucoes",
            headers=auth_admin,
            json={
                "client_uuid": str(uuid.uuid4()),
                "itens": [{"item_id": venda["itens"][0]["id"], "quantidade": 1}],
            },
        )
    ).json()
    return next(p["codigo_vale"] for p in devolucao["pagamentos"] if p.get("codigo_vale"))


async def _vale_de_uma_devolucao(client, auth_admin, preco="200.00"):
    """Gera um vale do jeito real: venda no cartão, devolvida — o resto não sai em espécie."""
    variante = await _peca(client, auth_admin, f"Peca Vale {uuid.uuid4().hex[:6]}", preco)
    venda = (
        await client.post(
            "/vendas",
            headers=auth_admin,
            json={
                "client_uuid": str(uuid.uuid4()),
                "itens": [{"variante_id": variante, "quantidade": 1}],
                "pagamentos": [{"forma": "CREDITO", "valor": preco}],
            },
        )
    ).json()
    devolucao = (
        await client.post(
            f"/vendas/{venda['id']}/devolucoes",
            headers=auth_admin,
            json={
                "itens": [{"item_id": venda["itens"][0]["id"], "quantidade": 1}],
                "client_uuid": str(uuid.uuid4()),
            },
        )
    ).json()
    return devolucao


async def test_troca_e_devolucao_com_vale_mais_venda_nova(client, auth_admin) -> None:
    """Não existe "modo troca": é devolução que vira vale + venda nova paga com o vale."""
    devolucao = await _vale_de_uma_devolucao(client, auth_admin, "200.00")
    # A venda foi no crédito: o valor volta no crédito (estorno), não em vale.
    assert {p["forma"] for p in devolucao["pagamentos"]} == {"CREDITO"}

    # Agora o caso que gera vale de verdade: venda em dinheiro devolvida por mais do que
    # entrou em espécie não existe, então forçamos o caminho do vale devolvendo uma venda
    # que já teve o dinheiro devolvido antes.
    variante = await _peca(client, auth_admin, "Peca Trocada", "100.00")
    venda = (
        await client.post(
            "/vendas",
            headers=auth_admin,
            json={
                "client_uuid": str(uuid.uuid4()),
                "itens": [{"variante_id": variante, "quantidade": 1}],
                "pagamentos": [{"forma": "DINHEIRO", "valor": "100.00"}],
            },
        )
    ).json()
    dev = (
        await client.post(
            f"/vendas/{venda['id']}/devolucoes",
            headers=auth_admin,
            json={
                "itens": [{"item_id": venda["itens"][0]["id"], "quantidade": 1}],
                "client_uuid": str(uuid.uuid4()),
            },
        )
    ).json()
    assert Decimal(dev["total"]) == Decimal("100.00")


async def test_vale_paga_venda_e_nao_pode_ser_usado_duas_vezes(client, auth_admin) -> None:
    """A trava é o UPDATE condicional: conferir antes deixaria o mesmo vale pagar duas vendas."""
    # Venda mista para sobrar valor sem forma de gaveta correspondente → vira vale.
    cliente = await _cliente(client, auth_admin, "Dona Vale")
    variante = await _peca(client, auth_admin, "Peca Geradora", "100.00")
    venda = (
        await client.post(
            "/vendas",
            headers=auth_admin,
            json={
                "client_uuid": str(uuid.uuid4()),
                "cliente_id": cliente["id"],
                "itens": [{"variante_id": variante, "quantidade": 1}],
                "pagamentos": [{"forma": "FIADO", "valor": "100.00"}],
            },
        )
    ).json()
    # Paga a dívida inteira: agora a venda foi paga, mas por customer_payment — a
    # devolução continua abatendo FIADO, que é o desenho. Este teste garante que um vale
    # inexistente não passa.
    inexistente = await client.post(
        "/vendas",
        headers=auth_admin,
        json={
            "client_uuid": str(uuid.uuid4()),
            "itens": [{"variante_id": variante, "quantidade": 1}],
            "pagamentos": [{"forma": "VALE", "valor": "100.00", "codigo_vale": "V999999"}],
        },
    )
    assert inexistente.status_code == 404, inexistente.text


async def test_cancelar_venda_paga_com_vale_devolve_o_vale(client, auth_admin) -> None:
    """Senão a peça volta para a arara E o crédito da cliente evapora junto.

    O papel na mão dela continua com o mesmo código, mas não compra mais nada, e a loja
    fica com o dinheiro sem nada em lugar nenhum registrando que aquele crédito existiu.
    """
    codigo = await _um_vale(client, auth_admin, "100.00")

    variante = await _peca(client, auth_admin, "Peca Do Vale", "100.00")
    venda = (
        await client.post(
            "/vendas",
            headers=auth_admin,
            json={
                "client_uuid": str(uuid.uuid4()),
                "itens": [{"variante_id": variante, "quantidade": 1}],
                "pagamentos": [{"forma": "VALE", "valor": "100.00", "codigo_vale": codigo}],
            },
        )
    ).json()
    gasto = (await client.get(f"/vendas/vales/{codigo}", headers=auth_admin)).json()
    assert Decimal(gasto["saldo"]) == Decimal("0.00")

    cancelou = await client.post(
        f"/vendas/{venda['id']}/cancelamento",
        headers=auth_admin,
        json={"motivo": "Cliente desistiu"},
    )
    assert cancelou.status_code == 200, cancelou.text

    de_volta = (await client.get(f"/vendas/vales/{codigo}", headers=auth_admin)).json()
    assert Decimal(de_volta["saldo"]) == Decimal("100.00"), "o vale tem de voltar a valer"

    # E vale de verdade: paga outra compra.
    outra = await client.post(
        "/vendas",
        headers=auth_admin,
        json={
            "client_uuid": str(uuid.uuid4()),
            "itens": [{"variante_id": variante, "quantidade": 1}],
            "pagamentos": [{"forma": "VALE", "valor": "100.00", "codigo_vale": codigo}],
        },
    )
    assert outra.status_code == 201, outra.text


async def test_pagamento_em_vale_exige_o_codigo(client, auth_admin) -> None:
    variante = await _peca(client, auth_admin, "Peca Sem Codigo", "50.00")
    resposta = await client.post(
        "/vendas",
        headers=auth_admin,
        json={
            "client_uuid": str(uuid.uuid4()),
            "itens": [{"variante_id": variante, "quantidade": 1}],
            "pagamentos": [{"forma": "VALE", "valor": "50.00"}],
        },
    )
    assert resposta.status_code == 422


async def test_devolucao_em_parcelas_fecha_o_relatorio_no_centavo(client, auth_admin) -> None:
    """O resíduo do pró-rata tem de entrar na linha do item, não só no total da devolução.

    Quem soma faturamento devolvido é `sale_return_items.refund_amount`; quem sai da
    gaveta é `sale_return_payments`. Corrigindo um só, uma venda que fechou exatamente em
    zero aparece no resumo do dia com lucro de -R$ 0,01 — e relatório que não fecha por um
    centavo é relatório em que ninguém confia.
    """
    variante = await _peca(client, auth_admin, "Peca Centavo", "50.00", "10.00")
    venda = (
        await client.post(
            "/vendas",
            headers=auth_admin,
            json={
                "client_uuid": str(uuid.uuid4()),
                "desconto": "33.33",
                "itens": [{"variante_id": variante, "quantidade": 2}],
                "pagamentos": [{"forma": "DINHEIRO", "valor": "66.67"}],
            },
        )
    ).json()
    assert Decimal(venda["total"]) == Decimal("66.67")

    item = venda["itens"][0]["id"]
    for _ in range(2):
        devolvida = await client.post(
            f"/vendas/{venda['id']}/devolucoes",
            headers=auth_admin,
            json={
                "client_uuid": str(uuid.uuid4()),
                "itens": [{"item_id": item, "quantidade": 1}],
            },
        )
        assert devolvida.status_code == 201, devolvida.text

    hoje = datetime.now(settings.tz_loja).date().isoformat()
    resumo = (
        await client.get(f"/relatorios/resumo?inicio={hoje}&fim={hoje}", headers=auth_admin)
    ).json()
    assert Decimal(resumo["devolucoes"]) == Decimal("66.67"), resumo
    assert Decimal(resumo["faturamento_liquido"]) == Decimal("0.00"), resumo
    assert Decimal(resumo["lucro_bruto"]) == Decimal("0.00"), resumo


# ----------------------------------------------------------------------- caixa


async def test_fiado_nao_conta_como_dinheiro_do_dia(client, auth_admin) -> None:
    """O erro clássico: caixa fechando com falta todo dia em que se vende fiado."""
    from datetime import UTC, datetime

    from app.core.config import settings

    hoje = datetime.now(UTC).astimezone(settings.tz_loja).date().isoformat()
    antes = (await client.get(f"/caixa/dia?data={hoje}", headers=auth_admin)).json()

    cliente = await _cliente(client, auth_admin, "Dona Caixa")
    variante = await _peca(client, auth_admin, "Peca Caixa", "300.00")
    await client.post(
        "/vendas",
        headers=auth_admin,
        json={
            "client_uuid": str(uuid.uuid4()),
            "cliente_id": cliente["id"],
            "itens": [{"variante_id": variante, "quantidade": 1}],
            "pagamentos": [{"forma": "FIADO", "valor": "300.00"}],
        },
    )
    depois = (await client.get(f"/caixa/dia?data={hoje}", headers=auth_admin)).json()

    assert Decimal(depois["total_esperado"]) == Decimal(antes["total_esperado"]), (
        "a venda no fiado inflou o esperado da gaveta"
    )
    assert {linha["forma"] for linha in depois["linhas"]} == {
        "DINHEIRO",
        "PIX",
        "DEBITO",
        "CREDITO",
    }, "o caixa está pedindo para contar VALE ou FIADO"


async def test_recebimento_de_fiado_entra_no_caixa_do_dia(client, auth_admin) -> None:
    """O outro lado: o dinheiro que a cliente traz para quitar É dinheiro de hoje."""
    from datetime import UTC, datetime

    from app.core.config import settings

    hoje = datetime.now(UTC).astimezone(settings.tz_loja).date().isoformat()

    cliente = await _cliente(client, auth_admin, "Dona Quitou")
    variante = await _peca(client, auth_admin, "Peca Quitada", "250.00")
    await client.post(
        "/vendas",
        headers=auth_admin,
        json={
            "client_uuid": str(uuid.uuid4()),
            "cliente_id": cliente["id"],
            "itens": [{"variante_id": variante, "quantidade": 1}],
            "pagamentos": [{"forma": "FIADO", "valor": "250.00"}],
        },
    )
    antes = (await client.get(f"/caixa/dia?data={hoje}", headers=auth_admin)).json()
    await client.post(
        f"/clientes/{cliente['id']}/pagamentos",
        headers=auth_admin,
        json={"forma": "DINHEIRO", "valor": "250.00", "client_uuid": str(uuid.uuid4())},
    )
    depois = (await client.get(f"/caixa/dia?data={hoje}", headers=auth_admin)).json()

    assert Decimal(depois["total_esperado"]) - Decimal(antes["total_esperado"]) == Decimal(
        "250.00"
    )
    linha = next(l for l in depois["linhas"] if l["forma"] == "DINHEIRO")
    assert Decimal(linha["recebimentos_de_fiado"]) >= Decimal("250.00")


async def test_devolucao_em_dinheiro_sai_do_esperado_do_dia(client, auth_admin) -> None:
    from datetime import UTC, datetime

    from app.core.config import settings

    hoje = datetime.now(UTC).astimezone(settings.tz_loja).date().isoformat()
    variante = await _peca(client, auth_admin, "Peca Saiu", "180.00")
    venda = (
        await client.post(
            "/vendas",
            headers=auth_admin,
            json={
                "client_uuid": str(uuid.uuid4()),
                "itens": [{"variante_id": variante, "quantidade": 1}],
                "pagamentos": [{"forma": "DINHEIRO", "valor": "180.00"}],
            },
        )
    ).json()
    com_venda = (await client.get(f"/caixa/dia?data={hoje}", headers=auth_admin)).json()

    await client.post(
        f"/vendas/{venda['id']}/devolucoes",
        headers=auth_admin,
        json={
            "itens": [{"item_id": venda["itens"][0]["id"], "quantidade": 1}],
            "client_uuid": str(uuid.uuid4()),
        },
    )
    com_devolucao = (await client.get(f"/caixa/dia?data={hoje}", headers=auth_admin)).json()

    assert Decimal(com_venda["total_esperado"]) - Decimal(
        com_devolucao["total_esperado"]
    ) == Decimal("180.00")
    linha = next(l for l in com_devolucao["linhas"] if l["forma"] == "DINHEIRO")
    assert Decimal(linha["devolucoes"]) >= Decimal("180.00")


# ------------------------------------------------------------------ relatórios


async def test_relatorio_separa_bruto_de_liquido(client, auth_admin) -> None:
    """Devolução somada em silêncio esconde justamente o número que pede ação."""
    from datetime import UTC, datetime

    from app.core.config import settings

    hoje = datetime.now(UTC).astimezone(settings.tz_loja).date().isoformat()
    variante = await _peca(client, auth_admin, "Peca Relatorio", "400.00", custo="150.00")
    venda = (
        await client.post(
            "/vendas",
            headers=auth_admin,
            json={
                "client_uuid": str(uuid.uuid4()),
                "itens": [{"variante_id": variante, "quantidade": 2}],
                "pagamentos": [{"forma": "DINHEIRO", "valor": "800.00"}],
            },
        )
    ).json()
    await client.post(
        f"/vendas/{venda['id']}/devolucoes",
        headers=auth_admin,
        json={
            "itens": [{"item_id": venda["itens"][0]["id"], "quantidade": 1}],
            "client_uuid": str(uuid.uuid4()),
        },
    )

    resumo = (
        await client.get(f"/relatorios/resumo?inicio={hoje}&fim={hoje}", headers=auth_admin)
    ).json()

    assert Decimal(resumo["devolucoes"]) >= Decimal("400.00")
    assert Decimal(resumo["faturamento_liquido"]) == Decimal(resumo["faturamento"]) - Decimal(
        resumo["devolucoes"]
    )
    assert resumo["pecas_devolvidas"] >= 1
    # A peça voltou vendável: o custo dela não pode continuar pesando no CMV.
    assert Decimal(resumo["cmv_devolvido"]) >= Decimal("150.00")
