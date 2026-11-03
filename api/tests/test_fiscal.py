"""NFC-e (ADR-41): dados fiscais, emissor desligado, adaptador Focus NFe e cancelamento.

Nenhum teste aqui fala com a internet. O adaptador da Focus é o de verdade, com um
`httpx.MockTransport` no lugar da rede: `FocusFalsa` faz o papel do servidor deles,
guarda cada pedido (para conferir o payload) e responde como a documentação pública da
API v2 descreve.
"""

import asyncio
import json
import uuid
from decimal import Decimal

import httpx
import pytest
from conftest import criar_produto
from httpx import AsyncClient
from pydantic import SecretStr
from sqlalchemy import text

from app.core.config import settings
from app.core.db import engine
from app.modules.catalogo.schemas import DadosFiscaisPecaOut
from app.modules.fiscal import automatico, emissores
from app.modules.fiscal.focusnfe import DESCRICAO_HOMOLOGACAO, FocusNFe, montar_payload
from app.modules.fiscal.models import Ambiente
from app.modules.fiscal.nfce import TPAG, DadosDaLoja, montar_nota, ratear_desconto
from app.modules.fiscal.service import FiscalService
from app.modules.vendas.models import FormaPagamento
from app.modules.vendas.schemas import ItemVendaOut, PagamentoOut, VendaOut

TOKEN = "token-secreto-da-loja-123"
CNPJ = "12345678000195"


# ------------------------------------------------------------------ a Focus de mentira
def _chave(numero: int) -> str:
    # UF, AAMM, CNPJ, modelo 65, série 001, número, tpEmis, cNF, DV: 44 dígitos.
    return f"352611{CNPJ}65001{numero:09d}1{numero:08d}0"


class FocusFalsa:
    """O servidor da Focus NFe, do jeito que a documentação descreve."""

    def __init__(self) -> None:
        self.pedidos: list[httpx.Request] = []
        self.notas: dict[str, dict] = {}
        self.ao_emitir = "autorizar"
        self.ao_cancelar = "cancelar"
        #: A consulta de uma nota "processando" já devolve autorizada.
        self.processamento_termina = True
        #: `(status HTTP, kwargs do httpx.Response)` que a consulta devolve no lugar da nota:
        #: limite de pedidos, proxy no caminho... Nada disso diz se a nota existe.
        self.consulta_falha: tuple[int, dict] | None = None
        self.numero = 0

    def _autorizar(self, ref: str) -> dict:
        self.numero += 1
        nota = {
            "cnpj_emitente": CNPJ,
            "ref": ref,
            "status": "autorizado",
            "status_sefaz": "100",
            "mensagem_sefaz": "Autorizado o uso da NF-e",
            "chave_nfe": f"NFe{_chave(self.numero)}",
            "numero": str(self.numero),
            "serie": "1",
            "numero_protocolo": f"1352600000{self.numero:05d}",
            "caminho_xml_nota_fiscal": f"/arquivos/{CNPJ}/{ref}-nfce.xml",
            "caminho_danfe": f"/notas_fiscais_consumidor/NFe{_chave(self.numero)}.html",
        }
        self.notas[ref] = nota
        return nota

    def de(self, metodo: str) -> list[httpx.Request]:
        return [p for p in self.pedidos if p.method == metodo]

    async def __call__(self, request: httpx.Request) -> httpx.Response:
        self.pedidos.append(request)
        await asyncio.sleep(0.01)  # dá tempo de um segundo pedido simultâneo chegar
        if request.method == "POST":
            ref = request.url.params["ref"]
            if self.ao_emitir == "sem_rede":
                raise httpx.ConnectError("sem rede", request=request)
            if self.ao_emitir == "token_errado":
                return httpx.Response(401, text="HTTP Basic: Access denied.")
            if self.ao_emitir == "fora_do_ar":
                return httpx.Response(503, text="<html>Service Unavailable</html>")
            if self.ao_emitir == "limite":
                # 100 pedidos por minuto por token; a doc não define corpo.
                return httpx.Response(429, text="Retry later")
            if self.ao_emitir == "proxy":
                # 4xx que a Focus não documenta (página de erro de um proxy no caminho).
                return httpx.Response(400, text="<html>Bad Request</html>")
            if self.ao_emitir == "sem_csc":
                return httpx.Response(
                    422, json={"codigo": "erro_validacao", "mensagem": "CSC não configurado"}
                )
            if self.notas.get(ref, {}).get("status") == "autorizado":
                return httpx.Response(
                    422, json={"codigo": "already_processed", "mensagem": "Nota já autorizada"}
                )
            if self.ao_emitir == "rejeitar":
                self.notas[ref] = {
                    "ref": ref,
                    "status": "erro_autorizacao",
                    "status_sefaz": "778",
                    "mensagem_sefaz": "Rejeição: Informado NCM inexistente",
                }
                return httpx.Response(201, json=self.notas[ref])
            if self.ao_emitir == "processando":
                self.notas[ref] = {"ref": ref, "status": "processando_autorizacao"}
                return httpx.Response(201, json=self.notas[ref])
            nota = self._autorizar(ref)
            if self.ao_emitir == "perder_resposta":
                # Autorizou lá, mas a resposta nunca chegou aqui.
                raise httpx.ReadTimeout("caiu no meio", request=request)
            return httpx.Response(201, json=nota)

        ref = request.url.path.rsplit("/", 1)[-1]
        if request.method == "GET":
            if self.consulta_falha is not None:
                status_http, kwargs = self.consulta_falha
                return httpx.Response(status_http, **kwargs)
            nota = self.notas.get(ref)
            if nota is None:
                return httpx.Response(
                    404, json={"codigo": "nfce_nao_encontrada", "mensagem": "NFC-e não encontrada."}
                )
            if nota["status"] == "processando_autorizacao" and self.processamento_termina:
                nota = self._autorizar(ref)
            return httpx.Response(200, json=nota)

        if request.method == "DELETE":
            if self.ao_cancelar == "sem_rede":
                raise httpx.ConnectError("sem rede", request=request)
            if self.ao_cancelar == "recusar":
                return httpx.Response(
                    200,
                    json={
                        "status": "erro_cancelamento",
                        "status_sefaz": "501",
                        "mensagem_sefaz": "Rejeição: Prazo de cancelamento superior ao previsto",
                    },
                )
            self.notas[ref]["status"] = "cancelado"
            return httpx.Response(
                200,
                json={
                    "status": "cancelado",
                    "status_sefaz": "135",
                    "mensagem_sefaz": "Evento registrado e vinculado a NFC-e",
                    "caminho_xml_cancelamento": f"/arquivos/{ref}-can.xml",
                    "numero_protocolo": "135260000099999",
                },
            )
        return httpx.Response(405)


@pytest.fixture
def focus(monkeypatch: pytest.MonkeyPatch) -> FocusFalsa:
    """Liga a Focus NFe como o dono ligaria — pelo .env — com a rede trocada pela falsa."""
    falsa = FocusFalsa()
    monkeypatch.setattr(settings, "fiscal_emissor", "focusnfe")
    monkeypatch.setattr(settings, "focusnfe_token", SecretStr(TOKEN))
    monkeypatch.setattr(settings, "focusnfe_ambiente", "homologacao")

    def fabrica(nome: str) -> FocusNFe:
        assert nome == "focusnfe"
        return FocusNFe(
            token=settings.focusnfe_token.get_secret_value(),
            ambiente=Ambiente(settings.focusnfe_ambiente),
            transport=httpx.MockTransport(falsa),
        )

    monkeypatch.setattr(emissores, "fabrica", fabrica)
    return falsa


# ------------------------------------------------------------------ cenário da loja
async def _configurar_loja(client: AsyncClient, auth_admin: dict, **extra) -> dict:
    dados = {
        "documento": "12.345.678/0001-95",
        "inscricao_estadual": "110.042.490.114",
        "regime_tributario": 1,
        **extra,
    }
    resp = await client.patch("/configuracao", headers=auth_admin, json=dados)
    assert resp.status_code == 200, resp.text
    return resp.json()


@pytest.fixture
async def pecas(client: AsyncClient, auth_admin: dict) -> dict:
    """Camiseta (NCM 6109.10.00) 49,90 e Calça (NCM 6203.42.00, ST) 149,90 — e um Boné sem NCM."""
    cat = (await client.post("/categorias", headers=auth_admin, json={"nome": "Roupas"})).json()
    camiseta = await criar_produto(
        client,
        auth_admin,
        {
            "categoria_id": cat["id"],
            "nome": "Camiseta Lisa",
            "ncm": "6109.10.00",
            "variantes": [
                {
                    "tamanho": "P",
                    "cor": "Branca",
                    "preco_custo": "20.00",
                    "preco_venda": "49.90",
                    "estoque_inicial": 10,
                }
            ],
        },
    )
    calca = await criar_produto(
        client,
        auth_admin,
        {
            "categoria_id": cat["id"],
            "nome": "Calça Jeans",
            "ncm": "62034200",
            "cest": "28.038.00",
            "cfop": "5405",
            "origem": 2,
            "variantes": [
                {
                    "tamanho": "M",
                    "cor": "Azul",
                    "preco_custo": "60.00",
                    "preco_venda": "149.90",
                    "estoque_inicial": 5,
                }
            ],
        },
    )
    bone = await criar_produto(
        client,
        auth_admin,
        {
            "categoria_id": cat["id"],
            "nome": "Boné Aba Reta",
            "variantes": [
                {
                    "tamanho": "U",
                    "cor": "Preto",
                    "preco_custo": "10.00",
                    "preco_venda": "39.90",
                    "estoque_inicial": 5,
                }
            ],
        },
    )
    return {
        "camiseta": camiseta["variantes"][0]["id"],
        "calca": calca["variantes"][0]["id"],
        "bone": bone["variantes"][0]["id"],
        "bone_produto": bone["id"],
    }


async def _vender(client, auth, itens, pagamentos, desconto="0.00", **extra) -> dict:
    resp = await client.post(
        "/vendas",
        headers=auth,
        json={
            "client_uuid": str(uuid.uuid4()),
            "itens": [{"variante_id": v, "quantidade": q} for v, q in itens],
            "pagamentos": [{"forma": f, "valor": valor} for f, valor in pagamentos],
            "desconto": desconto,
            **extra,
        },
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


async def _saldo(client, auth, variante_id: int) -> int:
    saldos = (await client.get("/estoque/saldos", headers=auth)).json()
    return next(s["saldo"] for s in saldos["items"] if s["variante_id"] == variante_id)


# ------------------------------------------------------------------ dados fiscais
async def test_produto_guarda_codigos_fiscais_so_com_digitos(client, auth_admin) -> None:
    cat = (await client.post("/categorias", headers=auth_admin, json={"nome": "Roupas"})).json()
    produto = await criar_produto(
        client,
        auth_admin,
        {
            "categoria_id": cat["id"],
            "nome": "Vestido",
            "ncm": "6204.44.00",
            "cest": "28.038.00",
            "origem": 2,
            "cfop": "5.405",
            "variantes": [
                {"tamanho": "M", "cor": "Rosa", "preco_custo": "1.00", "preco_venda": "2.00"}
            ],
        },
    )
    assert (produto["ncm"], produto["cest"], produto["origem"], produto["cfop"]) == (
        "62044400",
        "2803800",
        2,
        "5405",
    )

    # PATCH: `null` no CEST apaga; o que não vem fica como está.
    resp = await client.patch(
        f"/produtos/{produto['id']}", headers=auth_admin, json={"cest": None, "cfop": "5102"}
    )
    assert resp.status_code == 200, resp.text
    assert (resp.json()["ncm"], resp.json()["cest"], resp.json()["cfop"]) == (
        "62044400",
        None,
        "5102",
    )


async def test_produto_sem_dados_fiscais_nasce_com_os_padroes(client, auth_vendedor, admin) -> None:
    """A vendedora cadastra sem saber de NCM: a peça nasce, e a nota é quem cobra depois."""
    from app.core.db import SessionLocal
    from app.modules.catalogo.models import Category

    async with SessionLocal() as s:
        s.add(Category(name="Roupas"))
        await s.commit()
    cats = (await client.get("/categorias", headers=auth_vendedor)).json()["items"]
    resp = await client.post(
        "/produtos",
        headers=auth_vendedor,
        json={
            "categoria_id": cats[0]["id"],
            "nome": "Regata",
            "variantes": [{"tamanho": "P", "preco_custo": "0", "preco_venda": "30.00"}],
        },
    )
    assert resp.status_code == 201, resp.text
    p = resp.json()
    assert (p["ncm"], p["cest"], p["origem"], p["cfop"]) == (None, None, 0, "5102")


@pytest.mark.parametrize(
    "campo, valor",
    [("ncm", "6109.10"), ("ncm", "6109101A"), ("cest", "123456"), ("cfop", "51020"), ("origem", 9)],
)
async def test_codigo_fiscal_fora_do_formato_e_recusado(client, auth_admin, campo, valor) -> None:
    cat = (await client.post("/categorias", headers=auth_admin, json={"nome": "Roupas"})).json()
    resp = await client.post(
        "/produtos",
        headers=auth_admin,
        json={
            "categoria_id": cat["id"],
            "nome": "Peça",
            campo: valor,
            "variantes": [{"tamanho": "P", "preco_custo": "1.00", "preco_venda": "2.00"}],
        },
    )
    assert resp.status_code == 422, resp.text


async def test_dados_fiscais_da_loja_so_o_dono_muda(client, auth_admin, auth_gerente) -> None:
    resp = await client.patch("/configuracao", headers=auth_gerente, json={"regime_tributario": 1})
    assert resp.status_code == 403

    loja = await _configurar_loja(client, auth_admin, serie_nfce=3)
    assert (loja["regime_tributario"], loja["inscricao_estadual"], loja["serie_nfce"]) == (
        1,
        "110042490114",
        3,
    )
    # Série nula não apaga: volta a valer a que estava.
    resp = await client.patch("/configuracao", headers=auth_admin, json={"serie_nfce": None})
    assert resp.json()["serie_nfce"] == 3
    for invalido in (
        {"regime_tributario": 4},
        {"inscricao_estadual": "ISENTO"},
        {"serie_nfce": 900},
    ):
        resp = await client.patch("/configuracao", headers=auth_admin, json=invalido)
        assert resp.status_code == 422, invalido

    # Quem só está logado lê (o recibo imprime); quem não entrou, não.
    publica = (await client.get("/configuracao")).json()
    assert "inscricao_estadual" not in publica


# ------------------------------------------------------------------ emissor desligado
async def test_emissor_desligado_responde_409_dizendo_o_que_falta(
    client, auth_admin, pecas
) -> None:
    venda = await _vender(client, auth_admin, [(pecas["camiseta"], 1)], [("DINHEIRO", "49.90")])

    resp = await client.post(f"/vendas/{venda['id']}/nfce", headers=auth_admin)
    assert resp.status_code == 409
    corpo = resp.json()
    assert corpo["code"] == "EMISSOR_NAO_CONFIGURADO"
    assert any("FISCAL_EMISSOR" in f for f in corpo["detail"]["faltando"])

    situacao = (await client.get(f"/vendas/{venda['id']}/nfce", headers=auth_admin)).json()
    assert situacao["nota"] is None
    assert situacao["emissor"] == {
        "nome": "desligado",
        "ambiente": None,
        "configurado": False,
        "faltando": corpo["detail"]["faltando"],
        "emitir_automatico": False,
    }


async def test_focus_sem_token_tambem_e_409(client, auth_admin, pecas, monkeypatch) -> None:
    monkeypatch.setattr(settings, "fiscal_emissor", "focusnfe")
    monkeypatch.setattr(settings, "focusnfe_token", SecretStr("  "))
    venda = await _vender(client, auth_admin, [(pecas["camiseta"], 1)], [("PIX", "49.90")])
    resp = await client.post(f"/vendas/{venda['id']}/nfce", headers=auth_admin)
    assert resp.status_code == 409
    assert any("FOCUSNFE_TOKEN" in f for f in resp.json()["detail"]["faltando"])


# ------------------------------------------------------------------ emissão
async def test_emissao_autorizada_manda_a_venda_inteira_para_a_focus(
    client, auth_admin, pecas, focus
) -> None:
    await _configurar_loja(client, auth_admin)
    # 2 camisetas (99,80) + 1 calça (149,90) = 249,70, com R$ 10,00 de desconto = 239,70.
    venda = await _vender(
        client,
        auth_admin,
        [(pecas["camiseta"], 2), (pecas["calca"], 1)],
        [("DINHEIRO", "100.00"), ("CREDITO", "139.70")],
        desconto="10.00",
    )

    resp = await client.post(f"/vendas/{venda['id']}/nfce", headers=auth_admin)
    assert resp.status_code == 200, resp.text
    nota = resp.json()["nota"]
    assert nota["status"] == "AUTORIZADA"
    assert nota["chave"] == _chave(1) and len(nota["chave"]) == 44
    assert nota["numero"] == 1 and nota["serie"] == 1
    assert nota["ambiente"] == "homologacao" and nota["tentativas"] == 1
    assert nota["url_danfe"].startswith(
        "https://homologacao.focusnfe.com.br/notas_fiscais_consumidor/"
    )
    assert nota["url_xml"].startswith("https://homologacao.focusnfe.com.br/arquivos/")
    assert nota["referencia"].startswith(f"venda-{venda['id']}-")

    (pedido,) = focus.de("POST")
    assert str(pedido.url).startswith("https://homologacao.focusnfe.com.br/v2/nfce?ref=")
    assert pedido.url.params["ref"] == nota["referencia"]
    # HTTP Basic: token como usuário, senha vazia.
    assert pedido.headers["authorization"] == httpx.BasicAuth(TOKEN, "")._auth_header

    payload = json.loads(pedido.content)
    assert payload["cnpj_emitente"] == CNPJ
    assert payload["serie"] == "1"
    assert payload["presenca_comprador"] == "1" and payload["natureza_operacao"]
    camiseta, calca = payload["items"]
    assert camiseta["descricao"] == DESCRICAO_HOMOLOGACAO  # regra da SEFAZ em homologação
    assert calca["descricao"] == "Calça Jeans M Azul"
    assert (camiseta["codigo_ncm"], camiseta["cfop"], camiseta["icms_origem"]) == (
        "61091000",
        "5102",
        "0",
    )
    assert camiseta["icms_situacao_tributaria"] == "102"
    assert (calca["codigo_ncm"], calca["cfop"], calca["icms_origem"], calca["cest"]) == (
        "62034200",
        "5405",
        "2",
        "2803800",
    )
    assert calca["icms_situacao_tributaria"] == "500"  # 5405 = ICMS já pago por ST
    assert camiseta["quantidade_comercial"] == "2.0000"
    assert (camiseta["valor_unitario_comercial"], camiseta["valor_bruto"]) == ("49.90", "99.80")
    # Desconto rateado pelo valor de cada item, fechando ao centavo.
    descontos = [Decimal(i.get("valor_desconto", "0")) for i in payload["items"]]
    assert sum(descontos) == Decimal("10.00")
    assert descontos == [Decimal("3.99"), Decimal("6.01")]
    assert payload["formas_pagamento"] == [
        {"forma_pagamento": "01", "valor_pagamento": "100.00"},
        {"forma_pagamento": "03", "valor_pagamento": "139.70", "tipo_integracao": "2"},
    ]
    # O token não volta em resposta nenhuma.
    assert TOKEN not in resp.text


async def test_nota_autorizada_nao_e_emitida_de_novo(client, auth_admin, pecas, focus) -> None:
    await _configurar_loja(client, auth_admin)
    venda = await _vender(client, auth_admin, [(pecas["camiseta"], 1)], [("PIX", "49.90")])
    primeira = (await client.post(f"/vendas/{venda['id']}/nfce", headers=auth_admin)).json()
    segunda = await client.post(f"/vendas/{venda['id']}/nfce", headers=auth_admin)
    assert segunda.status_code == 200
    assert segunda.json()["nota"]["chave"] == primeira["nota"]["chave"]
    assert len(focus.pedidos) == 1  # o segundo clique nem chegou à Focus


async def test_dois_cliques_simultaneos_saem_com_uma_nota_so(
    client, auth_admin, pecas, focus
) -> None:
    await _configurar_loja(client, auth_admin)
    venda = await _vender(client, auth_admin, [(pecas["camiseta"], 1)], [("PIX", "49.90")])
    r1, r2 = await asyncio.gather(
        client.post(f"/vendas/{venda['id']}/nfce", headers=auth_admin),
        client.post(f"/vendas/{venda['id']}/nfce", headers=auth_admin),
    )
    assert r1.status_code == r2.status_code == 200
    assert r1.json()["nota"]["chave"] == r2.json()["nota"]["chave"]
    assert len(focus.de("POST")) == 1


async def test_rejeitada_guarda_o_motivo_e_tenta_de_novo_com_a_mesma_referencia(
    client, auth_admin, pecas, focus
) -> None:
    await _configurar_loja(client, auth_admin)
    venda = await _vender(client, auth_admin, [(pecas["camiseta"], 1)], [("DEBITO", "49.90")])
    focus.ao_emitir = "rejeitar"
    nota = (await client.post(f"/vendas/{venda['id']}/nfce", headers=auth_admin)).json()["nota"]
    assert nota["status"] == "REJEITADA"
    assert "NCM inexistente" in nota["mensagem"]
    assert nota["chave"] is None

    focus.ao_emitir = "autorizar"
    de_novo = (await client.post(f"/vendas/{venda['id']}/nfce", headers=auth_admin)).json()["nota"]
    assert de_novo["status"] == "AUTORIZADA" and de_novo["tentativas"] == 2
    refs = {p.url.params["ref"] for p in focus.de("POST")}
    assert refs == {nota["referencia"]}  # mesma referência: nunca uma segunda nota


async def test_processando_fica_pendente_e_a_proxima_tentativa_consulta(
    client, auth_admin, pecas, focus
) -> None:
    await _configurar_loja(client, auth_admin)
    venda = await _vender(client, auth_admin, [(pecas["camiseta"], 1)], [("PIX", "49.90")])
    focus.ao_emitir = "processando"
    nota = (await client.post(f"/vendas/{venda['id']}/nfce", headers=auth_admin)).json()["nota"]
    assert nota["status"] == "PENDENTE"

    nota = (await client.post(f"/vendas/{venda['id']}/nfce", headers=auth_admin)).json()["nota"]
    assert nota["status"] == "AUTORIZADA"
    assert len(focus.de("POST")) == 1 and len(focus.de("GET")) == 1  # consultou, não reenviou


async def test_sem_rede_fica_pendente_para_tentar_de_novo(client, auth_admin, pecas, focus) -> None:
    await _configurar_loja(client, auth_admin)
    venda = await _vender(client, auth_admin, [(pecas["camiseta"], 1)], [("PIX", "49.90")])
    focus.ao_emitir = "sem_rede"
    resp = await client.post(f"/vendas/{venda['id']}/nfce", headers=auth_admin)
    assert resp.status_code == 200
    nota = resp.json()["nota"]
    assert nota["status"] == "PENDENTE" and "Sem resposta do emissor" in nota["mensagem"]
    assert TOKEN not in resp.text

    focus.ao_emitir = "autorizar"
    nota = (await client.post(f"/vendas/{venda['id']}/nfce", headers=auth_admin)).json()["nota"]
    # Consultou (não achou: nunca chegou lá) e então enviou.
    assert nota["status"] == "AUTORIZADA" and nota["tentativas"] == 2
    assert [p.method for p in focus.pedidos] == ["POST", "GET", "POST"]


@pytest.mark.parametrize(
    "falha, status, trecho",
    [
        ("token_errado", "PENDENTE", "confira o token"),
        ("fora_do_ar", "PENDENTE", "HTTP 503"),
        ("sem_csc", "REJEITADA", "CSC não configurado"),
        ("limite", "PENDENTE", "HTTP 429"),
        ("proxy", "PENDENTE", "HTTP 400"),
    ],
)
async def test_recusa_do_emissor_vira_mensagem_na_nota(
    client, auth_admin, pecas, focus, falha, status, trecho
) -> None:
    """Token errado e emissor fora do ar ficam PENDENTE (o problema não é a nota: acertado
    o painel, tenta-se de novo); erro de cadastro no emissor vira REJEITADA com o motivo.
    Limite de pedidos (429) e 4xx que a Focus não documenta também são PENDENTE: REJEITADA
    é resposta definitiva, e libera cancelar a venda sem perguntar ao emissor."""
    await _configurar_loja(client, auth_admin)
    venda = await _vender(client, auth_admin, [(pecas["camiseta"], 1)], [("PIX", "49.90")])
    focus.ao_emitir = falha
    resp = await client.post(f"/vendas/{venda['id']}/nfce", headers=auth_admin)
    assert resp.status_code == 200, resp.text
    nota = resp.json()["nota"]
    assert nota["status"] == status and trecho in nota["mensagem"]
    assert nota["chave"] is None
    assert TOKEN not in resp.text


async def test_resposta_perdida_nao_vira_duas_notas(client, auth_admin, pecas, focus) -> None:
    """A Focus autorizou, mas a resposta caiu no caminho: o "tentar de novo" acha a nota
    que já existe em vez de emitir outra (imposto pago duas vezes)."""
    await _configurar_loja(client, auth_admin)
    venda = await _vender(client, auth_admin, [(pecas["camiseta"], 1)], [("PIX", "49.90")])
    focus.ao_emitir = "perder_resposta"
    nota = (await client.post(f"/vendas/{venda['id']}/nfce", headers=auth_admin)).json()["nota"]
    assert nota["status"] == "PENDENTE"

    focus.ao_emitir = "autorizar"
    nota = (await client.post(f"/vendas/{venda['id']}/nfce", headers=auth_admin)).json()["nota"]
    assert nota["status"] == "AUTORIZADA" and nota["chave"] == _chave(1)
    assert len(focus.de("POST")) == 1 and focus.numero == 1


async def test_tentar_de_novo_com_o_emissor_no_limite_nao_rejeita_nem_reenvia(
    client, auth_admin, pecas, focus
) -> None:
    """O "Tentar de novo" consulta antes de reenviar. Consulta com 429 não diz nada da nota:
    fica PENDENTE, sem POST novo. Antes virava REJEITADA aqui com a nota autorizada lá, e o
    cancelamento da venda depois nem falava com o emissor."""
    await _configurar_loja(client, auth_admin)
    venda = await _vender(client, auth_admin, [(pecas["camiseta"], 1)], [("PIX", "49.90")])
    focus.ao_emitir = "perder_resposta"
    await client.post(f"/vendas/{venda['id']}/nfce", headers=auth_admin)

    focus.ao_emitir = "limite"
    focus.consulta_falha = (429, {"json": {"codigo": "limite", "mensagem": "Aguarde."}})
    nota = (await client.post(f"/vendas/{venda['id']}/nfce", headers=auth_admin)).json()["nota"]
    assert nota["status"] == "PENDENTE" and "HTTP 429" in nota["mensagem"]
    assert len(focus.de("POST")) == 1  # não reenviou às cegas

    focus.consulta_falha = None
    nota = (await client.post(f"/vendas/{venda['id']}/nfce", headers=auth_admin)).json()["nota"]
    assert nota["status"] == "AUTORIZADA" and nota["chave"] == _chave(1)
    assert len(focus.de("POST")) == 1 and focus.numero == 1


async def test_referencia_ja_autorizada_e_consultada_em_vez_de_reemitida(
    client, auth_admin, pecas, focus
) -> None:
    """Se a linha local se perdeu mas a Focus já autorizou a referência (422
    already_processed), o adaptador consulta e traz a nota que vale."""
    await _configurar_loja(client, auth_admin)
    venda = await _vender(client, auth_admin, [(pecas["camiseta"], 1)], [("PIX", "49.90")])
    focus.ao_emitir = "perder_resposta"
    ref = (await client.post(f"/vendas/{venda['id']}/nfce", headers=auth_admin)).json()["nota"][
        "referencia"
    ]

    falsa = FocusNFe(TOKEN, Ambiente.HOMOLOGACAO, transport=httpx.MockTransport(focus))
    from app.modules.fiscal.emissores import NotaParaEmitir

    vazia = NotaParaEmitir(CNPJ, 1, 1, __import__("datetime").datetime.now(), Decimal("0"), [], [])
    resultado = await falsa.emitir(ref, vazia)
    assert resultado.status == "AUTORIZADA" and resultado.chave == _chave(1)
    assert [p.method for p in focus.pedidos][-2:] == ["POST", "GET"]


async def test_produto_sem_ncm_recusa_listando_o_que_falta(
    client, auth_admin, pecas, focus
) -> None:
    await _configurar_loja(client, auth_admin)
    venda = await _vender(
        client, auth_admin, [(pecas["camiseta"], 1), (pecas["bone"], 1)], [("PIX", "89.80")]
    )
    resp = await client.post(f"/vendas/{venda['id']}/nfce", headers=auth_admin)
    assert resp.status_code == 409
    corpo = resp.json()
    assert corpo["code"] == "DADOS_FISCAIS_INCOMPLETOS"
    assert corpo["detail"]["produtos_sem_ncm"] == [
        {"produto_id": pecas["bone_produto"], "produto": "Boné Aba Reta"}
    ]
    assert any("Boné Aba Reta" in f for f in corpo["detail"]["faltando"])
    assert focus.pedidos == []  # nada foi à Focus
    assert (await client.get(f"/vendas/{venda['id']}/nfce", headers=auth_admin)).json()[
        "nota"
    ] is None

    # Corrigido o cadastro, a mesma venda emite.
    await client.patch(
        f"/produtos/{pecas['bone_produto']}", headers=auth_admin, json={"ncm": "65050090"}
    )
    resp = await client.post(f"/vendas/{venda['id']}/nfce", headers=auth_admin)
    assert resp.json()["nota"]["status"] == "AUTORIZADA"


async def test_loja_sem_cnpj_ie_e_regime_recusa(client, auth_admin, pecas, focus) -> None:
    venda = await _vender(client, auth_admin, [(pecas["camiseta"], 1)], [("PIX", "49.90")])
    await client.patch("/configuracao", headers=auth_admin, json={"documento": "123.456.789-09"})
    resp = await client.post(f"/vendas/{venda['id']}/nfce", headers=auth_admin)
    assert resp.status_code == 409
    faltando = " | ".join(resp.json()["detail"]["faltando"])
    assert "CNPJ" in faltando and "Inscrição estadual" in faltando and "Regime" in faltando

    await _configurar_loja(client, auth_admin, regime_tributario=3)
    resp = await client.post(f"/vendas/{venda['id']}/nfce", headers=auth_admin)
    assert resp.status_code == 409
    assert any("Regime Normal" in f for f in resp.json()["detail"]["faltando"])
    assert focus.pedidos == []


async def test_vendedora_so_ve_e_emite_a_nota_das_proprias_vendas(
    client, auth_admin, auth_vendedor, pecas, focus
) -> None:
    await _configurar_loja(client, auth_admin)
    da_dona = await _vender(client, auth_admin, [(pecas["camiseta"], 1)], [("PIX", "49.90")])
    dela = await _vender(client, auth_vendedor, [(pecas["camiseta"], 1)], [("PIX", "49.90")])

    assert (
        await client.post(f"/vendas/{da_dona['id']}/nfce", headers=auth_vendedor)
    ).status_code == 404
    assert (
        await client.get(f"/vendas/{da_dona['id']}/nfce", headers=auth_vendedor)
    ).status_code == 404
    resp = await client.post(f"/vendas/{dela['id']}/nfce", headers=auth_vendedor)
    assert resp.status_code == 200 and resp.json()["nota"]["status"] == "AUTORIZADA"
    # E a resposta não carrega custo nem lucro.
    assert "custo" not in resp.text and "lucro" not in resp.text


async def test_fiado_e_pix_viram_codigos_da_sefaz(client, auth_admin, pecas, focus) -> None:
    await _configurar_loja(client, auth_admin)
    cliente = (
        await client.post(
            "/clientes", headers=auth_admin, json={"nome": "Dona Cida", "telefone": "11999990000"}
        )
    ).json()
    venda = await _vender(
        client,
        auth_admin,
        [(pecas["camiseta"], 1)],
        [("PIX", "20.00"), ("FIADO", "29.90")],
        cliente_id=cliente["id"],
    )
    await client.post(f"/vendas/{venda['id']}/nfce", headers=auth_admin)
    payload = json.loads(focus.de("POST")[0].content)
    assert payload["formas_pagamento"] == [
        {"forma_pagamento": "17", "valor_pagamento": "20.00", "tipo_integracao": "2"},
        {"forma_pagamento": "05", "valor_pagamento": "29.90"},
    ]


def test_vale_vira_outros_com_descricao_e_todas_as_formas_tem_codigo() -> None:
    """VALE → 99 "Vale-troca" (a SEFAZ rejeita 99 sem descrição — 441). Forma nova no PDV
    sem código aqui quebra este teste, e não a nota da loja."""
    assert set(TPAG) == set(FormaPagamento)
    venda = VendaOut(
        id=1,
        status="CONCLUIDA",
        vendedor_id=1,
        vendedor="Ana",
        subtotal=Decimal("50.00"),
        desconto=Decimal("0.00"),
        total=Decimal("50.00"),
        quantidade_pecas=1,
        vendida_em=__import__("datetime").datetime.now(),
        itens=[
            ItemVendaOut(
                id=1,
                variante_id=7,
                produto="Saia",
                tamanho="M",
                cor="Preta",
                codigo_barras="789",
                quantidade=1,
                quantidade_devolvida=0,
                preco_unitario=Decimal("50.00"),
                total_item=Decimal("50.00"),
            )
        ],
        pagamentos=[
            PagamentoOut(forma="VALE", valor=Decimal("30.00")),
            PagamentoOut(forma="DINHEIRO", valor=Decimal("20.00")),
        ],
    )
    peca = DadosFiscaisPecaOut(
        variante_id=7,
        produto_id=1,
        produto="Saia",
        tamanho="M",
        cor="Preta",
        codigo_barras="789",
        ncm="62045200",
        cest=None,
        origem=0,
        cfop="5102",
    )
    loja = DadosDaLoja(documento=CNPJ, inscricao_estadual="1", regime_tributario=1, serie_nfce=1)
    nota = montar_nota(venda, loja, {7: peca}, __import__("datetime").datetime.now())
    payload = montar_payload(nota, Ambiente.PRODUCAO)
    assert payload["formas_pagamento"] == [
        {"forma_pagamento": "99", "valor_pagamento": "30.00", "descricao_pagamento": "Vale-troca"},
        {"forma_pagamento": "01", "valor_pagamento": "20.00"},
    ]
    assert payload["items"][0]["descricao"] == "Saia M Preta"  # produção: o nome de verdade


def test_rateio_do_desconto_fecha_ao_centavo_sem_passar_do_item() -> None:
    assert ratear_desconto([Decimal("99.80"), Decimal("149.90")], Decimal("10.00")) == [
        Decimal("3.99"),
        Decimal("6.01"),
    ]
    tres = ratear_desconto([Decimal("10.00")] * 3, Decimal("10.00"))
    assert sum(tres) == Decimal("10.00") and max(tres) - min(tres) == Decimal("0.01")
    # Desconto do tamanho da venda: cada item zera, nenhum fica negativo.
    assert ratear_desconto([Decimal("0.01"), Decimal("0.02")], Decimal("0.03")) == [
        Decimal("0.01"),
        Decimal("0.02"),
    ]
    assert ratear_desconto([Decimal("5.00")], Decimal("0")) == [Decimal("0.00")]


# ------------------------------------------------------------------ cancelamento da venda
async def _venda_com_nota(client, auth_admin, pecas) -> dict:
    await _configurar_loja(client, auth_admin)
    venda = await _vender(client, auth_admin, [(pecas["camiseta"], 2)], [("CREDITO", "99.80")])
    nota = (await client.post(f"/vendas/{venda['id']}/nfce", headers=auth_admin)).json()["nota"]
    assert nota["status"] == "AUTORIZADA"
    return {**venda, "nota": nota}


def _cair_depois_do_proximo_envio(monkeypatch: pytest.MonkeyPatch, venda_id: int) -> list[dict]:
    """O processo cai logo depois de a Focus responder ao próximo POST: lá a nota foi
    processada, aqui a resposta nunca é gravada. Devolve, para cada POST, o que estava
    COMMITADO na linha da nota naquele instante (lido por outra conexão)."""
    no_banco: list[dict] = []
    original = FocusFalsa.__call__

    async def cai(self, request: httpx.Request) -> httpx.Response:
        if request.method == "POST":
            async with engine.connect() as conn:
                linha = (
                    await conn.execute(
                        text(
                            "SELECT referencia, ambiente, status, tentativas "
                            "FROM notas_fiscais WHERE sale_id = :v"
                        ),
                        {"v": venda_id},
                    )
                ).one()
            no_banco.append({"ref": request.url.params["ref"], **linha._asdict()})
        resp = await original(self, request)
        if request.method == "POST" and len(no_banco) == 1:
            raise RuntimeError("o processo caiu depois de o emissor responder")
        return resp

    monkeypatch.setattr(FocusFalsa, "__call__", cai)
    return no_banco


async def test_cancelar_venda_cancela_a_nota_no_emissor_antes(
    client, auth_admin, pecas, focus
) -> None:
    venda = await _venda_com_nota(client, auth_admin, pecas)
    resp = await client.post(
        f"/vendas/{venda['id']}/cancelamento",
        headers=auth_admin,
        json={"motivo": "cliente desistiu da compra"},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "CANCELADA"
    (pedido,) = focus.de("DELETE")
    assert pedido.url.path == f"/v2/nfce/{venda['nota']['referencia']}"
    assert json.loads(pedido.content) == {"justificativa": "cliente desistiu da compra"}

    nota = (await client.get(f"/vendas/{venda['id']}/nfce", headers=auth_admin)).json()["nota"]
    assert nota["status"] == "CANCELADA" and nota["cancelada_em"] is not None
    assert nota["chave"] == venda["nota"]["chave"]
    assert await _saldo(client, auth_admin, pecas["camiseta"]) == 10


async def test_emissor_recusa_cancelar_a_nota_e_a_venda_continua_concluida(
    client, auth_admin, pecas, focus
) -> None:
    """Passados 30 minutos a SEFAZ não cancela NFC-e. Cancelar só a venda deixaria uma nota
    valendo sobre uma venda que não existe — então nada muda, e a tela diz por quê."""
    venda = await _venda_com_nota(client, auth_admin, pecas)
    focus.ao_cancelar = "recusar"
    resp = await client.post(
        f"/vendas/{venda['id']}/cancelamento",
        headers=auth_admin,
        json={"motivo": "cliente desistiu da compra"},
    )
    assert resp.status_code == 409
    corpo = resp.json()
    assert "NÃO foi cancelada" in corpo["message"] and "Prazo de cancelamento" in corpo["message"]

    assert (await client.get(f"/vendas/{venda['id']}", headers=auth_admin)).json()[
        "status"
    ] == "CONCLUIDA"
    nota = (await client.get(f"/vendas/{venda['id']}/nfce", headers=auth_admin)).json()["nota"]
    assert nota["status"] == "AUTORIZADA"
    assert await _saldo(client, auth_admin, pecas["camiseta"]) == 8  # estoque não voltou

    focus.ao_cancelar = "sem_rede"
    resp = await client.post(
        f"/vendas/{venda['id']}/cancelamento",
        headers=auth_admin,
        json={"motivo": "cliente desistiu da compra"},
    )
    assert resp.status_code == 409
    assert (await client.get(f"/vendas/{venda['id']}", headers=auth_admin)).json()[
        "status"
    ] == "CONCLUIDA"


async def test_motivo_curto_com_nota_autorizada_nao_cancela_nada(
    client, auth_admin, pecas, focus
) -> None:
    venda = await _venda_com_nota(client, auth_admin, pecas)
    resp = await client.post(
        f"/vendas/{venda['id']}/cancelamento", headers=auth_admin, json={"motivo": "erro"}
    )
    assert resp.status_code == 422
    assert resp.json()["detail"] == {"minimo": 15}
    assert focus.de("DELETE") == []
    assert (await client.get(f"/vendas/{venda['id']}", headers=auth_admin)).json()[
        "status"
    ] == "CONCLUIDA"


async def test_venda_sem_nota_cancela_sem_falar_com_o_emissor(
    client, auth_admin, pecas, focus
) -> None:
    venda = await _vender(client, auth_admin, [(pecas["camiseta"], 1)], [("PIX", "49.90")])
    resp = await client.post(
        f"/vendas/{venda['id']}/cancelamento", headers=auth_admin, json={"motivo": "erro"}
    )
    assert resp.status_code == 200
    assert focus.pedidos == []
    # E venda cancelada não emite nota depois.
    await _configurar_loja(client, auth_admin)
    resp = await client.post(f"/vendas/{venda['id']}/nfce", headers=auth_admin)
    assert resp.status_code == 409 and resp.json()["code"] == "OPERACAO_INVALIDA"


async def test_nota_autorizada_com_emissor_desligado_trava_o_cancelamento(
    client, auth_admin, pecas, focus, monkeypatch
) -> None:
    """Nota de PRODUÇÃO sem emissor para cancelá-la: a venda não cancela (seria imposto
    sobre uma venda que não existe). Nota de homologação, sem valor fiscal, não segura."""
    monkeypatch.setattr(settings, "focusnfe_ambiente", "producao")
    venda = await _venda_com_nota(client, auth_admin, pecas)
    monkeypatch.setattr(settings, "fiscal_emissor", "desligado")
    resp = await client.post(
        f"/vendas/{venda['id']}/cancelamento",
        headers=auth_admin,
        json={"motivo": "cliente desistiu da compra"},
    )
    assert resp.status_code == 409 and resp.json()["code"] == "EMISSOR_NAO_CONFIGURADO"
    assert (await client.get(f"/vendas/{venda['id']}", headers=auth_admin)).json()[
        "status"
    ] == "CONCLUIDA"

    # A mesma coisa com uma nota de homologação: cancela, sem falar com ninguém.
    monkeypatch.setattr(settings, "fiscal_emissor", "focusnfe")
    monkeypatch.setattr(settings, "focusnfe_ambiente", "homologacao")
    teste = await _vender(client, auth_admin, [(pecas["camiseta"], 1)], [("PIX", "49.90")])
    await client.post(f"/vendas/{teste['id']}/nfce", headers=auth_admin)
    monkeypatch.setattr(settings, "fiscal_emissor", "desligado")
    pedidos_antes = len(focus.pedidos)
    resp = await client.post(
        f"/vendas/{teste['id']}/cancelamento", headers=auth_admin, json={"motivo": "teste"}
    )
    assert resp.status_code == 200, resp.text
    assert len(focus.pedidos) == pedidos_antes


async def test_nota_pendente_e_consultada_antes_de_cancelar_a_venda(
    client, auth_admin, pecas, focus
) -> None:
    """Sem resposta, a nota pode ter sido autorizada. Cancelar a venda sem perguntar
    deixaria essa nota valendo."""
    await _configurar_loja(client, auth_admin)
    venda = await _vender(client, auth_admin, [(pecas["camiseta"], 1)], [("PIX", "49.90")])
    focus.ao_emitir = "perder_resposta"
    await client.post(f"/vendas/{venda['id']}/nfce", headers=auth_admin)

    resp = await client.post(
        f"/vendas/{venda['id']}/cancelamento",
        headers=auth_admin,
        json={"motivo": "cliente desistiu da compra"},
    )
    assert resp.status_code == 200, resp.text
    assert [p.method for p in focus.pedidos] == ["POST", "GET", "DELETE"]
    nota = (await client.get(f"/vendas/{venda['id']}/nfce", headers=auth_admin)).json()["nota"]
    assert nota["status"] == "CANCELADA"


async def test_nota_pendente_que_nunca_chegou_nao_impede_cancelar(
    client, auth_admin, pecas, focus
) -> None:
    await _configurar_loja(client, auth_admin)
    venda = await _vender(client, auth_admin, [(pecas["camiseta"], 1)], [("PIX", "49.90")])
    focus.ao_emitir = "sem_rede"
    await client.post(f"/vendas/{venda['id']}/nfce", headers=auth_admin)
    resp = await client.post(
        f"/vendas/{venda['id']}/cancelamento", headers=auth_admin, json={"motivo": "erro"}
    )
    assert resp.status_code == 200, resp.text
    nota = (await client.get(f"/vendas/{venda['id']}/nfce", headers=auth_admin)).json()["nota"]
    assert nota["status"] == "REJEITADA" and "nenhuma nota vale" in nota["mensagem"]


async def test_queda_ao_reenviar_nota_rejeitada_nao_libera_cancelar_sem_perguntar(
    client, auth_admin, pecas, focus, monkeypatch
) -> None:
    """A rejeitada, corrigida, vai de novo e a Focus autoriza; o processo cai antes de
    gravar a resposta. Antes a linha ficava REJEITADA (só a resposta mudava o status), e
    cancelar a venda passava sem falar com o emissor — com a NFC-e AUTORIZADA lá. Agora o
    envio é anotado e commitado ANTES do POST: PENDENTE, com a tentativa contada."""
    await _configurar_loja(client, auth_admin)
    venda = await _vender(client, auth_admin, [(pecas["camiseta"], 1)], [("PIX", "49.90")])
    focus.ao_emitir = "rejeitar"
    nota = (await client.post(f"/vendas/{venda['id']}/nfce", headers=auth_admin)).json()["nota"]
    assert nota["status"] == "REJEITADA" and nota["tentativas"] == 1

    focus.ao_emitir = "autorizar"
    no_banco = _cair_depois_do_proximo_envio(monkeypatch, venda["id"])
    with pytest.raises(RuntimeError):
        await client.post(f"/vendas/{venda['id']}/nfce", headers=auth_admin)
    assert (no_banco[0]["status"], no_banco[0]["tentativas"]) == ("PENDENTE", 2)
    assert focus.notas[nota["referencia"]]["status"] == "autorizado"

    resp = await client.post(
        f"/vendas/{venda['id']}/cancelamento",
        headers=auth_admin,
        json={"motivo": "cliente desistiu da compra"},
    )
    assert resp.status_code == 200, resp.text
    assert [p.method for p in focus.pedidos][-2:] == ["GET", "DELETE"]
    assert focus.notas[nota["referencia"]]["status"] == "cancelado"


async def test_cancelar_no_vao_entre_anotar_o_envio_e_enviar_nao_deixa_a_nota_sair(
    client, auth_admin, pecas, focus, monkeypatch
) -> None:
    """Anotar o envio antes do POST é um commit, e o commit solta a trava da linha. Um
    cancelamento da venda que entre nesse vão pergunta ao emissor (nada chegou lá) e
    cancela; a emissão retrava, relê a venda e não manda nada — nota de uma venda que
    não existe mais é imposto sobre nada."""
    await _configurar_loja(client, auth_admin)
    venda = await _vender(client, auth_admin, [(pecas["camiseta"], 1)], [("PIX", "49.90")])
    original = FiscalService._travar_para_emitir
    chamadas: list[int] = []
    cancelamento: list = []

    async def travar(self, *args, **kwargs):
        chamadas.append(1)
        if len(chamadas) == 2:  # a retrava, logo depois de o envio ser anotado
            cancelamento.append(
                await client.post(
                    f"/vendas/{venda['id']}/cancelamento",
                    headers=auth_admin,
                    json={"motivo": "cliente desistiu da compra"},
                )
            )
        return await original(self, *args, **kwargs)

    monkeypatch.setattr(FiscalService, "_travar_para_emitir", travar)
    resp = await client.post(f"/vendas/{venda['id']}/nfce", headers=auth_admin)
    assert cancelamento[0].status_code == 200, cancelamento[0].text
    assert resp.status_code == 409 and "Venda cancelada" in resp.json()["message"]
    assert focus.de("POST") == [] and [p.method for p in focus.pedidos] == ["GET"]
    nota = (await client.get(f"/vendas/{venda['id']}/nfce", headers=auth_admin)).json()["nota"]
    assert nota["status"] == "REJEITADA" and "nenhuma nota vale" in nota["mensagem"]


@pytest.mark.parametrize(
    "falha",
    [
        pytest.param((429, {"json": {"codigo": "limite", "mensagem": "Aguarde."}}), id="429"),
        pytest.param((429, {"text": "Retry later"}), id="429-sem-corpo"),
        pytest.param((408, {"text": "Request Timeout"}), id="408"),
        pytest.param((400, {"json": {"codigo": "novo", "mensagem": "?"}}), id="4xx-desconhecido"),
        pytest.param((404, {"text": "<html>Not Found</html>"}), id="404-de-proxy"),
        pytest.param((503, {"text": "<html>Service Unavailable</html>"}), id="503"),
    ],
)
async def test_consulta_sem_resposta_definitiva_nao_libera_cancelar_a_venda(
    client, auth_admin, pecas, focus, falha
) -> None:
    """A 1ª emissão foi autorizada lá e a resposta se perdeu (PENDENTE). Ao cancelar a
    venda, a consulta leva 429, 4xx que a Focus não documenta ou 5xx — nada disso diz que a
    nota não existe. Antes virava REJEITADA ("nenhuma nota vale"), sem DELETE, e a venda
    cancelava com a NFC-e AUTORIZADA na SEFAZ. Só o 404 `nfce_nao_encontrada` libera."""
    await _configurar_loja(client, auth_admin)
    venda = await _vender(client, auth_admin, [(pecas["camiseta"], 1)], [("PIX", "49.90")])
    focus.ao_emitir = "perder_resposta"
    nota = (await client.post(f"/vendas/{venda['id']}/nfce", headers=auth_admin)).json()["nota"]
    assert nota["status"] == "PENDENTE"
    assert focus.notas[nota["referencia"]]["status"] == "autorizado"

    focus.consulta_falha = falha
    motivo = {"motivo": "cliente desistiu da compra"}
    resp = await client.post(f"/vendas/{venda['id']}/cancelamento", headers=auth_admin, json=motivo)
    assert resp.status_code == 409, resp.text
    assert "Não deu para confirmar com o emissor" in resp.json()["message"]
    assert focus.de("DELETE") == []
    depois = (await client.get(f"/vendas/{venda['id']}/nfce", headers=auth_admin)).json()["nota"]
    assert depois["status"] == "PENDENTE"
    venda_agora = (await client.get(f"/vendas/{venda['id']}", headers=auth_admin)).json()
    assert venda_agora["status"] == "CONCLUIDA"

    # O emissor voltou a responder: a consulta acha a nota autorizada e ela cai antes.
    focus.consulta_falha = None
    resp = await client.post(f"/vendas/{venda['id']}/cancelamento", headers=auth_admin, json=motivo)
    assert resp.status_code == 200, resp.text
    assert len(focus.de("DELETE")) == 1
    assert focus.notas[nota["referencia"]]["status"] == "cancelado"


# ------------------------------------------------------------------ homologação → produção
async def test_ir_para_producao_reemite_a_nota_de_homologacao(
    client, auth_admin, pecas, focus, monkeypatch
) -> None:
    venda = await _venda_com_nota(client, auth_admin, pecas)
    monkeypatch.setattr(settings, "focusnfe_ambiente", "producao")
    nota = (await client.post(f"/vendas/{venda['id']}/nfce", headers=auth_admin)).json()["nota"]
    assert nota["ambiente"] == "producao" and nota["status"] == "AUTORIZADA"
    assert nota["referencia"] != venda["nota"]["referencia"]
    ultimo = focus.de("POST")[-1]
    assert str(ultimo.url).startswith("https://api.focusnfe.com.br/v2/nfce")
    assert json.loads(ultimo.content)["items"][0]["descricao"] == "Camiseta Lisa P Branca"


async def test_ir_para_producao_grava_a_referencia_nova_antes_do_primeiro_envio(
    client, auth_admin, pecas, focus, monkeypatch
) -> None:
    """A referência de produção só sai para o emissor depois de commitada, como a da linha
    nova (`garantir`). Antes, `_recomecar` a sorteava só em memória: se o processo caísse
    entre a autorização e o commit, o próximo clique sorteava outra — duas NFC-e em
    produção para a mesma venda."""
    venda = await _venda_com_nota(client, auth_admin, pecas)  # autorizada em homologação
    monkeypatch.setattr(settings, "focusnfe_ambiente", "producao")

    no_banco = _cair_depois_do_proximo_envio(monkeypatch, venda["id"])
    with pytest.raises(RuntimeError):
        await client.post(f"/vendas/{venda['id']}/nfce", headers=auth_admin)
    ref = no_banco[0]["ref"]
    assert ref != venda["nota"]["referencia"]
    assert (no_banco[0]["referencia"], no_banco[0]["ambiente"]) == (ref, "producao")

    nota = (await client.post(f"/vendas/{venda['id']}/nfce", headers=auth_admin)).json()["nota"]
    assert nota["status"] == "AUTORIZADA" and nota["ambiente"] == "producao"
    assert nota["referencia"] == ref  # a mesma: o emissor respondeu already_processed
    em_producao = {
        p.url.params["ref"]
        for p in focus.de("POST")
        if str(p.url).startswith("https://api.focusnfe.com.br")
    }
    assert em_producao == {ref}  # uma NFC-e em produção, não duas


async def test_queda_em_producao_nao_deixa_a_volta_para_homologacao_largar_a_nota(
    client, auth_admin, pecas, focus, monkeypatch
) -> None:
    """O processo cai depois de a Focus autorizar a nota de PRODUÇÃO. Antes, `tentativas`
    só ia ao banco junto com a resposta, e a linha ficava "produção / PENDENTE / 0" — cara
    de nunca enviada. Voltando o .env para homologação, "Emitir" largava essa referência
    (`_pode_recomecar`) e a venda cancelava com a NFC-e de produção valendo."""
    venda = await _venda_com_nota(client, auth_admin, pecas)  # autorizada em homologação
    monkeypatch.setattr(settings, "focusnfe_ambiente", "producao")
    no_banco = _cair_depois_do_proximo_envio(monkeypatch, venda["id"])
    with pytest.raises(RuntimeError):
        await client.post(f"/vendas/{venda['id']}/nfce", headers=auth_admin)
    r1 = no_banco[0]["ref"]
    assert focus.notas[r1]["status"] == "autorizado"
    assert (no_banco[0]["status"], no_banco[0]["tentativas"]) == ("PENDENTE", 1)

    monkeypatch.setattr(settings, "focusnfe_ambiente", "homologacao")
    resp = await client.post(f"/vendas/{venda['id']}/nfce", headers=auth_admin)
    assert resp.status_code == 409, resp.text  # não larga a nota de produção
    assert "confira no painel" in resp.json()["message"]
    motivo = {"motivo": "cliente desistiu da compra"}
    resp = await client.post(f"/vendas/{venda['id']}/cancelamento", headers=auth_admin, json=motivo)
    assert resp.status_code == 409, resp.text
    venda_agora = (await client.get(f"/vendas/{venda['id']}", headers=auth_admin)).json()
    assert venda_agora["status"] == "CONCLUIDA"

    # De volta à produção, o cancelamento pergunta pela R1 e a cancela antes da venda.
    monkeypatch.setattr(settings, "focusnfe_ambiente", "producao")
    resp = await client.post(f"/vendas/{venda['id']}/cancelamento", headers=auth_admin, json=motivo)
    assert resp.status_code == 200, resp.text
    assert focus.notas[r1]["status"] == "cancelado"
    assert {p.url.params.get("ref") for p in focus.de("POST")} == {
        venda["nota"]["referencia"],
        r1,
    }


# ------------------------------------------------------------------ emissão automática
async def test_emissao_automatica_vem_depois_da_venda(
    client, auth_admin, pecas, focus, monkeypatch
) -> None:
    await _configurar_loja(client, auth_admin)
    monkeypatch.setattr(settings, "fiscal_emitir_automatico", True)
    venda = await _vender(client, auth_admin, [(pecas["camiseta"], 1)], [("PIX", "49.90")])
    await automatico.aguardar_emissoes()
    nota = (await client.get(f"/vendas/{venda['id']}/nfce", headers=auth_admin)).json()["nota"]
    assert nota["status"] == "AUTORIZADA"


async def test_emissor_fora_do_ar_nunca_impede_vender(
    client, auth_admin, auth_vendedor, pecas, focus, monkeypatch
) -> None:
    await _configurar_loja(client, auth_admin)
    monkeypatch.setattr(settings, "fiscal_emitir_automatico", True)
    focus.ao_emitir = "sem_rede"
    venda = await _vender(client, auth_vendedor, [(pecas["camiseta"], 1)], [("PIX", "49.90")])
    sem_ncm = await _vender(client, auth_vendedor, [(pecas["bone"], 1)], [("PIX", "39.90")])
    await automatico.aguardar_emissoes()
    assert venda["status"] == sem_ncm["status"] == "CONCLUIDA"
    nota = (await client.get(f"/vendas/{venda['id']}/nfce", headers=auth_vendedor)).json()["nota"]
    assert nota["status"] == "PENDENTE"  # fica para o "Tentar de novo"
    assert (await client.get(f"/vendas/{sem_ncm['id']}/nfce", headers=auth_vendedor)).json()[
        "nota"
    ] is None

    # Emissor desligado + automático: vende igual, sem nota e sem erro.
    monkeypatch.setattr(settings, "fiscal_emissor", "desligado")
    mais_uma = await _vender(client, auth_vendedor, [(pecas["camiseta"], 1)], [("PIX", "49.90")])
    await automatico.aguardar_emissoes()
    assert (await client.get(f"/vendas/{mais_uma['id']}/nfce", headers=auth_vendedor)).json()[
        "nota"
    ] is None


# ------------------------------------------------------------------ a credencial
async def test_token_do_emissor_nunca_sai_por_rota(client, auth_admin, pecas, focus) -> None:
    await _configurar_loja(client, auth_admin)
    venda = await _vender(client, auth_admin, [(pecas["camiseta"], 1)], [("PIX", "49.90")])
    respostas = [
        await client.get("/fiscal/emissor", headers=auth_admin),
        await client.get("/configuracao", headers=auth_admin),
        await client.get("/configuracao/completa", headers=auth_admin),
        await client.post(f"/vendas/{venda['id']}/nfce", headers=auth_admin),
        await client.get(f"/vendas/{venda['id']}/nfce", headers=auth_admin),
        await client.get("/auditoria", headers=auth_admin),
    ]
    for r in respostas:
        assert r.status_code == 200, r.text
        assert TOKEN not in r.text
    assert respostas[0].json() == {
        "nome": "focusnfe",
        "ambiente": "homologacao",
        "configurado": True,
        "faltando": [],
        "emitir_automatico": False,
    }
    assert TOKEN not in repr(settings)
    diario = respostas[-1].json()["items"]
    assert any(linha["acao"] == "NFCE_EMITIDA" for linha in diario)
