"""A página com os códigos para testar a câmera do app (Apple, diretriz 2.1(a)).

A revisão da Apple pediu "um QR de demonstração ou uma imagem" para testar o app: sem ela, o
revisor não tem o que apontar para a câmera. As etiquetas da demonstração são EAN-13
determinísticos (`seed_demo.ean_de_fornecedor`), então a página é estática e não pede login:
`web/legal/codigos-para-teste.html`, servida em `<raiz>/codigos-para-teste` (na Vercel e na
demonstração da instalação, `/demo/codigos-para-teste`). O QR do leitor do computador não cabe
numa imagem fixa — o código vale 5 minutos (ADR-43) —, então a página ensina a gerá-lo.

Mudou o catálogo da demonstração? Rode de novo, dentro de `api/`:

    .venv/bin/python -m scripts.codigos_para_teste

O teste `tests/test_codigos_para_teste.py` reprova se o arquivo e o catálogo divergirem.
"""

from __future__ import annotations

import html
from pathlib import Path

from scripts.seed_demo import CATALOGO, ean_de_fornecedor

ARQUIVO = Path(__file__).resolve().parents[2] / "web" / "legal" / "codigos-para-teste.html"

# Peças COM etiqueta de fornecedor na demonstração (o índice par da grade tem EAN; o ímpar usa o
# código interno). A primeira é a das notas da revisão (`codigo_demo` do publicador).
PECAS = [(0, 0), (2, 0), (4, 0), (8, 0)]

_L = [
    "0001101",
    "0011001",
    "0010011",
    "0111101",
    "0100011",
    "0110001",
    "0101111",
    "0111011",
    "0110111",
    "0001011",
]
_G = [
    "0100111",
    "0110011",
    "0011011",
    "0100001",
    "0011101",
    "0111001",
    "0000101",
    "0010001",
    "0001001",
    "0010111",
]
_R = [
    "1110010",
    "1100110",
    "1101100",
    "1000010",
    "1011100",
    "1001110",
    "1010000",
    "1000100",
    "1001000",
    "1110100",
]
_PARIDADE = [
    "LLLLLL",
    "LLGLGG",
    "LLGGLG",
    "LLGGGL",
    "LGLLGG",
    "LGGLLG",
    "LGGGLL",
    "LGLGLG",
    "LGLGGL",
    "LGGLGL",
]


def modulos_ean13(codigo: str) -> str:
    """Os 95 módulos (1 = barra) de um EAN-13: guarda, 6 dígitos pela paridade do 1º, centro, 6, guarda."""
    if len(codigo) != 13 or not codigo.isdigit():
        raise ValueError(f"EAN-13 precisa de 13 dígitos: {codigo!r}")
    paridade = _PARIDADE[int(codigo[0])]
    esquerda = "".join(
        (_L if p == "L" else _G)[int(d)] for p, d in zip(paridade, codigo[1:7], strict=True)
    )
    direita = "".join(_R[int(d)] for d in codigo[7:])
    return "101" + esquerda + "01010" + direita + "101"


def svg_ean13(codigo: str, modulo: int = 3, altura: int = 110) -> str:
    """O código de barras em SVG, preto sobre branco (também no tema escuro da página), com as
    margens de silêncio que o leitor precisa (11 módulos antes, 7 depois)."""
    modulos = modulos_ean13(codigo)
    antes, depois = 11, 7
    largura = (antes + len(modulos) + depois) * modulo
    guardas = set(range(0, 3)) | set(range(45, 50)) | set(range(92, 95))
    barras = []
    i = 0
    while i < len(modulos):
        if modulos[i] == "1":
            j = i
            while j < len(modulos) and modulos[j] == "1" and (j in guardas) == (i in guardas):
                j += 1
            extra = 12 if i in guardas else 0
            barras.append(
                f'<rect x="{(antes + i) * modulo}" y="8" width="{(j - i) * modulo}" height="{altura + extra}"/>'
            )
            i = j
        else:
            i += 1
    y_texto = 8 + altura + 26
    digitos = [f'<text x="{(antes - 6) * modulo}" y="{y_texto}">{codigo[0]}</text>']
    for n, d in enumerate(codigo[1:7]):
        digitos.append(f'<text x="{(antes + 3 + n * 7 + 1.5) * modulo}" y="{y_texto}">{d}</text>')
    for n, d in enumerate(codigo[7:]):
        digitos.append(f'<text x="{(antes + 50 + n * 7 + 1.5) * modulo}" y="{y_texto}">{d}</text>')
    altura_total = y_texto + 10
    return (
        f'<svg class="barras" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {largura} {altura_total}" '
        f'width="{largura}" height="{altura_total}" role="img" aria-label="EAN-13 {codigo}">'
        f'<rect width="{largura}" height="{altura_total}" fill="#fff"/>'
        f'<g fill="#000">{"".join(barras)}</g>'
        f'<g fill="#000" font-family="ui-monospace, Menlo, Consolas, monospace" font-size="20">{"".join(digitos)}</g>'
        "</svg>"
    )


def pecas_com_etiqueta() -> list[dict]:
    pecas = []
    for ordem, indice in PECAS:
        _categoria, nome, venda, _custo, tamanhos, cor = CATALOGO[ordem]
        pecas.append(
            {
                "codigo": ean_de_fornecedor(ordem, indice),
                "nome": nome,
                "tamanho": tamanhos[indice],
                "cor": cor,
                "preco": venda.replace(".", ","),
            }
        )
    return pecas


def montar_pagina() -> str:
    cartoes = "\n".join(
        f"""  <figure class="etiqueta">
    {svg_ean13(p["codigo"])}
    <figcaption><strong>{html.escape(p["nome"])}</strong> · {html.escape(p["tamanho"])} · {html.escape(p["cor"])} · R$ {p["preco"]}</figcaption>
  </figure>"""
        for p in pecas_com_etiqueta()
    )
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Codes for testing the camera · Gestão de Loja</title>
<meta name="description" content="Barcodes and the QR code steps to test the camera of the Gestão de Loja app with the demo shop.">
<!-- Gerada por api/scripts/codigos_para_teste.py: não edite à mão. Endereços RELATIVOS, como nas
     páginas legais: servida em <raiz>/codigos-para-teste (na demonstração da instalação, /demo). -->
<link rel="stylesheet" href="legal/estilo.css">
</head>
<body>
<main>
  <header>
    <p class="marca">Gestão de Loja · demo shop</p>
    <h1>Codes for testing the camera</h1>
    <p class="vigencia">Show this page on a computer screen (or print it) and point the app's camera at it. The products below exist in the demo shop, with fictitious data only.</p>
  </header>

<h2>1. Product barcodes (EAN-13)</h2>
<p>In the app, tap <strong>“Ler código de barras”</strong> in the <strong>Vender</strong> tab (point of sale) and point the camera at a barcode: the item goes into the sale. The same barcodes work in Entrada, Inventário, Devolução and Condicional.</p>
<div class="etiquetas">
{cartoes}
</div>

<h2>2. QR code: the phone as the computer's barcode reader</h2>
<p>This QR code is created live by the shop's computer and is valid for 5 minutes, so it cannot be a fixed image. To get one:</p>
<ol>
  <li>On a computer, open <a href="app/">the demo shop in the browser</a> and sign in with the demo account from the App Review notes.</li>
  <li>In <strong>Vender</strong>, click <strong>“Celular de outra pessoa? Ler o QR”</strong>. The QR code appears on the screen.</li>
  <li>In the app: <strong>Mais › Leitor do computador › “Ler o QR do computador”</strong>, and point the camera at the QR code.</li>
  <li>Now scan a barcode from section 1 with the phone: the item appears in the computer's sale.</li>
</ol>
<p>Without a QR code: with the app open on the phone (same account), click <strong>“Abrir no app o leitor de código”</strong> on the computer. The app shows “O computador está chamando” with <strong>“Abrir o leitor”</strong>.</p>

<footer>
  <p>Gestão de Loja · point of sale and stock control for small shops. <a href="privacidade">Privacy policy</a></p>
</footer>
</main>
</body>
</html>
"""


def main() -> None:
    ARQUIVO.write_text(montar_pagina(), encoding="utf-8")
    print(f"✔ {ARQUIVO}")


if __name__ == "__main__":
    main()
