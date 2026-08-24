"""Quem pode o quê. Um lugar só, e é este.

Com dois papéis dava para escrever `if user.role != ADMIN` espalhado pelo código. Com
quatro isso vira um campo minado: basta um `!=` esquecido para a vendedora enxergar a
margem da loja. Aqui o código pergunta pela CAPACIDADE ("pode ver dinheiro?"), nunca pelo
cargo — trocar o que um cargo faz é mexer numa linha desta tabela, e nada mais.

A regra do projeto continua valendo: quem corta é o servidor. App e web escondem botão
por conveniência; a recusa de verdade acontece aqui.
"""

from enum import StrEnum

from app.modules.usuarios.models import Papel


class Pode(StrEnum):
    """As capacidades do sistema, no vocabulário da loja."""

    #: Custo da peça, lucro, margem, despesas e relatórios financeiros.
    VER_DINHEIRO = "VER_DINHEIRO"
    #: Lançar, editar e apagar despesa.
    LANCAR_DESPESA = "LANCAR_DESPESA"
    #: Cancelar venda concluída, devolvendo a peça ao estoque.
    CANCELAR_VENDA = "CANCELAR_VENDA"
    #: Receber peça de volta. Fica junto de cancelar pelo mesmo motivo: quem vende não
    #: desfaz a própria venda — é o controle clássico contra desvio (peça "devolvida" que
    #: sai pela porta com o dinheiro).
    DEVOLVER_VENDA = "DEVOLVER_VENDA"
    #: Cadastrar cliente, vender fiado e receber o que devem.
    GERIR_CREDIARIO = "GERIR_CREDIARIO"
    #: Ver as vendas de toda a equipe, não só as próprias.
    VER_VENDAS_DE_TODOS = "VER_VENDAS_DE_TODOS"
    #: Ajuste manual de saldo e inventário — as duas portas de mexer no estoque sem venda.
    CORRIGIR_ESTOQUE = "CORRIGIR_ESTOQUE"
    #: Editar e excluir produto, variante e categoria (cadastrar, todo mundo pode).
    EDITAR_CATALOGO = "EDITAR_CATALOGO"
    #: Conferir o caixa do dia e registrar o fechamento.
    FECHAR_CAIXA = "FECHAR_CAIXA"
    #: Criar, editar, desativar login e redefinir senha de outra pessoa.
    GERIR_USUARIOS = "GERIR_USUARIOS"
    #: Ler o diário de auditoria — tudo que cada pessoa fez no seu login. Só o dono.
    #: Não entra no GERENTE de propósito: a auditoria existe para o dono conferir a
    #: própria equipe, gerente incluído. Quem é auditado não controla o próprio registro.
    VER_AUDITORIA = "VER_AUDITORIA"
    #: Mudar o nome e o ramo da loja. Só o dono: é a identidade do negócio, aparece no
    #: recibo que vai para a mão do cliente, e não é decisão de quem toma conta do turno.
    CONFIGURAR_LOJA = "CONFIGURAR_LOJA"
    #: Ligar o backup na nuvem e conectar a conta do Drive. Só o dono: quem tem essa
    #: conta tem a cópia inteira da loja — vendas, custos, clientes e dívidas.
    GERIR_BACKUP = "GERIR_BACKUP"


VENDEDORA: frozenset[Pode] = frozenset()
"""Vende, consulta preço e saldo, cadastra peça nova e dá entrada de mercadoria.

Tudo isso é aberto a qualquer usuário autenticado e por isso não aparece como capacidade.
O que a vendedora NÃO faz está no que falta aqui: nada de custo, de estorno, de correção
de estoque e de despesa.
"""

SUPERVISORA: frozenset[Pode] = VENDEDORA | {
    Pode.VER_VENDAS_DE_TODOS,
    Pode.CORRIGIR_ESTOQUE,
    Pode.EDITAR_CATALOGO,
    Pode.FECHAR_CAIXA,
}
"""Toma conta do chão de loja: estoque, catálogo, caixa e o acompanhamento da equipe.

Fica de fora do dinheiro (custo, lucro, despesa) e do estorno. A separação é de propósito:
quem confere o caixa não desfaz a venda que entrou nele.
"""

GERENTE: frozenset[Pode] = SUPERVISORA | {
    Pode.VER_DINHEIRO,
    Pode.LANCAR_DESPESA,
    Pode.CANCELAR_VENDA,
    Pode.DEVOLVER_VENDA,
    Pode.GERIR_CREDIARIO,
    Pode.GERIR_USUARIOS,
}
"""Responde pelo resultado da loja, então enxerga o resultado — e mexe na equipe.

A única coisa que o dono tem e o gerente não: mexer em usuário DONO. Um gerente não
promove ninguém a dono, não edita o dono e não se promove (`usuarios/service.py`).
"""

DONO: frozenset[Pode] = frozenset(Pode)
"""Tudo. É a conta criada na instalação."""


PERMISSOES: dict[Papel, frozenset[Pode]] = {
    Papel.ADMIN: DONO,
    Papel.GERENTE: GERENTE,
    Papel.SUPERVISORA: SUPERVISORA,
    Papel.VENDEDOR: VENDEDORA,
}


def pode(papel: Papel | str, capacidade: Pode) -> bool:
    """Papel desconhecido não recebe nada — falha fechada, nunca aberta."""
    return capacidade in PERMISSOES.get(Papel(papel), VENDEDORA)
