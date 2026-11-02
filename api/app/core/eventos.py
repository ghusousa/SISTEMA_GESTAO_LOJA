"""Avisos de mudança para as telas abertas.

O problema que isto resolve: alguém cadastra uma peça no computador do balcão e o celular
da vendedora continua mostrando o catálogo de antes, até fechar e abrir o app. Cada tela
tinha a sua cópia dos dados e ninguém contava a ela que o mundo mudou.

**O que trafega aqui é um aviso, não o dado.** A mensagem diz "produtos mudaram"; quem
recebe decide se está com aquela tela aberta e, se estiver, refaz a consulta pela API
normal. Isso é de propósito, e é o que mantém a coisa segura: o filtro por papel continua
inteiro na rota REST, e uma vendedora não recebe custo por um caminho lateral só porque
um gerente editou um preço. Também deixa o evento minúsculo — cabe num pacote e não
depende de nenhuma tela em particular.

Entrega no melhor esforço. Aviso perdido não corrompe nada: a tela segue com o dado
anterior até o próximo aviso, até a pessoa puxar para atualizar, ou até voltar para a
tela. Por isso não há fila, confirmação nem histórico — nada disso pagaria o próprio
custo numa loja com meia dúzia de aparelhos.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any

logger = logging.getLogger(__name__)

#: Quantos avisos podem esperar num ouvinte lento antes de começar a descartar. Uma tela
#: que não consegue acompanhar não pode segurar memória do servidor da loja.
FILA_MAXIMA = 32


class Assunto(StrEnum):
    """O que mudou, no vocabulário das telas — não no das tabelas.

    Quem recebe usa isto para saber quais consultas refazer, então os nomes acompanham o
    que a pessoa vê, e não o nome da tabela que foi escrita.
    """

    CATALOGO = "catalogo"
    """Produto, variante ou categoria: criado, editado ou removido."""

    ESTOQUE = "estoque"
    """Saldo mudou: entrada, ajuste, inventário, venda ou estorno."""

    VENDAS = "vendas"
    """Venda registrada ou cancelada."""

    DESPESAS = "despesas"
    """Despesa lançada, editada ou apagada."""

    CLIENTES = "clientes"
    """Cliente cadastrado ou editado, e quanto cada um deve."""

    CAIXA = "caixa"
    """Fechamento de caixa registrado."""

    USUARIOS = "usuarios"
    """Alguém entrou, saiu ou mudou de cargo."""

    CONDICIONAIS = "condicionais"
    """Condicional aberta ou fechada (o saldo que ela move sai também como `estoque`)."""

    CONTAS_PAGAR = "contas_pagar"
    """Conta de fornecedor lançada, corrigida, paga ou excluída."""


@dataclass(slots=True)
class Evento:
    assunto: Assunto
    #: Detalhe opcional para a tela decidir melhor: `{"produto_id": 7}` evita recarregar
    #: o catálogo inteiro quando só uma peça mudou.
    dados: dict[str, Any] = field(default_factory=dict)

    def como_json(self) -> dict[str, Any]:
        return {"assunto": str(self.assunto), "dados": self.dados}


class Central:
    """Um lugar só por onde os avisos saem, e a lista de quem está ouvindo.

    Deliberadamente em memória e por processo. A loja roda um servidor; empilhar Redis
    aqui seria mais uma peça para instalar, monitorar e ver quebrar num sábado cheio.
    Se um dia houver mais de um processo, é aqui — e só aqui — que entra o repasse
    entre eles.
    """

    def __init__(self) -> None:
        self._ouvintes: set[asyncio.Queue[Evento]] = set()

    @property
    def ouvintes(self) -> int:
        return len(self._ouvintes)

    def publicar(self, assunto: Assunto, **dados: Any) -> None:
        """Avisa todo mundo. Nunca levanta erro: publicar não pode derrubar a venda.

        É síncrono de propósito — `put_nowait` não espera ninguém. Um aviso não pode
        atrasar o commit de uma venda porque um celular está com a rede ruim.
        """
        evento = Evento(assunto, dados)
        for fila in list(self._ouvintes):
            try:
                fila.put_nowait(evento)
            except asyncio.QueueFull:
                # Ouvinte que não acompanha perde o aviso, e não o servidor. Ele se
                # atualiza sozinho na próxima vez que a tela ganhar foco.
                logger.warning("Ouvinte lento: aviso %s descartado.", assunto)

    @contextlib.asynccontextmanager
    async def inscrever(self) -> AsyncIterator[asyncio.Queue[Evento]]:
        fila: asyncio.Queue[Evento] = asyncio.Queue(maxsize=FILA_MAXIMA)
        self._ouvintes.add(fila)
        try:
            yield fila
        finally:
            # `discard` e não `remove`: a saída também acontece por queda de conexão, e
            # não vale explodir no caminho de limpeza.
            self._ouvintes.discard(fila)


#: A central do processo. Os módulos importam esta instância.
central = Central()


def publicar(assunto: Assunto, **dados: Any) -> None:
    """Atalho para o que os services chamam depois de gravar."""
    central.publicar(assunto, **dados)


# --------------------------------------------------------- avisos automáticos

#: De que tabela para que assunto. O que não está aqui não vira aviso —
#: `refresh_tokens` escreve a cada login e renovação, e nenhuma tela se importa.
ASSUNTO_POR_TABELA: dict[str, Assunto] = {
    "products": Assunto.CATALOGO,
    "product_variants": Assunto.CATALOGO,
    "categories": Assunto.CATALOGO,
    "stock_movements": Assunto.ESTOQUE,
    "stock_entries": Assunto.ESTOQUE,
    "stock_balances": Assunto.ESTOQUE,
    "sales": Assunto.VENDAS,
    "sale_items": Assunto.VENDAS,
    "sale_payments": Assunto.VENDAS,
    # A nota chega segundos depois da venda (ou na emissão automática, sem ninguém clicar):
    # o detalhe da venda aberto precisa saber que mudou.
    "notas_fiscais": Assunto.VENDAS,
    "expenses": Assunto.DESPESAS,
    "expense_categories": Assunto.DESPESAS,
    "cash_closings": Assunto.CAIXA,
    "cash_closing_lines": Assunto.CAIXA,
    "users": Assunto.USUARIOS,
    "customers": Assunto.CLIENTES,
    # Recebimento de fiado e devolução mexem na GAVETA do dia: quem está com a tela do
    # caixa aberta precisa saber, e não só quem olha a lista de clientes.
    "customer_payments": Assunto.CAIXA,
    "sale_return_payments": Assunto.CAIXA,
    "sale_returns": Assunto.VENDAS,
    "sale_return_items": Assunto.ESTOQUE,
    "vouchers": Assunto.VENDAS,
    "consignments": Assunto.CONDICIONAIS,
    "consignment_items": Assunto.CONDICIONAIS,
    "payables": Assunto.CONTAS_PAGAR,
}

_CHAVE = "_tabelas_tocadas"


def registrar_avisos_automaticos() -> None:
    """Pendura o aviso no próprio commit do SQLAlchemy.

    A alternativa seria chamar `publicar()` depois de cada `commit()` nos services — são
    mais de vinte pontos, e o esquecido não quebra teste nenhum: só faz uma tela ficar
    velha, o que ninguém liga a um commit específico. Aqui é impossível esquecer, porque
    quem avisa é o commit.

    O saldo de estoque é escrito por SQL direto e não passa pelo ORM, mas nunca muda
    sozinho: toda alteração de saldo vem com uma linha em `stock_movements`, na mesma
    transação (é a invariante do projeto). Ouvir o ORM basta.
    """
    from sqlalchemy import event
    from sqlalchemy.orm import Session

    @event.listens_for(Session, "after_flush")
    def _anotar(sessao: Session, _contexto: object) -> None:
        # Anotado no flush porque no `after_commit` a sessão já esqueceu o que mudou.
        tocadas: set[str] = sessao.info.setdefault(_CHAVE, set())
        for obj in (*sessao.new, *sessao.dirty, *sessao.deleted):
            tabela = getattr(obj, "__tablename__", None)
            if tabela:
                tocadas.add(tabela)

    @event.listens_for(Session, "after_commit")
    def _publicar(sessao: Session) -> None:
        tocadas: set[str] = sessao.info.pop(_CHAVE, set())
        assuntos = {ASSUNTO_POR_TABELA[t] for t in tocadas if t in ASSUNTO_POR_TABELA}
        for assunto in assuntos:
            # Depois do commit, nunca antes: aviso de uma transação que deu rollback
            # mandaria todo mundo recarregar para ver exatamente o que já tinha.
            central.publicar(assunto)

    @event.listens_for(Session, "after_rollback")
    def _esquecer(sessao: Session) -> None:
        sessao.info.pop(_CHAVE, None)
