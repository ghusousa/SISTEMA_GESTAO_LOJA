"""Popula a loja com dados de demonstração.

Serve para conhecer o sistema com a tela cheia — catálogo variado, vendas espalhadas
pelos últimos dias, despesas do mês e uma peça no estoque mínimo para o alerta aparecer.

    .venv/bin/python scripts/seed_demo.py          # com a API no ar

Na Vercel quem chama é o `scripts/vercel_build.py`, pela função `popular()`, com a API dentro
do processo do build (ADR-42). Rodar de novo não duplica: cada gravação usa uma chave fixa, e a
carga que caiu no meio termina de onde parou.

NÃO use em produção: cria usuários com senha conhecida.
"""

import asyncio
import os
import random
import subprocess
import sys
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import httpx

# Rodando como script, o Python coloca scripts/ no path — e não a raiz da API, onde `app` vive.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

BASE = os.environ.get("SEED_API_URL", "http://127.0.0.1:8000").rstrip("/") + "/api/v1"
TZ_LOJA = ZoneInfo(os.environ.get("TIMEZONE_LOJA", "America/Sao_Paulo"))

# O admin é configurável porque numa instalação de verdade a conta do dono já existe com o
# e-mail e a senha que a pessoa escolheu — e o `create-admin` abaixo, encontrando o e-mail
# ocupado, não troca a senha. Sem estas variáveis, o seed logava com a senha de exemplo e
# levava 401 em toda instalação que não fosse a de demonstração.
ADMIN = {
    "nome": os.environ.get("SEED_ADMIN_NOME", "Dona Maria"),
    "email": os.environ.get("SEED_ADMIN_EMAIL", "dona@loja.com"),
    "senha": os.environ.get("SEED_ADMIN_SENHA", "senha12345"),
}
VENDEDORA = {
    "nome": "Ana Vendedora",
    "email": "ana@loja.com",
    "senha": "senha12345",
    "papel": "VENDEDOR",
}

CATALOGO = [
    ("Camisetas", "Camiseta Básica Gola V", "39.90", "16.00", ["P", "M", "G", "GG"], "Preta"),
    ("Camisetas", "Camiseta Estampada Verão", "49.90", "19.00", ["P", "M", "G"], "Branca"),
    ("Calças", "Calça Jeans Skinny", "159.90", "68.00", ["36", "38", "40", "42"], "Azul"),
    ("Calças", "Calça Alfaiataria", "189.90", "82.00", ["38", "40", "42"], "Bege"),
    ("Vestidos", "Vestido Midi Floral", "229.90", "95.00", ["P", "M", "G"], "Estampado"),
    ("Vestidos", "Vestido Longo Festa", "349.90", "140.00", ["M", "G"], "Vinho"),
    ("Blusas", "Blusa Cropped Canelada", "69.90", "27.00", ["P", "M", "G"], "Off White"),
    ("Blusas", "Blusa de Tricô", "129.90", "54.00", ["M", "G", "GG"], "Camel"),
    ("Jaquetas", "Jaqueta Jeans Oversized", "259.90", "110.00", ["P", "M", "G"], "Azul Claro"),
    ("Saias", "Saia Midi Plissada", "139.90", "58.00", ["P", "M", "G"], "Preta"),
]


def ean_de_fornecedor(produto: int, variante: int) -> str:
    """EAN-13 de mentira, porém válido — com o dígito verificador certo.

    Antes eram treze dígitos sorteados. Ninguém percebia, porque a API aceita qualquer
    string como código de barras (loja de verdade também usa CODE-128). Só que um EAN-13
    com verificador errado NÃO IMPRIME: a tela de etiquetas o recusa e leitor nenhum o lê,
    e a demonstração passava a impressão de que a impressão estava quebrada.

    Determinístico de propósito: a folha de etiquetas impressa continua valendo depois de
    recriar a demonstração.
    """
    from app.modules.catalogo.barcode import digito_verificador_ean13

    payload = f"789{produto:04d}{variante:05d}"
    return payload + digito_verificador_ean13(payload)

DESPESAS = [
    ("Aluguel", "Aluguel da loja", "2800.00", 5, True),
    ("Energia", "Conta de luz", "486.30", 12, True),
    ("Internet", "Internet e telefone", "159.90", 10, True),
    ("Salários", "Salário Ana", "1650.00", 5, True),
    ("Fornecedores", "Compra de malha - Malharia Nova", "3240.00", 8, False),
    ("Marketing", "Impulsionamento Instagram", "180.00", 15, False),
]

FORMAS = ["DINHEIRO", "PIX", "DEBITO", "CREDITO"]

#: Fregueses da caderneta. O limite é o combinado com a dona — avisa, não bloqueia (ADR-20).
CLIENTES = [
    ("Marizete Alves", "11987654321", "300.00"),
    ("Cleide Ramos", "11976543210", "500.00"),
    ("Sônia Barbosa", "11965432109", None),
]


#: Raiz das chaves `client_uuid` da carga. A MESMA chave a cada execução: o passo que já foi
#: gravado volta como réplica (200, o registro de antes) em vez de gravar outra vez. É isso que
#: deixa o build da Vercel retomar a carga que caiu no meio sem duplicar nada (ADR-42) — e
#: rodar o seed de novo na loja local também não dobra mais a demonstração.
RAIZ_DAS_CHAVES = uuid.UUID("6f1c7a0e-3d52-4c1e-9a43-5e0d7b2a8c11")

#: Quantas vendas sorteadas a carga tenta (algumas recusam por falta de estoque, de propósito).
VENDAS_SORTEADAS = 115

MOTIVO_DO_AJUSTE = "peças com defeito de fábrica devolvidas ao fornecedor"


def chave(rotulo: str) -> str:
    return str(uuid.uuid5(RAIZ_DAS_CHAVES, rotulo))


class CargaInterrompida(RuntimeError):
    """A API recusou um passo da carga. Diz qual e o porquê — nunca o que foi enviado (pode
    levar senha)."""


def _exigir(resposta: httpx.Response, passo: str, *aceitos: int) -> httpx.Response:
    if resposta.status_code in (aceitos or (200, 201)):
        return resposta
    try:
        corpo = resposta.json()
    except ValueError:
        corpo = None
    motivo = (
        f"{corpo.get('code', '')} {corpo.get('message', '')}".strip()
        if isinstance(corpo, dict)
        else ""
    )
    raise CargaInterrompida(f"{passo}: HTTP {resposta.status_code} {motivo}".strip())


def hoje_loja() -> datetime:
    return datetime.now(UTC).astimezone(TZ_LOJA)


async def _espalhar_vendas_no_mes(vendas: list[tuple[int, int]]) -> None:
    """Redistribui `sold_at` pelos últimos 25 dias, em horário de loja.

    Sábado vende mais, domingo quase nada — sem isso a curva de vendas fica reta e não
    ajuda a enxergar como o relatório se comporta. `vendas` é (número na carga, id): o sorteio
    é POR VENDA, então a mesma venda cai no mesmo horário a cada execução, e a retomada da
    carga não embaralha o que já estava espalhado.
    """
    if not vendas:
        return

    import asyncpg

    from app.core.config import settings

    agora = datetime.now(UTC).astimezone(TZ_LOJA)
    momentos: list[tuple[int, datetime]] = []
    for numero, venda_id in vendas:
        sorteio = random.Random(numero)
        dias_atras = int((numero / max(VENDAS_SORTEADAS - 1, 1)) * 24)
        dia = (agora - timedelta(days=dias_atras)).date()
        peso_do_dia = {5: 1.6, 6: 0.2}.get(dia.weekday(), 1.0)
        if sorteio.random() > peso_do_dia:
            dias_atras = max(dias_atras - 1, 0)
            dia = (agora - timedelta(days=dias_atras)).date()
        hora = sorteio.randint(9, 18)
        momento = datetime(
            dia.year, dia.month, dia.day, hora, sorteio.randint(0, 59), tzinfo=TZ_LOJA
        )
        momentos.append((venda_id, momento))

    from app.core.url_do_banco import argumentos_asyncpg

    url = settings.database_url.replace("postgresql+asyncpg://", "postgresql://")
    # SSL (e o modo PgBouncer) quando o banco é o Neon da Vercel — ver core/url_do_banco.py.
    conexao = await asyncpg.connect(
        url, **argumentos_asyncpg(ssl=settings.db_ssl, pooler=settings.db_pooler)
    )
    try:
        await conexao.executemany(
            "UPDATE sales SET sold_at = $2, created_at = $2 WHERE id = $1", momentos
        )
    finally:
        await conexao.close()


def _entrar(c: httpx.Client, conta: dict) -> httpx.Response:
    return c.post("/auth/login", json={"email": conta["email"], "senha": conta["senha"]})


def _vendedora(c: httpx.Client, admin: dict, conta: dict) -> dict:
    """A vendedora da demonstração, criada se faltar, e o crachá dela."""
    criada = _exigir(
        c.post("/usuarios", headers=admin, json=conta), "criar a vendedora", 201, 409
    )
    if criada.status_code == 201:
        print("vendedora criada")
    entrou = _entrar(c, conta)
    if entrou.status_code == 401 and criada.status_code == 409:
        # Ela já existia, de uma carga que caiu no meio — e lá a senha sorteada foi OUTRA.
        equipe = c.get("/usuarios", headers=admin, params={"size": 100}).json()["items"]
        ana_id = next(u["id"] for u in equipe if u["email"] == conta["email"])
        _exigir(
            c.patch(
                f"/usuarios/{ana_id}/senha", headers=admin, json={"nova_senha": conta["senha"]}
            ),
            "redefinir a senha da vendedora",
            204,
        )
        entrou = _entrar(c, conta)
    _exigir(entrou, "entrar como a vendedora", 200)
    return {"Authorization": f"Bearer {entrou.json()['access_token']}"}


def _id_por_nome(c: httpx.Client, admin: dict, rota: str, nome: str) -> int:
    return next(
        x["id"] for x in c.get(rota, headers=admin, params={"size": 100}).json()["items"]
        if x["nome"] == nome
    )


def _achar_por_nome(c: httpx.Client, admin: dict, rota: str, nome: str) -> dict | None:
    """O registro com exatamente este nome, se a carga já o criou."""
    achados = c.get(rota, headers=admin, params={"q": nome, "size": 100}).json()["items"]
    return next((x for x in achados if x["nome"] == nome), None)


def popular(c: httpx.Client, admin_conta: dict, vendedora_conta: dict) -> int:
    """Enche a loja PELA API, com o cliente HTTP que receber.

    `main()` passa um `httpx.Client` apontado para a API no ar; o build da Vercel
    (`vercel_build.py`) passa um `TestClient` com a API dentro do próprio processo — lá não
    há servidor de pé durante o build. O caminho é o mesmo nos dois: as rotas, as regras e a
    auditoria de sempre, nada escrito por fora (só o `sold_at` espalhado, ver acima).

    **Retomável**: rodar de novo depois de cair no meio termina a carga sem duplicar. Toda
    gravação com `client_uuid` usa a chave fixa do passo (`chave()`), e o resto procura antes
    de criar. O sorteio (`random.seed(42)`) é consumido igual em toda execução, então a
    réplica manda exatamente o pedido de antes. Recusa que impede de seguir vira
    `CargaInterrompida`, com o passo e o motivo.
    """
    random.seed(42)  # dados iguais a cada execução: bom para comparar telas, e para retomar

    entrar = _entrar(c, admin_conta)
    if entrar.status_code == 401:
        print(
            f"Não consegui entrar como {admin_conta['email']}.\n"
            "Se a conta de administrador desta instalação é outra, informe-a:\n"
            "  SEED_ADMIN_EMAIL=voce@sualoja.com SEED_ADMIN_SENHA='sua-senha' "
            "python scripts/seed_demo.py",
            file=sys.stderr,
        )
        return 1
    _exigir(entrar, "entrar como o dono", 200)
    admin = {"Authorization": f"Bearer {entrar.json()['access_token']}"}
    ana = _vendedora(c, admin, vendedora_conta)

    # ---------------------------------------------------------- catálogo
    categorias: dict[str, int] = {}
    variantes: list[dict] = []
    for ordem, (cat, nome, venda, custo, tamanhos, cor) in enumerate(CATALOGO):
        if cat not in categorias:
            resp = c.post("/categorias", headers=admin, json={"nome": cat})
            categorias[cat] = (
                resp.json()["id"]
                if resp.status_code == 201
                else _id_por_nome(c, admin, "/categorias", cat)
            )

        grade = []
        for indice, tamanho in enumerate(tamanhos):
            # Metade das peças com EAN de fornecedor, metade sem etiqueta (código interno).
            tem_etiqueta = indice % 2 == 0
            grade.append(
                {
                    "tamanho": tamanho,
                    "cor": cor,
                    "codigo_barras": (
                        ean_de_fornecedor(ordem, indice) if tem_etiqueta else None
                    ),
                    "preco_custo": custo,
                    "preco_venda": venda,
                    "estoque_minimo": 2,
                }
            )
        produto = _achar_por_nome(c, admin, "/produtos", nome)
        if produto is None:
            produto = _exigir(
                c.post(
                    "/produtos",
                    headers=admin,
                    json={"categoria_id": categorias[cat], "nome": nome, "variantes": grade},
                ),
                f"cadastrar {nome}",
                201,
            ).json()
        pecas = sorted(produto["variantes"], key=lambda v: v["id"])
        # Cadastro nasce com saldo zero (ADR-29): a mercadoria entra pela Entrada.
        _exigir(
            c.post(
                "/estoque/entradas",
                headers=admin,
                json={
                    "client_uuid": chave(f"entrada-{ordem}"),
                    "fornecedor": "Fornecedor demo",
                    "itens": [
                        {"variante_id": v["id"], "quantidade": random.randint(4, 14)}
                        for v in pecas
                    ],
                },
            ),
            f"entrada de {nome}",
        )
        for v in pecas:
            variantes.append({"id": v["id"], "preco": v["preco_venda"], "nome": nome})
    print(f"catálogo: {len(CATALOGO)} produtos, {len(variantes)} peças")

    # ---------------------------------------------------------- vendas
    vendas_da_carga: list[tuple[int, int]] = []
    for numero in range(VENDAS_SORTEADAS):
        variante = random.choice(variantes)
        quantidade = random.choice([1, 1, 1, 2])
        preco = float(variante["preco"])
        subtotal = round(preco * quantidade, 2)
        desconto = 10.00 if random.random() < 0.25 and subtotal > 100 else 0.0
        total = round(subtotal - desconto, 2)

        if random.random() < 0.3:  # pagamento dividido
            metade = round(total / 2, 2)
            pagamentos = [
                {"forma": "DINHEIRO", "valor": f"{metade:.2f}"},
                {"forma": "PIX", "valor": f"{total - metade:.2f}"},
            ]
        else:
            pagamentos = [
                {"forma": random.choice(FORMAS), "valor": f"{total:.2f}"}
            ]

        resp = c.post(
            "/vendas",
            headers=ana if random.random() < 0.6 else admin,
            json={
                "client_uuid": chave(f"venda-{numero}"),
                "desconto": f"{desconto:.2f}",
                "itens": [{"variante_id": variante["id"], "quantidade": quantidade}],
                "pagamentos": pagamentos,
            },
        )
        if resp.status_code in (200, 201):  # 200: já gravada numa execução anterior
            vendas_da_carga.append((numero, resp.json()["id"]))

    # A API sempre carimba a venda com o instante atual — correto em produção, mas aqui
    # deixaria as 70 vendas empilhadas no mesmo minuto e o gráfico do mês seria uma
    # barra só. Espalhar exige tocar no banco, e é por isso que este script é de demo.
    asyncio.run(_espalhar_vendas_no_mes(vendas_da_carga))
    print(f"vendas: {len(vendas_da_carga)} (espalhadas nos últimos 25 dias)")

    # Uma venda cancelada, para o histórico mostrar os dois estados. Sempre a mesma: na
    # retomada, a já cancelada responde que já está, e nenhuma outra cai junto.
    if vendas_da_carga:
        c.post(
            f"/vendas/{vendas_da_carga[0][1]}/cancelamento",
            headers=admin,
            json={"motivo": "cliente trocou por outro tamanho"},
        )

    # ---------------------------------------------------------- despesas
    hoje = hoje_loja().date()
    for categoria, descricao, valor, dia, recorrente in DESPESAS:
        resp = c.post("/despesas/categorias", headers=admin, json={"nome": categoria})
        categoria_id = (
            resp.json()["id"]
            if resp.status_code == 201
            else _id_por_nome(c, admin, "/despesas/categorias", categoria)
        )
        data = hoje.replace(day=min(dia, 28)).isoformat()
        lancadas = c.get(
            "/despesas",
            headers=admin,
            params={"inicio": data, "fim": data, "categoria_id": categoria_id, "size": 100},
        ).json()["items"]
        if any(d["descricao"] == descricao for d in lancadas):
            continue
        c.post(
            "/despesas",
            headers=admin,
            json={
                "categoria_id": categoria_id,
                "descricao": descricao,
                "valor": valor,
                "data": data,
                "recorrente": recorrente,
            },
        )
    print(f"despesas: {len(DESPESAS)}")

    # ------------------------------------------- uma peça pedindo reposição
    # Ajuste não tem chave: procura o dele no extrato antes de baixar outra peça.
    ajustes = c.get(
        "/estoque/movimentacoes", headers=admin, params={"tipo": "AJUSTE", "size": 100}
    ).json()["items"]
    if not any(m.get("observacao") == MOTIVO_DO_AJUSTE for m in ajustes):
        saldos = c.get("/estoque/saldos", headers=admin, params={"size": 100}).json()
        alvo = next(s for s in saldos["items"] if s["saldo"] > 3)
        c.post(
            "/estoque/ajustes",
            headers=admin,
            json={
                "variante_id": alvo["variante_id"],
                "quantidade": -(alvo["saldo"] - 1),
                "motivo": MOTIVO_DO_AJUSTE,
            },
        )

    # ------------------------------------------- entrada de reposição
    reposicao = random.sample(variantes, 3)
    c.post(
        "/estoque/entradas",
        headers=admin,
        json={
            "client_uuid": chave("reposicao"),
            "fornecedor": "Malharia Nova",
            "itens": [{"variante_id": v["id"], "quantidade": 6} for v in reposicao],
        },
    )

    # ------------------------------------------ a compra do recibo
    # As vendas sorteadas acima são de uma peça só, e recibo de uma linha não mostra
    # nada. Esta é a compra que a demonstração usa para o recibo: três peças, desconto
    # no total e pagamento dividido — o que o balcão faz num sábado.
    sacola = random.sample(variantes, 3)
    subtotal = sum(float(v["preco"]) for v in sacola)
    desconto = 20.00
    total = round(subtotal - desconto, 2)
    metade = round(total / 2, 2)
    recibo = c.post(
        "/vendas",
        headers=admin,
        json={
            "client_uuid": chave("recibo"),
            "desconto": f"{desconto:.2f}",
            "itens": [{"variante_id": v["id"], "quantidade": 1} for v in sacola],
            "pagamentos": [
                {"forma": "DINHEIRO", "valor": f"{metade:.2f}"},
                {"forma": "PIX", "valor": f"{total - metade:.2f}"},
            ],
        },
    )
    if recibo.status_code in (200, 201):
        print(f"venda do recibo: #{recibo.json()['id']} — 3 peças, desconto e pagamento dividido")

    # ------------------------------------------------- crediário (fiado)
    clientes = []
    for nome, telefone, limite in CLIENTES:
        existente = _achar_por_nome(c, admin, "/clientes", nome)
        if existente is not None:
            clientes.append(existente)
            continue
        resp = c.post(
            "/clientes",
            headers=admin,
            json={"nome": nome, "telefone": telefone, "limite": limite},
        )
        if resp.status_code == 201:
            clientes.append(resp.json())
    if clientes:
        # Marizete leva no fiado duas vezes e passa do limite combinado: é o caso que
        # faz a etiqueta de aviso aparecer na tela, sem travar venda nenhuma.
        for vez in range(2):
            peca = random.choice(variantes)
            valor = f"{float(peca['preco']):.2f}"
            c.post(
                "/vendas",
                headers=admin,
                json={
                    "client_uuid": chave(f"fiado-marizete-{vez}"),
                    "cliente_id": clientes[0]["id"],
                    "itens": [{"variante_id": peca["id"], "quantidade": 1}],
                    "pagamentos": [{"forma": "FIADO", "valor": valor}],
                },
            )

        # Cleide levou metade no fiado e já veio pagar uma parte: o extrato mostra as
        # três linhas (levou, pagou, deve) em vez de só a dívida.
        peca = random.choice(variantes)
        preco = float(peca["preco"])
        metade = round(preco / 2, 2)
        venda_cleide = c.post(
            "/vendas",
            headers=admin,
            json={
                "client_uuid": chave("fiado-cleide"),
                "cliente_id": clientes[1]["id"],
                "itens": [{"variante_id": peca["id"], "quantidade": 1}],
                "pagamentos": [
                    {"forma": "DINHEIRO", "valor": f"{metade:.2f}"},
                    {"forma": "FIADO", "valor": f"{preco - metade:.2f}"},
                ],
            },
        )
        if venda_cleide.status_code in (200, 201):
            c.post(
                f"/clientes/{clientes[1]['id']}/pagamentos",
                headers=admin,
                json={
                    "forma": "PIX",
                    "valor": f"{round((preco - metade) / 2, 2):.2f}",
                    "client_uuid": chave("pagamento-cleide"),
                },
            )
        print(f"crediário: {len(clientes)} clientes, com fiado e pagamento parcial")

    # ------------------------------------------------------- devolução
    # Duas devoluções, os dois desfechos que existem:
    #
    #   1. venda à vista → o dinheiro volta pela forma em que entrou;
    #   2. fiado JÁ PAGO → a dívida não existe mais, então sai vale (ADR-21).
    recentes = c.get("/vendas", headers=admin, params={"size": 20}).json()["items"]
    a_vista = next(
        (
            v
            for v in recentes
            if v["status"] == "CONCLUIDA" and "FIADO" not in v["formas_pagamento"]
        ),
        None,
    )
    if a_vista:
        detalhe = c.get(f"/vendas/{a_vista['id']}", headers=admin).json()
        # A chave é única na loja inteira: se a retomada achar OUTRA venda aqui, a mesma
        # chave noutro pedido é recusada (409) e a devolução não sai duas vezes.
        devolveu = c.post(
            f"/vendas/{a_vista['id']}/devolucoes",
            headers=admin,
            json={
                "client_uuid": chave("devolucao-a-vista"),
                "motivo": "não serviu",
                "itens": [
                    {
                        "item_id": detalhe["itens"][0]["id"],
                        "quantidade": 1,
                        "voltar_ao_estoque": True,
                    }
                ],
            },
        )
        if devolveu.status_code in (200, 201):
            print("devolução: uma peça de volta na arara, dinheiro pela forma que entrou")

    if clientes:
        # O caminho do vale, do começo: Sônia leva no fiado, paga tudo, e só depois
        # volta com a peça. Sem dívida para abater, o valor sai em vale — o papel com
        # código que a próxima compra dela consome (ADR-21).
        peca = random.choice(variantes)
        valor = f"{float(peca['preco']):.2f}"
        venda_sonia = c.post(
            "/vendas",
            headers=admin,
            json={
                "client_uuid": chave("fiado-sonia"),
                "cliente_id": clientes[2]["id"],
                "itens": [{"variante_id": peca["id"], "quantidade": 1}],
                "pagamentos": [{"forma": "FIADO", "valor": valor}],
            },
        )
        if venda_sonia.status_code in (200, 201):
            venda_sonia = venda_sonia.json()
            c.post(
                f"/clientes/{clientes[2]['id']}/pagamentos",
                headers=admin,
                json={
                    "forma": "DINHEIRO",
                    "valor": valor,
                    "client_uuid": chave("pagamento-sonia"),
                },
            )
            devolvida = c.post(
                f"/vendas/{venda_sonia['id']}/devolucoes",
                headers=admin,
                json={
                    "client_uuid": chave("devolucao-sonia"),
                    "motivo": "presente repetido",
                    "itens": [
                        {"item_id": venda_sonia["itens"][0]["id"], "quantidade": 1}
                    ],
                },
            )
            if devolvida.status_code in (200, 201):
                vale = next(
                    (
                        p["codigo_vale"]
                        for p in devolvida.json()["pagamentos"]
                        if p.get("codigo_vale")
                    ),
                    None,
                )
                if vale:
                    print(f"vale de troca em aberto: {vale}")

    # --------------------------------------------- caixa de ontem fechado
    # Com uma diferença de verdade (R$ 3,50 a menos), porque é assim que o dia fecha na
    # vida real — e a tela existe justamente para a diferença aparecer.
    ontem = (hoje_loja() - timedelta(days=1)).date()
    dia = c.get("/caixa/dia", headers=admin, params={"data": ontem.isoformat()}).json()
    contagens = []
    for indice, linha in enumerate(dia.get("linhas", [])):
        esperado = float(linha["esperado"])
        contado = esperado - 3.50 if indice == 0 and esperado > 3.50 else esperado
        contagens.append({"forma": linha["forma"], "valor_contado": f"{contado:.2f}"})
    if contagens:
        fechou = c.post(
            "/caixa/fechamentos",
            headers=admin,
            json={
                "data": ontem.isoformat(),
                "contagens": contagens,
                "observacao": "conferido com a Ana no fim do dia",
            },
        )
        if fechou.status_code in (200, 201):
            print("caixa de ontem fechado, com diferença")

    resumo = c.get(
        "/relatorios/resumo",
        headers=admin,
        params={"inicio": hoje.replace(day=1).isoformat(), "fim": hoje.isoformat()},
    ).json()
    print(
        f"\nresultado do mês: faturamento {resumo['faturamento']}, "
        f"lucro bruto {resumo['lucro_bruto']}, despesas {resumo['despesas']}, "
        f"resultado {resumo['resultado']}"
    )
    return 0


def main() -> int:
    subprocess.run(
        [
            sys.executable, "-m", "app.cli", "create-admin",
            "--nome", ADMIN["nome"], "--email", ADMIN["email"], "--senha", ADMIN["senha"],
        ],
        capture_output=True, text=True, check=False,
    )

    with httpx.Client(base_url=BASE, timeout=60) as c:
        if popular(c, ADMIN, VENDEDORA) != 0:
            return 1
    print(f"\nadmin:    {ADMIN['email']} / {ADMIN['senha']}")
    print(f"vendedor: {VENDEDORA['email']} / {VENDEDORA['senha']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
