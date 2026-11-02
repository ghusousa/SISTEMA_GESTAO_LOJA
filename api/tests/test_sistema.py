"""A versão instalada, e a pergunta que interessa: está atrasada?

Mostrar `5c31d04` numa tela não ajuda ninguém — o hash não é maior nem menor que o
anterior. O que resolve a dúvida de quem cuida da loja é a frase pronta, e é ela que estes
testes prendem.
"""

import base64
import json
import re
import shutil
import subprocess
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from tests.test_backup import RAIZ, TOKEN, _banco_descartavel, _maquina, _psql




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


# O "GitHub": o origin do servidor é o endereço de verdade, com o token como o --automatico
# manda gravar, e o `insteadOf` do git o leva ao repositório local. O atualizar.sh lê o
# endereço CRU (dono/repositório e token) e pergunta o CI a um curl de mentira, que anota a
# chamada (com o que veio pelo `-K -`) e responde o que estiver em ctr/ci.json — sem o
# arquivo, falha como um GitHub fora do ar ou um token sem permissão. Qualquer outro endereço
# é o ntfy: responde 200, ou falha se existir ctr/ntfy-fora.
REPO_GITHUB = "https://x-access-token:tok-de-teste@github.com/dono/loja.git"

CURL_DE_MENTIRA = r"""#!/usr/bin/env bash
conf=""; args=("$@")
for ((i = 0; i < ${#args[@]}; i++)); do
    case "${args[$i]}" in -K|--config) [ "${args[$((i + 1))]}" = - ] && conf="$(cat)" ;; esac
done
{ printf 'curl'; printf ' [%s]' "$@"; printf '\n'; [ -n "$conf" ] && printf '%s\n' "$conf"; } \
    >> "$FAKE_CTR/curl.log"
case "${args[-1]}" in
    https://api.github.com/*)
        [ -f "$FAKE_CTR/ci.json" ] || { echo "curl: (22) The requested URL returned error: 403" >&2; exit 22; }
        cat "$FAKE_CTR/ci.json" ;;
    *)
        [ -f "$FAKE_CTR/ntfy-fora" ] && { echo "curl: (7) Failed to connect" >&2; exit 7; }
        exit 0 ;;
esac
"""


def _verificacao(status: str, conclusao: str | None) -> dict[str, object]:
    # O texto livre do `output` pode citar "status" e "conclusion"; no JSON eles vêm com as
    # aspas escapadas, e não podem contar como uma verificação a mais.
    return {
        "name": "API (pytest + migrations)", "status": status, "conclusion": conclusao,
        "app": {"name": "GitHub Actions"},
        "output": {"text": 'o passo anterior: "status": "queued", "conclusion": "failure"'},
    }


CI = {
    "verde": [_verificacao("completed", "success"), _verificacao("completed", "skipped")],
    "vermelho": [_verificacao("completed", "success"), _verificacao("completed", "failure")],
    "rodando": [_verificacao("completed", "success"), _verificacao("in_progress", None)],
    "sem verificação": [],
}


def _ci(tmp_path: Path, situacao: str | None) -> None:
    """O CI do commit novo no GitHub de mentira; None = o GitHub não responde."""
    arquivo = tmp_path / "ctr" / "ci.json"
    if situacao is None:
        arquivo.unlink(missing_ok=True)
        return
    # Numa linha só, como a API às vezes manda: contar por linha (`grep -c`) daria 1.
    corpo = CI[situacao]
    arquivo.write_text(json.dumps({"total_count": len(corpo), "check_runs": corpo}))


def _servidor(
    tmp_path: Path, env: dict[str, str], antes: dict[str, str], depois: dict[str, str]
) -> Path:
    """Um clone do sistema "instalado" e, no GitHub de mentira, uma versão nova esperando."""
    origem, servidor, dev = tmp_path / "origin.git", tmp_path / "servidor", tmp_path / "dev"
    _git(tmp_path, env, "init", "-q", "--bare", str(origem))
    _git(tmp_path, env, "clone", "-q", str(origem), str(servidor))
    for nome in ("atualizar.sh", "backup.sh", "notificar.sh", "docker-compose.yml", ".gitignore"):
        shutil.copy(RAIZ / nome, servidor / nome)
    for nome, conteudo in antes.items():
        (servidor / nome).write_text(conteudo)
    _git(servidor, env, "add", "-A")
    _git(servidor, env, "commit", "-qm", "v1")
    _git(servidor, env, "push", "-q", "origin", "HEAD")
    _git(servidor, env, "config", f"url.{origem}.insteadOf", REPO_GITHUB)
    _git(servidor, env, "remote", "set-url", "origin", REPO_GITHUB)
    curl = tmp_path / "bin" / "curl"
    curl.write_text(CURL_DE_MENTIRA)
    curl.chmod(0o755)
    _ci(tmp_path, "verde")
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


# Morre como o systemd mata um build lento (TimeoutStartSec): SIGKILL no script, no meio do
# `up`, com o `git reset` já feito. O resto vai para o docker de mentira do test_backup.
DOCKER_QUE_MORRE_NO_UP = r"""#!/usr/bin/env bash
if [ "$1 $2" = "compose up" ] && [ -f "$FAKE_CTR/morrer-no-up" ]; then
    rm -f "$FAKE_CTR/morrer-no-up"
    kill -9 "$PPID"
    exit 137
fi
exec "$(dirname "$0")/docker-de-mentira" "$@"
"""


@precisa_do_git
async def test_atualizacao_morta_depois_do_reset_e_refeita_na_proxima(tmp_path: Path) -> None:
    """O "nada a fazer" olhava o HEAD: morto entre o `git reset` e o /health, o script deixava
    o código novo no disco e a imagem velha no ar, e toda execução seguinte via HEAD =
    GitHub e saía sem fazer nada — para sempre. Quem decide é o commit que SUBIU."""
    env = _maquina(tmp_path, FAKE_API="echo ok") | GIT_ISOLADO
    docker = tmp_path / "bin" / "docker"
    docker.rename(tmp_path / "bin" / "docker-de-mentira")
    docker.write_text(DOCKER_QUE_MORRE_NO_UP)
    docker.chmod(0o755)
    servidor = _servidor(tmp_path, env, antes={}, depois={"novidade.txt": "v2"})
    log = tmp_path / "ctr" / "docker.log"
    versao = servidor / "docker/estado/versao.json"

    (tmp_path / "ctr" / "morrer-no-up").touch()
    morta = _atualizar(servidor, env, "--sem-backup")
    assert morta.returncode == -9, morta.stdout + morta.stderr
    assert (servidor / "novidade.txt").exists()  # o código novo já estava no disco
    # E a tela não diz "está na mais nova" com a velha no ar.
    assert json.loads(versao.read_text())["atualizada"] is False

    log.unlink(missing_ok=True)
    r = _atualizar(servidor, env, "--sem-backup")
    assert r.returncode == 0, r.stdout + r.stderr
    assert "Nada a fazer" not in r.stdout, r.stdout
    assert "não chegou ao fim" in r.stdout, r.stdout
    assert "docker compose up -d --build" in log.read_text()
    assert "Atualizado." in r.stdout
    assert json.loads(versao.read_text())["atualizada"] is True

    # Subiu de verdade: agora sim, nada a fazer — e sem reconstruir a cada conferida.
    log.unlink()
    r = _atualizar(servidor, env, "--sem-backup")
    assert r.returncode == 0, r.stdout + r.stderr
    assert "Nada a fazer" in r.stdout, r.stdout
    assert "compose up" not in log.read_text()


# Um pg_dump que "dá certo" e entrega lixo: disco cheio no meio, contêiner morrendo.
PG_DUMP_ILEGIVEL = r"""#!/usr/bin/env bash
while [ $# -gt 0 ]; do
    [ "$1" = -f ] && { echo "isto não é um dump" > "$2"; exit 0; }
    shift
done
"""


@precisa_do_git
@pytest.mark.parametrize("defeito", ["o banco não responde", "o dump sai ilegível"])
async def test_sem_copia_que_abra_a_atualizacao_sozinha_nao_segue(
    tmp_path: Path, defeito: str
) -> None:
    """Com --sim (o timer), um backup que falhava virava um aviso e a atualização seguia,
    aplicando migrations de madrugada sem cópia nenhuma de antes. E o dump não passava pelo
    `pg_restore -l`, então "backup feito" podia ser um arquivo que não abre."""
    env = _maquina(tmp_path, FAKE_API="echo ok") | GIT_ISOLADO
    if defeito == "o banco não responde":
        env["FAKE_DB"] = "banco_que_nao_existe"
    else:
        falso = tmp_path / "bin" / "pg_dump"
        falso.write_text(PG_DUMP_ILEGIVEL)
        falso.chmod(0o755)
    servidor = _servidor(tmp_path, env, antes={}, depois={"novidade.txt": "v2"})

    r = _atualizar(servidor, env)

    assert r.returncode == 1, r.stdout + r.stderr
    assert "não segue" in r.stderr, r.stdout + r.stderr
    assert "--sem-backup" in r.stdout
    assert not (servidor / "novidade.txt").exists()  # nem o código mudou
    assert "compose up" not in (tmp_path / "ctr" / "docker.log").read_text()
    # Dump que não abre não fica parecendo backup.
    assert not list(servidor.glob("loja-backup-antes-de-atualizar-*.dump"))
    # A loja ficou para trás, e a tela precisa dizer.
    assert json.loads((servidor / "docker/estado/versao.json").read_text())["atualizada"] is False


def _publicar(tmp_path: Path, env: dict[str, str], arquivos: dict[str, str],
              apagar: tuple[str, ...] = ()) -> None:
    """Mais um commit no GitHub de mentira (o de quem desenvolve)."""
    dev = tmp_path / "dev"
    for nome, conteudo in arquivos.items():
        (dev / nome).write_text(conteudo)
    for nome in apagar:
        (dev / nome).unlink()
    _git(dev, env, "add", "-A")
    _git(dev, env, "commit", "-qm", "mais um")
    _git(dev, env, "push", "-q", "origin", "HEAD")


def _cabeca_do_github(tmp_path: Path) -> str:
    return subprocess.run(["git", "-C", str(tmp_path / "dev"), "rev-parse", "HEAD"],
                          capture_output=True, text=True, check=True).stdout.strip()


@precisa_do_git
@pytest.mark.parametrize("situacao", ["vermelho", "rodando", "sem verificação"])
async def test_atualizacao_sozinha_so_sobe_commit_de_ci_verde(tmp_path: Path, situacao: str) -> None:
    """O timer implantava o que estivesse no main sem olhar o CI: um commit quebrado
    derrubava a loja por 3 a 4 minutos a cada 10, o dia inteiro. Sem CI verde, o --sim não
    mexe em nada, e a tela passa a dizer que há uma versão nova esperando."""
    env = _maquina(tmp_path, FAKE_API="echo ok") | GIT_ISOLADO
    servidor = _servidor(tmp_path, env, antes={}, depois={"novidade.txt": "v2"})
    _ci(tmp_path, situacao)

    r = _atualizar(servidor, env, "--sem-backup")

    assert r.returncode == 0, r.stdout + r.stderr
    assert not (servidor / "novidade.txt").exists()
    assert "compose up" not in (tmp_path / "ctr" / "docker.log").read_text()
    assert json.loads((servidor / "docker/estado/versao.json").read_text())["atualizada"] is False
    # Perguntou pelo commit certo, com a credencial que o git já usa — e o token foi pelo
    # `-K -`, nunca na linha de comando, onde qualquer usuário o leria num `ps`.
    chamadas = (tmp_path / "ctr" / "curl.log").read_text()
    sha = _cabeca_do_github(tmp_path)
    assert f"[https://api.github.com/repos/dono/loja/commits/{sha}/check-runs?per_page=100]" in chamadas
    assert 'header = "Authorization: Bearer tok-de-teste"' in chamadas
    assert not [linha for linha in chamadas.splitlines()
                if linha.startswith("curl ") and "tok-de-teste" in linha]

    # Pedido explícito, sobe.
    r = _atualizar(servidor, env, "--sem-backup", "--ignorar-ci")
    assert r.returncode == 0, r.stdout + r.stderr
    assert "Atualizado." in r.stdout
    assert (servidor / "novidade.txt").exists()


@precisa_do_git
async def test_sem_permissao_de_ler_o_ci_o_timer_sobe_como_antes_e_avisa(tmp_path: Path) -> None:
    """Token que lê o código mas não o CI (fine-grained sem "Checks" — o que o README
    pedia): parar aqui deixava toda loja já instalada sem atualizar nunca mais, calada. Sem
    resposta do CI, o --sim sobe como subia antes desta conferência existir (a volta atrás
    automática continua de guarda) e avisa o que dar ao token."""
    env = _maquina(tmp_path, FAKE_API="echo ok") | GIT_ISOLADO
    servidor = _servidor(tmp_path, env, antes={}, depois={"novidade.txt": "v2"})
    _ci(tmp_path, None)

    r = _atualizar(servidor, env, "--sem-backup")

    assert r.returncode == 0, r.stdout + r.stderr
    assert "Checks: leitura" in r.stdout
    assert "sem conferir o CI" in r.stdout + r.stderr
    assert (servidor / "novidade.txt").exists()
    assert "compose up" in (tmp_path / "ctr" / "docker.log").read_text()


@precisa_do_git
async def test_versao_que_caiu_nao_e_tentada_de_novo_ate_chegar_outra(tmp_path: Path) -> None:
    """A volta atrás desfazia o commit quebrado, e a conferida seguinte via de novo "o
    GitHub tem outra versão" e derrubava a loja outra vez — o dia inteiro, até alguém mandar
    a correção. O commit que caiu fica anotado; só um commit NOVO faz o timer tentar."""
    env = _maquina(tmp_path, FAKE_API="[ ! -f quebrada ]") | GIT_ISOLADO
    servidor = _servidor(tmp_path, env, antes={}, depois={"quebrada": ""})
    log = tmp_path / "ctr" / "docker.log"
    versao = servidor / "docker/estado/versao.json"

    caiu = _atualizar(servidor, env, "--sem-backup")
    assert caiu.returncode == 1, caiu.stdout + caiu.stderr
    assert "não será tentada de novo" in caiu.stdout, caiu.stdout
    assert not (servidor / "quebrada").exists()  # voltou para a de antes

    log.unlink()
    de_novo = _atualizar(servidor, env, "--sem-backup")
    assert de_novo.returncode == 0, de_novo.stdout + de_novo.stderr
    assert "já subiu neste servidor" in de_novo.stdout, de_novo.stdout
    assert "compose up" not in log.read_text()
    assert json.loads(versao.read_text())["atualizada"] is False

    _publicar(tmp_path, env, {"correcao.txt": "v3"}, apagar=("quebrada",))
    corrigida = _atualizar(servidor, env, "--sem-backup")
    assert corrigida.returncode == 0, corrigida.stdout + corrigida.stderr
    assert "Atualizado." in corrigida.stdout
    assert (servidor / "correcao.txt").exists()
    assert not (servidor / "docker/estado/falhou").exists()
    assert json.loads(versao.read_text())["atualizada"] is True


@precisa_do_git
async def test_atualizacao_sozinha_que_falha_avisa_o_dono(tmp_path: Path) -> None:
    """A unidade loja-atualizar só falhava no journal. Agora leva OnFailure=, e ligar
    confere se o token lê o CI — senão a loja pararia de atualizar sem ninguém saber."""
    env = _maquina(tmp_path) | GIT_ISOLADO
    servidor = _servidor(tmp_path, env, antes={}, depois={"novidade.txt": "v2"})

    r = subprocess.run(["bash", "./atualizar.sh", "--automatico"], cwd=servidor, env=env,
                       capture_output=True, text=True, timeout=120)

    assert r.returncode == 0, r.stdout + r.stderr
    assert "o CI do GitHub responde" in r.stdout
    unidades = tmp_path / "systemd"
    assert "OnFailure=loja-aviso@%N.service" in (unidades / "loja-atualizar.service").read_text()
    assert f"ExecStart={servidor}/notificar.sh --unidade %i" in (
        unidades / "loja-aviso@.service").read_text()
    assert "enable --now loja-atualizar.timer" in (tmp_path / "ctr" / "systemctl.log").read_text()


# ------------------------------------------------------------------ avisos e vigia
#
# Nenhum alerta saía da máquina: loja caída, disco enchendo, backup parado e atualização
# falhando só apareciam no journal — e quem descobria era a vendedora, com fila no caixa.

precisa_do_bash = pytest.mark.skipif(not shutil.which("bash"), reason="roda os scripts")


def _loja_com_avisos(tmp_path: Path, env_extra: str = "") -> tuple[Path, dict[str, str]]:
    env = _maquina(tmp_path)
    curl = tmp_path / "bin" / "curl"
    curl.write_text(CURL_DE_MENTIRA)
    curl.chmod(0o755)
    loja = tmp_path / "loja"
    loja.mkdir()
    for nome in ("notificar.sh", "vigia.sh", "docker-compose.yml"):
        shutil.copy(RAIZ / nome, loja / nome)
    (loja / ".env").write_text(env_extra)
    return loja, env


def _avisar(loja: Path, env: dict[str, str], *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["bash", "./notificar.sh", *args], cwd=loja, env=env,
                          capture_output=True, text=True, timeout=60)


def _avisos(tmp_path: Path) -> list[str]:
    """Os títulos que chegaram ao ntfy, em ordem (o cabeçalho vem em RFC 2047)."""
    log = tmp_path / "ctr" / "curl.log"
    if not log.exists():
        return []
    return [base64.b64decode(m[1]).decode()
            for m in re.finditer(r"\[Title: =\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=\]", log.read_text())]


@precisa_do_bash
async def test_aviso_chega_no_celular_uma_vez_por_hora(tmp_path: Path) -> None:
    """O OnFailure= chama o notificar.sh com o nome da unidade. O aviso vai ao tópico do
    ntfy do .env (só o nome também vale), e o mesmo assunto não se repete antes de uma hora:
    a atualização que falha a cada 10 minutos manda um aviso, não seis."""
    loja, env = _loja_com_avisos(tmp_path, "NOTIFICAR_URL=loja-k3x9q\n")

    r = _avisar(loja, env, "--unidade", "loja-backup")

    assert r.returncode == 0, r.stdout + r.stderr
    assert _avisos(tmp_path) == ["A cópia diária do banco falhou"]
    chamada = (tmp_path / "ctr" / "curl.log").read_text()
    assert "[https://ntfy.sh/loja-k3x9q]" in chamada
    assert "[Priority: high]" in chamada
    assert "journalctl -u loja-backup" in chamada

    de_novo = _avisar(loja, env, "--unidade", "loja-backup")
    assert de_novo.returncode == 0 and "segurado" in de_novo.stdout
    assert len(_avisos(tmp_path)) == 1
    _avisar(loja, env, "Disco quase cheio", "92% usado")  # outro assunto passa
    assert _avisos(tmp_path) == ["A cópia diária do banco falhou", "Disco quase cheio"]


@precisa_do_bash
async def test_sem_tópico_o_aviso_fica_no_journal_e_ntfy_fora_tenta_de_novo(tmp_path: Path) -> None:
    """Sem NOTIFICAR_URL, o aviso fica no registro da máquina e nada sai dela. Com o ntfy
    fora do ar, o envio falha SEM carimbar: o próximo tenta, em vez de achar que o dono já
    sabe."""
    loja, env = _loja_com_avisos(tmp_path)
    sem = _avisar(loja, env, "A loja está fora do ar", "teste")
    assert sem.returncode == 0
    assert "sem NOTIFICAR_URL" in sem.stdout
    assert _avisos(tmp_path) == []

    (loja / ".env").write_text("NOTIFICAR_URL=https://ntfy.exemplo/loja\n")
    (tmp_path / "ctr" / "ntfy-fora").touch()
    fora = _avisar(loja, env, "--assunto", "x", "Disco quase cheio", "92%")
    assert fora.returncode == 1
    (tmp_path / "ctr" / "ntfy-fora").unlink()
    voltou = _avisar(loja, env, "--assunto", "x", "Disco quase cheio", "92%")
    assert voltou.returncode == 0 and "segurado" not in voltou.stdout


DF_DE_MENTIRA = """#!/bin/sh
echo "Filesystem 1024-blocks Used Available Capacity Mounted on"
echo "/dev/disco 100 ${FAKE_DISCO:-40} 0 ${FAKE_DISCO:-40}% /"
"""


@precisa_do_git
async def test_vigia_avisa_queda_disco_e_backup_atrasado_e_avisa_quando_volta(
    session: AsyncSession, tmp_path: Path
) -> None:
    """De 5 em 5 minutos: o /health, o disco e a idade do backup da nuvem (2× o intervalo,
    lido do banco). A queda da API só avisa na segunda conferida seguida — uma atualização
    normal fica fora um ou dois minutos e não vira alarme —, e o que voltou também avisa."""
    await session.execute(text(
        "INSERT INTO backup_config (id, ativo, rclone_token, pasta, manter, intervalo_min, "
        "ultimo_em, ultimo_ok) VALUES (1, true, :t, 'loja', 10, 30, now() - interval '3 hours', true)"
    ), {"t": TOKEN})
    await session.commit()
    loja, env = _loja_com_avisos(tmp_path, "NOTIFICAR_URL=https://ntfy.exemplo/loja\n")
    df = tmp_path / "bin" / "df"
    df.write_text(DF_DE_MENTIRA)
    df.chmod(0o755)
    fora = env | {"FAKE_API": "exit 1", "FAKE_DISCO": "95"}

    def vigiar(ambiente: dict[str, str]) -> subprocess.CompletedProcess:
        return subprocess.run(["bash", "./vigia.sh"], cwd=loja, env=ambiente,
                              capture_output=True, text=True, timeout=120)

    primeira = vigiar(fora)
    assert primeira.returncode == 1, primeira.stdout + primeira.stderr
    assert _avisos(tmp_path) == ["Disco quase cheio", "Backup da nuvem atrasado"]

    segunda = vigiar(fora)
    assert segunda.returncode == 1
    # A queda, agora sim; disco e backup não se repetem (lembrete só a cada 6 h).
    assert _avisos(tmp_path)[2:] == ["A loja está fora do ar"]

    await session.execute(text("UPDATE backup_config SET ultimo_em = now()"))
    await session.commit()
    voltou = vigiar(env | {"FAKE_API": "exit 0", "FAKE_DISCO": "40"})
    assert voltou.returncode == 0, voltou.stdout + voltou.stderr
    assert _avisos(tmp_path)[3:] == [
        "A loja voltou", "O disco tem folga de novo", "O backup da nuvem voltou",
    ]


# ------------------------------------------------------------------ o ./instalar.sh

# O Docker do instalador: tudo sobe, e a API responde "healthy" na primeira conferida.
DOCKER_DO_INSTALADOR = r"""#!/usr/bin/env bash
echo "docker $*" >> "$FAKE_CTR/docker.log"
case "$1 $2" in
    "volume inspect") exit 1 ;;
    "compose ps") echo "id-da-api" ;;
    "inspect -f") echo healthy ;;
esac
exit 0
"""


def _instalador(tmp_path: Path) -> tuple[Path, dict[str, str]]:
    env = _maquina(tmp_path)
    for nome, corpo in (("docker", DOCKER_DO_INSTALADOR), ("curl", CURL_DE_MENTIRA)):
        (tmp_path / "bin" / nome).write_text(corpo)
        (tmp_path / "bin" / nome).chmod(0o755)
    loja = tmp_path / "loja"
    loja.mkdir()
    for nome in ("instalar.sh", "backup.sh", "vigia.sh", "notificar.sh", "docker-compose.yml"):
        shutil.copy(RAIZ / nome, loja / nome)
    (tmp_path / "run-systemd").mkdir()
    # "Há systemd no comando" (o /run/systemd/system da máquina de verdade).
    return loja, env | {"DIR_SYSTEMD_RODANDO": str(tmp_path / "run-systemd")}


def _instalar(loja: Path, env: dict[str, str], dominio: str, *mais: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["bash", "./instalar.sh", "--sim", "--dominio", dominio, "--nome", "Dona Maria",
         "--email", "dona@loja.com", "--senha", "senha12345", *mais],
        cwd=loja, env=env, capture_output=True, text=True, timeout=300,
    )


@precisa_do_bash
async def test_instalar_liga_a_copia_diaria_e_o_vigia(tmp_path: Path) -> None:
    """A instalação oficial terminava sem cópia NENHUMA do banco: o --automatico só ligava
    por SSH. Agora a cópia diária e o vigia nascem ligados, e o tópico de avisos vai para
    o .env com um aviso de teste. O IP da rede da loja continua sendo instalação local."""
    loja, env = _instalador(tmp_path)

    r = _instalar(loja, env, "192.168.0.10", "--avisos", "loja-teste")

    assert r.returncode == 0, r.stdout + r.stderr
    dotenv = (loja / ".env").read_text()
    assert "AMBIENTE=local" in dotenv
    assert "NOTIFICAR_URL=https://ntfy.sh/loja-teste" in dotenv
    unidades = tmp_path / "systemd"
    assert "OnCalendar=*-*-* 03:15:00" in (unidades / "loja-backup.timer").read_text()
    assert "OnUnitActiveSec=5min" in (unidades / "loja-vigia.timer").read_text()
    ligados = (tmp_path / "ctr" / "systemctl.log").read_text()
    assert "enable --now loja-backup.timer" in ligados
    assert "enable --now loja-vigia.timer" in ligados
    assert "Avisos da loja ligados" in _avisos(tmp_path)
    assert (loja / "backups" / ".chave-do-backup").exists()


def _endereco(ip: str) -> str:
    """O que o instalar.sh decide para o endereço: 'local' (HTTP) ou 'internet'."""
    funcoes = (
        f'eval "$(sed -n "/^eh_ip()/p; /^ip_de_rede_local() {{/,/^}}/p; '
        f'/^endereco_local() {{/,/^}}/p" {RAIZ / "instalar.sh"})"'
    )
    feito = subprocess.run(
        ["bash", "-c", f'{funcoes}; endereco_local "$1" && echo local || echo internet', "_", ip],
        capture_output=True, text=True, timeout=30,
    )
    return feito.stdout.strip()


@precisa_do_bash
@pytest.mark.parametrize(("ip", "esperado"), [
    ("", "local"), ("localhost", "local"),
    ("127.0.0.1", "local"), ("10.0.0.5", "local"), ("10.255.255.255", "local"),
    ("172.16.0.1", "local"), ("172.31.255.254", "local"), ("192.168.0.10", "local"),
    ("172.15.0.1", "internet"), ("172.32.0.1", "internet"), ("192.169.0.1", "internet"),
    ("8.8.8.8", "internet"), ("169.58.209.199", "internet"), ("203.0.113.10", "internet"),
    # Tailscale/CGNAT e link-local não se alcançam da internet: religar a loja pelo Tailscale
    # não pode morrer com "é um IP PÚBLICO".
    ("100.101.102.103", "local"), ("100.64.0.1", "local"), ("100.127.255.254", "local"),
    ("169.254.10.20", "local"), ("100.63.0.1", "internet"), ("100.128.0.1", "internet"),
])
async def test_so_ip_da_rede_da_loja_e_instalacao_local(ip: str, esperado: str) -> None:
    """Qualquer IP virava AMBIENTE=local: numa VPS acessada pelo IP público, /docs aberto
    na internet, CORS para qualquer origem e senha trafegando em HTTP puro."""
    assert _endereco(ip) == esperado


@precisa_do_bash
async def test_instalar_por_ip_publico_recusa_sem_gravar_nada(tmp_path: Path) -> None:
    """IP público não cai em 'local': o instalador recusa antes de gravar o .env, e diz o
    caminho — um domínio, ou o <ip>.sslip.io, que dá HTTPS sem domínio."""
    loja, env = _instalador(tmp_path)

    r = _instalar(loja, env, "203.0.113.10")

    assert r.returncode == 1, r.stdout + r.stderr
    assert "IP PÚBLICO" in r.stderr
    assert "--dominio 203.0.113.10.sslip.io" in r.stderr
    assert not (loja / ".env").exists()
    assert "compose up" not in (tmp_path / "ctr" / "docker.log").read_text()


@precisa_do_git
async def test_repositorio_publico_sem_token_tambem_confere_o_ci(tmp_path: Path) -> None:
    """Sem credencial gravada (repositório público), a pergunta vai sem token — e a resposta
    do GitHub vale do mesmo jeito: não pode virar "o GitHub não respondeu"."""
    env = _maquina(tmp_path, FAKE_API="echo ok") | GIT_ISOLADO
    servidor = _servidor(tmp_path, env, antes={}, depois={"novidade.txt": "v2"})
    publico = "https://github.com/dono/loja.git"
    _git(servidor, env, "config", f"url.{tmp_path / 'origin.git'}.insteadOf", publico)
    _git(servidor, env, "remote", "set-url", "origin", publico)
    _ci(tmp_path, "vermelho")

    r = _atualizar(servidor, env, "--sem-backup")

    assert r.returncode == 0, r.stdout + r.stderr
    assert "CI VERMELHO" in r.stdout, r.stdout
    assert "Authorization" not in (tmp_path / "ctr" / "curl.log").read_text()
    assert not (servidor / "novidade.txt").exists()


@precisa_do_bash
async def test_desinstalar_desliga_o_vigia_e_as_rotinas(tmp_path: Path) -> None:
    """Com a loja desligada de propósito, o vigia mandaria "loja fora do ar" ao celular de
    quem acabou de desligá-la, a cópia falharia todo dia, e a atualização sozinha faria
    `up -d` e ligaria de novo a loja que se quis desligar."""
    env = _maquina(tmp_path)
    loja = tmp_path / "loja"
    loja.mkdir()
    for nome in ("desinstalar.sh", "docker-compose.yml"):
        shutil.copy(RAIZ / nome, loja / nome)
    unidades = tmp_path / "systemd"
    for unidade in ("loja-vigia", "loja-backup", "loja-backup-nuvem", "loja-atualizar"):
        for tipo in ("service", "timer"):
            (unidades / f"{unidade}.{tipo}").write_text("")
    (unidades / "loja-atualizar.timer").write_text("[Timer]\nOnBootSec=5min\nOnUnitActiveSec=15min\n")

    r = subprocess.run(["bash", "./desinstalar.sh", "--manter-dados", "--sim"], cwd=loja,
                       env=env, capture_output=True, text=True, timeout=60)

    assert r.returncode == 0, r.stdout + r.stderr
    assert not list(unidades.glob("loja-*"))
    # "Só desligar": o instalador religa as MESMAS rotinas, com o intervalo de antes. Sem a
    # anotação, a loja religada ficava com o Drive "ligado" na tela e timer nenhum.
    anotadas = (loja / "docker" / "estado" / "rotinas").read_text().split("\n")
    assert "loja-backup-nuvem" in anotadas
    assert "loja-atualizar 15" in anotadas
    desligados = (tmp_path / "ctr" / "systemctl.log").read_text()
    assert "disable --now loja-vigia.timer" in desligados
    assert "disable --now loja-atualizar.timer" in desligados
