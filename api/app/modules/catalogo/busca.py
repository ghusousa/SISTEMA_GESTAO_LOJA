"""Busca sem acento: o achatamento que toda busca por nome da loja usa.

Mora fora do repositório do catálogo porque o estoque (`/estoque/saldos`) busca o mesmo nome
de produto, e um módulo não importa o repository do outro. Uma regra só, nos dois lados: se
`/variantes?q=calca` acha a "Calça" e `/estoque/saldos?q=calca` não, a dona conclui na tela
de Estoque que a peça não existe e cadastra outra igual.

E é a MESMA expressão do índice trigram (`ix_products_nome_achatado`,
`ix_product_variants_cor_achatada`, ADR-31): o Postgres só usa índice de expressão quando a
consulta escreve a expressão idêntica. Mexeu na tabela de acentos, mexeu nos índices — uma
migration que os recria com a tabela nova.
"""

from sqlalchemy import String, func, literal_column

#: Acentos que o teclado da loja produz e o dedo apressado não digita. Quem procura a
#: peça escreve "calca jeans", não "calça jeans" — e sem isto a busca não acha nada, o que
#: na prática significa cadastrar a mesma peça duas vezes.
#:
#: `translate()` do Postgres em vez da extensão `unaccent`: `unaccent()` não é IMMUTABLE,
#: então não entra em índice de expressão, e ainda depende de dicionário instalado no
#: servidor. Para o alfabeto do português esta tabela resolve igual — e `translate(lower())`
#: é indexável.
_COM_ACENTO = "áàâãäéèêëíìîïóòôõöúùûüçñ"
_SEM_ACENTO = "aaaaaeeeeiiiiooooouuuucn"
assert len(_COM_ACENTO) == len(_SEM_ACENTO)
# Vão para o SQL como literal, então não podem ter aspas.
assert "'" not in _COM_ACENTO + _SEM_ACENTO

#: As duas tabelas entram no SQL como LITERAIS, nunca como parâmetro. Como parâmetro
#: (`translate(lower(name), $2, $3)`), o plano genérico que o asyncpg reaproveita depois da
#: quinta execução não sabe o valor de `$2` — e aí nenhum índice de expressão casa, e cada
#: tecla digitada na busca volta a varrer o catálogo inteiro.
_DE = literal_column(f"'{_COM_ACENTO}'", String)
_PARA = literal_column(f"'{_SEM_ACENTO}'", String)


def achatar(coluna):  # noqa: ANN001, ANN201 — expressão SQL, não valor Python
    """Minúsculas e sem acento, do lado do banco."""
    return func.translate(func.lower(coluna), _DE, _PARA)


def achatar_termo(termo: str) -> str:
    """O mesmo achatamento do lado de cá, para os dois lados baterem."""
    tabela = str.maketrans(_COM_ACENTO, _SEM_ACENTO)
    return termo.strip().lower().translate(tabela)
