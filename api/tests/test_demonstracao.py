"""A demonstração que sobe com a loja (ADR-46): a config e os comandos que a preparam.

O que se prende:

- `LOJA_DEMONSTRACAO=1` liga a demonstração (e desliga a NFC-e, venha o que vier do .env);
  `PREFIXO` só aceita um caminho limpo; a conta protegida é a da variável SÓ numa
  demonstração; config inválida não repete no log a URL do banco nem o segredo;
- `preparar-demonstracao` e `renovar-demonstracao` exigem as DUAS chaves — o contêiner
  (LOJA_DEMONSTRACAO) e o banco (o marco `loja.demonstracao`) — e sem uma delas saem com
  código ≠ 0, dizendo qual faltou, sem tocar em nada: o banco de uma loja recém-instalada
  está vazio, e "vazio" é o que a carga entende como "pode semear";
- com as duas: semeia uma vez, dá o nome e o ramo da demo, CONVERGE a conta das notas da
  Apple a cada preparo (senha trocada no banco volta a ser a do .env), renova voltando as
  vendas para hoje (igual à primeira carga), põe preparo e renovação em fila — e nunca
  imprime senha nem a URL do banco.

O banco da demo daqui imita o da instalação: um papel SEM superusuário, dono só do próprio
banco, que migra e semeia sozinho. Nome e papel derivam do banco de teste desta suíte.
"""

from __future__ import annotations

import asyncio
import os
import secrets
import subprocess
import sys
import time
from collections.abc import AsyncIterator
from datetime import UTC, datetime
from pathlib import Path

import asyncpg
import pytest
from pydantic import ValidationError
from sqlalchemy.engine import make_url

from app.core.config import PASTA_API, Settings, settings
from app.core.security import hash_senha, verificar_senha

# ------------------------------------------------------------------ a config


def _settings(monkeypatch: pytest.MonkeyPatch, **env: str) -> Settings:
    """Settings lidas SÓ do ambiente dado (sem o .env da máquina nem o do conftest)."""
    for chave in (
        "DATABASE_URL", "DATABASE_URL_UNPOOLED", "JWT_SECRET", "AMBIENTE", "CORS_ORIGINS",
        "DEBUG", "VERCEL", "VERCEL_ENV", "VERCEL_URL", "VERCEL_BRANCH_URL",
        "VERCEL_PROJECT_PRODUCTION_URL", "LOJA_DEMONSTRACAO", "DEMONSTRACAO", "PREFIXO",
        "DEMO_ADMIN_EMAIL", "FISCAL_EMISSOR", "FOCUSNFE_TOKEN", "FISCAL_EMITIR_AUTOMATICO",
    ):
        monkeypatch.delenv(chave, raising=False)
    for chave, valor in env.items():
        monkeypatch.setenv(chave, valor)
    return Settings(_env_file=None)


def test_prefixo_so_aceita_um_caminho_limpo(monkeypatch: pytest.MonkeyPatch) -> None:
    assert _settings(monkeypatch).prefixo == ""
    assert _settings(monkeypatch, PREFIXO="/demo").prefixo == "/demo"
    assert _settings(monkeypatch, PREFIXO="/demo-2").prefixo == "/demo-2"
    for errado in ("demo", "/demo/", "/Demo", "/", "//demo", "/demo/x", "/de mo"):
        with pytest.raises(ValidationError, match="PREFIXO"):
            _settings(monkeypatch, PREFIXO=errado)


def test_loja_demonstracao_liga_a_demo_e_desliga_a_nota_fiscal(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    loja = _settings(monkeypatch, DEMO_ADMIN_EMAIL="dono@demo.example")
    assert loja.demonstracao is False
    assert loja.conta_demo_protegida == "", "na loja a variável não protege nada"
    # Só a variável com o nome da instalação liga; um DEMONSTRACAO solto não.
    assert _settings(monkeypatch, DEMONSTRACAO="1").demonstracao is False

    demo = _settings(
        monkeypatch,
        LOJA_DEMONSTRACAO="1",
        DEMO_ADMIN_EMAIL="  Dono@Demo.Example ",
        # O bloco de environment copiado da loja por engano: a nota não sai na demo.
        FISCAL_EMISSOR="focusnfe",
        FOCUSNFE_TOKEN="token-do-cnpj-da-loja",
        FISCAL_EMITIR_AUTOMATICO="1",
    )
    assert demo.demonstracao is True
    assert demo.conta_demo_protegida == "dono@demo.example"
    assert demo.fiscal_emissor == "desligado"
    assert demo.focusnfe_token.get_secret_value() == ""
    assert demo.fiscal_emitir_automatico is False


def test_na_vercel_a_conta_e_protegida_mas_nao_vira_a_demo_da_instalacao(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    vercel = _settings(
        monkeypatch,
        VERCEL="1",
        JWT_SECRET="j" * 48,
        VERCEL_PROJECT_PRODUCTION_URL="loja-tria.vercel.app",
        DEMO_ADMIN_EMAIL="dono@demo.com",
    )
    assert vercel.conta_demo_protegida == "dono@demo.com"
    assert vercel.demonstracao is False, "a Vercel não ganha faixa nem nome trocado"


def test_config_invalida_nao_repete_a_url_do_banco_nem_o_segredo(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """O erro de boot vai para o log do Docker (e o da Vercel). A frase fica; os valores, não."""
    url = "postgresql+asyncpg://loja_demo:SENHA-DO-BANCO-DA-DEMO@db:5432/loja_demo"
    for env, frase in (
        ({"PREFIXO": "/Demo/"}, "PREFIXO"),
        ({"AMBIENTE": "producao", "JWT_SECRET": "SEGREDO-CURTO"}, "JWT_SECRET"),
    ):
        with pytest.raises(ValidationError) as erro:
            _settings(monkeypatch, DATABASE_URL=url, **env)
        texto = str(erro.value)
        assert frase in texto
        assert "SENHA-DO-BANCO-DA-DEMO" not in texto and "SEGREDO-CURTO" not in texto


# ------------------------------------------------------------------ o banco da demo

SENHA_DO_DONO = f"Dono-{secrets.token_urlsafe(12)}"
EMAIL_DO_DONO = "dono@demo.example"
_BASE = make_url(settings.database_url)
#: Derivados do banco desta suíte: outra suíte rodando ao lado (outro banco) não esbarra.
BANCO_DA_DEMO = f"{_BASE.database}_demo"
PAPEL_DA_DEMO = f"{_BASE.database}_demo_papel"
SENHA_DO_PAPEL = f"Senha-Do-Papel-{secrets.token_hex(8)}"


async def _admin_postgres() -> asyncpg.Connection:
    return await asyncpg.connect(
        host=_BASE.host, port=_BASE.port or 5432, user=_BASE.username,
        password=_BASE.password, database="postgres",
    )


async def _como_admin(sql: str) -> None:
    conexao = await _admin_postgres()
    try:
        await conexao.execute(sql)
    finally:
        await conexao.close()


async def _apagar_banco_e_papel() -> None:
    await _como_admin(f'DROP DATABASE IF EXISTS "{BANCO_DA_DEMO}" WITH (FORCE)')
    await _como_admin(f'DROP ROLE IF EXISTS "{PAPEL_DA_DEMO}"')


def _url_da_demo() -> str:
    return _BASE.set(
        username=PAPEL_DA_DEMO, password=SENHA_DO_PAPEL, database=BANCO_DA_DEMO
    ).render_as_string(hide_password=False)


def _ambiente(**extra: str) -> dict[str, str]:
    """O ambiente da api-demo, e só ele: nada da máquina que mude o que se testa."""
    limpo = {
        chave: valor
        for chave, valor in os.environ.items()
        if not chave.startswith(
            ("VERCEL", "DATABASE_URL", "DEMO_", "SEED_", "FISCAL_", "FOCUSNFE_")
        )
        and chave not in {
            "AMBIENTE", "CORS_ORIGINS", "DEBUG", "MEDIA_DIR", "WEB_DIR", "JWT_SECRET",
            "LOJA_DEMONSTRACAO", "PREFIXO",
        }
    }
    limpo.update(
        DATABASE_URL=_url_da_demo(),
        # Como no contêiner: produção, segredo próprio da demo, a API sob /demo.
        AMBIENTE="producao",
        CORS_ORIGINS="https://loja.exemplo.com.br",
        JWT_SECRET="d" * 64,
        PREFIXO="/demo",
        **extra,
    )
    return limpo


def _da_demo(**extra: str) -> dict[str, str]:
    return _ambiente(
        LOJA_DEMONSTRACAO="1",
        DEMO_ADMIN_EMAIL=EMAIL_DO_DONO,
        DEMO_ADMIN_SENHA=SENHA_DO_DONO,
        DEMO_ADMIN_NOME="Dona Maria",
        **extra,
    )


def _rodar(comando: str, env: dict[str, str], tmp_path: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, "-m", "app.cli", comando],
        cwd=PASTA_API, capture_output=True, text=True, timeout=600,
        env={**env, "MEDIA_DIR": str(tmp_path / "media")},
    )


def _sem_segredo(feito: subprocess.CompletedProcess[str]) -> str:
    saida = feito.stdout + feito.stderr
    for segredo in (SENHA_DO_DONO, SENHA_DO_PAPEL, _url_da_demo(), "d" * 64):
        assert segredo not in saida, "a saída da CLI levou um segredo"
    return saida


@pytest.fixture
async def banco_da_demo() -> AsyncIterator[str]:
    """Um banco vazio e migrado, de um papel sem superusuário — ainda SEM o marco."""
    await _apagar_banco_e_papel()
    await _como_admin(
        f"CREATE ROLE \"{PAPEL_DA_DEMO}\" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE "
        f"PASSWORD '{SENHA_DO_PAPEL}'"
    )
    await _como_admin(f'CREATE DATABASE "{BANCO_DA_DEMO}" OWNER "{PAPEL_DA_DEMO}"')
    migrou = subprocess.run(
        [sys.executable, "-m", "alembic", "upgrade", "head"],
        cwd=PASTA_API, capture_output=True, text=True, timeout=300, env=_ambiente(),
    )
    assert migrou.returncode == 0, (migrou.stdout + migrou.stderr)[-3000:]
    try:
        yield BANCO_DA_DEMO
    finally:
        await _como_admin(f'ALTER DATABASE "{BANCO_DA_DEMO}" RESET loja.demonstracao')
        await _apagar_banco_e_papel()


async def _marcar_o_banco(marcado: bool = True) -> None:
    """O que o serviço demo-banco faz a cada subida (e o que desfaz)."""
    if marcado:
        await _como_admin(f"ALTER DATABASE \"{BANCO_DA_DEMO}\" SET loja.demonstracao = 'sim'")
    else:
        await _como_admin(f'ALTER DATABASE "{BANCO_DA_DEMO}" RESET loja.demonstracao')


async def _consultar(sql: str, *args):
    conexao = await asyncpg.connect(
        host=_BASE.host, port=_BASE.port or 5432, user=_BASE.username,
        password=_BASE.password, database=BANCO_DA_DEMO,
    )
    try:
        return await conexao.fetch(sql, *args)
    finally:
        await conexao.close()


#: O retrato da demo: o que a carga gravou, tabela por tabela, e os números que somam.
RETRATO = """
SELECT (SELECT count(*) FROM users), (SELECT count(*) FROM products),
       (SELECT count(*) FROM product_variants), (SELECT count(*) FROM sales),
       (SELECT count(*) FROM sales WHERE status = 'CANCELADA'), (SELECT sum(total) FROM sales),
       (SELECT count(*) FROM sale_payments), (SELECT count(*) FROM stock_entries),
       (SELECT sum(quantity) FROM stock_balances), (SELECT count(*) FROM stock_movements),
       (SELECT count(*) FROM expenses), (SELECT count(*) FROM customers),
       (SELECT count(*) FROM customer_payments), (SELECT count(*) FROM sale_returns),
       (SELECT count(*) FROM vouchers), (SELECT count(*) FROM cash_closings),
       (SELECT count(*) FROM payables),
       (SELECT count(*) FROM audit_log WHERE acao LIKE 'DEMONSTRACAO%'),
       (SELECT min(id) FROM users), (SELECT min(id) FROM sales)
"""

#: O que um preparo mexe: contas, diário, a identidade da loja (a migration já deixa a linha
#: de fábrica, "Minha Loja") e o catálogo.
_INTOCADO = (
    "SELECT (SELECT count(*) FROM users), (SELECT count(*) FROM audit_log), "
    "(SELECT string_agg(nome || '/' || segmento, ',') FROM store_config), "
    "(SELECT count(*) FROM categories)"
)


async def test_sem_as_duas_chaves_recusa_e_nao_toca_em_nada(
    banco_da_demo: str, tmp_path: Path
) -> None:
    de_fabrica = tuple((await _consultar(_INTOCADO))[0])
    assert de_fabrica[:2] == (0, 0) and de_fabrica[3] == 0

    # A loja de verdade: o banco SEM o marco, mesmo com a variável copiada por engano.
    for comando in ("preparar-demonstracao", "renovar-demonstracao"):
        feito = _rodar(comando, _da_demo(), tmp_path)
        saida = _sem_segredo(feito)
        assert feito.returncode == 2, saida[-3000:]
        assert "marco da demonstração" in feito.stderr and "nada foi feito" in feito.stderr
    assert tuple((await _consultar(_INTOCADO))[0]) == de_fabrica

    # Uma peça "da loja" no banco: a renovação recusada não a apaga.
    await _consultar("INSERT INTO categories (name) VALUES ('Da loja')")
    # O banco marcado, mas o contêiner não é o da demo: também não.
    await _marcar_o_banco()
    for comando in ("preparar-demonstracao", "renovar-demonstracao"):
        feito = _rodar(comando, _ambiente(DEMO_ADMIN_EMAIL=EMAIL_DO_DONO,
                                          DEMO_ADMIN_SENHA=SENHA_DO_DONO), tmp_path)
        saida = _sem_segredo(feito)
        assert feito.returncode == 2, saida[-3000:]
        assert "LOJA_DEMONSTRACAO" in feito.stderr and "nada foi feito" in feito.stderr
    assert tuple((await _consultar(_INTOCADO))[0]) == (*de_fabrica[:3], 1)


async def test_com_as_duas_chaves_semeia_converge_e_renova(
    banco_da_demo: str, tmp_path: Path
) -> None:
    await _marcar_o_banco()

    # 1. A primeira subida semeia, com o nome e o ramo da demo.
    feito = _rodar("preparar-demonstracao", _da_demo(), tmp_path)
    saida = _sem_segredo(feito)
    assert feito.returncode == 0, saida[-3000:]
    assert "demonstração semeada" in feito.stdout

    usuarios = await _consultar("SELECT email, role, password_hash FROM users")
    assert {u["email"]: u["role"] for u in usuarios} == {
        EMAIL_DO_DONO: "ADMIN", "ana@loja.com": "VENDEDOR"
    }
    loja = (await _consultar("SELECT nome, segmento FROM store_config"))[0]
    assert tuple(loja) == ("Loja de Demonstração", "ROUPAS")
    autores = await _consultar(
        "SELECT DISTINCT user_nome FROM audit_log WHERE acao LIKE 'DEMONSTRACAO%'"
    )
    assert [a["user_nome"] for a in autores] == ["Demonstração (instalação)"]
    retrato = tuple((await _consultar(RETRATO))[0])
    assert retrato[1] == 10 and retrato[3] > 100 and retrato[17] == 2

    # 2. A subida seguinte não duplica nada.
    de_novo = _rodar("preparar-demonstracao", _da_demo(), tmp_path)
    assert de_novo.returncode == 0, _sem_segredo(de_novo)[-3000:]
    assert "já semeada" in de_novo.stdout
    assert tuple((await _consultar(RETRATO))[0]) == retrato

    # 3. A conta das notas mexida no banco (rebaixada, desligada, outra senha) volta a ser a
    #    do .env na subida seguinte — o revisor entra sem ninguém consertar à mão.
    await _consultar(
        "UPDATE users SET role = 'VENDEDOR', is_active = false, password_hash = $1 "
        "WHERE email = $2",
        hash_senha("outra-senha-qualquer"),
        EMAIL_DO_DONO,
    )
    convergiu = _rodar("preparar-demonstracao", _da_demo(), tmp_path)
    assert convergiu.returncode == 0, _sem_segredo(convergiu)[-3000:]
    assert "acertada" in convergiu.stdout
    dono = (await _consultar(
        "SELECT role, is_active, password_hash FROM users WHERE email = $1", EMAIL_DO_DONO
    ))[0]
    assert dono["role"] == "ADMIN" and dono["is_active"]
    assert verificar_senha(SENHA_DO_DONO, dono["password_hash"])
    assert tuple((await _consultar(RETRATO))[0]) == retrato

    # 4. Uma semana depois, os dados envelheceram; a renovação zera e semeia de novo, com as
    #    vendas voltando para hoje — e a demo renovada é igual à primeira.
    await _consultar(
        "UPDATE sales SET sold_at = sold_at - interval '30 days', "
        "created_at = created_at - interval '30 days'"
    )
    renovou = _rodar("renovar-demonstracao", _da_demo(), tmp_path)
    assert renovou.returncode == 0, _sem_segredo(renovou)[-3000:]
    assert "zerada" in renovou.stdout and "demonstração semeada" in renovou.stdout
    assert tuple((await _consultar(RETRATO))[0]) == retrato
    ultima = (await _consultar("SELECT max(sold_at) FROM sales"))[0][0]
    hoje = datetime.now(UTC).astimezone(settings.tz_loja).date()
    assert ultima.astimezone(settings.tz_loja).date() == hoje
    loja = (await _consultar("SELECT nome, segmento FROM store_config"))[0]
    assert tuple(loja) == ("Loja de Demonstração", "ROUPAS")


async def test_preparo_espera_a_renovacao_que_esta_rodando(
    banco_da_demo: str, tmp_path: Path
) -> None:
    """Quem segura a trava da demonstração faz o outro esperar — nunca os dois juntos."""
    await _marcar_o_banco()
    conexao = await asyncpg.connect(
        host=_BASE.host, port=_BASE.port or 5432, user=_BASE.username,
        password=_BASE.password, database=BANCO_DA_DEMO,
    )
    try:
        await conexao.execute("SELECT pg_advisory_lock(46, 1)")  # "a renovação em curso"
        processo = subprocess.Popen(
            [sys.executable, "-m", "app.cli", "preparar-demonstracao"],
            cwd=PASTA_API, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            env={**_da_demo(), "MEDIA_DIR": str(tmp_path / "media")},
        )
        prazo = time.monotonic() + 60
        while True:
            esperando = await conexao.fetchval(
                "SELECT count(*) FROM pg_stat_activity "
                "WHERE datname = current_database() AND wait_event = 'advisory'"
            )
            if esperando:
                break
            assert processo.poll() is None, "o preparo não esperou a trava"
            assert time.monotonic() < prazo, "o preparo nunca chegou à trava"
            await asyncio.sleep(0.05)
        # Na fila, nada foi gravado.
        assert (await conexao.fetchval("SELECT count(*) FROM users")) == 0
        await conexao.execute("SELECT pg_advisory_unlock(46, 1)")
        saida, erros = processo.communicate(timeout=600)
    finally:
        await conexao.close()
    assert processo.returncode == 0, (saida + erros)[-3000:]
    assert "esperando" in saida and "demonstração semeada" in saida
