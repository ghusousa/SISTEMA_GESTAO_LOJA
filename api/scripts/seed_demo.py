"""Popula a loja com dados de demonstração.

Serve para conhecer o sistema com a tela cheia — catálogo variado, vendas espalhadas
pelos últimos dias, despesas do mês e uma peça no estoque mínimo para o alerta aparecer.

    .venv/bin/python scripts/seed_demo.py          # com a API no ar

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


def hoje_loja() -> datetime:
    return datetime.now(UTC).astimezone(TZ_LOJA)


async def _espalhar_vendas_no_mes(ids: list[int]) -> None:
    """Redistribui `sold_at` pelos últimos 25 dias, em horário de loja.

    Sábado vende mais, domingo quase nada — sem isso a curva de vendas fica reta e não
    ajuda a enxergar como o relatório se comporta.
    """
    if not ids:
        return

    import asyncpg

    from app.core.config import settings

    agora = datetime.now(UTC).astimezone(TZ_LOJA)
    momentos: list[datetime] = []
    for indice, _ in enumerate(ids):
        dias_atras = int((indice / max(len(ids) - 1, 1)) * 24)
        dia = (agora - timedelta(days=dias_atras)).date()
        peso_do_dia = {5: 1.6, 6: 0.2}.get(dia.weekday(), 1.0)
        if random.random() > peso_do_dia:
            dias_atras = max(dias_atras - 1, 0)
            dia = (agora - timedelta(days=dias_atras)).date()
        hora = random.randint(9, 18)
        momentos.append(
            datetime(dia.year, dia.month, dia.day, hora, random.randint(0, 59), tzinfo=TZ_LOJA)
        )

    url = settings.database_url.replace("postgresql+asyncpg://", "postgresql://")
    conexao = await asyncpg.connect(url)
    try:
        await conexao.executemany(
            "UPDATE sales SET sold_at = $2, created_at = $2 WHERE id = $1",
            list(zip(ids, momentos, strict=True)),
        )
    finally:
        await conexao.close()


def main() -> int:
    random.seed(42)  # dados iguais a cada execução: bom para comparar telas

    subprocess.run(
        [
            sys.executable, "-m", "app.cli", "create-admin",
            "--nome", ADMIN["nome"], "--email", ADMIN["email"], "--senha", ADMIN["senha"],
        ],
        capture_output=True, text=True, check=False,
    )

    with httpx.Client(base_url=BASE, timeout=60) as c:
        entrar = c.post(
            "/auth/login", json={"email": ADMIN["email"], "senha": ADMIN["senha"]}
        )
        if entrar.status_code == 401:
            print(
                f"Não consegui entrar como {ADMIN['email']}.\n"
                "Se a conta de administrador desta instalação é outra, informe-a:\n"
                "  SEED_ADMIN_EMAIL=voce@sualoja.com SEED_ADMIN_SENHA='sua-senha' "
                "python scripts/seed_demo.py",
                file=sys.stderr,
            )
            return 1
        entrar.raise_for_status()
        admin = {"Authorization": f"Bearer {entrar.json()['access_token']}"}

        if c.post("/usuarios", headers=admin, json=VENDEDORA).status_code == 201:
            print("vendedora criada")
        login_ana = c.post(
            "/auth/login", json={"email": VENDEDORA["email"], "senha": VENDEDORA["senha"]}
        )
        ana = {"Authorization": f"Bearer {login_ana.json()['access_token']}"}

        # ---------------------------------------------------------- catálogo
        categorias: dict[str, int] = {}
        variantes: list[dict] = []
        for ordem, (cat, nome, venda, custo, tamanhos, cor) in enumerate(CATALOGO):
            if cat not in categorias:
                resp = c.post("/categorias", headers=admin, json={"nome": cat})
                categorias[cat] = (
                    resp.json()["id"]
                    if resp.status_code == 201
                    else next(
                        x["id"]
                        for x in c.get("/categorias", headers=admin).json()["items"]
                        if x["nome"] == cat
                    )
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
                        "estoque_inicial": random.randint(4, 14),
                    }
                )
            criado = c.post(
                "/produtos",
                headers=admin,
                json={"categoria_id": categorias[cat], "nome": nome, "variantes": grade},
            )
            criado.raise_for_status()
            for v in criado.json()["variantes"]:
                variantes.append({"id": v["id"], "preco": v["preco_venda"], "nome": nome})
        print(f"catálogo: {len(CATALOGO)} produtos, {len(variantes)} peças")

        # ---------------------------------------------------------- vendas
        vendidas = 0
        ids_criados: list[int] = []
        for _ in range(115):
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
                    "client_uuid": str(uuid.uuid4()),
                    "desconto": f"{desconto:.2f}",
                    "itens": [{"variante_id": variante["id"], "quantidade": quantidade}],
                    "pagamentos": pagamentos,
                },
            )
            if resp.status_code == 201:
                vendidas += 1
                ids_criados.append(resp.json()["id"])

        # A API sempre carimba a venda com o instante atual — correto em produção, mas aqui
        # deixaria as 70 vendas empilhadas no mesmo minuto e o gráfico do mês seria uma
        # barra só. Espalhar exige tocar no banco, e é por isso que este script é de demo.
        asyncio.run(_espalhar_vendas_no_mes(ids_criados))
        print(f"vendas: {vendidas} (espalhadas nos últimos 25 dias)")

        # Uma venda cancelada, para o histórico mostrar os dois estados.
        primeira = c.get("/vendas", headers=admin).json()["items"][-1]
        c.post(
            f"/vendas/{primeira['id']}/cancelamento",
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
                else next(
                    x["id"]
                    for x in c.get("/despesas/categorias", headers=admin).json()["items"]
                    if x["nome"] == categoria
                )
            )
            c.post(
                "/despesas",
                headers=admin,
                json={
                    "categoria_id": categoria_id,
                    "descricao": descricao,
                    "valor": valor,
                    "data": hoje.replace(day=min(dia, 28)).isoformat(),
                    "recorrente": recorrente,
                },
            )
        print(f"despesas: {len(DESPESAS)}")

        # ------------------------------------------- uma peça pedindo reposição
        saldos = c.get("/estoque/saldos", headers=admin, params={"size": 100}).json()
        alvo = next(s for s in saldos["items"] if s["saldo"] > 3)
        c.post(
            "/estoque/ajustes",
            headers=admin,
            json={
                "variante_id": alvo["variante_id"],
                "quantidade": -(alvo["saldo"] - 1),
                "motivo": "peças com defeito de fábrica devolvidas ao fornecedor",
            },
        )

        # ------------------------------------------- entrada de reposição
        reposicao = random.sample(variantes, 3)
        c.post(
            "/estoque/entradas",
            headers=admin,
            json={
                "client_uuid": str(uuid.uuid4()),
                "fornecedor": "Malharia Nova",
                "itens": [{"variante_id": v["id"], "quantidade": 6} for v in reposicao],
            },
        )

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
        print(f"\nadmin:    {ADMIN['email']} / {ADMIN['senha']}")
        print(f"vendedor: {VENDEDORA['email']} / {VENDEDORA['senha']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
