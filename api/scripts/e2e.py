"""Cenário E2E: um dia inteiro de loja, do cadastro ao fechamento do caixa.

Roda contra a API de verdade (uvicorn + Postgres), exatamente como o app faria.
"""

import subprocess
import sys
import uuid
from datetime import UTC, datetime
from zoneinfo import ZoneInfo

import httpx

# O "dia" do comércio é o do fuso da loja, não o do servidor: às 23h de São Paulo
# o UTC já virou, e perguntar pelo dia errado devolve um caixa vazio.
TZ_LOJA = ZoneInfo("America/Sao_Paulo")


def hoje_na_loja() -> str:
    return datetime.now(UTC).astimezone(TZ_LOJA).date().isoformat()

BASE = "http://127.0.0.1:8000/api/v1"
falhas: list[str] = []


def checar(condicao: bool, descricao: str, extra: str = "") -> None:
    marca = "OK  " if condicao else "FALHA"
    print(f"  [{marca}] {descricao}{f'  ({extra})' if extra else ''}")
    if not condicao:
        falhas.append(descricao)


def secao(titulo: str) -> None:
    print(f"\n=== {titulo}")


with httpx.Client(base_url=BASE, timeout=30) as c:
    secao("1. Bootstrap do primeiro admin (CLI)")
    saida = subprocess.run(
        [
            ".venv/bin/python", "-m", "app.cli", "create-admin",
            "--nome", "Dona Maria", "--email", "dona@loja.com", "--senha", "senha12345",
        ],
        capture_output=True, text=True, cwd="/home/user/SISTEMA_GESTAO_LOJA/api",
    )
    checar(saida.returncode == 0, "CLI cria o admin inicial", saida.stdout.strip())

    secao("2. Login e sessão")
    r = c.post("/auth/login", json={"email": "dona@loja.com", "senha": "senha12345"})
    checar(r.status_code == 200, "admin faz login", str(r.status_code))
    tokens = r.json()
    admin = {"Authorization": f"Bearer {tokens['access_token']}"}
    checar(tokens["usuario"]["papel"] == "ADMIN", "papel do admin correto")

    r = c.post("/auth/refresh", json={"refresh_token": tokens["refresh_token"]})
    checar(r.status_code == 200, "refresh rotaciona a sessão")
    r = c.post("/auth/refresh", json={"refresh_token": tokens["refresh_token"]})
    checar(r.status_code == 401, "refresh reutilizado é recusado")

    secao("3. Vendedor")
    r = c.post("/usuarios", headers=admin, json={
        "nome": "João Vendedor", "email": "joao@loja.com",
        "senha": "senha12345", "papel": "VENDEDOR",
    })
    checar(r.status_code == 201, "admin cria vendedor")
    r = c.post("/auth/login", json={"email": "joao@loja.com", "senha": "senha12345"})
    vendedor = {"Authorization": f"Bearer {r.json()['access_token']}"}
    checar(r.status_code == 200, "vendedor faz login")

    secao("4. Catálogo com grade e códigos")
    cat = c.post("/categorias", headers=admin, json={"nome": "Camisetas"}).json()
    r = c.post("/produtos", headers=admin, json={
        "categoria_id": cat["id"],
        "nome": "Camiseta Básica Gola V",
        "variantes": [
            {"tamanho": "P", "cor": "Preta", "codigo_barras": "7891234567895",
             "preco_custo": "20.00", "preco_venda": "50.00",
             "estoque_minimo": 2},
            {"tamanho": "M", "cor": "Preta", "preco_custo": "20.00",
             "preco_venda": "50.00", "estoque_minimo": 2},
            {"tamanho": "G", "cor": "Preta", "preco_custo": "20.00",
             "preco_venda": "50.00", "estoque_minimo": 2},
        ],
    })
    checar(r.status_code == 201, "cadastra produto com grade P/M/G", str(r.status_code))
    produto = r.json()
    por_tamanho = {v["tamanho"]: v for v in produto["variantes"]}
    checar(por_tamanho["P"]["tipo_codigo"] == "EAN", "peça com etiqueta mantém o EAN")
    checar(por_tamanho["M"]["tipo_codigo"] == "INTERNO", "peça sem etiqueta ganha código interno")
    checar(len(por_tamanho["M"]["codigo_barras"]) == 13, "código interno é EAN-13")
    checar(produto["saldo_total"] == 0, "cadastro nasce com saldo zero (ADR-29)")

    # A primeira compra entra pela mesma porta das outras: a Entrada, com fornecedor.
    r = c.post("/estoque/entradas", headers=admin, json={
        "client_uuid": str(uuid.uuid4()), "fornecedor": "Malharia Inicial",
        "itens": [{"variante_id": por_tamanho[t]["id"], "quantidade": q}
                  for t, q in (("P", 10), ("M", 5), ("G", 1))],
    })
    checar(r.status_code == 201, "primeira entrada registrada", str(r.status_code))
    produto = c.get(f"/produtos/{produto['id']}", headers=admin).json()
    checar(produto["saldo_total"] == 16, "entrada inicial virou saldo", str(produto["saldo_total"]))

    secao("5. Visibilidade por papel")
    visao_admin = c.get(f"/produtos/{produto['id']}", headers=admin).text
    visao_vendedor = c.get(f"/produtos/{produto['id']}", headers=vendedor).text
    checar("preco_custo" in visao_admin, "admin enxerga o custo")
    checar("preco_custo" not in visao_vendedor, "vendedor NÃO enxerga o custo")
    checar(c.get("/despesas", headers=vendedor).status_code == 403, "vendedor bloqueado em despesas")
    checar(
        c.get("/relatorios/resumo", headers=vendedor,
              params={"inicio": "2026-01-01", "fim": "2026-12-31"}).status_code == 403,
        "vendedor bloqueado em relatórios",
    )

    secao("6. Lookup do PDV")
    r = c.get("/variantes/codigo-barras/7891234567895", headers=vendedor)
    peca_p = r.json()
    checar(r.status_code == 200, "bipar etiqueta encontra a peça")
    checar(peca_p["saldo"] == 10 and peca_p["preco_venda"] == "50.00", "traz saldo e preço")
    checar(
        c.get("/variantes/codigo-barras/0000000000000", headers=vendedor).status_code == 404,
        "código desconhecido devolve 404 (app oferece cadastro)",
    )

    secao("7. Entrada de mercadoria")
    entrada_uuid = str(uuid.uuid4())
    corpo = {"client_uuid": entrada_uuid, "fornecedor": "Malharia Nova",
             "itens": [{"variante_id": por_tamanho["G"]["id"], "quantidade": 9}]}
    r1 = c.post("/estoque/entradas", headers=vendedor, json=corpo)
    r2 = c.post("/estoque/entradas", headers=vendedor, json=corpo)
    checar(r1.status_code == 201, "entrada registrada")
    checar(r1.json()["id"] == r2.json()["id"], "reenvio não duplica (idempotência)")
    saldos = c.get("/estoque/saldos", headers=vendedor).json()["items"]
    saldo_g = next(s["saldo"] for s in saldos if s["variante_id"] == por_tamanho["G"]["id"])
    checar(saldo_g == 10, "saldo somou uma vez só", f"G={saldo_g}")

    secao("8. Venda no PDV (pagamento misto + desconto)")
    venda_uuid = str(uuid.uuid4())
    corpo_venda = {
        "client_uuid": venda_uuid,
        "desconto": "10.00",
        "itens": [
            {"variante_id": por_tamanho["P"]["id"], "quantidade": 2},
            {"variante_id": por_tamanho["M"]["id"], "quantidade": 1},
        ],
        "pagamentos": [
            {"forma": "DINHEIRO", "valor": "40.00"},
            {"forma": "PIX", "valor": "100.00"},
        ],
    }
    r = c.post("/vendas", headers=vendedor, json=corpo_venda)
    checar(r.status_code == 201, "venda concluída", r.text[:120])
    venda = r.json()
    checar(venda["subtotal"] == "150.00" and venda["total"] == "140.00", "totais corretos")
    checar("lucro_bruto" not in venda, "vendedor não recebe o lucro da venda")

    r = c.post("/vendas", headers=vendedor, json=corpo_venda)
    checar(r.json()["id"] == venda["id"], "reenvio da venda não duplica")

    saldos = c.get("/estoque/saldos", headers=vendedor).json()["items"]
    saldo_p = next(s["saldo"] for s in saldos if s["variante_id"] == por_tamanho["P"]["id"])
    checar(saldo_p == 8, "estoque baixou uma vez só", f"P={saldo_p}")

    secao("9. Regras que protegem o caixa")
    r = c.post("/vendas", headers=vendedor, json={
        "client_uuid": str(uuid.uuid4()),
        "itens": [{"variante_id": por_tamanho["P"]["id"], "quantidade": 1}],
        "pagamentos": [{"forma": "PIX", "valor": "10.00"}],
    })
    checar(r.status_code == 422 and r.json()["code"] == "PAGAMENTO_DIVERGENTE",
           "pagamento que não fecha é recusado")
    checar(r.json()["detail"]["total_da_venda"] == "50.00",
           "o erro traz o total certo para o app refazer")

    r = c.post("/vendas", headers=vendedor, json={
        "client_uuid": str(uuid.uuid4()),
        "itens": [{"variante_id": por_tamanho["M"]["id"], "quantidade": 99}],
        "pagamentos": [{"forma": "PIX", "valor": "4950.00"}],
    })
    checar(r.status_code == 409 and r.json()["code"] == "ESTOQUE_INSUFICIENTE",
           "venda sem estoque é recusada")

    secao("10. Cancelamento devolve o estoque")
    r = c.post(f"/vendas/{venda['id']}/cancelamento", headers=admin,
               json={"motivo": "cliente desistiu"})
    checar(r.status_code == 200 and r.json()["status"] == "CANCELADA", "venda cancelada")
    saldos = c.get("/estoque/saldos", headers=admin).json()["items"]
    saldo_p = next(s["saldo"] for s in saldos if s["variante_id"] == por_tamanho["P"]["id"])
    checar(saldo_p == 10, "peças voltaram ao estoque", f"P={saldo_p}")
    movs = c.get("/estoque/movimentacoes", headers=admin, params={"tipo": "ESTORNO"}).json()
    checar(movs["total"] == 2, "estorno registrado no extrato", f"{movs['total']} movimentos")

    secao("11. Venda que vai valer para o relatório")
    r = c.post("/vendas", headers=admin, json={
        "client_uuid": str(uuid.uuid4()),
        "itens": [{"variante_id": por_tamanho["P"]["id"], "quantidade": 3}],
        "pagamentos": [{"forma": "DEBITO", "valor": "150.00"}],
    })
    checar(r.status_code == 201, "segunda venda concluída")
    checar(r.json()["lucro_bruto"] == "90.00", "admin vê lucro (150 − 60 de custo)",
           r.json().get("lucro_bruto", "?"))

    secao("12. Despesas")
    cat_desp = c.post("/despesas/categorias", headers=admin, json={"nome": "Aluguel"}).json()
    hoje = hoje_na_loja()
    c.post("/despesas", headers=admin, json={
        "categoria_id": cat_desp["id"], "descricao": "Aluguel da loja",
        "valor": "40.00", "data": hoje, "recorrente": True,
    })
    r1 = c.post("/despesas/replicar-recorrentes", headers=admin,
                params={"competencia": hoje_na_loja()[:7]})
    checar(r1.json()["criadas"] == 0, "não replica dentro da própria competência")

    secao("13. Resultado do dia")
    r = c.get("/relatorios/resumo", headers=admin, params={"inicio": hoje, "fim": hoje})
    resumo = r.json()
    checar(resumo["faturamento"] == "150.00", "faturamento ignora a venda cancelada",
           resumo["faturamento"])
    checar(resumo["custo_mercadoria_vendida"] == "60.00", "CMV usa o custo congelado")
    checar(resumo["lucro_bruto"] == "90.00", "lucro bruto = faturamento − CMV")
    checar(resumo["despesas"] == "40.00", "despesas do dia entram")
    checar(resumo["resultado"] == "50.00", "resultado = 150 − 60 − 40", resumo["resultado"])
    checar(resumo["vendas_canceladas"] == 1, "cancelada aparece separada")

    secao("14. Estoque baixo")
    r = c.get("/relatorios/estoque-baixo", headers=admin)
    baixos = {p["tamanho"] for p in r.json()}
    # P=7, M=5, G=10, todos com mínimo 2: nada precisa de reposição ainda.
    checar(not baixos, "nada abaixo do mínimo agora", f"listados: {baixos or 'nenhum'}")

    c.post("/estoque/ajustes", headers=admin, json={
        "variante_id": por_tamanho["M"]["id"], "quantidade": -4,
        "motivo": "peças manchadas no provador",
    })
    r = c.get("/relatorios/estoque-baixo", headers=admin)
    baixos = {p["tamanho"]: p for p in r.json()}
    checar("M" in baixos, "peça cai no alerta ao chegar no mínimo", f"listados: {list(baixos)}")
    checar(baixos.get("M", {}).get("saldo") == 1, "alerta mostra o saldo real")

    secao("15. Caixa do dia")
    r = c.get("/caixa/dia", headers=admin, params={"data": hoje})
    dia = r.json()
    por_forma = {linha["forma"]: linha["esperado"] for linha in dia["linhas"]}
    checar(por_forma["DEBITO"] == "150.00", "débito esperado correto", por_forma["DEBITO"])
    checar(por_forma["PIX"] == "0.00", "PIX da venda cancelada saiu do esperado")
    checar(dia["total_esperado"] == "150.00", "total esperado do dia")

    r = c.post("/caixa/fechamentos", headers=admin, json={
        "data": hoje,
        "contagens": [{"forma": "DEBITO", "valor_contado": "140.00"}],
        "observacao": "faltou uma maquininha",
    })
    checar(r.status_code == 201, "caixa fechado")
    checar(r.json()["diferenca"] == "-10.00", "diferença registrada", r.json()["diferenca"])

    r2 = c.post("/caixa/fechamentos", headers=admin, json={
        "data": hoje, "contagens": [{"forma": "DEBITO", "valor_contado": "150.00"}],
    })
    checar(r2.json()["id"] == r.json()["id"], "refechar atualiza em vez de duplicar")
    checar(r2.json()["diferenca"] == "0.00", "diferença corrigida")

    secao("16. Escopo do vendedor nas vendas")
    minhas = c.get("/vendas", headers=vendedor).json()
    todas = c.get("/vendas", headers=admin).json()
    checar(minhas["total"] == 1, "vendedor vê só as próprias", f"{minhas['total']} de {todas['total']}")
    checar(todas["total"] == 2, "admin vê todas")

print("\n" + "=" * 60)
if falhas:
    print(f"FALHAS ({len(falhas)}):")
    for f in falhas:
        print(f"  - {f}")
    sys.exit(1)
print("Cenário completo passou.")
