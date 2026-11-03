"""Tempo real entre instâncias: o aviso passa pelo LISTEN/NOTIFY do Postgres.

Na Vercel cada instância da função é isolada, e no Docker com mais de um worker cada
worker é um processo: a venda feita num não chegava à tela ligada no outro. Aqui a
"outra instância" é uma segunda `Central` com a sua `Escuta` no mesmo processo de teste
(a origem dela é outra, então ela recebe o que a instância do app gravou) — e, no teste
de ponta a ponta, um segundo processo uvicorn de verdade, com o socket de verdade.
"""

from __future__ import annotations

import asyncio
import json
import os
import socket
import subprocess
import sys
from collections.abc import AsyncIterator
from pathlib import Path

import asyncpg
import httpx
import pytest
from sqlalchemy import text
from sqlalchemy.engine import make_url
from sqlalchemy.exc import DBAPIError

from app.core import escuta as modulo_escuta
from app.core.escuta import Escuta, dsn_da_escuta, dsn_direto, escuta
from app.core.eventos import (
    CANAL_DO_BANCO,
    Assunto,
    Central,
    Evento,
    carga_do_aviso,
    central,
)
from app.modules.catalogo.models import Category

PRONTA_EM = 5.0


@pytest.fixture
async def outra() -> AsyncIterator[tuple[Central, Escuta]]:
    """A outra instância: central própria (origem própria) e escuta própria."""
    central_b = Central()
    escuta_b = Escuta(central_b, espera_inicial=0.05, espera_maxima=0.2)
    yield central_b, escuta_b
    await escuta_b.encerrar()


async def _esperar(fila: asyncio.Queue[Evento], assunto: Assunto, limite: float = 5.0) -> None:
    async def _ate_chegar() -> None:
        while (await fila.get()).assunto is not assunto:
            pass

    await asyncio.wait_for(_ate_chegar(), timeout=limite)


def _drenar(fila: asyncio.Queue[Evento]) -> list[Assunto]:
    recebidos = []
    while not fila.empty():
        recebidos.append(fila.get_nowait().assunto)
    return recebidos


async def _ate(condicao, limite: float = 5.0) -> None:
    async def _laco() -> None:
        while not condicao():
            await asyncio.sleep(0.02)

    await asyncio.wait_for(_laco(), timeout=limite)


async def _conexao_avulsa() -> asyncpg.Connection:
    return await asyncpg.connect(dsn_da_escuta())


async def _aviso_de_outra_instancia(assunto: Assunto) -> None:
    """Outra instância gravou: o NOTIFY dela, por uma conexão que não é a da escuta."""
    avulsa = await _conexao_avulsa()
    try:
        await avulsa.execute(
            "SELECT pg_notify($1, $2)", CANAL_DO_BANCO, carga_do_aviso("outra-instancia", assunto)
        )
    finally:
        await avulsa.close()


class RedeDeMentira:
    """Um pedaço de rede entre a escuta e o Postgres, para os dois sustos que o banco de
    verdade não faz quando o teste pede: o Neon que demora a acordar (`segurar_novas`: a
    conexão nova espera antes de chegar ao banco) e o NAT de operadora que esquece a
    conexão sem fechá-la (`congelar`: nada mais passa nas conexões de agora, e ninguém do
    lado de cá fica sabendo — nem aviso de término, nem erro)."""

    def __init__(self, dsn: str) -> None:
        self._url = make_url(dsn)
        self._destino = (self._url.host or "localhost", self._url.port or 5432)
        self._servidor: asyncio.Server | None = None
        self._passagens: list[asyncio.Event] = []
        self._conexoes: set[asyncio.Task[None]] = set()
        self._novas = asyncio.Event()
        self._novas.set()
        self.dsn = ""

    async def abrir(self) -> None:
        self._servidor = await asyncio.start_server(self._atender, "127.0.0.1", 0)
        porta = self._servidor.sockets[0].getsockname()[1]
        self.dsn = self._url.set(host="127.0.0.1", port=porta).render_as_string(hide_password=False)

    def segurar_novas(self) -> None:
        self._novas.clear()

    def soltar_novas(self) -> None:
        self._novas.set()

    def congelar(self) -> None:
        for passagem in self._passagens:
            passagem.clear()

    async def fechar(self) -> None:
        for tarefa in self._conexoes:
            tarefa.cancel()
        if self._conexoes:
            await asyncio.wait(self._conexoes, timeout=2)
        if self._servidor is not None:
            self._servidor.close()

    async def _atender(self, leitor: asyncio.StreamReader, escritor: asyncio.StreamWriter) -> None:
        tarefa = asyncio.current_task()
        assert tarefa is not None
        self._conexoes.add(tarefa)
        escritor_db: asyncio.StreamWriter | None = None
        try:
            await self._novas.wait()
            leitor_db, escritor_db = await asyncio.open_connection(*self._destino)
            passagem = asyncio.Event()
            passagem.set()
            self._passagens.append(passagem)
            await asyncio.gather(
                self._repassar(leitor, escritor_db, passagem),
                self._repassar(leitor_db, escritor, passagem),
            )
        except (ConnectionError, asyncio.IncompleteReadError):
            pass
        finally:
            for lado in (escritor, escritor_db):
                if lado is not None:
                    lado.transport.abort()
            self._conexoes.discard(tarefa)

    @staticmethod
    async def _repassar(
        de: asyncio.StreamReader, para: asyncio.StreamWriter, passagem: asyncio.Event
    ) -> None:
        while dados := await de.read(65536):
            await passagem.wait()  # congelada: o que chega fica aqui, e nada responde
            para.write(dados)
            await para.drain()
        para.transport.abort()


@pytest.fixture
async def rede() -> AsyncIterator[RedeDeMentira]:
    rede = RedeDeMentira(dsn_da_escuta())
    await rede.abrir()
    yield rede
    await rede.fechar()


# ------------------------------------------------------------ o caminho do aviso


async def test_commit_numa_instancia_chega_a_tela_de_outra(client, auth_admin, outra) -> None:
    """O caso da Vercel: a vendedora cadastra no balcão (instância A) e o celular ligado
    na instância B precisa saber — sem nada em comum entre as duas além do banco."""
    central_b, escuta_b = outra
    async with central_b.inscrever() as fila, escuta_b.tela():
        assert await escuta_b.aguardar_pronta(PRONTA_EM)

        r = await client.post("/categorias", headers=auth_admin, json={"nome": "Blusas"})
        assert r.status_code == 201

        await _esperar(fila, Assunto.CATALOGO)


async def test_rollback_nao_avisa_outra_instancia(session, client, auth_admin, outra) -> None:
    """O NOTIFY vai DENTRO da transação: o Postgres joga fora com o rollback."""
    central_b, escuta_b = outra
    async with central_b.inscrever() as fila, escuta_b.tela():
        assert await escuta_b.aguardar_pronta(PRONTA_EM)

        session.add(Category(name="Nunca existiu"))
        await session.flush()  # o pg_notify já foi executado aqui
        await session.rollback()
        await asyncio.sleep(0.5)
        assert _drenar(fila) == [], "aviso de uma transação desfeita"

        # O cano está vivo: o silêncio acima não é por falta de escuta.
        r = await client.post("/categorias", headers=auth_admin, json={"nome": "Calças"})
        assert r.status_code == 201
        await _esperar(fila, Assunto.CATALOGO)


async def test_savepoint_desfeito_avisa_de_novo_o_que_veio_depois(session, outra) -> None:
    """O NOTIFY feito dentro de um savepoint desfeito some. Se a transação lembrasse que
    "já avisou o catálogo", o que ela grava depois do savepoint não avisaria ninguém."""
    central_b, escuta_b = outra
    async with central_b.inscrever() as fila, escuta_b.tela():
        assert await escuta_b.aguardar_pronta(PRONTA_EM)

        with pytest.raises(DBAPIError):
            async with session.begin_nested():
                session.add(Category(name="Dentro do savepoint"))
                await session.flush()
                await session.execute(text("SELECT 1/0"))
        session.add(Category(name="Depois do savepoint"))
        await session.commit()

        await _esperar(fila, Assunto.CATALOGO)


async def test_savepoint_desfeito_nao_apaga_o_aviso_do_que_veio_antes(session) -> None:
    """Na mesma instância: o savepoint que falha (a despesa recorrente já lançada) não pode
    apagar o aviso do que a transação gravou ANTES dele — ela vai ser commitada."""
    async with central.inscrever() as fila:
        session.add(Category(name="Antes do savepoint"))
        await session.flush()
        with pytest.raises(DBAPIError):
            async with session.begin_nested():
                await session.execute(text("SELECT 1/0"))
        await session.commit()

        assert Assunto.CATALOGO in _drenar(fila)


async def test_aviso_nao_chega_duas_vezes_a_tela_da_instancia_que_gravou(
    client, auth_admin, outra
) -> None:
    """A instância que grava entrega em memória no commit E recebe o próprio NOTIFY de
    volta. O segundo é descartado: a tela recebe UM aviso."""
    central_b, escuta_b = outra
    async with (
        central.inscrever() as fila,
        escuta.tela(),
        central_b.inscrever() as fila_b,
        escuta_b.tela(),
    ):
        assert await escuta.aguardar_pronta(PRONTA_EM)
        assert await escuta_b.aguardar_pronta(PRONTA_EM)
        descartados_antes = escuta.descartados

        r = await client.post("/categorias", headers=auth_admin, json={"nome": "Saias"})
        assert r.status_code == 201

        # Sincroniza com o banco: a outra recebeu e esta já viu (e jogou fora) a volta.
        await _esperar(fila_b, Assunto.CATALOGO)
        await _ate(lambda: escuta.descartados > descartados_antes)

        assert _drenar(fila).count(Assunto.CATALOGO) == 1


async def test_carga_estranha_no_canal_nao_derruba_a_escuta(outra) -> None:
    """Qualquer conexão do banco pode dar NOTIFY no canal; lixo é ignorado."""
    central_b, escuta_b = outra
    async with central_b.inscrever() as fila, escuta_b.tela():
        assert await escuta_b.aguardar_pronta(PRONTA_EM)
        conexao = escuta_b.conexao

        avulsa = await _conexao_avulsa()
        try:
            await avulsa.execute("SELECT pg_notify($1, 'isto não é json')", CANAL_DO_BANCO)
            await avulsa.execute(
                "SELECT pg_notify($1, $2)",
                CANAL_DO_BANCO,
                json.dumps({"origem": "x", "assunto": "nao-existe"}),
            )
            await avulsa.execute(
                "SELECT pg_notify($1, $2)",
                CANAL_DO_BANCO,
                carga_do_aviso("outra-instancia", Assunto.ESTOQUE),
            )
        finally:
            await avulsa.close()

        await _esperar(fila, Assunto.ESTOQUE)
        assert escuta_b.conexao is conexao, "a escuta não pode religar por causa de lixo"


# ------------------------------------------------------------ a vida da conexão


async def test_escuta_que_cai_religa_e_manda_refazer(client, auth_admin, outra) -> None:
    """Postgres reiniciou, compute do Neon dormiu: a conexão de LISTEN cai. A escuta religa
    sozinha e, como o que foi gravado no buraco não chegou, manda as telas refazerem tudo."""
    central_b, escuta_b = outra
    async with central_b.inscrever() as fila, escuta_b.tela():
        assert await escuta_b.aguardar_pronta(PRONTA_EM)
        pid_antigo = escuta_b.conexao.get_server_pid()

        avulsa = await _conexao_avulsa()
        try:
            assert await avulsa.fetchval("SELECT pg_terminate_backend($1)", pid_antigo)
        finally:
            await avulsa.close()

        await _ate(lambda: escuta_b.religacoes == 1)
        assert await escuta_b.aguardar_pronta(PRONTA_EM)
        assert escuta_b.conexao.get_server_pid() != pid_antigo
        assert set(_drenar(fila)) == set(Assunto), "o buraco da queda tem de virar 'refaça'"

        r = await client.post("/categorias", headers=auth_admin, json={"nome": "Vestidos"})
        assert r.status_code == 201
        await _esperar(fila, Assunto.CATALOGO)


async def test_batimento_sem_resposta_religa_e_manda_refazer(rede, monkeypatch) -> None:
    """A queda calada (NAT de operadora que esqueceu a conexão sem fechá-la) não avisa
    ninguém: é o `SELECT 1` de tempos em tempos que descobre. A escuta larga a conexão muda
    SEM a despedida educada — que esperaria resposta de quem não responde, ESPERA_FECHAR
    inteiro —, religa e manda refazer, porque o que chegou no silêncio se perdeu."""
    monkeypatch.setattr(modulo_escuta, "ESPERA_BATIMENTO", 0.3)
    escuta_b = Escuta(
        central_b := Central(),
        dsn=lambda: rede.dsn,
        batimento=0.1,
        espera_inicial=0.05,
        espera_maxima=0.2,
    )
    try:
        async with central_b.inscrever() as fila, escuta_b.tela():
            assert await escuta_b.aguardar_pronta(PRONTA_EM)
            muda = escuta_b.conexao
            assert _drenar(fila) == []

            rede.congelar()
            # Bem antes de ESPERA_FECHAR (5 s): sem esperar a despedida de quem emudeceu.
            await _ate(lambda: escuta_b.religacoes == 1, limite=3.0)

            assert await escuta_b.aguardar_pronta(PRONTA_EM)
            assert escuta_b.conexao is not muda and muda.is_closed()
            assert set(_drenar(fila)) == set(Assunto), "o silêncio tem de virar 'refaça'"

            await _aviso_de_outra_instancia(Assunto.VENDAS)  # e a nova escuta ouve
            await _esperar(fila, Assunto.VENDAS)
    finally:
        await escuta_b.encerrar()


async def test_escuta_que_sobe_depois_do_conectado_manda_refazer(rede) -> None:
    """O Neon acordando: conectar demora mais do que a tela aceita esperar (ESPERA_ESCUTA).
    A tela recebe "conectado" e refaz as consultas ANTES de o LISTEN subir; o que outra
    instância grava nesse meio não chega pela consulta (já feita) nem por aviso (ninguém
    escutava). Quando o LISTEN sobe, a escuta manda refazer tudo, como na volta de uma
    queda — e só dessa vez."""
    escuta_b = Escuta(central_b := Central(), dsn=lambda: rede.dsn)
    rede.segurar_novas()
    try:
        async with central_b.inscrever() as fila, escuta_b.tela():
            assert not await escuta_b.aguardar_pronta(0.2), "o 'conectado' sai sem o LISTEN"
            await _aviso_de_outra_instancia(Assunto.ESTOQUE)  # cai no buraco

            rede.soltar_novas()
            assert await escuta_b.aguardar_pronta(PRONTA_EM)
            assert set(_drenar(fila)) == set(Assunto), "o atraso tem de virar 'refaça'"
            assert escuta_b.religacoes == 0, "não foi queda: foi atraso"

            # Tela que chega com o LISTEN de pé não refaz nada: a marca já foi zerada.
            async with escuta_b.tela():
                assert await escuta_b.aguardar_pronta(PRONTA_EM)
            assert _drenar(fila) == []
            await _aviso_de_outra_instancia(Assunto.CLIENTES)
            await _esperar(fila, Assunto.CLIENTES)
    finally:
        await escuta_b.encerrar()


async def test_tela_que_espera_a_tempo_nao_manda_refazer(outra) -> None:
    """O caminho de todo dia (banco local, milissegundos): sem buraco, sem rodada à toa."""
    central_b, escuta_b = outra
    async with central_b.inscrever() as fila, escuta_b.tela():
        assert await escuta_b.aguardar_pronta(PRONTA_EM)
        assert _drenar(fila) == []
        await _aviso_de_outra_instancia(Assunto.CAIXA)
        await _esperar(fila, Assunto.CAIXA)
        assert _drenar(fila) == []


async def test_ultima_tela_que_sai_fecha_a_escuta(outra) -> None:
    """Uma conexão por instância, e só enquanto houver tela: instância sem ninguém não
    segura conexão no banco (no Neon, é o que deixa o banco dormir)."""
    _central_b, escuta_b = outra
    async with escuta_b.tela():
        async with escuta_b.tela():
            assert await escuta_b.aguardar_pronta(PRONTA_EM)
            conexao = escuta_b.conexao
            pid = conexao.get_server_pid()
            assert escuta_b.telas == 2
        assert escuta_b.telas == 1
        assert escuta_b.conexao is conexao and not conexao.is_closed()

    assert escuta_b.telas == 0
    assert escuta_b.conexao is None
    assert conexao.is_closed()

    avulsa = await _conexao_avulsa()
    try:

        async def _sumiu() -> None:
            consulta = "SELECT count(*) FROM pg_stat_activity WHERE pid = $1"
            while await avulsa.fetchval(consulta, pid):
                await asyncio.sleep(0.02)

        await asyncio.wait_for(_sumiu(), timeout=5)
    finally:
        await avulsa.close()


async def test_tela_que_cai_solta_a_escuta_na_hora(monkeypatch) -> None:
    """O socket do app: a tela que fecha o app solta a conexão de LISTEN NA HORA — não no
    próximo ping (25 s), segurando a escuta e, na Vercel, a instância da função."""
    from types import SimpleNamespace

    from test_tempo_real import CanalQueCai

    from app.modules.tempo_real import router as tr

    async def _fingir_autenticar(_ws):
        return SimpleNamespace(id=1, email="dona@loja.com")

    monkeypatch.setattr(tr, "_autenticar", _fingir_autenticar)
    assert tr.INTERVALO_PING == 25.0  # o de produção: quem esperasse o ping não passaria

    canal = CanalQueCai()
    await asyncio.wait_for(tr.tempo_real(canal), timeout=1.0)  # type: ignore[arg-type]

    assert canal.enviados[0]["assunto"] == "conectado"
    assert escuta.telas == 0 and escuta.conexao is None


async def test_conectado_so_sai_com_a_escuta_de_pe(monkeypatch) -> None:
    """O "conectado" é o sinal para o cliente refazer o que tem aberto. Mandado antes de o
    LISTEN estar de pé, o que outra instância gravasse no meio cairia num buraco: nem na
    consulta (feita antes) nem no aviso (que ninguém escutava)."""
    from contextlib import asynccontextmanager
    from types import SimpleNamespace

    from test_tempo_real import CanalQueCai

    from app.modules.tempo_real import router as tr

    ordem: list[str] = []

    class EscutaDemorada:
        @asynccontextmanager
        async def tela(self):
            ordem.append("tela")
            yield

        async def aguardar_pronta(self, _limite: float) -> bool:
            await asyncio.sleep(0.05)  # o Neon acordando
            ordem.append("pronta")
            return True

    class Canal(CanalQueCai):
        async def send_json(self, dados: dict) -> None:
            ordem.append(dados["assunto"])
            await super().send_json(dados)

    async def _fingir_autenticar(_ws):
        return SimpleNamespace(id=1, email="dona@loja.com")

    monkeypatch.setattr(tr, "_autenticar", _fingir_autenticar)
    monkeypatch.setattr(tr, "escuta", EscutaDemorada())

    await tr.tempo_real(Canal())  # type: ignore[arg-type]
    assert ordem[:3] == ["tela", "pronta", "conectado"]


# ------------------------------------------------------------ o endereço


def test_endereco_da_escuta_tira_o_que_o_asyncpg_nao_entende() -> None:
    """A URL do app tem a cara do SQLAlchemy; a do Neon traz parâmetros do libpq. O asyncpg
    mandaria o que não conhece ao servidor, e o Postgres recusaria a conexão."""
    dsn = dsn_direto(
        "postgres://u:s%40nha@ep-x-pooler.sa-east-1.aws.neon.tech/neondb"
        "?sslmode=require&channel_binding=require",
        tirar_pooler=True,
    )
    assert dsn == "postgresql://u:s%40nha@ep-x.sa-east-1.aws.neon.tech/neondb?sslmode=require"

    assert (
        dsn_direto("postgresql+asyncpg://u:p@db:5432/loja?ssl=true", tirar_pooler=True)
        == "postgresql://u:p@db:5432/loja?sslmode=require"
    )
    # URL direta dada de propósito não é mexida no host.
    assert "-pooler." in dsn_direto("postgresql://u:p@ep-x-pooler.neon.tech/db", tirar_pooler=False)


def test_escuta_prefere_a_url_sem_pooler(monkeypatch) -> None:
    """LISTEN atrás de PgBouncer em modo transação não recebe nada — e não dá erro."""
    s = modulo_escuta.settings
    monkeypatch.setattr(s, "database_url", "postgresql+asyncpg://u:p@ep-x-pooler.neon.tech/db")
    monkeypatch.setattr(s, "database_url_unpooled", "")
    monkeypatch.setattr(s, "db_ssl", "")
    assert dsn_da_escuta() == "postgresql://u:p@ep-x.neon.tech/db"

    monkeypatch.setattr(s, "database_url_unpooled", "postgres://u:p@direta.neon.tech/db")
    assert dsn_da_escuta() == "postgresql://u:p@direta.neon.tech/db"


def test_escuta_conecta_com_o_ssl_do_app(monkeypatch) -> None:
    """A URL do app pode chegar já SEM `sslmode` — tirado para ir por `connect_args`, com o
    modo em `DB_SSL`. A escuta segue o mesmo modo: a conexão de LISTEN não fica menos
    protegida que a do app (sem isso, um `verify-full` valia para o app e não para ela)."""
    s = modulo_escuta.settings
    monkeypatch.setattr(s, "database_url_unpooled", "")
    monkeypatch.setattr(s, "database_url", "postgresql+asyncpg://u:p@ep-x-pooler.neon.tech/db")
    monkeypatch.setattr(s, "db_ssl", "require")
    assert dsn_da_escuta() == "postgresql://u:p@ep-x.neon.tech/db?sslmode=require"

    # O modo do app manda sobre o que a URL direta pedir.
    monkeypatch.setattr(
        s, "database_url_unpooled", "postgres://u:p@direta.neon.tech/db?sslmode=require"
    )
    monkeypatch.setattr(s, "db_ssl", "verify-full")
    assert dsn_da_escuta() == "postgresql://u:p@direta.neon.tech/db?sslmode=verify-full"

    # A loja: nem URL nem DB_SSL pedem nada, e nada muda.
    monkeypatch.setattr(s, "database_url_unpooled", "")
    monkeypatch.setattr(s, "database_url", "postgresql+asyncpg://loja:x@db:5432/loja")
    monkeypatch.setattr(s, "db_ssl", "")
    assert dsn_da_escuta() == "postgresql://loja:x@db:5432/loja"


# ------------------------------------------------------------ dois processos de verdade

API = Path(__file__).resolve().parent.parent


async def _escutas_no_banco() -> int:
    """Conexões de LISTEN abertas neste banco (só o outro processo tem tela ligada)."""
    avulsa = await _conexao_avulsa()
    try:
        return await avulsa.fetchval(
            "SELECT count(*) FROM pg_stat_activity"
            " WHERE application_name = $1 AND datname = current_database()",
            modulo_escuta.NOME_NO_BANCO,
        )
    finally:
        await avulsa.close()


def _porta_livre() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


async def test_commit_aqui_chega_ao_socket_de_outro_processo(client, auth_admin, tmp_path) -> None:
    """Ponta a ponta, com dois processos: um uvicorn à parte serve o WebSocket, e a
    escrita acontece neste processo. Só o banco liga os dois."""
    from websockets.asyncio.client import connect

    porta = _porta_livre()
    saida = (tmp_path / "uvicorn.log").open("w")
    processo = subprocess.Popen(
        [
            sys.executable,
            "-m",
            "uvicorn",
            "app.main:app",
            "--host",
            "127.0.0.1",
            "--port",
            str(porta),
            "--log-level",
            "warning",
        ],
        cwd=API,
        env=os.environ.copy(),
        stdout=saida,
        stderr=subprocess.STDOUT,
    )
    try:
        async with httpx.AsyncClient(trust_env=False) as http:

            async def _no_ar() -> None:
                while True:
                    try:
                        if (await http.get(f"http://127.0.0.1:{porta}/health")).status_code == 200:
                            return
                    except httpx.TransportError:
                        pass
                    assert processo.poll() is None, (tmp_path / "uvicorn.log").read_text()
                    await asyncio.sleep(0.1)

            await asyncio.wait_for(_no_ar(), timeout=30)

        token = auth_admin["Authorization"].removeprefix("Bearer ")
        async with connect(f"ws://127.0.0.1:{porta}/api/v1/tempo-real", proxy=None) as ws:
            await ws.send(json.dumps({"tipo": "entrar", "token": token}))
            primeira = json.loads(await asyncio.wait_for(ws.recv(), timeout=10))
            # "conectado" só sai com a escuta do outro processo de pé: daqui em diante,
            # nada gravado aqui pode escapar daquela tela.
            assert primeira["assunto"] == "conectado"

            r = await client.post("/categorias", headers=auth_admin, json={"nome": "Shorts"})
            assert r.status_code == 201

            async def _catalogo() -> dict:
                while True:
                    msg = json.loads(await ws.recv())
                    if msg["assunto"] == "catalogo":
                        return msg

            msg = await asyncio.wait_for(_catalogo(), timeout=10)
            assert msg["dados"] == {}, "pelo socket vai o assunto, nunca o dado"

            # Só a do outro processo (a de um teste anterior pode levar um instante a sumir).
            async def _so_a_dele() -> None:
                while await _escutas_no_banco() != 1:
                    await asyncio.sleep(0.05)

            await asyncio.wait_for(_so_a_dele(), timeout=5)

        # A tela saiu: o outro processo solta a conexão de LISTEN na hora — não no próximo
        # ping (25 s), que seguraria a conexão e, na Vercel, a instância.
        async def _soltou() -> None:
            while await _escutas_no_banco():
                await asyncio.sleep(0.05)

        await asyncio.wait_for(_soltou(), timeout=5)
    finally:
        processo.terminate()
        try:
            processo.wait(timeout=15)
        except subprocess.TimeoutExpired:
            processo.kill()
        saida.close()
