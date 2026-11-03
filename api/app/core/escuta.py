"""A escuta do banco: como o aviso gravado numa instância chega à tela ligada em outra.

A `Central` (`core/eventos.py`) entrega só às telas do MESMO processo. Na Vercel cada
instância da função é isolada, e no Docker com mais de um worker cada worker é um
processo: a venda feita num não avisava a tela ligada no outro. O commit já manda o
assunto por `pg_notify` (dentro da transação); aqui fica o outro lado — uma conexão
asyncpg DEDICADA que faz `LISTEN` no canal da loja e repassa o assunto à Central local,
que segue fazendo o que sempre fez.

**Uma conexão por instância, e só enquanto houver tela.** A primeira tela que liga abre a
escuta; a última que sai fecha. Instância sem tela não segura conexão no banco — no Neon
isso é o que deixa o banco dormir quando ninguém usa.

**Cai e volta sozinha.** Rede, Postgres reiniciando, compute do Neon que dormiu: a conexão
é vigiada (aviso de término do asyncpg e um `SELECT 1` de tempos em tempos, para a queda
calada) e religada com espera crescente. Na volta, as telas desta instância recebem todos
os assuntos de uma vez: o que outra instância gravou no buraco não chegou, e não há como
saber o quê.

**Sem aviso dobrado.** A instância que gravou já entregou em memória no commit; quando o
mesmo aviso volta pelo LISTEN com a origem dela, é descartado.

O LISTEN precisa de conexão de sessão: atrás de PgBouncer em modo transação (o
`DATABASE_URL` "pooled" do Neon) ele não recebe nada, e sem erro. Por isso o endereço sai
de `dsn_da_escuta()`, o ponto único que prefere a URL direta.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass, field

import asyncpg
from sqlalchemy.engine import make_url

from app.core.config import settings
from app.core.eventos import CANAL_DO_BANCO, Central, central, ler_carga

logger = logging.getLogger(__name__)

#: Como a conexão aparece em `pg_stat_activity`: quem olha o banco sabe o que ela é.
NOME_NO_BANCO = "loja-tempo-real"

ESPERA_CONECTAR = 10.0
#: De quanto em quanto tempo a escuta confere que a conexão ainda está viva. A queda
#: limpa (Postgres reiniciou, compute dormiu) chega na hora pelo aviso de término; esta é
#: para a calada — NAT que esqueceu a conexão sem fechar —, que só uma consulta descobre.
BATIMENTO = 60.0
ESPERA_BATIMENTO = 10.0
#: Espera crescente entre tentativas: banco fora do ar não leva uma conexão por segundo
#: de cada instância.
ESPERA_INICIAL = 1.0
ESPERA_MAXIMA = 30.0
ESPERA_FECHAR = 5.0

#: Parâmetros que a URL do app pode ter e o `asyncpg.connect` não conhece. Ele mandaria
#: cada um ao servidor como configuração de sessão, e o Postgres recusa a conexão.
_FORA_DO_ASYNCPG = frozenset({"channel_binding", "prepared_statement_cache_size"})
_SSL_DO_SQLALCHEMY = {"true": "require", "1": "require", "false": "disable", "0": "disable"}


def dsn_direto(url: str, *, tirar_pooler: bool) -> str:
    """A URL do app (formato do SQLAlchemy) como o `asyncpg.connect` aceita, sem pooler.

    `postgresql+asyncpg://` e `postgres://` viram `postgresql://`; `ssl=` (do dialeto)
    vira `sslmode=`, que o asyncpg lê da URL; `channel_binding` e companhia saem. Com
    `tirar_pooler`, o host `<endpoint>-pooler.<região>` do Neon perde o `-pooler`: é o
    mesmo banco nos dois endereços, e só o direto entrega NOTIFY.
    """
    u = make_url(url)
    query = {k: v for k, v in u.query.items() if k not in _FORA_DO_ASYNCPG}
    if "ssl" in query:
        valor = str(query.pop("ssl"))
        query.setdefault("sslmode", _SSL_DO_SQLALCHEMY.get(valor.lower(), valor))
    host = u.host
    if tirar_pooler and host and "-pooler." in host:
        host = host.replace("-pooler.", ".", 1)
    return u.set(drivername="postgresql", host=host, query=query).render_as_string(
        hide_password=False
    )


def dsn_da_escuta() -> str:
    """**Ponto único** do endereço da escuta.

    `DATABASE_URL_UNPOOLED` (a direta que o Neon injeta) quando existe; senão a mesma
    `DATABASE_URL` do app — que na loja de Docker já é direta. Mudou a forma de montar a
    URL do app? É aqui que a escuta acompanha.
    """
    direta = settings.database_url_unpooled
    return dsn_direto(direta or settings.database_url, tirar_pooler=not direta)


@dataclass(eq=False)
class _Turno:
    """Uma vida da escuta: da primeira tela que liga até a última sair.

    Cada turno tem o seu estado. Se a última tela sai e outra chega enquanto a conexão
    antiga ainda fecha, a antiga não apaga o "pronta" nem a conexão da nova.
    """

    pronta: asyncio.Event = field(default_factory=asyncio.Event)
    conexao: asyncpg.Connection | None = None
    tarefa: asyncio.Task[None] | None = None


class Escuta:
    """O LISTEN desta instância, com contagem de telas."""

    def __init__(
        self,
        central: Central,
        *,
        dsn: Callable[[], str] = dsn_da_escuta,
        canal: str = CANAL_DO_BANCO,
        batimento: float = BATIMENTO,
        espera_inicial: float = ESPERA_INICIAL,
        espera_maxima: float = ESPERA_MAXIMA,
    ) -> None:
        self._central = central
        self._dsn = dsn
        self._canal = canal
        self._batimento = batimento
        self._espera_inicial = espera_inicial
        self._espera_maxima = espera_maxima
        self._telas = 0
        self._turno: _Turno | None = None
        #: Quantas vezes a escuta voltou depois de ficar sem conexão com tela ligada.
        self.religacoes = 0
        #: Avisos desta própria instância que voltaram pelo banco e foram jogados fora.
        self.descartados = 0

    @property
    def telas(self) -> int:
        return self._telas

    @property
    def conexao(self) -> asyncpg.Connection | None:
        """A conexão de LISTEN de agora, ou `None` (sem tela, ou religando)."""
        return self._turno.conexao if self._turno else None

    @contextlib.asynccontextmanager
    async def tela(self) -> AsyncIterator[None]:
        """Conta uma tela ligada. A primeira abre a escuta; a última fecha."""
        self._telas += 1
        if self._turno is None:
            turno = _Turno()
            turno.tarefa = asyncio.create_task(self._manter(turno), name="tempo-real-escuta")
            self._turno = turno
        try:
            yield
        finally:
            self._telas = max(0, self._telas - 1)
            if self._telas == 0:
                await self._encerrar_turno()

    async def aguardar_pronta(self, limite: float) -> bool:
        """Espera o LISTEN estar de pé. Desiste em `limite` — a tela segue com os avisos
        desta instância, e os das outras chegam quando a escuta voltar."""
        turno = self._turno
        if turno is None:
            return False
        try:
            await asyncio.wait_for(turno.pronta.wait(), timeout=limite)
        except TimeoutError:
            logger.warning("tempo-real: a escuta do banco não ficou pronta em %.0f s.", limite)
            return False
        return True

    async def encerrar(self) -> None:
        """Fecha já, com ou sem tela: o processo está desligando."""
        self._telas = 0
        await self._encerrar_turno()

    async def _encerrar_turno(self) -> None:
        turno, self._turno = self._turno, None
        if turno is None or turno.tarefa is None:
            return
        turno.tarefa.cancel()
        # `wait`, não `await tarefa`: a tarefa cancelada termina em CancelledError, e o
        # erro é dela. Se quem for cancelado for QUEM SAIU (o servidor desligando), o
        # cancelamento dele sobe normalmente.
        await asyncio.wait({turno.tarefa}, timeout=ESPERA_FECHAR)

    async def _manter(self, turno: _Turno) -> None:
        espera = self._espera_inicial
        buraco = False
        while True:
            conexao: asyncpg.Connection | None = None
            try:
                conexao = await asyncpg.connect(
                    self._dsn(),
                    timeout=ESPERA_CONECTAR,
                    server_settings={"application_name": NOME_NO_BANCO},
                )
                caiu = asyncio.Event()
                conexao.add_termination_listener(lambda _c, caiu=caiu: caiu.set())
                await conexao.add_listener(self._canal, self._ao_receber)
                turno.conexao = conexao
                turno.pronta.set()
                espera = self._espera_inicial
                if buraco:
                    self.religacoes += 1
                    logger.info("tempo-real: escuta do banco de volta; as telas refazem tudo.")
                    self._central.publicar_tudo()
                await self._vigiar(conexao, caiu)
                logger.warning("tempo-real: a escuta do banco caiu; religando.")
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 — rede, senha, banco fora: nova tentativa
                logger.warning(
                    "tempo-real: escuta do banco falhou (%s: %s); de novo em %.0f s.",
                    type(exc).__name__,
                    exc,
                    espera,
                )
            finally:
                turno.pronta.clear()
                turno.conexao = None
                if conexao is not None:
                    await self._fechar(conexao)
            buraco = True
            await asyncio.sleep(espera)
            espera = min(espera * 2, self._espera_maxima)

    async def _vigiar(self, conexao: asyncpg.Connection, caiu: asyncio.Event) -> None:
        """Volta quando a conexão cai; levanta se o batimento não responder."""
        while not caiu.is_set():
            try:
                await asyncio.wait_for(caiu.wait(), timeout=self._batimento)
            except TimeoutError:
                await conexao.fetchval("SELECT 1", timeout=ESPERA_BATIMENTO)

    def _ao_receber(self, _conexao: object, _pid: int, _canal: str, carga: str) -> None:
        lido = ler_carga(carga)
        if lido is None:
            # Qualquer conexão do banco pode dar NOTIFY no canal: lixo não derruba nada.
            logger.warning("tempo-real: carga estranha no canal %s, ignorada.", self._canal)
            return
        origem, assunto = lido
        if origem == self._central.instancia:
            self.descartados += 1  # já entregue em memória no commit
            return
        self._central.publicar(assunto)

    @staticmethod
    async def _fechar(conexao: asyncpg.Connection) -> None:
        try:
            await conexao.close(timeout=ESPERA_FECHAR)
        except asyncio.CancelledError:
            conexao.terminate()
            raise
        except Exception:  # noqa: BLE001 — fechando: o que importa é soltar o socket
            conexao.terminate()


#: A escuta desta instância, ligada à central dela. O canal de tempo real usa esta.
escuta = Escuta(central)
