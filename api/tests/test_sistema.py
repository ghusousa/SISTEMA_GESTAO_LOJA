"""A versão instalada, e a pergunta que interessa: está atrasada?

Mostrar `5c31d04` numa tela não ajuda ninguém — o hash não é maior nem menor que o
anterior. O que resolve a dúvida de quem cuida da loja é a frase pronta, e é ela que estes
testes prendem.
"""

import json
import shutil
import subprocess
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from tests.test_backup import RAIZ, _banco_descartavel, _maquina, _psql




def _escrever(tmp_path, monkeypatch, **campos) -> None:
    from app.core.config import settings

    (tmp_path / "versao.json").write_text(json.dumps(campos), encoding="utf-8")
    monkeypatch.setattr(settings, "estado_dir", str(tmp_path))


def _agora(delta: timedelta = timedelta()) -> str:
    return (datetime.now(UTC) + delta).isoformat()


async def test_conferido_agora_e_em_dia(client, auth_vendedor, tmp_path, monkeypatch) -> None:
    _escrever(
        tmp_path,
        monkeypatch,
        commit="5c31d04",
        data=_agora(-timedelta(hours=2)),
        conferido_em=_agora(-timedelta(minutes=4)),
        atualizada=True,
    )
    corpo = (await client.get("/versao", headers=auth_vendedor)).json()
    assert corpo["commit"] == "5c31d04"
    assert corpo["atualizada"] is True
    assert corpo["conferido_recente"] is True
    assert corpo["resumo"] == "Está na versão mais nova."


async def test_existe_versao_nova_esperando(client, auth_admin, tmp_path, monkeypatch) -> None:
    """O caso do rollback: a instalada voltou a ser a velha e a nova ficou no GitHub."""
    _escrever(
        tmp_path,
        monkeypatch,
        commit="414c046",
        conferido_em=_agora(-timedelta(minutes=10)),
        atualizada=False,
    )
    corpo = (await client.get("/versao", headers=auth_admin)).json()
    assert corpo["atualizada"] is False
    assert "mais nova esperando" in corpo["resumo"]


async def test_conferida_velha_nao_tranquiliza(client, auth_admin, tmp_path, monkeypatch) -> None:
    """"Atualizada" de três dias atrás não é resposta: o timer pode ter morrido ontem."""
    _escrever(
        tmp_path,
        monkeypatch,
        commit="414c046",
        conferido_em=_agora(-timedelta(days=3)),
        atualizada=True,
    )
    corpo = (await client.get("/versao", headers=auth_admin)).json()
    assert corpo["conferido_recente"] is False
    assert "Não confere" in corpo["resumo"]


async def test_sem_arquivo_nao_quebra(client, auth_admin, tmp_path, monkeypatch) -> None:
    """Rodar fora do Docker não tem arquivo nenhum, e isso é desenvolvimento, não erro."""
    from app.core.config import settings

    monkeypatch.setattr(settings, "estado_dir", str(tmp_path / "nao-existe"))
    resposta = await client.get("/versao", headers=auth_admin)
    assert resposta.status_code == 200
    assert resposta.json()["commit"] is None
    assert "sem conferir" in resposta.json()["resumo"].lower()


async def test_versao_exige_login(client) -> None:
    assert (await client.get("/versao")).status_code == 401


# ------------------------------------------------------------------ o ./atualizar.sh
#
# Quem escreve o versao.json é o ./atualizar.sh, e é ele que faz a loja voltar sozinha de
# uma atualização ruim. Estes rodam o script de verdade contra um "GitHub" que é um
# repositório local e o mesmo docker de mentira do test_backup (o "db" é um Postgres real).

precisa_do_git = pytest.mark.skipif(
    not all(shutil.which(p) for p in ("bash", "git", "psql", "pg_dump", "pg_restore")),
    reason="roda o atualizar.sh: precisa de bash, git e dos clientes do Postgres",
)

# Sem a configuração de quem roda os testes (assinatura de commit, hooks), e com autor fixo.
GIT_ISOLADO = {
    "GIT_CONFIG_GLOBAL": "/dev/null",
    "GIT_CONFIG_NOSYSTEM": "1",
    "GIT_AUTHOR_NAME": "teste",
    "GIT_AUTHOR_EMAIL": "teste@loja",
    "GIT_COMMITTER_NAME": "teste",
    "GIT_COMMITTER_EMAIL": "teste@loja",
}


def _git(pasta: Path, env: dict[str, str], *args: str) -> None:
    subprocess.run(["git", *args], cwd=pasta, env=env, check=True, capture_output=True)


def _servidor(
    tmp_path: Path, env: dict[str, str], antes: dict[str, str], depois: dict[str, str]
) -> Path:
    """Um clone do sistema "instalado" e, no GitHub de mentira, uma versão nova esperando."""
    origem, servidor, dev = tmp_path / "origin.git", tmp_path / "servidor", tmp_path / "dev"
    _git(tmp_path, env, "init", "-q", "--bare", str(origem))
    _git(tmp_path, env, "clone", "-q", str(origem), str(servidor))
    for nome in ("atualizar.sh", "backup.sh", "docker-compose.yml", ".gitignore"):
        shutil.copy(RAIZ / nome, servidor / nome)
    for nome, conteudo in antes.items():
        (servidor / nome).write_text(conteudo)
    _git(servidor, env, "add", "-A")
    _git(servidor, env, "commit", "-qm", "v1")
    _git(servidor, env, "push", "-q", "origin", "HEAD")
    _git(tmp_path, env, "clone", "-q", str(origem), str(dev))
    for nome, conteudo in depois.items():
        (dev / nome).write_text(conteudo)
    _git(dev, env, "add", "-A")
    _git(dev, env, "commit", "-qm", "v2")
    _git(dev, env, "push", "-q", "origin", "HEAD")
    (servidor / ".env").write_text("SENHA_BANCO=x\n")
    return servidor


def _atualizar(servidor: Path, env: dict[str, str], *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["bash", "./atualizar.sh", "--sim", *args],
        cwd=servidor, env=env, capture_output=True, text=True, timeout=300,
    )


@precisa_do_git
async def test_atualizar_tira_o_conteiner_orfao_e_sobe_a_versao_nova(tmp_path: Path) -> None:
    """`limpar_orfaos` chamava `alerta`, que não existe: o script morria DEPOIS do `git
    reset` e antes do `up`, e a execução seguinte dizia "nada a fazer" — com a loja em 502."""
    env = _maquina(tmp_path, FAKE_PS="3f2a9c1b7d4e_loja-api-1", FAKE_API="echo ok") | GIT_ISOLADO
    servidor = _servidor(tmp_path, env, antes={}, depois={"novidade.txt": "v2"})

    r = _atualizar(servidor, env, "--sem-backup")

    assert r.returncode == 0, r.stdout + r.stderr
    assert "Atualizado." in r.stdout
    log = (tmp_path / "ctr" / "docker.log").read_text()
    assert "docker rm -f 3f2a9c1b7d4e_loja-api-1" in log
    assert "docker compose up -d --build" in log
    # A migration é do entrada.sh, ao subir; aqui só se espera o /health. Um segundo
    # `alembic upgrade head` por fora corria junto com o do contêiner e, quando as duas
    # transações se cruzavam, transformava uma atualização boa em volta atrás.
    assert "exec -T api alembic" not in log
    assert json.loads((servidor / "docker/estado/versao.json").read_text())["atualizada"] is True


# O contêiner da API, do jeito do entrada.sh: migra até a última revisão que o código DESTA
# pasta conhece (revisoes.txt) e só então responde ao /health — a não ser que esta versão
# esteja quebrada. Banco numa revisão que o código não conhece: não sobe, como o alembic.
API_DE_MENTIRA = r"""#!/usr/bin/env bash
rev="$(psql -d "$FAKE_DB" -tAc 'SELECT version_num FROM alembic_version')"
conhecidas="$(cat revisoes.txt)"
case " $conhecidas " in
    *" $rev "*) ;;
    *) echo "Can't locate revision identified by '$rev'" >&2; exit 1 ;;
esac
cabeca="${conhecidas##* }"
if [ "$rev" != "$cabeca" ]; then
    psql -d "$FAKE_DB" -qc "CREATE TABLE tabela_de_$cabeca (x int)" \
        -c "UPDATE alembic_version SET version_num = '$cabeca'" || exit 1
fi
[ ! -f quebrada ]
"""


@pytest.fixture
def banco_vazio() -> Iterator[str]:
    with _banco_descartavel() as nome:
        yield nome


@precisa_do_git
async def test_volta_atras_depois_de_migration_volta_o_banco_junto(
    tmp_path: Path, banco_vazio: str
) -> None:
    """A versão nova migrou o banco e não subiu. Voltar só o código deixava a loja FORA: o
    alembic da anterior não acha a revisão nova. A volta usa a cópia de antes da
    atualização, e o --restaurar guarda o banco migrado antes de trocar."""
    banco = banco_vazio
    env = _maquina(tmp_path, banco) | GIT_ISOLADO
    api = tmp_path / "bin" / "api"
    api.write_text(API_DE_MENTIRA)
    api.chmod(0o755)
    env["FAKE_API"] = str(api)
    _psql(env, banco, "CREATE TABLE alembic_version (version_num varchar(32) PRIMARY KEY)")
    _psql(env, banco, "INSERT INTO alembic_version VALUES ('rev_a')")
    servidor = _servidor(
        tmp_path, env,
        antes={"revisoes.txt": "rev_a\n"},
        depois={"revisoes.txt": "rev_a rev_b\n", "quebrada": ""},
    )

    r = _atualizar(servidor, env)

    assert r.returncode == 1, r.stdout + r.stderr  # a atualização falhou, e o script diz
    assert "Código e banco voltaram para antes da atualização" in r.stdout, r.stdout
    assert (servidor / "revisoes.txt").read_text() == "rev_a\n"
    assert _psql(env, banco, "SELECT version_num FROM alembic_version") == "rev_a"
    assert subprocess.run([str(api)], cwd=servidor, env=env).returncode == 0  # a loja sobe
    assert list((servidor / "backups").glob("loja-antes-de-restaurar-*.dump"))
