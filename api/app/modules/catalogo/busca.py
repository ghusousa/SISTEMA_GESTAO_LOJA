"""Busca sem acento: o achatamento que toda busca por nome da loja usa.

Mora fora do repositório do catálogo porque o estoque (`/estoque/saldos`) busca o mesmo nome
de produto, e um módulo não importa o repository do outro. Uma regra só, nos dois lados: se
`/variantes?q=calca` acha a "Calça" e `/estoque/saldos?q=calca` não, a dona conclui na tela
de Estoque que a peça não existe e cadastra outra igual.
"""

from sqlalchemy import func

#: Acentos que o teclado da loja produz e o dedo apressado não digita. Quem procura a
#: peça escreve "calca jeans", não "calça jeans" — e sem isto a busca não acha nada, o que
#: na prática significa cadastrar a mesma peça duas vezes.
#:
#: `translate()` do Postgres em vez da extensão `unaccent`: a extensão precisa de
#: `CREATE EXTENSION` (mais uma migration, mais um privilégio, mais uma coisa para faltar
#: num servidor novo), e para o alfabeto do português esta tabela resolve igual.
_COM_ACENTO = "áàâãäéèêëíìîïóòôõöúùûüçñ"
_SEM_ACENTO = "aaaaaeeeeiiiiooooouuuucn"
assert len(_COM_ACENTO) == len(_SEM_ACENTO)


def achatar(coluna):
    """Minúsculas e sem acento, do lado do banco."""
    return func.translate(func.lower(coluna), _COM_ACENTO, _SEM_ACENTO)


def achatar_termo(termo: str) -> str:
    """O mesmo achatamento do lado de cá, para os dois lados baterem."""
    tabela = str.maketrans(_COM_ACENTO, _SEM_ACENTO)
    return termo.strip().lower().translate(tabela)
