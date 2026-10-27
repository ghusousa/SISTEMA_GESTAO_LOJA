"""Configuração do backup na nuvem.

A promessa: só o dono mexe, o token do Google NUNCA sai por rota nenhuma, e ligar sem
conta conectada é recusado — porque uma tela dizendo "ativo" sem backup acontecendo é
pior do que não ter tela.
"""

import os
import re
import shlex
import shutil
import subprocess
import sys
import time
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

import pytest
from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.permissoes import Pode, pode
from app.modules.usuarios.models import Papel


TOKEN = '{"access_token":"aa","refresh_token":"bb","expiry":"2030-01-01T00:00:00Z"}'


async def test_so_o_dono_mexe_no_backup(
    client: AsyncClient, auth_gerente: dict, auth_supervisora: dict, auth_vendedor: dict
) -> None:
    """Quem tem a conta do Drive tem a loja inteira: vendas, custos, clientes e dívidas."""
    for headers in (auth_gerente, auth_supervisora, auth_vendedor):
        assert (await client.get("/backup", headers=headers)).status_code == 403
        resp = await client.put("/backup", json={"ativo": True}, headers=headers)
        assert resp.status_code == 403
    assert (await client.get("/backup")).status_code == 401


async def test_gerir_backup_e_capacidade_so_do_dono() -> None:
    assert pode(Papel.ADMIN, Pode.GERIR_BACKUP)
    for papel in (Papel.GERENTE, Papel.SUPERVISORA, Papel.VENDEDOR):
        assert not pode(papel, Pode.GERIR_BACKUP)


async def test_nasce_desligado_e_sem_conta(client: AsyncClient, auth_admin: dict) -> None:
    corpo = (await client.get("/backup", headers=auth_admin)).json()
    assert corpo["ativo"] is False
    assert corpo["configurado"] is False
    assert corpo["manter"] == 10
    assert corpo["intervalo_min"] == 30


async def test_o_token_do_google_nunca_sai(client: AsyncClient, auth_admin: dict) -> None:
    """O teste mais importante deste arquivo."""
    await client.put("/backup", json={"rclone_token": TOKEN}, headers=auth_admin)
    resp = await client.get("/backup", headers=auth_admin)
    assert resp.status_code == 200
    assert resp.json()["configurado"] is True
    # nem o campo, nem o valor, em lugar nenhum da resposta
    assert "rclone_token" not in resp.json()
    assert "refresh_token" not in resp.text
    assert "bb" not in resp.text


async def test_ligar_sem_conta_conectada_e_recusado(
    client: AsyncClient, auth_admin: dict
) -> None:
    """Senão a tela diria 'ativo' e nada aconteceria — o pior tipo de backup."""
    resp = await client.put("/backup", json={"ativo": True}, headers=auth_admin)
    assert resp.status_code == 409
    assert resp.json()["code"] == "OPERACAO_INVALIDA"


async def test_ligar_depois_de_conectar_funciona(
    client: AsyncClient, auth_admin: dict
) -> None:
    await client.put("/backup", json={"rclone_token": TOKEN}, headers=auth_admin)
    resp = await client.put("/backup", json={"ativo": True}, headers=auth_admin)
    assert resp.status_code == 200
    assert resp.json()["ativo"] is True


async def test_salvar_sem_mandar_token_nao_apaga_o_que_existe(
    client: AsyncClient, auth_admin: dict, session: AsyncSession
) -> None:
    """Desligar e religar não pode exigir reconectar a conta do Google."""
    await client.put("/backup", json={"rclone_token": TOKEN, "ativo": True}, headers=auth_admin)
    await client.put("/backup", json={"ativo": False}, headers=auth_admin)
    guardado = await session.scalar(
        text("SELECT rclone_token FROM backup_config WHERE id = 1")
    )
    assert guardado == TOKEN
    assert (await client.get("/backup", headers=auth_admin)).json()["configurado"] is True


async def test_texto_que_nao_e_token_e_recusado(
    client: AsyncClient, auth_admin: dict
) -> None:
    """Colar o texto errado e a tela dizer 'configurado' faria a loja passar semanas
    achando que tem backup."""
    for lixo in ["meu token", "https://drive.google.com/...", '{"foo":"bar"}']:
        resp = await client.put("/backup", json={"rclone_token": lixo}, headers=auth_admin)
        assert resp.status_code == 422, lixo


async def test_teto_de_copias_tem_minimo(client: AsyncClient, auth_admin: dict) -> None:
    """Guardar 1 cópia é não ter backup: a próxima apaga a única boa."""
    assert (await client.put("/backup", json={"manter": 1}, headers=auth_admin)).status_code == 422
    assert (await client.put("/backup", json={"manter": 10}, headers=auth_admin)).status_code == 200


async def test_intervalo_tem_minimo(client: AsyncClient, auth_admin: dict) -> None:
    assert (
        await client.put("/backup", json={"intervalo_min": 1}, headers=auth_admin)
    ).status_code == 422
    assert (
        await client.put("/backup", json={"intervalo_min": 30}, headers=auth_admin)
    ).status_code == 200


async def test_o_estado_da_ultima_copia_chega_na_tela(
    client: AsyncClient, auth_admin: dict, session: AsyncSession
) -> None:
    """É o `backup.sh` quem escreve isto, na máquina. A tela só lê — e é o que faz o dono
    confiar ou desconfiar do backup."""
    await client.get("/backup", headers=auth_admin)  # garante a linha
    await session.execute(
        text(
            "UPDATE backup_config SET ultimo_em = now(), ultimo_ok = true, "
            "ultimo_bytes = 4200000, copias_na_nuvem = 10 WHERE id = 1"
        )
    )
    await session.commit()
    corpo = (await client.get("/backup", headers=auth_admin)).json()
    assert corpo["ultimo_ok"] is True
    assert corpo["ultimo_bytes"] == 4200000
    assert corpo["copias_na_nuvem"] == 10


async def test_mexer_no_backup_entra_no_diario(
    client: AsyncClient, auth_admin: dict
) -> None:
    await client.put("/backup", json={"rclone_token": TOKEN}, headers=auth_admin)
    diario = await client.get("/auditoria?acao=BACKUP_CONFIGURADO", headers=auth_admin)
    assert diario.json()["total"] == 1


# ------------------------------------------------------------------ o backup.sh de verdade
#
# Os testes acima prendem a tela; os de baixo rodam o `backup.sh`, que é quem copia, com um
# `docker` e um `rclone` de mentira no PATH: o "db" é um Postgres de verdade, o Drive é uma
# pasta. Foi rodando o script que apareceram os defeitos que a tela não via — ligado na tela
# e nenhuma cópia, nunca, sem erro em lugar nenhum.

RAIZ = Path(__file__).resolve().parents[2]
PASTA_API = RAIZ / "api"

precisa_da_maquina = pytest.mark.skipif(
    not all(shutil.which(p) for p in ("bash", "psql", "pg_dump", "pg_restore")),
    reason="roda o backup.sh: precisa de bash e dos clientes do Postgres nesta máquina",
)

DOCKER_DE_MENTIRA = r"""#!/usr/bin/env bash
# "db" = Postgres local ($FAKE_DB); os arquivos "do contêiner" moram em $FAKE_CTR.
echo "docker $*" >> "$FAKE_CTR/docker.log"
case "$1" in
    info|rm) exit 0 ;;
    ps) printf '%s\n' ${FAKE_PS:-}; exit 0 ;;
    image) echo "Total reclaimed space: 0B"; exit 0 ;;
    compose) shift ;;
    *) exit 0 ;;
esac
dentro() { printf '%s/%s' "$FAKE_CTR" "$(basename "$1")"; }
case "$1" in
    exec)
        shift; [ "$1" = -T ] && shift; svc="$1"; shift; prog="$1"; shift
        if [ "$svc" = db ]; then
            args=(); com_d=0
            while [ $# -gt 0 ]; do
                case "$1" in
                    -U) shift 2 ;;
                    -d) com_d=1; shift 2 ;;
                    -f) args+=(-f "$(dentro "$2")"); shift 2 ;;
                    /tmp/*) args+=("$(dentro "$1")"); shift ;;
                    *) args+=("$1"); shift ;;
                esac
            done
            case "$prog" in
                psql|pg_dump) exec "$prog" -d "$FAKE_DB" "${args[@]}" ;;
                pg_restore) [ "$com_d" = 1 ] && args=(-d "$FAKE_DB" "${args[@]}")
                            exec pg_restore "${args[@]}" ;;
                *) exit 0 ;;
            esac
        fi
        [ "$svc" = api ] && exec bash -c "${FAKE_API:-exit 0}"
        exit 0 ;;
    cp) case "$2" in
            db:*) cp "$(dentro "${2#db:}")" "$3" ;;
            *) cp "$2" "$(dentro "${3#db:}")" ;;
        esac ;;
    logs) echo "(log da api)" ;;
esac
"""

RCLONE_DE_MENTIRA = r"""#!/usr/bin/env bash
# O Drive é a pasta $DRIVE.
[ "$1" = --config ] && shift 2
case "$1" in
    copy) mkdir -p "$DRIVE/${3#loja:}"; cp "$2" "$DRIVE/${3#loja:}/" ;;
    copyto) mkdir -p "$(dirname "$DRIVE/${3#loja:}")"; cp "$2" "$DRIVE/${3#loja:}" ;;
    lsf) ls -1 "$DRIVE/${2#loja:}" 2>/dev/null | grep '^loja-.*\.dump$' ;;
    deletefile) rm -f "$DRIVE/${2#loja:}" ;;
esac
"""


def _postgres() -> dict[str, str]:
    """Onde está o Postgres dos testes, do jeito que psql/pg_dump/pg_restore leem."""
    url = make_url(settings.database_url)
    return {
        "PGHOST": url.host or "localhost",
        "PGPORT": str(url.port or 5432),
        "PGUSER": url.username or "postgres",
        "PGPASSWORD": url.password or "",
    }


def _maquina(tmp_path: Path, banco: str | None = None, **extra: str) -> dict[str, str]:
    """Ambiente com docker, rclone e sleep de mentira no PATH (sleep para a espera do
    /health não custar minutos no teste)."""
    bin_ = tmp_path / "bin"
    bin_.mkdir()
    for nome, corpo in (
        ("docker", DOCKER_DE_MENTIRA),
        ("rclone", RCLONE_DE_MENTIRA),
        ("sleep", "#!/bin/sh\nexit 0\n"),
    ):
        (bin_ / nome).write_text(corpo)
        (bin_ / nome).chmod(0o755)
    for pasta in ("ctr", "drive", "home"):
        (tmp_path / pasta).mkdir()
    return {
        **os.environ,
        **_postgres(),
        "PATH": f"{bin_}{os.pathsep}{os.environ.get('PATH', '')}",
        "FAKE_DB": banco or make_url(settings.database_url).database or "loja_test",
        "FAKE_CTR": str(tmp_path / "ctr"),
        "DRIVE": str(tmp_path / "drive"),
        "HOME": str(tmp_path / "home"),
        **extra,
    }


def _pasta_da_loja(tmp_path: Path) -> Path:
    """Uma CÓPIA do backup.sh numa pasta de mentira: ele grava `backups/` ao lado de si."""
    loja = tmp_path / "loja"
    if not loja.exists():
        loja.mkdir()
        shutil.copy(RAIZ / "backup.sh", loja / "backup.sh")
        (loja / "docker-compose.yml").write_text("")
    return loja


def _backup_sh(tmp_path: Path, env: dict[str, str], *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["bash", str(_pasta_da_loja(tmp_path) / "backup.sh"), *args],
        env=env, capture_output=True, text=True, timeout=300,
    )


def _psql(env: dict[str, str], banco: str, sql: str) -> str:
    feito = subprocess.run(
        ["psql", "-d", banco, "-v", "ON_ERROR_STOP=1", "-tAqc", sql],
        env=env, capture_output=True, text=True, check=True, timeout=60,
    )
    return feito.stdout.strip()


def _url_de(banco: str) -> str:
    return make_url(settings.database_url).set(database=banco).render_as_string(
        hide_password=False
    )


def _alembic(banco: str, *args: str) -> None:
    subprocess.run(
        [sys.executable, "-m", "alembic", *args],
        cwd=PASTA_API, env={**os.environ, "DATABASE_URL": _url_de(banco)},
        capture_output=True, check=True, timeout=120,
    )


@contextmanager
def _banco_descartavel() -> Iterator[str]:
    """Um banco vazio só deste teste: restaurar ZERA o schema, e o loja_test é de todos."""
    env = {**os.environ, **_postgres()}
    nome = f"{make_url(settings.database_url).database}_descartavel"
    _psql(env, "postgres", f'DROP DATABASE IF EXISTS "{nome}" WITH (FORCE)')
    _psql(env, "postgres", f'CREATE DATABASE "{nome}"')
    try:
        yield nome
    finally:
        _psql(env, "postgres", f'DROP DATABASE IF EXISTS "{nome}" WITH (FORCE)')


@pytest.fixture
def banco_descartavel() -> Iterator[str]:
    with _banco_descartavel() as nome:
        yield nome


async def _ligar_backup(session: AsyncSession, manter: int = 10) -> None:
    await session.execute(
        text(
            "INSERT INTO backup_config (id, ativo, rclone_token, pasta, manter, intervalo_min) "
            "VALUES (1, true, :token, 'loja', :manter, 30)"
        ),
        {"token": TOKEN, "manter": manter},
    )
    await session.commit()


@precisa_da_maquina
async def test_ligado_na_tela_o_timer_copia_de_verdade(
    session: AsyncSession, tmp_path: Path
) -> None:
    """`ativo::text` é 'true', não 't': comparar com "t" fazia o backup ligado nunca rodar —
    o timer saía calado, sem cópia e sem erro, e a tela continuava dizendo 'ligado'."""
    await _ligar_backup(session)
    r = _backup_sh(tmp_path, _maquina(tmp_path), "--nuvem-timer", "--sim")
    assert r.returncode == 0, r.stdout + r.stderr
    no_drive = [p.name for p in (tmp_path / "drive" / "loja").iterdir()]
    assert len(no_drive) == 1
    assert re.fullmatch(r"loja-\d{8}-\d{6}\.dump", no_drive[0]), no_drive
    linha = (
        await session.execute(text("SELECT ultimo_ok, copias_na_nuvem FROM backup_config"))
    ).one()
    assert linha.ultimo_ok is True
    assert linha.copias_na_nuvem == 1


@precisa_da_maquina
async def test_sem_home_como_no_systemd_o_backup_roda(tmp_path: Path) -> None:
    """Serviço de sistema sem User= não recebe $HOME, e com `set -u` o script morria ao ler
    o caminho da configuração do rclone — antes do pg_dump, todo dia, com o erro só no
    journal."""
    env = _maquina(tmp_path)
    del env["HOME"]
    r = _backup_sh(tmp_path, env, "--sim")
    assert r.returncode == 0, r.stdout + r.stderr
    assert list((tmp_path / "loja" / "backups").glob("loja-*.dump"))
    # E as duas unidades que o script grava levam o HOME, para o rclone achar a configuração.
    assert (RAIZ / "backup.sh").read_text().count("Environment=HOME=/root") == 2


@precisa_da_maquina
async def test_rotacao_do_drive_nao_congela_o_ultimo_backup(
    session: AsyncSession, tmp_path: Path
) -> None:
    """O recado 'apagada do Drive' ia para o stdout que vira o número de cópias: o UPDATE
    quebrava calado, `ultimo_em` congelava e o timer passava a copiar a cada 5 minutos —
    com 10 cópias, o Drive guardava só os últimos 50 minutos."""
    await _ligar_backup(session, manter=2)
    drive = tmp_path / "drive" / "loja"
    env = _maquina(tmp_path)
    drive.mkdir()
    for velha in ("loja-20260101-031500.dump", "loja-20260102-031500.dump"):
        (drive / velha).write_text("")

    r = _backup_sh(tmp_path, env, "--nuvem")

    assert r.returncode == 0, r.stdout + r.stderr
    assert "apagada do Drive: loja-20260101-031500.dump" in r.stderr
    ficaram = sorted(p.name for p in drive.iterdir())
    assert len(ficaram) == 2 and ficaram[0] == "loja-20260102-031500.dump"
    linha = (
        await session.execute(
            text("SELECT ultimo_em, ultimo_ok, copias_na_nuvem FROM backup_config")
        )
    ).one()
    assert linha.ultimo_em is not None
    assert linha.ultimo_ok is True
    assert linha.copias_na_nuvem == 2


@precisa_da_maquina
async def test_faxina_da_nuvem_so_apaga_as_copias_dela(
    session: AsyncSession, tmp_path: Path
) -> None:
    """A faxina de 12 h apagava todo `loja-*.dump`: o dump de segurança do --restaurar (que
    nunca sobe para o Drive) e as cópias diárias, que prometem 14 dias."""
    await _ligar_backup(session)
    env = _maquina(tmp_path)
    backups = _pasta_da_loja(tmp_path) / "backups"
    backups.mkdir()
    agora = time.time()
    guardar = {
        "loja-antes-de-restaurar-20261026-100000.dump": agora - 13 * 3600,
        "loja-20261023-031500.dump": agora - 3 * 86400,
    }
    velha_da_nuvem = {"loja-nuvem-20261026-100000.dump": agora - 13 * 3600}
    for nome, quando in {**guardar, **velha_da_nuvem}.items():
        (backups / nome).write_text("")
        os.utime(backups / nome, (quando, quando))

    r = _backup_sh(tmp_path, env, "--nuvem")

    assert r.returncode == 0, r.stdout + r.stderr
    ficaram = {p.name for p in backups.iterdir()}
    assert set(guardar) <= ficaram
    assert not set(velha_da_nuvem) & ficaram
    assert any(n.startswith("loja-nuvem-") for n in ficaram)  # a de agora fica


@precisa_da_maquina
async def test_restaurar_copia_de_antes_de_uma_migration_deixa_a_api_subir(
    tmp_path: Path, banco_descartavel: str
) -> None:
    """O uso previsto: voltar para o `loja-backup-antes-de-atualizar-*`. `pg_restore --clean`
    só derrubava o que estava no dump: a tabela da migration nova ficava, o alembic_version
    voltava, e o `upgrade head` do contêiner caía em DuplicateTable — a loja não subia mais."""
    banco = banco_descartavel
    # O "contêiner da API" faz o que o entrada.sh faz: migra até a head, e só então responde.
    sobe = (
        f"cd {shlex.quote(str(PASTA_API))} && DATABASE_URL={shlex.quote(_url_de(banco))} "
        f"{shlex.quote(sys.executable)} -m alembic upgrade head"
    )
    env = _maquina(tmp_path, banco, FAKE_API=sobe)
    _alembic(banco, "upgrade", "head")
    cabeca = _psql(env, banco, "SELECT version_num FROM alembic_version")
    # A cópia é de antes da migration que CRIA `backup_config` (b6a389f137a3): é tabela
    # nova, que o dump não conhece, o que o `--clean` deixava para trás.
    _alembic(banco, "downgrade", "b6a389f137a3-1")
    _psql(env, banco, "INSERT INTO categories (name) VALUES ('da cópia')")
    antiga = tmp_path / "antes-da-migration.dump"
    subprocess.run(["pg_dump", "-d", banco, "-Fc", "-f", str(antiga)], env=env, check=True)
    _alembic(banco, "upgrade", "head")
    _psql(env, banco, "INSERT INTO categories (name) VALUES ('depois da cópia')")

    r = _backup_sh(tmp_path, env, "--restaurar", str(antiga), "--sim")

    assert r.returncode == 0, r.stdout + r.stderr
    assert "a loja voltou" in r.stdout
    assert _psql(env, banco, "SELECT version_num FROM alembic_version") == cabeca
    assert _psql(env, banco, "SELECT string_agg(name, ',') FROM categories") == "da cópia"


@precisa_da_maquina
async def test_restaurar_arquivo_ruim_nao_mexe_no_banco(
    tmp_path: Path, banco_descartavel: str
) -> None:
    """Zerar o schema e recriar pelo dump é UMA transação: se o arquivo não abre, o banco
    fica o de antes e a loja volta com ele — em vez de meio apagada."""
    banco = banco_descartavel
    env = _maquina(tmp_path, banco)
    _alembic(banco, "upgrade", "head")
    _psql(env, banco, "INSERT INTO categories (name) VALUES ('ainda aqui')")
    ruim = tmp_path / "ruim.dump"
    ruim.write_bytes(b"PGDMP" + b"\0" * 64)

    r = _backup_sh(tmp_path, env, "--restaurar", str(ruim), "--sim")

    assert r.returncode == 1
    assert "o banco continua o de antes" in r.stderr
    assert _psql(env, banco, "SELECT count(*) FROM categories WHERE name = 'ainda aqui'") == "1"
