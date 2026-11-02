"""Adaptador da Focus NFe — API v2 de NFC-e (https://focusnfe.com.br, doc.focusnfe.com.br).

O que este arquivo sabe da Focus, e só ele:

- `POST /v2/nfce?ref=REF` emite. É síncrono: a resposta já diz `autorizado` ou
  `erro_autorizacao`. Mesma referência já autorizada → 422 `already_processed`; ainda
  processando → 422 `pending_operation`.
- `GET /v2/nfce/REF` consulta (404 `nfce_nao_encontrada` se a referência não existe).
- `DELETE /v2/nfce/REF` com `{"justificativa"}` (15 a 255 caracteres) cancela. A SEFAZ só
  aceita até 30 minutos depois da autorização; depois disso a resposta é recusa.
- Autenticação: HTTP Basic, token como usuário e senha vazia. O token vem do `.env` e só
  existe dentro deste objeto — não é logado, não volta em mensagem, não vai ao banco.

Valores de dinheiro vão como TEXTO com duas casas ("79.90"), como nos exemplos da própria
Focus: `float` nunca encosta em valor de nota (CLAUDE.md).
"""

from decimal import Decimal
from typing import Any

import httpx

from app.modules.fiscal.emissores import NotaParaEmitir, PagamentoNota, Resultado
from app.modules.fiscal.models import Ambiente, StatusNota

URL_BASE = {
    Ambiente.HOMOLOGACAO: "https://homologacao.focusnfe.com.br",
    Ambiente.PRODUCAO: "https://api.focusnfe.com.br",
}

#: Regra da SEFAZ para NFC-e de homologação: a descrição do PRIMEIRO item tem de ser esta
#: (rejeição 373). Em produção o nome da peça vai como está.
DESCRICAO_HOMOLOGACAO = "NOTA FISCAL EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL"

#: Cartão e PIX pela maquininha da loja, que não conversa com este sistema: "pagamento não
#: integrado" (tpIntegra = 2). Integrado (TEF) exigiria credenciadora e autorização.
CODIGOS_COM_MAQUININHA = {"03", "04", "17"}

_STATUS = {
    "autorizado": StatusNota.AUTORIZADA,
    "cancelado": StatusNota.CANCELADA,
    "erro_autorizacao": StatusNota.REJEITADA,
    "denegado": StatusNota.REJEITADA,
    "processando_autorizacao": StatusNota.PENDENTE,
}

TIMEOUT_S = 30.0


def _dinheiro(valor: Decimal) -> str:
    return str(valor.quantize(Decimal("0.01")))


def _quantidade(qtd: int) -> str:
    return str(Decimal(qtd).quantize(Decimal("0.0001")))


def _situacao_icms(regime: int, cfop: str) -> str:
    """CSOSN do Simples Nacional. 102 = tributada pelo Simples sem crédito (a venda comum
    de loja); 500 = ICMS já cobrado por substituição tributária, que é o que o CFOP 5405
    declara. Só o regime 1 chega aqui (`nfce.o_que_falta` barra os outros)."""
    return "500" if cfop == "5405" else "102"


def _pagamento(p: PagamentoNota) -> dict[str, Any]:
    forma: dict[str, Any] = {"forma_pagamento": p.codigo, "valor_pagamento": _dinheiro(p.valor)}
    if p.descricao:
        forma["descricao_pagamento"] = p.descricao
    if p.codigo in CODIGOS_COM_MAQUININHA:
        forma["tipo_integracao"] = "2"
    return forma


def montar_payload(nota: NotaParaEmitir, ambiente: Ambiente) -> dict[str, Any]:
    """A NFC-e no JSON da Focus. Função pura: o teste confere campo a campo."""
    itens = []
    for item in nota.itens:
        descricao = item.descricao
        if ambiente == Ambiente.HOMOLOGACAO and item.numero == 1:
            descricao = DESCRICAO_HOMOLOGACAO
        linha: dict[str, Any] = {
            "numero_item": str(item.numero),
            "codigo_produto": item.codigo,
            "descricao": descricao[:120],
            "codigo_ncm": item.ncm,
            "cfop": item.cfop,
            "icms_origem": str(item.origem),
            "icms_situacao_tributaria": _situacao_icms(nota.regime_tributario, item.cfop),
            "unidade_comercial": "UN",
            "unidade_tributavel": "UN",
            "quantidade_comercial": _quantidade(item.quantidade),
            "quantidade_tributavel": _quantidade(item.quantidade),
            "valor_unitario_comercial": _dinheiro(item.valor_unitario),
            "valor_unitario_tributavel": _dinheiro(item.valor_unitario),
            "valor_bruto": _dinheiro(item.valor_bruto),
        }
        if item.cest:
            linha["cest"] = item.cest
        if item.desconto > 0:
            linha["valor_desconto"] = _dinheiro(item.desconto)
        itens.append(linha)

    return {
        "cnpj_emitente": nota.cnpj_emitente,
        # A SEFAZ recusa NFC-e com mais de 5 minutos de diferença do relógio: a data é a da
        # EMISSÃO, não a da venda (a venda de ontem, emitida hoje, sai com a hora de hoje).
        "data_emissao": nota.emitida_em.isoformat(timespec="seconds"),
        "natureza_operacao": "VENDA AO CONSUMIDOR",
        "presenca_comprador": "1",  # venda presencial, no balcão
        "modalidade_frete": "9",  # sem frete
        "local_destino": "1",  # operação interna
        "serie": str(nota.serie),
        "items": itens,
        "formas_pagamento": [_pagamento(p) for p in nota.pagamentos],
    }


class FocusNFe:
    nome = "focusnfe"

    def __init__(
        self,
        token: str,
        ambiente: Ambiente,
        transport: httpx.AsyncBaseTransport | None = None,
    ):
        self.ambiente = ambiente
        self._token = token
        self._base = URL_BASE[ambiente]
        #: Os testes passam um `httpx.MockTransport`; em produção é a rede de verdade.
        self._transport = transport

    def _cliente(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(
            base_url=f"{self._base}/v2",
            auth=httpx.BasicAuth(self._token, ""),
            timeout=TIMEOUT_S,
            transport=self._transport,
        )

    def _url(self, caminho: str | None) -> str | None:
        """A Focus devolve caminhos relativos ("/arquivos/..."); a tela precisa do link."""
        if not caminho:
            return None
        return caminho if caminho.startswith("http") else f"{self._base}{caminho}"

    def _resultado(self, corpo: dict[str, Any]) -> Resultado:
        status = _STATUS.get(str(corpo.get("status", "")))
        mensagem = corpo.get("mensagem_sefaz") or corpo.get("mensagem")
        erros = corpo.get("erros")
        if isinstance(erros, list) and erros:
            detalhes = "; ".join(str(e.get("mensagem", e)) for e in erros if e)
            mensagem = f"{mensagem}: {detalhes}" if mensagem else detalhes
        if status is None:
            # Status que este adaptador não conhece não pode virar "autorizada" por engano.
            status = StatusNota.PENDENTE
            mensagem = mensagem or f"Resposta inesperada do emissor: {corpo.get('status')!r}"
        numero = corpo.get("numero")
        serie = corpo.get("serie")
        return Resultado(
            status=status,
            mensagem=mensagem,
            numero=int(numero) if numero not in (None, "") else None,
            serie=int(serie) if serie not in (None, "") else None,
            chave=_chave(corpo.get("chave_nfe")),
            protocolo=corpo.get("numero_protocolo") or corpo.get("protocolo"),
            url_danfe=self._url(corpo.get("caminho_danfe")),
            url_xml=self._url(corpo.get("caminho_xml_nota_fiscal")),
        )

    @staticmethod
    def _sem_rede(exc: Exception) -> Resultado:
        return Resultado(
            status=StatusNota.PENDENTE,
            mensagem=(
                "Sem resposta do emissor fiscal (internet ou serviço fora do ar). "
                f"Tente de novo em instantes. [{type(exc).__name__}]"
            ),
        )

    @staticmethod
    def _corpo(resp: httpx.Response) -> dict[str, Any]:
        try:
            corpo = resp.json()
        except ValueError:
            # Página de erro do proxy/servidor (HTML): o que serve à tela é o código HTTP,
            # não as tags. Texto curto e sem tag (o 401 da Focus) vai junto.
            texto = resp.text.strip()
            extra = f": {texto[:120]}" if texto and "<" not in texto else ""
            return {"mensagem": f"O emissor respondeu HTTP {resp.status_code}{extra}."}
        return corpo if isinstance(corpo, dict) else {"mensagem": str(corpo)[:300]}

    # ------------------------------------------------------------------ operações
    async def emitir(self, referencia: str, nota: NotaParaEmitir) -> Resultado:
        try:
            async with self._cliente() as c:
                resp = await c.post(
                    "/nfce",
                    params={"ref": referencia},
                    json=montar_payload(nota, self.ambiente),
                )
        except httpx.HTTPError as exc:
            return self._sem_rede(exc)

        corpo = self._corpo(resp)
        if resp.status_code in (200, 201):
            return self._resultado(corpo)
        codigo = corpo.get("codigo")
        if codigo == "already_processed":
            # A mesma referência já foi autorizada (a resposta da 1ª tentativa se perdeu):
            # a nota que vale é a que está lá, e a consulta a traz.
            return await self.consultar(referencia)
        return self._recusa(resp.status_code, corpo)

    async def consultar(self, referencia: str) -> Resultado:
        try:
            async with self._cliente() as c:
                resp = await c.get(f"/nfce/{referencia}", params={"completa": 0})
        except httpx.HTTPError as exc:
            return self._sem_rede(exc)
        corpo = self._corpo(resp)
        if resp.status_code == 404:
            return Resultado(status=None, encontrada=False, mensagem=corpo.get("mensagem"))
        if resp.status_code == 200:
            return self._resultado(corpo)
        return self._recusa(resp.status_code, corpo)

    async def cancelar(self, referencia: str, justificativa: str) -> Resultado:
        try:
            async with self._cliente() as c:
                resp = await c.request(
                    "DELETE", f"/nfce/{referencia}", json={"justificativa": justificativa}
                )
        except httpx.HTTPError as exc:
            return self._sem_rede(exc)
        corpo = self._corpo(resp)
        if resp.status_code == 200:
            if corpo.get("status") == "cancelado":
                return Resultado(
                    status=StatusNota.CANCELADA,
                    mensagem=corpo.get("mensagem_sefaz"),
                    protocolo=corpo.get("numero_protocolo"),
                )
            # `erro_cancelamento`: a SEFAZ recusou (prazo de 30 minutos, por exemplo).
            return Resultado(
                status=StatusNota.AUTORIZADA,
                mensagem=corpo.get("mensagem_sefaz") or "A SEFAZ recusou o cancelamento.",
            )
        if corpo.get("codigo") == "already_processed":
            # "A nota fiscal foi cancelada": um cancelamento anterior chegou lá e a resposta
            # se perdeu. Cancelar de novo é o mesmo que confirmar.
            return Resultado(status=StatusNota.CANCELADA, mensagem=corpo.get("mensagem"))
        recusa = self._recusa(resp.status_code, corpo)
        # Nada que não seja "cancelado" deixa a nota fora de AUTORIZADA.
        return Resultado(status=StatusNota.AUTORIZADA, mensagem=recusa.mensagem)

    @staticmethod
    def _recusa(status_http: int, corpo: dict[str, Any]) -> Resultado:
        mensagem = corpo.get("mensagem") or f"O emissor respondeu HTTP {status_http}."
        codigo = corpo.get("codigo")
        if codigo:
            mensagem = f"{mensagem} ({codigo})"
        if codigo == "pending_operation" or status_http >= 500:
            return Resultado(status=StatusNota.PENDENTE, mensagem=mensagem)
        if status_http in (401, 403):
            # Token errado ou CNPJ não habilitado no painel: não é a nota que está errada,
            # e tentar de novo depois de acertar o .env/painel tem de ser possível.
            return Resultado(
                status=StatusNota.PENDENTE,
                mensagem=(
                    f"O emissor recusou o acesso: confira o token e o CNPJ no painel. {mensagem}"
                ),
            )
        return Resultado(status=StatusNota.REJEITADA, mensagem=mensagem)


def _chave(valor: Any) -> str | None:
    """A Focus devolve a chave com o prefixo "NFe"; guardamos os 44 dígitos."""
    if not valor:
        return None
    texto = str(valor)
    return texto[3:] if texto.upper().startswith("NFE") else texto
