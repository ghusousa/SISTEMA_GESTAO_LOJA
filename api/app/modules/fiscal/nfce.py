"""Da venda para a NFC-e: as regras que não dependem de emissor nenhum (ADR-41).

Tudo aqui é função pura — entra venda, loja e peças; sai a nota ou a lista do que falta.
"""

from dataclasses import dataclass
from datetime import datetime
from decimal import ROUND_DOWN, Decimal

from app.modules.catalogo.schemas import DadosFiscaisPecaOut
from app.modules.fiscal.emissores import ItemNota, NotaParaEmitir, PagamentoNota
from app.modules.vendas.models import FormaPagamento
from app.modules.vendas.schemas import VendaOut

CENTAVO = Decimal("0.01")
ZERO = Decimal("0.00")

#: Forma de pagamento do PDV → código tPag da SEFAZ.
#:
#: - VALE (vale-troca de uma devolução) → **99 "Outros"**, descrito como "Vale-troca". Não é
#:   dinheiro novo entrando: é crédito que a cliente já tinha na loja por uma devolução.
#:   Não é "12 Vale Presente" (presente é vendido, este nasce de devolução).
#: - FIADO (crediário da própria loja) → **05 "Crédito Loja"**, que é exatamente o
#:   crediário próprio: a loja financia e recebe depois.
#:
#: As duas escolhas estão no ADR-41 e devem ser confirmadas pelo contador da loja; mudar
#: é trocar uma linha aqui.
TPAG: dict[FormaPagamento, str] = {
    FormaPagamento.DINHEIRO: "01",
    FormaPagamento.CREDITO: "03",
    FormaPagamento.DEBITO: "04",
    FormaPagamento.PIX: "17",
    FormaPagamento.FIADO: "05",
    FormaPagamento.VALE: "99",
}
DESCRICAO_TPAG_99: dict[FormaPagamento, str] = {FormaPagamento.VALE: "Vale-troca"}

#: Regime do CRT da NF-e: 1 = Simples Nacional. É o único que este sistema emite: os
#: regimes 2 e 3 tributam ICMS por alíquota, e alíquota por produto não está no cadastro.
REGIME_SIMPLES = 1
NOMES_DO_REGIME = {
    1: "Simples Nacional",
    2: "Simples Nacional (excesso de sublimite)",
    3: "Regime Normal",
}


def so_digitos(texto: str | None) -> str:
    return "".join(c for c in (texto or "") if c.isdigit())


def ratear_desconto(brutos: list[Decimal], desconto: Decimal) -> list[Decimal]:
    """Reparte o desconto da venda entre os itens, na proporção do valor de cada um.

    A soma bate com o desconto ao centavo (a SEFAZ confere: vDesc da nota = soma dos
    itens) e nenhum item recebe mais desconto do que vale. Arredonda para baixo e entrega
    os centavos que sobram, um a um, aos itens de maior valor — determinístico.
    """
    n = len(brutos)
    total = sum(brutos, ZERO)
    if desconto <= ZERO or total <= ZERO or n == 0:
        return [ZERO] * n
    partes = [(b * desconto / total).quantize(CENTAVO, rounding=ROUND_DOWN) for b in brutos]
    resto = desconto - sum(partes, ZERO)
    ordem = sorted(range(n), key=lambda i: (brutos[i], -i), reverse=True)
    i = 0
    while resto > ZERO:
        idx = ordem[i % n]
        if partes[idx] + CENTAVO <= brutos[idx]:
            partes[idx] += CENTAVO
            resto -= CENTAVO
        i += 1
    return partes


@dataclass(frozen=True)
class DadosDaLoja:
    documento: str | None
    inscricao_estadual: str | None
    regime_tributario: int | None
    serie_nfce: int


def o_que_falta(
    loja: DadosDaLoja, pecas: dict[int, DadosFiscaisPecaOut]
) -> tuple[list[str], list[dict]]:
    """O que impede esta nota de sair, em frases que o dono entende. Vazio = pode emitir."""
    faltando: list[str] = []
    if len(so_digitos(loja.documento)) != 14:
        faltando.append(
            "CNPJ da loja (Configuração › A loja): a NFC-e sai no CNPJ — CPF não emite nota"
        )
    if not loja.inscricao_estadual:
        faltando.append("Inscrição estadual da loja (Configuração › A loja)")
    if loja.regime_tributario is None:
        faltando.append("Regime tributário da loja (Configuração › A loja — pergunte ao contador)")
    elif loja.regime_tributario != REGIME_SIMPLES:
        faltando.append(
            f"Regime {NOMES_DO_REGIME[loja.regime_tributario]}: este sistema emite NFC-e só no "
            "Simples Nacional (CSOSN). O ICMS com alíquota por produto ainda não é cadastrado"
        )

    sem_ncm: dict[int, str] = {}
    for peca in pecas.values():
        if not peca.ncm:
            sem_ncm[peca.produto_id] = peca.produto
    produtos = [{"produto_id": pid, "produto": nome} for pid, nome in sorted(sem_ncm.items())]
    faltando.extend(f"NCM do produto “{p['produto']}” (#{p['produto_id']})" for p in produtos)
    return faltando, produtos


def descricao_do_item(peca: DadosFiscaisPecaOut) -> str:
    return " ".join(parte for parte in (peca.produto, peca.tamanho, peca.cor) if parte)


def montar_nota(
    venda: VendaOut,
    loja: DadosDaLoja,
    pecas: dict[int, DadosFiscaisPecaOut],
    agora: datetime,
) -> NotaParaEmitir:
    """A venda inteira, como foi feita. Só chama depois de `o_que_falta` vazio."""
    brutos = [item.preco_unitario * item.quantidade for item in venda.itens]
    descontos = ratear_desconto(brutos, venda.desconto)
    itens = []
    for n, (item, bruto, desconto) in enumerate(
        zip(venda.itens, brutos, descontos, strict=True), start=1
    ):
        peca = pecas[item.variante_id]
        assert peca.ncm is not None  # o_que_falta barrou antes
        itens.append(
            ItemNota(
                numero=n,
                codigo=peca.codigo_barras or str(peca.variante_id),
                descricao=descricao_do_item(peca),
                ncm=peca.ncm,
                cest=peca.cest,
                cfop=peca.cfop,
                origem=peca.origem,
                quantidade=item.quantidade,
                valor_unitario=item.preco_unitario,
                valor_bruto=bruto,
                desconto=desconto,
            )
        )
    pagamentos = [
        PagamentoNota(
            codigo=TPAG[FormaPagamento(p.forma)],
            valor=p.valor,
            descricao=DESCRICAO_TPAG_99.get(FormaPagamento(p.forma)),
        )
        for p in venda.pagamentos
    ]
    return NotaParaEmitir(
        cnpj_emitente=so_digitos(loja.documento),
        regime_tributario=loja.regime_tributario or REGIME_SIMPLES,
        serie=loja.serie_nfce,
        emitida_em=agora,
        total=venda.total,
        itens=itens,
        pagamentos=pagamentos,
    )
