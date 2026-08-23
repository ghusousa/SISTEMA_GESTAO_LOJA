"""Traduz uma requisição HTTP no que a loja entende: 'Cancelou a venda #87'.

Isto é o que faz o diário ser legível para o dono em vez de uma tabela de rotas. O mapa é
explícito de propósito: cada ação que merece registro está listada com a frase que o dono
vê. O que não estiver no mapa não é perdido — vira um registro genérico, para nada passar
despercebido, e é sinal de que uma rota nova precisa de uma linha aqui.
"""

import re
from dataclasses import dataclass


@dataclass(frozen=True)
class Ato:
    acao: str
    descricao: str
    entidade: str | None = None
    entidade_id: int | None = None


#: (método, regex do caminho SEM o /api/v1, código, molde da frase, entidade).
#: `{id}` no molde é o primeiro grupo capturado da regex.
_REGRAS: list[tuple[str, re.Pattern[str], str, str, str | None]] = [
    # vendas
    ("POST", re.compile(r"^/vendas$"), "VENDA_CRIADA", "Registrou uma venda", "venda"),
    ("POST", re.compile(r"^/vendas/(\d+)/cancelamento$"), "VENDA_CANCELADA", "Cancelou a venda #{id}", "venda"),
    ("POST", re.compile(r"^/vendas/(\d+)/devolucoes$"), "DEVOLUCAO", "Registrou uma devolução na venda #{id}", "venda"),
    # estoque
    ("POST", re.compile(r"^/estoque/entradas$"), "ENTRADA", "Deu entrada de mercadoria", "estoque"),
    ("POST", re.compile(r"^/estoque/ajustes$"), "AJUSTE", "Ajustou o estoque à mão", "estoque"),
    ("POST", re.compile(r"^/estoque/inventarios$"), "INVENTARIO", "Registrou um inventário", "estoque"),
    # catálogo
    ("POST", re.compile(r"^/produtos$"), "PRODUTO_CRIADO", "Cadastrou uma peça nova", "produto"),
    ("PATCH", re.compile(r"^/produtos/(\d+)$"), "PRODUTO_EDITADO", "Editou o produto #{id}", "produto"),
    ("DELETE", re.compile(r"^/produtos/(\d+)$"), "PRODUTO_EXCLUIDO", "Excluiu o produto #{id}", "produto"),
    ("PUT", re.compile(r"^/produtos/(\d+)/foto$"), "FOTO", "Trocou a foto do produto #{id}", "produto"),
    ("POST", re.compile(r"^/produtos/(\d+)/variantes$"), "PECA_ADICIONADA", "Adicionou uma peça ao produto #{id}", "produto"),
    ("PATCH", re.compile(r"^/variantes/(\d+)$"), "PECA_EDITADA", "Editou a peça #{id} (preço, custo ou código)", "variante"),
    ("DELETE", re.compile(r"^/variantes/(\d+)$"), "PECA_EXCLUIDA", "Excluiu a peça #{id}", "variante"),
    ("POST", re.compile(r"^/categorias$"), "CATEGORIA_CRIADA", "Criou uma categoria", "categoria"),
    ("PATCH", re.compile(r"^/categorias/(\d+)$"), "CATEGORIA_EDITADA", "Renomeou a categoria #{id}", "categoria"),
    ("DELETE", re.compile(r"^/categorias/(\d+)$"), "CATEGORIA_EXCLUIDA", "Excluiu a categoria #{id}", "categoria"),
    # crediário
    ("POST", re.compile(r"^/clientes$"), "CLIENTE_CRIADO", "Cadastrou um cliente no crediário", "cliente"),
    ("PATCH", re.compile(r"^/clientes/(\d+)$"), "CLIENTE_EDITADO", "Editou o cliente #{id}", "cliente"),
    ("DELETE", re.compile(r"^/clientes/(\d+)$"), "CLIENTE_EXCLUIDO", "Excluiu o cliente #{id}", "cliente"),
    ("POST", re.compile(r"^/clientes/(\d+)/pagamentos$"), "FIADO_RECEBIDO", "Recebeu um pagamento de fiado do cliente #{id}", "cliente"),
    # despesas
    ("POST", re.compile(r"^/despesas$"), "DESPESA_CRIADA", "Lançou uma despesa", "despesa"),
    ("PATCH", re.compile(r"^/despesas/(\d+)$"), "DESPESA_EDITADA", "Editou a despesa #{id}", "despesa"),
    ("DELETE", re.compile(r"^/despesas/(\d+)$"), "DESPESA_EXCLUIDA", "Excluiu a despesa #{id}", "despesa"),
    ("POST", re.compile(r"^/despesas/replicar-recorrentes$"), "DESPESAS_REPLICADAS", "Trouxe as contas fixas do mês", "despesa"),
    ("POST", re.compile(r"^/despesas/categorias$"), "CATEGORIA_DESPESA", "Criou uma categoria de despesa", "despesa"),
    ("DELETE", re.compile(r"^/despesas/categorias/(\d+)$"), "CATEGORIA_DESPESA_EXCLUIDA", "Excluiu uma categoria de despesa", "despesa"),
    # caixa
    ("POST", re.compile(r"^/caixa/fechamentos$"), "CAIXA_FECHADO", "Fechou o caixa do dia", "caixa"),
    # usuários — os mais sensíveis: mexer em quem entra no sistema
    ("POST", re.compile(r"^/usuarios$"), "USUARIO_CRIADO", "Criou um usuário", "usuario"),
    ("PATCH", re.compile(r"^/usuarios/(\d+)/senha$"), "SENHA_REDEFINIDA", "Redefiniu a senha do usuário #{id}", "usuario"),
    ("PATCH", re.compile(r"^/usuarios/me/senha$"), "SENHA_PROPRIA", "Trocou a própria senha", "usuario"),
    ("PATCH", re.compile(r"^/usuarios/(\d+)$"), "USUARIO_EDITADO", "Editou o usuário #{id} (papel ou acesso)", "usuario"),
    # identidade da loja
    ("PATCH", re.compile(r"^/configuracao$"), "LOJA_CONFIGURADA", "Mudou o nome ou o ramo da loja", "loja"),
    # sessão
    ("POST", re.compile(r"^/auth/logout$"), "LOGOUT", "Saiu do sistema", None),
]

#: Rotas que mudam algo mas não merecem uma linha no diário — puro ruído.
_IGNORAR = [
    ("POST", re.compile(r"^/auth/login$")),  # login tem tratamento próprio (sucesso/falha)
    ("POST", re.compile(r"^/auth/refresh$")),  # renovar sessão acontece toda hora, sozinho
]


def classificar(metodo: str, caminho: str) -> Ato | None:
    """Devolve o Ato de uma requisição, ou None se ela não deve entrar no diário.

    `caminho` é o path já sem o prefixo /api/v1 e sem query string.
    """
    metodo = metodo.upper()
    caminho = caminho.rstrip("/") or "/"

    for m, regex in _IGNORAR:
        if m == metodo and regex.match(caminho):
            return None

    for m, regex, acao, molde, entidade in _REGRAS:
        if m != metodo:
            continue
        achou = regex.match(caminho)
        if achou:
            ent_id = int(achou.group(1)) if achou.groups() else None
            descricao = molde.format(id=ent_id) if ent_id is not None else molde
            return Ato(acao=acao, descricao=descricao, entidade=entidade, entidade_id=ent_id)

    # Mutação que o mapa não conhece: registra genérico em vez de perder. Se aparecer no
    # diário, é sinal de que uma rota nova precisa de uma linha em `_REGRAS`.
    if metodo in {"POST", "PUT", "PATCH", "DELETE"}:
        return Ato(acao="OUTRO", descricao=f"{metodo} {caminho}", entidade=None, entidade_id=None)
    return None
