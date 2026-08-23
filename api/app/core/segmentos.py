"""O que a loja vende, e as palavras que isso traz junto. Um lugar só, e é este.

O sistema nasceu para uma loja de roupas, e o vocabulário foi junto: "peça", "tamanho",
"cor". Numa autopeças, "tamanho P" não quer dizer nada — o que varia é a aplicação e o
lado. Numa loja de informática, o que varia é a capacidade.

A saída **não** foi mexer no banco. `product_variants` tem dois eixos de variação
(`size` e `color`), e eles são genéricos: são só "a primeira coisa que varia" e "a
segunda". O que muda por segmento é o NOME que a tela dá a eles — e isso é uma tabela,
não uma migration. Trocar o segmento da loja amanhã não move um dado de lugar.

Espelhos: `web/js/segmento.js` e `mobile/src/lib/segmento.ts`. Mudou aqui, mude os três
(mesma regra de `permissoes.py`).
"""

from dataclasses import dataclass
from enum import StrEnum


class Segmento(StrEnum):
    """O ramo da loja. `OUTRO` é o vocabulário neutro, que serve para qualquer coisa."""

    ROUPAS = "ROUPAS"
    CALCADOS = "CALCADOS"
    AUTOPECAS = "AUTOPECAS"
    INFORMATICA = "INFORMATICA"
    COSMETICOS = "COSMETICOS"
    ALIMENTOS = "ALIMENTOS"
    CONSTRUCAO = "CONSTRUCAO"
    OUTRO = "OUTRO"


@dataclass(frozen=True)
class Vocabulario:
    """As palavras de um segmento. Só texto de tela — nada aqui muda regra de negócio."""

    #: Como o segmento se chama na hora de escolher ("Roupas e confecção").
    rotulo: str
    #: O emoji da marca na tela. Uma camiseta numa autopeças entrega que o sistema é
    #: de outra loja.
    icone: str
    #: Nome de produto do ramo, para o placeholder do cadastro não sugerir camiseta a
    #: quem vende amortecedor.
    exemplo_produto: str
    #: A coisa que se vende, no singular e no plural ("peça"/"peças").
    item: str
    itens: str
    #: O artigo do item, para a frase não sair torta ("a peça" / "o produto").
    artigo: str
    #: Nome do 1º eixo de variação (coluna `size`) e exemplos para o placeholder.
    eixo1: str
    eixo1_exemplos: str
    #: Botões de atalho do cadastro em grade: gera uma linha por valor de uma vez. Vazio
    #: quando o eixo não tem valores previsíveis (não existe "tamanho padrão" de autopeça).
    eixo1_rapidos: tuple[str, ...]
    #: Nome do 2º eixo de variação (coluna `color`).
    eixo2: str
    eixo2_exemplos: str
    #: Categorias sugeridas na primeira vez, para a loja não começar de uma tela vazia.
    categorias: tuple[str, ...]


#: A tabela. Cada linha é um segmento; nenhuma delas encosta em regra de negócio.
VOCABULARIO: dict[Segmento, Vocabulario] = {
    Segmento.ROUPAS: Vocabulario(
        rotulo="Roupas e confecção",
        icone="👕",
        exemplo_produto="Camiseta Básica Algodão",
        item="peça",
        itens="peças",
        artigo="a",
        eixo1="Tamanho",
        eixo1_exemplos="P, M, G, GG",
        eixo1_rapidos=("PP", "P", "M", "G", "GG", "XG", "U"),
        eixo2="Cor",
        eixo2_exemplos="Preto, Branco, Azul",
        categorias=("Camisetas", "Calças", "Vestidos", "Blusas", "Acessórios"),
    ),
    Segmento.CALCADOS: Vocabulario(
        rotulo="Calçados",
        icone="👟",
        exemplo_produto="Tênis de Corrida Masculino",
        item="par",
        itens="pares",
        artigo="o",
        eixo1="Numeração",
        eixo1_exemplos="37, 38, 39, 40",
        eixo1_rapidos=("34", "35", "36", "37", "38", "39", "40", "41", "42", "43", "44"),
        eixo2="Cor",
        eixo2_exemplos="Preto, Marrom, Branco",
        categorias=("Tênis", "Sandálias", "Sapatos", "Chinelos", "Botas"),
    ),
    Segmento.AUTOPECAS: Vocabulario(
        rotulo="Peças de carro e moto",
        icone="🔧",
        exemplo_produto="Pastilha de Freio Dianteira",
        item="peça",
        itens="peças",
        artigo="a",
        eixo1="Aplicação",
        eixo1_exemplos="Gol 2015, Onix 2020",
        eixo1_rapidos=(),
        eixo2="Posição",
        eixo2_exemplos="Dianteiro, Traseiro, Esquerdo",
        categorias=("Freios", "Suspensão", "Motor", "Elétrica", "Filtros", "Óleos"),
    ),
    Segmento.INFORMATICA: Vocabulario(
        rotulo="Informática e eletrônicos",
        icone="💻",
        exemplo_produto="SSD NVMe 500MB/s",
        item="produto",
        itens="produtos",
        artigo="o",
        eixo1="Capacidade",
        eixo1_exemplos="256GB, 512GB, 1TB",
        eixo1_rapidos=("128GB", "256GB", "512GB", "1TB"),
        eixo2="Cor",
        eixo2_exemplos="Preto, Prata",
        categorias=("Periféricos", "Armazenamento", "Cabos", "Notebooks", "Celulares"),
    ),
    Segmento.COSMETICOS: Vocabulario(
        rotulo="Cosméticos e perfumaria",
        icone="💄",
        exemplo_produto="Perfume Floral Amadeirado",
        item="produto",
        itens="produtos",
        artigo="o",
        eixo1="Volume",
        eixo1_exemplos="50ml, 100ml, 200ml",
        eixo1_rapidos=("30ml", "50ml", "100ml", "200ml"),
        eixo2="Tom",
        eixo2_exemplos="Nude, Vermelho, Rosé",
        categorias=("Perfumes", "Maquiagem", "Cabelo", "Pele", "Unhas"),
    ),
    Segmento.ALIMENTOS: Vocabulario(
        rotulo="Alimentos e mercearia",
        icone="🛒",
        exemplo_produto="Café Torrado e Moído",
        item="produto",
        itens="produtos",
        artigo="o",
        eixo1="Peso",
        eixo1_exemplos="250g, 500g, 1kg",
        eixo1_rapidos=("100g", "250g", "500g", "1kg"),
        eixo2="Sabor",
        eixo2_exemplos="Original, Chocolate",
        categorias=("Bebidas", "Doces", "Mercearia", "Congelados", "Limpeza"),
    ),
    Segmento.CONSTRUCAO: Vocabulario(
        rotulo="Material de construção",
        icone="🧱",
        exemplo_produto="Tubo PVC para Esgoto",
        item="item",
        itens="itens",
        artigo="o",
        eixo1="Medida",
        eixo1_exemplos='1/2", 3/4", 20mm',
        eixo1_rapidos=(),
        eixo2="Acabamento",
        eixo2_exemplos="Fosco, Brilhante, Branco",
        categorias=("Hidráulica", "Elétrica", "Tintas", "Ferramentas", "Fixação"),
    ),
    Segmento.OUTRO: Vocabulario(
        rotulo="Outro ramo",
        icone="🏪",
        exemplo_produto="Nome do produto",
        item="produto",
        itens="produtos",
        artigo="o",
        eixo1="Variação",
        eixo1_exemplos="Único, A, B",
        eixo1_rapidos=(),
        eixo2="Tipo",
        eixo2_exemplos="Padrão",
        categorias=("Geral",),
    ),
}


def vocabulario(segmento: Segmento | str) -> Vocabulario:
    """As palavras de um segmento. Segmento desconhecido cai no neutro em vez de estourar:
    uma linha estranha no banco não pode derrubar a tela de login da loja."""
    try:
        return VOCABULARIO[Segmento(segmento)]
    except (ValueError, KeyError):
        return VOCABULARIO[Segmento.OUTRO]
