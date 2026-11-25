"""A página com os códigos para testar a câmera (Apple, diretriz 2.1(a)).

A revisão do build 7 pediu "um QR de demonstração ou uma imagem": as notas só davam o código
para digitar. A página `/codigos-para-teste` mostra as etiquetas da demonstração e ensina a gerar
o QR do leitor do computador (ele vale 5 min, ADR-43). Ela é gerada a partir do catálogo da
demonstração (`scripts/codigos_para_teste.py`): estes testes reprovam se o arquivo, o catálogo e o
código das notas da revisão divergirem, ou se uma etiqueta não for um EAN-13 válido.
"""

import json
from pathlib import Path

from app.modules.catalogo.barcode import digito_verificador_ean13
from scripts import codigos_para_teste as pagina
from scripts.seed_demo import CATALOGO, ean_de_fornecedor

RAIZ = Path(__file__).resolve().parents[2]


def _decodificar(modulos: str) -> str:
    """O caminho de volta, pela tabela inversa: os 95 módulos viram os 13 dígitos."""
    assert len(modulos) == 95
    assert modulos[:3] == "101" and modulos[45:50] == "01010" and modulos[92:] == "101"
    tabela = {}
    for nome, codigos in (("L", pagina._L), ("G", pagina._G), ("R", pagina._R)):
        for digito, padrao in enumerate(codigos):
            tabela[padrao] = (nome, str(digito))
    esquerda = [tabela[modulos[3 + 7 * i : 10 + 7 * i]] for i in range(6)]
    direita = [tabela[modulos[50 + 7 * i : 57 + 7 * i]] for i in range(6)]
    assert all(n == "R" for n, _ in direita)
    primeiro = str(pagina._PARIDADE.index("".join(n for n, _ in esquerda)))
    return primeiro + "".join(d for _, d in esquerda) + "".join(d for _, d in direita)


def test_o_arquivo_e_o_que_o_gerador_monta() -> None:
    gravado = (RAIZ / "web" / "legal" / "codigos-para-teste.html").read_text(encoding="utf-8")
    assert gravado == pagina.montar_pagina(), (
        "a página saiu do catálogo da demonstração: rode .venv/bin/python -m scripts.codigos_para_teste"
    )


def test_cada_etiqueta_e_um_ean13_valido_e_volta_ao_mesmo_numero() -> None:
    for p in pagina.pecas_com_etiqueta():
        codigo = p["codigo"]
        assert codigo[-1] == digito_verificador_ean13(codigo[:-1]), codigo
        assert _decodificar(pagina.modulos_ean13(codigo)) == codigo
        assert f'aria-label="EAN-13 {codigo}"' in pagina.svg_ean13(codigo)


def test_as_pecas_da_pagina_existem_com_etiqueta_na_demonstracao() -> None:
    for ordem, indice in pagina.PECAS:
        _cat, nome, _venda, _custo, tamanhos, _cor = CATALOGO[ordem]
        assert indice < len(tamanhos) and indice % 2 == 0, (
            f"{nome}: o índice ímpar não tem EAN (código interno)"
        )
        assert ean_de_fornecedor(ordem, indice) in pagina.montar_pagina()


def test_o_codigo_das_notas_da_revisao_esta_na_pagina() -> None:
    padroes = json.loads(
        (RAIZ / "mobile" / "publicar" / "padroes.json").read_text(encoding="utf-8")
    )
    assert padroes["codigo_demo"] == pagina.pecas_com_etiqueta()[0]["codigo"]


async def test_a_pagina_abre_sem_login(client) -> None:
    resposta = await client.get("http://test/codigos-para-teste")
    assert resposta.status_code == 200 and "text/html" in resposta.headers["content-type"]
    assert "EAN-13 7890000000000" in resposta.text
    assert "Ler o QR do computador" in resposta.text
