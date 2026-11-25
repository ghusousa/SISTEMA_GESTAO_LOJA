"""Configuração do backup na nuvem.

A promessa: só o dono mexe, o token do Google NUNCA sai por rota nenhuma, e ligar sem
conta conectada é recusado — porque uma tela dizendo "ativo" sem backup acontecendo é
pior do que não ter tela.
"""

import os
import re
import shlex
import shutil
import stat
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
    ps)  # $FAKE_PS são os contêineres da máquina; o --filter name= vale (por pedaço do nome)
        filtro=""
        while [ $# -gt 0 ]; do case "$1" in --filter) filtro="${2#name=}"; shift 2 ;; *) shift ;; esac; done
        for nome in ${FAKE_PS:-}; do case "$nome" in *"$filtro"*) printf '%s\n' "$nome" ;; esac; done
        exit 0 ;;
    image) echo "Total reclaimed space: 0B"; exit 0 ;;
    compose) shift ;;
    *) exit 0 ;;
esac
while [ "${1:-}" = --profile ]; do shift 2; done
dentro() { printf '%s/%s' "$FAKE_CTR" "$(basename "$1")"; }
case "$1" in
    ps)  # `compose ps -q SERVIÇO`: o id do contêiner (o `up` troca o de quem está em $FAKE_RECRIA)
        [ "${2:-}" = -q ] && [ -n "${3:-}" ] && { cat "$FAKE_CTR/id-$3" 2>/dev/null || echo "id-$3"; }
        exit 0 ;;
    up)  # falha se pedir um serviço de $FAKE_UP_FALHA; recria os de $FAKE_RECRIA
        for svc in ${FAKE_UP_FALHA:-}; do case " $* " in *" $svc "*) exit 1 ;; esac; done
        for svc in ${FAKE_RECRIA:-}; do
            printf '%s+\n' "$(cat "$FAKE_CTR/id-$svc" 2>/dev/null || echo "id-$svc")" > "$FAKE_CTR/id-$svc"
        done
        exit 0 ;;
    exec)
        shift; [ "$1" = -T ] && shift; svc="$1"; shift; prog="$1"; shift
        if [ "$svc" = db ]; then
            # O banco da demonstração NÃO existe no Postgres dos testes, que é de todos: o SQL
            # dele (DROP DATABASE, DROP ROLE) só é anotado, nunca roda de verdade aqui.
            case " $* " in *loja_demo*) exit 0 ;; esac
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
        # A demonstração e o proxy recebem o comando: "$1 $2" = "python -c", "caddy validate"...
        [ "$svc" = api-demo ] && exec bash -c "${FAKE_API_DEMO:-exit 0}" _ "$prog" "$@"
        [ "$svc" = proxy ] && exec bash -c "${FAKE_PROXY:-exit 0}" _ "$prog" "$@"
        exit 0 ;;
    cp) case "$2" in
            db:*) cp "$(dentro "${2#db:}")" "$3" ;;
            *) cp "$2" "$(dentro "${3#db:}")" ;;
        esac ;;
    logs) echo "(log da api)" ;;
esac
"""

RCLONE_DE_MENTIRA = r"""#!/usr/bin/env bash
# O Drive é a pasta $DRIVE: o remote do tipo drive é ela mesma, e um remote qualquer "x:"
# (o BACKUP_REMOTO) é $DRIVE/x/. O tipo `crypt` — no --config ou em RCLONE_CONFIG_<NOME>_*,
# como o de verdade — cifra de mentira: NOME vira NOME.bin, com "RCLONE\0\0<senha>" na
# primeira linha; abrir confere a senha e falha com a errada, como o de verdade.
echo "rclone $*" >> "$FAKE_CTR/rclone.log"
conf=""
[ "$1" = --config ] && { conf="$2"; shift 2; }
if [ "$1" = obscure ]; then read -r s; printf 'obsc-%s\n' "$s"; exit 0; fi
campo() {
    local v="" var
    [ -n "$conf" ] && v="$(awk -v s="[$1]" -v k="$2" '$0 == s {d = 1; next} /^\[/ {d = 0}
        d && $1 == k {sub(/^[^=]*= */, ""); print; exit}' "$conf")"
    if [ -z "$v" ]; then
        var="RCLONE_CONFIG_$(printf '%s' "$1" | tr 'a-z-' 'A-Z_')_$(printf '%s' "$2" | tr 'a-z' 'A-Z')"
        v="${!var:-}"
    fi
    printf '%s' "$v"
}
remoto() { case "$1" in /*|.*) return 1 ;; *:*) return 0 ;; *) return 1 ;; esac; }
# resolver <alvo>: CAMINHO = onde mora de verdade; SENHA = a do crypt (vazia = em claro)
resolver() {
    local nome resto base senha
    if ! remoto "$1"; then CAMINHO="$1"; SENHA=""; return; fi
    nome="${1%%:*}"; resto="${1#*:}"
    case "$(campo "$nome" type)" in
        crypt)
            senha="$(campo "$nome" password)"; base="$(campo "$nome" remote)"
            case "$base" in *:|'') resolver "$base$resto" ;; *) resolver "$base${resto:+/$resto}" ;; esac
            SENHA="$senha" ;;
        alias)
            base="$(campo "$nome" remote)"
            case "$base" in *:|'') resolver "$base$resto" ;; *) resolver "$base${resto:+/$resto}" ;; esac ;;
        drive) CAMINHO="$DRIVE${resto:+/$resto}"; SENHA="" ;;
        *)     CAMINHO="$DRIVE/$nome${resto:+/$resto}"; SENHA="" ;;
    esac
}
cifrar() { mkdir -p "$(dirname "$2")"; { printf 'RCLONE\0\0%s\n' "$SENHA"; cat "$1"; } > "$2"; }
abrir() {
    [ "$(head -n1 "$1" | tr -d '\0')" = "RCLONE$SENHA" ] \
        || { echo "ERROR : failed to authenticate decrypted block - bad password?" >&2; exit 1; }
    tail -n +2 "$1" > "$2"
}
case "$1" in
    copy)
        resolver "$3"; mkdir -p "$CAMINHO"
        if [ -n "$SENHA" ]; then cifrar "$2" "$CAMINHO/$(basename "$2").bin"; else cp "$2" "$CAMINHO/"; fi ;;
    copyto)
        if remoto "$2"; then
            resolver "$2"; [ -n "$SENHA" ] && abrir "$CAMINHO.bin" "$3" || cp "$CAMINHO" "$3"
        else
            resolver "$3"
            if [ -n "$SENHA" ]; then cifrar "$2" "$CAMINHO.bin"
            else mkdir -p "$(dirname "$CAMINHO")"; cp "$2" "$CAMINHO"; fi
        fi ;;
    lsf)
        resolver "$2"; padrao="${4:-*}"
        for f in "$CAMINHO"/*; do
            [ -f "$f" ] || continue; n="$(basename "$f")"
            if [ -n "$SENHA" ]; then case "$n" in *.bin) n="${n%.bin}" ;; *) continue ;; esac; fi
            # shellcheck disable=SC2254
            case "$n" in $padrao) echo "$n" ;; esac
        done ;;
    deletefile)
        resolver "$2"; if [ -n "$SENHA" ]; then rm -f "$CAMINHO.bin"; else rm -f "$CAMINHO"; fi ;;
esac
"""

# O que o systemd, o sudo e o syslog fariam, sem tocar na máquina de verdade: o systemctl só
# anota, o sudo só executa (com o PATH de mentira), e o logger não escreve no journal real.
SYSTEMCTL_DE_MENTIRA = '#!/bin/sh\necho "systemctl $*" >> "$FAKE_CTR/systemctl.log"\nexit 0\n'
SUDO_DE_MENTIRA = '#!/bin/sh\nexec "$@"\n'
LOGGER_DE_MENTIRA = '#!/bin/sh\nexit 0\n'


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
        ("systemctl", SYSTEMCTL_DE_MENTIRA),
        ("sudo", SUDO_DE_MENTIRA),
        ("logger", LOGGER_DE_MENTIRA),
    ):
        (bin_ / nome).write_text(corpo)
        (bin_ / nome).chmod(0o755)
    for pasta in ("ctr", "drive", "home", "systemd"):
        (tmp_path / pasta).mkdir()
    return {
        **os.environ,
        **_postgres(),
        "PATH": f"{bin_}{os.pathsep}{os.environ.get('PATH', '')}",
        "FAKE_DB": banco or make_url(settings.database_url).database or "loja_test",
        "FAKE_CTR": str(tmp_path / "ctr"),
        "DRIVE": str(tmp_path / "drive"),
        "HOME": str(tmp_path / "home"),
        # As unidades do systemd vão para uma pasta de mentira, nunca para /etc.
        "DIR_SYSTEMD": str(tmp_path / "systemd"),
        **extra,
    }


def _pasta_da_loja(tmp_path: Path) -> Path:
    """Uma CÓPIA do backup.sh numa pasta de mentira: ele grava `backups/` ao lado de si."""
    loja = tmp_path / "loja"
    if not loja.exists():
        loja.mkdir()
        for nome in ("backup.sh", "notificar.sh"):
            shutil.copy(RAIZ / nome, loja / nome)
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
    # Sem a chave confirmada por uma pessoa, a cópia sai como sempre saiu (ADR-28).
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
async def test_backup_nao_leva_os_aparelhos_de_notificacao(
    session: AsyncSession, tmp_path: Path
) -> None:
    """O token de push é credencial ao portador (ADR-47): com ele, qualquer um manda
    notificação com o nome e o ícone do app. O backup leva a tabela só como estrutura — a
    cópia de fora sai legível até alguém confirmar a chave do backup."""
    await session.execute(
        text(
            "INSERT INTO users (name, email, password_hash, role, is_active) "
            "VALUES ('Dona', 'dona@x.com', 'x', 'ADMIN', true)"
        )
    )
    await session.execute(
        text(
            "INSERT INTO notificacao_aparelhos (user_id, instalacao, plataforma, token) "
            "SELECT id, gen_random_uuid(), 'ios', 'ExponentPushToken[do-backup]' FROM users"
        )
    )
    await session.commit()

    r = _backup_sh(tmp_path, _maquina(tmp_path), "--sim")
    assert r.returncode == 0, r.stdout + r.stderr
    (dump,) = (tmp_path / "loja" / "backups").glob("loja-*.dump")
    indice = subprocess.run(
        ["pg_restore", "-l", str(dump)], capture_output=True, text=True, check=True, timeout=60
    ).stdout
    assert re.search(r"\bTABLE public notificacao_aparelhos\b", indice), indice
    assert "TABLE DATA public notificacao_aparelhos" not in indice
    assert "TABLE DATA public users" in indice, "o backup deixou de levar o resto"


def test_todo_pg_dump_da_loja_deixa_os_aparelhos_de_fora() -> None:
    """Guarda de texto: todo `pg_dump` dos scripts da raiz leva o `--exclude-table-data` da tabela
    dos tokens de push — os do Linux (o backup diário, o da nuvem, o de antes de restaurar, o de
    antes de atualizar e o de antes de desinstalar) E os do Windows (`backup.ps1`, o da Tarefa
    Agendada diária, e o de antes de desinstalar). O Windows também é caminho suportado
    (`instalar.bat`), e o backup dele vai para pen drive e nuvem do mesmo jeito.
    `utf-8-sig`: o `backup.ps1` começa com BOM, que o PowerShell 5 precisa."""
    comandos = [
        (script.name, numero, linha)
        for padrao in ("*.sh", "*.ps1")
        for script in sorted(RAIZ.glob(padrao))
        for numero, linha in enumerate(script.read_text(encoding="utf-8-sig").splitlines(), 1)
        if not linha.lstrip().startswith("#") and re.search(r"\bpg_dump\s+-", linha)
    ]
    assert {nome for nome, _, _ in comandos} == {
        "atualizar.sh",
        "backup.sh",
        "desinstalar.sh",
        "backup.ps1",
        "desinstalar.ps1",
    }
    assert len(comandos) >= 7, comandos
    for nome, numero, linha in comandos:
        assert "--exclude-table-data=notificacao_aparelhos" in linha, f"{nome}:{numero}"


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
    assert _backup_sh(tmp_path, env, "--confirmar-chave").returncode == 0
    # As de antes, já cifradas (`.dump.bin`): a rotação enxerga o Drive pelo crypt.
    for velha in ("loja-20260101-031500.dump.bin", "loja-20260102-031500.dump.bin"):
        (drive / velha).write_text("")

    r = _backup_sh(tmp_path, env, "--nuvem")

    assert r.returncode == 0, r.stdout + r.stderr
    assert "apagada do Drive: loja-20260101-031500.dump" in r.stderr
    ficaram = sorted(p.name for p in drive.iterdir())
    assert len(ficaram) == 2 and ficaram[0] == "loja-20260102-031500.dump.bin"
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


#: O rclone que não consegue enviar: anota para onde vai o stderr dele (o arquivo que o `2>`
#: do backup.sh abriu) e falha como o Drive cheio falha. O resto é o rclone de mentira.
MOTIVO_DO_DRIVE = "googleapi: Error 403: The user's Drive storage quota has been exceeded."
RCLONE_QUE_NAO_ENVIA = rf"""#!/usr/bin/env bash
if [ "$1" = --config ] && [ "$3" = copyto ]; then
    readlink /proc/self/fd/2 > "$FAKE_CTR/stderr-do-rclone"
    echo "ERROR : Attempt 3/3 failed with 1 errors" >&2
    echo "Failed to copyto: {MOTIVO_DO_DRIVE}" >&2
    exit 1
fi
exec "$(dirname "$0")/rclone-de-mentira" "$@"
"""


@precisa_da_maquina
@pytest.mark.skipif(not Path("/proc/self/fd").is_dir(), reason="lê o stderr do rclone no /proc")
async def test_envio_que_falha_diz_o_motivo_sem_caminho_fixo_no_tmp(
    session: AsyncSession, tmp_path: Path
) -> None:
    """O motivo ia para `/tmp/rclone.err`, um caminho fixo e de todos: criado antes por outro
    usuário (o root do timer, uma rodada dos testes), o `2>` falhava, e o script dizia "NÃO
    consegui enviar para o Drive" com o rclone bom. O motivo vai a um temporário do próprio
    processo, que some no fim — e continua chegando ao terminal e à tela."""
    await _ligar_backup(session)
    temporarios = tmp_path / "tmp"
    temporarios.mkdir()
    env = _maquina(tmp_path, TMPDIR=str(temporarios))
    rclone = tmp_path / "bin" / "rclone"
    rclone.rename(tmp_path / "bin" / "rclone-de-mentira")
    rclone.write_text(RCLONE_QUE_NAO_ENVIA)
    rclone.chmod(0o755)

    r = _backup_sh(tmp_path, env, "--nuvem")

    assert r.returncode == 1, r.stdout + r.stderr
    assert "NÃO consegui enviar para o Drive" in r.stderr
    assert MOTIVO_DO_DRIVE in r.stdout
    destino = Path((tmp_path / "ctr" / "stderr-do-rclone").read_text().strip())
    assert destino != Path("/tmp/rclone.err")
    assert destino.parent == temporarios.resolve(), destino
    assert not destino.exists()  # e não fica para trás
    linha = (
        await session.execute(text("SELECT ultimo_ok, ultimo_erro FROM backup_config"))
    ).one()
    assert linha.ultimo_ok is False
    assert linha.ultimo_erro.startswith("Não subiu para o Drive: ")
    assert MOTIVO_DO_DRIVE in linha.ultimo_erro


#: O mktemp que não cria nada (pasta temporária cheia, sem permissão): o envio segue sem ele.
MKTEMP_QUE_FALHA = (
    '#!/bin/sh\necho "mktemp: failed to create file via template: No space left" >&2\nexit 1\n'
)


@precisa_da_maquina
@pytest.mark.parametrize("sem", ["tmpdir_que_nao_existe", "mktemp_que_falha"])
async def test_sem_temporario_para_o_motivo_a_copia_vai_ao_drive_mesmo_assim(
    session: AsyncSession, tmp_path: Path, sem: str
) -> None:
    """O temporário do motivo do rclone nasceu para dizer por que o envio falhou, e não pode
    impedir o envio: com um TMPDIR que não existe, o mktemp falhava, o `set -e` encerrava o
    --nuvem depois do dump e antes do rclone, nada ia ao Drive e a tela ficava sem anotação
    (`ultimo_em`, `ultimo_ok` e `ultimo_erro` nulos). Agora tenta o /tmp e, sem nenhum dos
    dois, envia sem o motivo detalhado."""
    await _ligar_backup(session)
    env = _maquina(tmp_path, TMPDIR=str(tmp_path / "nao-existe"))
    if sem == "mktemp_que_falha":
        (tmp_path / "bin" / "mktemp").write_text(MKTEMP_QUE_FALHA)
        (tmp_path / "bin" / "mktemp").chmod(0o755)

    r = _backup_sh(tmp_path, env, "--nuvem")

    assert r.returncode == 0, r.stdout + r.stderr
    no_drive = [p.name for p in (tmp_path / "drive" / "loja").iterdir()]
    assert len(no_drive) == 1 and re.fullmatch(r"loja-\d{8}-\d{6}\.dump", no_drive[0])
    linha = (
        await session.execute(
            text("SELECT ultimo_em, ultimo_ok, ultimo_erro, copias_na_nuvem FROM backup_config")
        )
    ).one()
    assert linha.ultimo_em is not None
    assert linha.ultimo_ok is True and linha.ultimo_erro is None
    assert linha.copias_na_nuvem == 1


@precisa_da_maquina
@pytest.mark.skipif(not Path("/proc/self/fd").is_dir(), reason="lê o stderr do rclone no /proc")
@pytest.mark.parametrize("sem", ["tmpdir_que_nao_existe", "mktemp_que_falha"])
async def test_sem_temporario_o_envio_que_falha_ainda_e_anotado(
    session: AsyncSession, tmp_path: Path, sem: str
) -> None:
    """Com o TMPDIR que não existe, o motivo vai a um temporário do /tmp (e some no fim); sem
    temporário nenhum, a tela recebe a frase genérica e o motivo segue pela saída de erro do
    script (o journal do timer) — nunca ao /dev/null, que o some, nem apagando o /dev/null na saída
    do script (que roda como root no timer)."""
    await _ligar_backup(session)
    env = _maquina(tmp_path, TMPDIR=str(tmp_path / "nao-existe"))
    rclone = tmp_path / "bin" / "rclone"
    rclone.rename(tmp_path / "bin" / "rclone-de-mentira")
    rclone.write_text(RCLONE_QUE_NAO_ENVIA)
    rclone.chmod(0o755)
    if sem == "mktemp_que_falha":
        (tmp_path / "bin" / "mktemp").write_text(MKTEMP_QUE_FALHA)
        (tmp_path / "bin" / "mktemp").chmod(0o755)

    r = _backup_sh(tmp_path, env, "--nuvem")

    assert r.returncode == 1, r.stdout + r.stderr
    assert "NÃO consegui enviar para o Drive" in r.stderr
    assert Path("/dev/null").is_char_device()
    destino = Path((tmp_path / "ctr" / "stderr-do-rclone").read_text().strip())
    linha = (
        await session.execute(text("SELECT ultimo_em, ultimo_ok, ultimo_erro FROM backup_config"))
    ).one()
    assert linha.ultimo_em is not None and linha.ultimo_ok is False
    if sem == "tmpdir_que_nao_existe":
        assert destino.parent == Path("/tmp").resolve(), destino
        assert not destino.exists()  # e não fica para trás
        assert MOTIVO_DO_DRIVE in linha.ultimo_erro
    else:
        assert destino != Path("/dev/null")
        assert MOTIVO_DO_DRIVE in r.stderr  # no journal, ao menos
        assert linha.ultimo_erro == "Não subiu para o Drive: erro do rclone"


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


# ------------------------------------------------------------------ cópias de fora cifradas


def _modo(caminho: Path) -> int:
    return stat.S_IMODE(caminho.stat().st_mode)


@precisa_da_maquina
async def test_copia_da_nuvem_sai_cifrada_e_a_chave_so_existe_na_maquina(
    session: AsyncSession, tmp_path: Path
) -> None:
    """O dump subia em claro para o Drive: quem entrasse no Google do dono levava o banco
    inteiro — CPF e telefone das clientes, hashes de senha, o diário com IPs e o próprio
    rclone_token, que vai dentro do dump. E ficava 644 no disco, legível por qualquer
    usuário da máquina."""
    await _ligar_backup(session)
    env = _maquina(tmp_path)
    drive = tmp_path / "drive" / "loja"

    # 1ª cópia, pelo timer, numa loja que já existia: a chave nasce, mas NINGUÉM a viu.
    # Cifrar com ela trocaria "backup legível" por "backup que não abre" quando o disco
    # morrer — então a cópia sai como antes, e o recado manda ir ver e confirmar a chave.
    r = _backup_sh(tmp_path, env, "--nuvem")

    assert r.returncode == 0, r.stdout + r.stderr
    [copia] = list(drive.iterdir())
    assert copia.name.endswith(".dump") and not copia.read_bytes().startswith(b"RCLONE")
    loja = tmp_path / "loja"
    chave = loja / "backups" / ".chave-do-backup"
    valor = chave.read_text().strip()
    assert re.fullmatch(r"[a-z2-9]{4}(-[a-z2-9]{4}){5}", valor), valor
    assert _modo(chave) == 0o600
    assert _modo(loja / "backups") == 0o700
    dumps = list((loja / "backups").glob("loja-nuvem-*.dump"))
    assert dumps and all(_modo(d) == 0o600 for d in dumps)
    # Pelo timer ninguém está olhando: a chave não vai para o journal, só o recado...
    assert valor not in r.stdout + r.stderr
    assert "SEM criptografia" in r.stdout + r.stderr
    assert "--mostrar-chave" in r.stdout + r.stderr
    # ...nem para o banco, que vai dentro do dump que ela protege.
    linha = (await session.execute(text("SELECT row_to_json(b)::text FROM backup_config b"))).scalar()
    assert valor not in linha
    # Quem pede, vê — com a ordem de guardar fora. Sem terminal, só ver não liga a cifra.
    mostrada = _backup_sh(tmp_path, env, "--mostrar-chave")
    assert mostrada.returncode == 0
    assert valor in mostrada.stdout and "FORA deste servidor" in mostrada.stdout
    assert not (loja / "backups" / ".chave-confirmada").exists()

    # Confirmada, a próxima cópia sai cifrada.
    assert _backup_sh(tmp_path, env, "--confirmar-chave").returncode == 0
    shutil.copy(copia, tmp_path / "a-de-antes.dump")  # só para não confundir com a nova
    copia.unlink()
    r = _backup_sh(tmp_path, env, "--nuvem")
    assert r.returncode == 0, r.stdout + r.stderr
    [cifrada] = list(drive.iterdir())
    assert cifrada.name.endswith(".dump.bin"), cifrada.name
    assert cifrada.read_bytes().startswith(b"RCLONE\0\0")  # o cabeçalho do crypt do rclone
    assert "SEM criptografia" not in r.stdout + r.stderr


@precisa_da_maquina
async def test_backup_remoto_do_env_tambem_sai_cifrado(tmp_path: Path) -> None:
    """O BACKUP_REMOTO do .env recebia o mesmo dump em claro. Agora vai por um crypt
    montado por cima dele, sem mexer na configuração do rclone de quem cuida do servidor."""
    env = _maquina(tmp_path)
    (_pasta_da_loja(tmp_path) / ".env").write_text("BACKUP_REMOTO=remoto:loja-backups\n")
    assert _backup_sh(tmp_path, env, "--confirmar-chave").returncode == 0

    r = _backup_sh(tmp_path, env, "--sim")

    assert r.returncode == 0, r.stdout + r.stderr
    [enviada] = list((tmp_path / "drive" / "remoto" / "loja-backups").iterdir())
    assert enviada.name.endswith(".dump.bin"), enviada.name
    assert enviada.read_bytes().startswith(b"RCLONE\0\0")
    assert all(_modo(d) == 0o600 for d in (tmp_path / "loja" / "backups").glob("loja-*.dump"))


@precisa_da_maquina
async def test_sem_chave_confirmada_o_backup_remoto_sai_como_antes_e_avisa(
    tmp_path: Path,
) -> None:
    """Loja já instalada recebe a versão nova pelo atualizar.sh: a chave nasce pelo timer e
    ninguém a vê. Se a cópia de fora saísse cifrada, o disco morreria levando a única chave
    — e a cópia de fora, a que existe para esse dia, não abriria. Até alguém confirmar a
    chave, ela sai como antes; e o recado diz o que fazer."""
    env = _maquina(tmp_path)
    (_pasta_da_loja(tmp_path) / ".env").write_text("BACKUP_REMOTO=remoto:loja-backups\n")

    r = _backup_sh(tmp_path, env, "--sim")

    assert r.returncode == 0, r.stdout + r.stderr
    [enviada] = list((tmp_path / "drive" / "remoto" / "loja-backups").iterdir())
    assert enviada.name.endswith(".dump"), enviada.name
    assert not enviada.read_bytes().startswith(b"RCLONE")
    assert "SEM criptografia" in r.stdout + r.stderr
    assert "--mostrar-chave" in r.stdout + r.stderr


@precisa_da_maquina
async def test_copia_cifrada_do_drive_restaura_noutra_maquina(
    tmp_path: Path, banco_descartavel: str
) -> None:
    """Cifrar só vale se a cópia voltar. O servidor morreu: o dono baixa o `.dump.bin` do
    Drive numa máquina nova, que não tem a chave, e usa a que guardou. Sem ela (ou com outra)
    o banco não é tocado; com ela, volta — e a máquina nova passa a usar a mesma chave."""
    banco = banco_descartavel
    env = _maquina(tmp_path, banco)
    _alembic(banco, "upgrade", "head")
    _psql(env, banco, "INSERT INTO categories (name) VALUES ('da cópia')")
    _psql(env, banco, "INSERT INTO backup_config (id, ativo, rclone_token, pasta, manter, "
                      f"intervalo_min) VALUES (1, true, '{TOKEN}', 'loja', 10, 30)")
    assert _backup_sh(tmp_path, env, "--confirmar-chave").returncode == 0
    assert _backup_sh(tmp_path, env, "--nuvem").returncode == 0
    [no_drive] = list((tmp_path / "drive" / "loja").iterdir())
    baixada = tmp_path / no_drive.name
    shutil.copy(no_drive, baixada)
    arquivo_da_chave = tmp_path / "loja" / "backups" / ".chave-do-backup"
    chave = arquivo_da_chave.read_text().strip()
    arquivo_da_chave.unlink()  # a máquina nova
    _psql(env, banco, "INSERT INTO categories (name) VALUES ('depois da cópia')")
    categorias = "SELECT string_agg(name, ',' ORDER BY id) FROM categories"

    sem_chave = _backup_sh(tmp_path, env, "--restaurar", str(baixada), "--sim")
    assert sem_chave.returncode == 1
    assert "nenhuma chave conhecida a abre" in sem_chave.stderr, sem_chave.stdout + sem_chave.stderr
    errada = _backup_sh(tmp_path, env | {"CHAVE_DO_BACKUP": "aaaa-bbbb-cccc-dddd-eeee-ffff"},
                        "--restaurar", str(baixada), "--sim")
    assert errada.returncode == 1
    assert _psql(env, banco, categorias) == "da cópia,depois da cópia"
    assert "compose stop api" not in (tmp_path / "ctr" / "docker.log").read_text()

    # Do papel: maiúsculas e sem hífen também valem.
    digitada = chave.replace("-", "").upper()
    r = _backup_sh(tmp_path, env | {"CHAVE_DO_BACKUP": digitada},
                   "--restaurar", str(baixada), "--sim")

    assert r.returncode == 0, r.stdout + r.stderr
    assert "a loja voltou" in r.stdout
    assert _psql(env, banco, categorias) == "da cópia"
    assert arquivo_da_chave.read_text().strip() == chave


# ------------------------------------------------------------------ agendar e avisar


@precisa_da_maquina
async def test_copia_diaria_que_falha_avisa_o_dono(tmp_path: Path) -> None:
    """As unidades da cópia só falhavam no journal, que ninguém olha. Agora levam
    `OnFailure=`, que chama o notificar.sh com o nome de quem falhou."""
    env = _maquina(tmp_path)

    diaria = _backup_sh(tmp_path, env, "--automatico")
    nuvem = _backup_sh(tmp_path, env, "--nuvem-automatico")

    assert diaria.returncode == 0, diaria.stdout + diaria.stderr
    assert nuvem.returncode == 0, nuvem.stdout + nuvem.stderr
    unidades = tmp_path / "systemd"
    for nome in ("loja-backup", "loja-backup-nuvem"):
        assert "OnFailure=loja-aviso@%N.service" in (unidades / f"{nome}.service").read_text()
    aviso = (unidades / "loja-aviso@.service").read_text()
    assert f"ExecStart={tmp_path / 'loja'}/notificar.sh --unidade %i" in aviso
    ligados = (tmp_path / "ctr" / "systemctl.log").read_text()
    assert "enable --now loja-backup.timer" in ligados
    assert "enable --now loja-backup-nuvem.timer" in ligados


@precisa_da_maquina
async def test_no_mac_a_copia_diaria_e_do_launchd(tmp_path: Path) -> None:
    """O --automatico exigia systemd, e no Mac a loja ficava sem cópia nenhuma para sempre.
    Lá quem agenda é o launchd do usuário (onde roda o Docker Desktop)."""
    env = _maquina(tmp_path)
    bin_ = tmp_path / "bin"
    (bin_ / "uname").write_text('#!/bin/sh\necho Darwin\n')
    (bin_ / "launchctl").write_text('#!/bin/sh\necho "launchctl $*" >> "$FAKE_CTR/launchctl.log"\n')
    for nome in ("uname", "launchctl"):
        (bin_ / nome).chmod(0o755)

    r = _backup_sh(tmp_path, env, "--automatico", "21:05")

    assert r.returncode == 0, r.stdout + r.stderr
    plist = tmp_path / "home" / "Library" / "LaunchAgents" / "br.loja.backup.plist"
    conteudo = plist.read_text()
    assert f"<string>{tmp_path / 'loja'}/backup.sh</string><string>--sim</string>" in conteudo
    assert "<key>Hour</key><integer>21</integer>" in conteudo
    assert "<key>Minute</key><integer>5</integer>" in conteudo
    assert f"load -w {plist}" in (tmp_path / "ctr" / "launchctl.log").read_text()
    assert not (tmp_path / "systemd" / "loja-backup.service").exists()
