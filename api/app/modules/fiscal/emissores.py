"""A porta para quem de fato emite a NFC-e (ADR-41).

O sistema não fala com a SEFAZ. Quem fala é um emissor terceirizado (Focus NFe, NFE.io,
PlugNotas...), que guarda o certificado A1 e o CSC da loja e devolve a nota autorizada.
Aqui fica o CONTRATO com esse emissor — emitir, consultar, cancelar — e a escolha de qual
usar, feita só pelo `.env` (`FISCAL_EMISSOR`). Trocar de emissor é escrever um adaptador
novo que cumpra `Emissor`; nada no resto do módulo muda.

**Regra de ouro dos adaptadores: rede caída nunca vira exceção.** Vira `Resultado` com
status PENDENTE e a mensagem do que aconteceu. Emissão é coisa que se tenta de novo; a
exceção é reservada a defeito de programa.
"""

from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal
from typing import Protocol

from fastapi import status as http

from app.core.config import settings
from app.core.exceptions import AppError
from app.modules.fiscal.models import Ambiente, StatusNota


# ------------------------------------------------------------------ erros de domínio
class EmissorNaoConfigurado(AppError):
    code = "EMISSOR_NAO_CONFIGURADO"
    http_status = http.HTTP_409_CONFLICT
    message = "Emissor fiscal não configurado."


class DadosFiscaisIncompletos(AppError):
    code = "DADOS_FISCAIS_INCOMPLETOS"
    http_status = http.HTTP_409_CONFLICT
    message = "Faltam dados fiscais para emitir a NFC-e."


# ------------------------------------------------------------------ o que vai e o que volta
@dataclass(frozen=True)
class ItemNota:
    numero: int
    codigo: str
    descricao: str
    ncm: str
    cest: str | None
    cfop: str
    origem: int
    quantidade: int
    valor_unitario: Decimal
    valor_bruto: Decimal
    desconto: Decimal


@dataclass(frozen=True)
class PagamentoNota:
    #: Código tPag da SEFAZ ("01" dinheiro, "17" PIX...). Ver `nfce.TPAG`.
    codigo: str
    valor: Decimal
    #: Só para o código 99 ("Outros"): a SEFAZ rejeita 99 sem descrição (441) e
    #: descrição com outro código (442).
    descricao: str | None = None


@dataclass(frozen=True)
class NotaParaEmitir:
    """A venda já traduzida para a língua da nota, sem nada de nenhum emissor."""

    cnpj_emitente: str
    regime_tributario: int
    serie: int
    emitida_em: datetime
    total: Decimal
    itens: list[ItemNota]
    pagamentos: list[PagamentoNota]


@dataclass(frozen=True)
class Resultado:
    """A resposta do emissor, já no vocabulário do sistema.

    `status=None` com `encontrada=False` é a consulta que não achou a referência: a nota
    nunca chegou ao emissor (ou chegou e foi descartada) e pode ser enviada.
    """

    status: StatusNota | None
    mensagem: str | None = None
    numero: int | None = None
    serie: int | None = None
    chave: str | None = None
    protocolo: str | None = None
    url_danfe: str | None = None
    url_xml: str | None = None
    encontrada: bool = True


class Emissor(Protocol):
    nome: str
    ambiente: Ambiente

    async def emitir(self, referencia: str, nota: NotaParaEmitir) -> Resultado: ...

    async def consultar(self, referencia: str) -> Resultado: ...

    async def cancelar(self, referencia: str, justificativa: str) -> Resultado: ...


# ------------------------------------------------------------------ qual emissor
@dataclass(frozen=True)
class EstadoEmissor:
    nome: str
    ambiente: Ambiente | None
    configurado: bool
    faltando: list[str] = field(default_factory=list)


def estado_do_emissor() -> EstadoEmissor:
    """O que o `.env` diz, e o que falta nele. Nunca expõe o token — só se ele existe."""
    if settings.fiscal_emissor == "desligado":
        return EstadoEmissor(
            nome="desligado",
            ambiente=None,
            configurado=False,
            faltando=[
                "Contratar um emissor de NFC-e (ex.: Focus NFe) e cadastrar nele o "
                "certificado A1 e o CSC da loja",
                "No .env do servidor: FISCAL_EMISSOR=focusnfe e FOCUSNFE_TOKEN=<token da "
                "empresa no painel do emissor>",
            ],
        )
    ambiente = Ambiente(settings.focusnfe_ambiente)
    if not settings.focusnfe_token.get_secret_value().strip():
        return EstadoEmissor(
            nome=settings.fiscal_emissor,
            ambiente=ambiente,
            configurado=False,
            faltando=["No .env do servidor: FOCUSNFE_TOKEN=<token da empresa no painel>"],
        )
    return EstadoEmissor(nome=settings.fiscal_emissor, ambiente=ambiente, configurado=True)


def _fabricar(nome: str) -> Emissor:
    if nome == "focusnfe":
        from app.modules.fiscal.focusnfe import FocusNFe

        return FocusNFe(
            token=settings.focusnfe_token.get_secret_value().strip(),
            ambiente=Ambiente(settings.focusnfe_ambiente),
        )
    raise EmissorNaoConfigurado(detail={"faltando": [f"Emissor desconhecido: {nome}"]})


#: Ponto de troca para os testes: a fábrica que monta o emissor a partir do `.env`.
#: O teste põe aqui um Focus NFe com `httpx.MockTransport` — e nada vai para a internet.
fabrica = _fabricar


def emissor_configurado() -> Emissor:
    """O emissor do `.env`, ou 409 dizendo o que falta para existir um."""
    estado = estado_do_emissor()
    if not estado.configurado:
        raise EmissorNaoConfigurado(
            "Emissor fiscal não configurado. A NFC-e não sai enquanto o dono não ligar um.",
            {"faltando": estado.faltando},
        )
    return fabrica(estado.nome)


def emissor_da_nota(nome_na_nota: str) -> Emissor:
    """Consultar e cancelar falam com quem EMITIU a nota. Se o `.env` mudou de emissor
    (ou o desligou), a nota antiga fica sem quem a cancele — e isso tem de ser dito."""
    estado = estado_do_emissor()
    if not estado.configurado or estado.nome != nome_na_nota:
        raise EmissorNaoConfigurado(
            f"Esta venda tem NFC-e emitida pelo emissor '{nome_na_nota}', que não está "
            "ligado neste servidor. Sem ele, a nota não pode ser consultada nem cancelada.",
            {"faltando": estado.faltando or [f"FISCAL_EMISSOR={nome_na_nota} no .env"]},
        )
    return fabrica(estado.nome)
