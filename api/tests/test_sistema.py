"""A versão instalada, e a pergunta que interessa: está atrasada?

Mostrar `5c31d04` numa tela não ajuda ninguém — o hash não é maior nem menor que o
anterior. O que resolve a dúvida de quem cuida da loja é a frase pronta, e é ela que estes
testes prendem.
"""

import base64
import json
import os
import re
import shutil
import signal
import subprocess
import time
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from tests.test_backup import RAIZ, TOKEN, _banco_descartavel, _maquina, _modo, _psql




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


async def test_na_vercel_a_versao_e_o_proprio_deploy(
    client, auth_vendedor, tmp_path, monkeypatch
) -> None:
    """Na Vercel não há atualizador: o commit vem dela, e o que está no ar é o mais novo.

    Um versao.json esquecido por perto (dizendo "desatualizada") não pode mandar na resposta.
    """
    from app.core.config import settings

    _escrever(tmp_path, monkeypatch, commit="414c046", atualizada=False)
    monkeypatch.setattr(settings, "vercel", True)
    monkeypatch.setattr(
        settings, "vercel_git_commit_sha", "fa1eade47b73733d6312d5abfad33ce9e4068081"
    )
    corpo = (await client.get("/versao", headers=auth_vendedor)).json()
    assert corpo["commit"] == "fa1eade"
    assert corpo["atualizada"] is True
    assert corpo["conferido_recente"] is True
    assert corpo["conferido_em"] is not None
    assert "Vercel" in corpo["resumo"]


async def test_na_vercel_sem_commit_nao_inventa_um(client, auth_admin, monkeypatch) -> None:
    """Deploy feito pela CLI, sem Git: não há SHA, e a tela mostra "sem versão"."""
    from app.core.config import settings

    monkeypatch.setattr(settings, "vercel", True)
    monkeypatch.setattr(settings, "vercel_git_commit_sha", "")
    corpo = (await client.get("/versao", headers=auth_admin)).json()
    assert corpo["commit"] is None
    assert corpo["atualizada"] is True


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
# arquivo, falha como um GitHub fora do ar ou um token sem permissão. Os serviços que dizem o
# IP público desta máquina respondem ctr/ip-publico (ou ctr/ip6-publico, com -6). Um /health é
# a loja pelo proxy: responde, ou falha se existir ctr/proxy-fora. Qualquer outro endereço é o
# ntfy: responde 200, ou falha se existir ctr/ntfy-fora.
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
    https://api.ipify.org|https://api64.ipify.org|https://ifconfig.me/ip|https://icanhazip.com)
        case " $* " in *" -6 "*) ip="$FAKE_CTR/ip6-publico" ;; *) ip="$FAKE_CTR/ip-publico" ;; esac
        [ -f "$ip" ] || { echo "curl: (6) Could not resolve host" >&2; exit 6; }
        cat "$ip" ;;
    */health)
        codigo=200; [ -f "$FAKE_CTR/proxy-fora" ] && codigo=000
        case " $* " in *"%{http_code}"*) printf '%s' "$codigo" ;; esac
        [ "$codigo" = 200 ] || { echo "curl: (7) Failed to connect" >&2; exit 7; } ;;
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


def _gravar(pasta: Path, nome: str, conteudo: str) -> None:
    """Grava `nome` (pode ter pasta no meio, como docker/caddy/Caddyfile) dentro de `pasta`."""
    (pasta / nome).parent.mkdir(parents=True, exist_ok=True)
    (pasta / nome).write_text(conteudo)


def _servidor(
    tmp_path: Path, env: dict[str, str], antes: dict[str, str], depois: dict[str, str]
) -> Path:
    """Um clone do sistema "instalado" e, no GitHub de mentira, uma versão nova esperando."""
    origem, servidor, dev = tmp_path / "origin.git", tmp_path / "servidor", tmp_path / "dev"
    _git(tmp_path, env, "init", "-q", "--bare", str(origem))
    _git(tmp_path, env, "clone", "-q", str(origem), str(servidor))
    for nome in ("atualizar.sh", "backup.sh", "notificar.sh", "demo.sh", "docker-compose.yml",
                 ".gitignore"):
        shutil.copy(RAIZ / nome, servidor / nome)
    for nome, conteudo in antes.items():
        _gravar(servidor, nome, conteudo)
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
        _gravar(dev, nome, conteudo)
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
        _gravar(dev, nome, conteudo)
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


# ------------------------------------------------------------- a demonstração na atualização
#
# ADR-46: a loja sobe primeiro e decide sozinha se a atualização fica ou volta; a
# demonstração vem depois, e nunca desfaz nada. O proxy é conferido por onde o navegador chega.

ENV_COM_DEMO = "SENHA_BANCO=x\nCOMPOSE_PROFILES=demo\nNOTIFICAR_URL=https://ntfy.exemplo/loja\n"


@precisa_do_git
async def test_a_loja_sobe_primeiro_e_a_demo_depois(tmp_path: Path) -> None:
    """Duas fases: o `up` da loja (db, api, proxy) é o que decide sucesso ou volta atrás; a
    demonstração sobe depois, pelo nome, só com o perfil dela ligado no .env."""
    env = _maquina(tmp_path, FAKE_API="echo ok") | GIT_ISOLADO
    servidor = _servidor(tmp_path, env, antes={}, depois={"novidade.txt": "v2"})
    (servidor / ".env").write_text(ENV_COM_DEMO)

    r = _atualizar(servidor, env, "--sem-backup")

    assert r.returncode == 0, r.stdout + r.stderr
    assert "Atualizado." in r.stdout
    assert "Demonstração (/demo): no ar" in r.stdout
    log = (tmp_path / "ctr" / "docker.log").read_text()
    loja, demo = log.index("compose up -d --build --remove-orphans db api proxy"), log.index("compose up -d demo-banco api-demo")
    assert loja < demo
    assert "exec -T api-demo python -c" in log[demo:]  # e esperou o /health dela
    # Conferida pelo proxy, antes do "Atualizado".
    assert "[http://127.0.0.1:80/health]" in (tmp_path / "ctr" / "curl.log").read_text()


@precisa_do_git
async def test_loja_sem_a_demo_atualiza_sem_tocar_nela_nem_no_env(tmp_path: Path) -> None:
    """A loja que veio pela 1ª atualização (rodada pelo atualizar.sh VELHO, que não conhece a
    demonstração) chega aqui com o .env de antes: a demo fica de fora, e o .env não é escrito."""
    env = _maquina(tmp_path, FAKE_API="echo ok") | GIT_ISOLADO
    servidor = _servidor(tmp_path, env, antes={}, depois={"novidade.txt": "v2"})
    dotenv = "SENHA_BANCO=x\nJWT_SECRET=y\nNOTIFICAR_URL=\n"
    (servidor / ".env").write_text(dotenv)

    r = _atualizar(servidor, env, "--sem-backup")

    assert r.returncode == 0, r.stdout + r.stderr
    log = (tmp_path / "ctr" / "docker.log").read_text()
    # A loja sobe pelo nome, e só ela: um contêiner da demonstração que tenha ficado de pé
    # (perfil desligado) nem é tocado pela fase que decide a atualização.
    assert "compose up -d --build --remove-orphans db api proxy" in log
    assert "demo-banco" not in log and "api-demo" not in log
    assert "Demonstração" not in r.stdout
    assert (servidor / ".env").read_text() == dotenv


@precisa_do_git
@pytest.mark.parametrize("defeito", [{"FAKE_UP_FALHA": "api-demo"}, {"FAKE_API_DEMO": "exit 1"}])
async def test_falha_so_da_demo_nao_desfaz_a_atualizacao_e_avisa(
    tmp_path: Path, defeito: dict[str, str]
) -> None:
    """A demonstração que não sobe (ou não responde) não é motivo para voltar a LOJA para trás:
    a atualização fica, e o dono é avisado — ela é a vitrine da revisão da Apple."""
    env = _maquina(tmp_path, FAKE_API="echo ok", **defeito) | GIT_ISOLADO
    servidor = _servidor(tmp_path, env, antes={}, depois={"novidade.txt": "v2"})
    (servidor / ".env").write_text(ENV_COM_DEMO)

    r = _atualizar(servidor, env, "--sem-backup")

    assert r.returncode == 0, r.stdout + r.stderr
    assert "Atualizado." in r.stdout
    assert (servidor / "novidade.txt").exists()
    assert not (servidor / "docker/estado/falhou").exists()
    assert (servidor / "docker/estado/implantado").read_text().strip() == _cabeca_do_github(tmp_path)
    assert _avisos(tmp_path) == ["A demonstração não subiu"]


@precisa_do_git
async def test_caddyfile_novo_e_conferido_e_recarregado(tmp_path: Path) -> None:
    """O proxy só lê o Caddyfile ao subir, e o `up` não o recria por mudança no arquivo: a
    CSP nova (ou o /demo) ficava esperando o próximo reboot. Mudou e o proxy não foi
    recriado: confere e recarrega, depois do `up`. Não mudou: nada de mexer no proxy à toa."""
    env = _maquina(tmp_path, FAKE_API="echo ok") | GIT_ISOLADO
    servidor = _servidor(tmp_path, env, antes={"docker/caddy/Caddyfile": ":80 {\n}\n"},
                         depois={"docker/caddy/Caddyfile": ":80 {\n\tencode gzip\n}\n"})
    log = tmp_path / "ctr" / "docker.log"

    r = _atualizar(servidor, env, "--sem-backup")

    assert r.returncode == 0, r.stdout + r.stderr
    assert "Caddyfile novo conferido e aplicado ao proxy" in r.stdout
    texto = log.read_text()
    up = texto.index("compose up -d --build")
    validar = texto.index("compose exec -T proxy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile")
    recarregar = texto.index("compose exec -T proxy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile")
    assert up < validar < recarregar

    _publicar(tmp_path, env, {"outra.txt": "v3"})
    log.unlink()
    r = _atualizar(servidor, env, "--sem-backup")
    assert r.returncode == 0, r.stdout + r.stderr
    assert "caddy" not in log.read_text()


@precisa_do_git
async def test_proxy_recriado_ja_subiu_com_o_caddyfile_novo(tmp_path: Path) -> None:
    env = _maquina(tmp_path, FAKE_API="echo ok", FAKE_RECRIA="proxy") | GIT_ISOLADO
    servidor = _servidor(tmp_path, env, antes={"docker/caddy/Caddyfile": "v1\n"},
                         depois={"docker/caddy/Caddyfile": "v2\n"})

    r = _atualizar(servidor, env, "--sem-backup")

    assert r.returncode == 0, r.stdout + r.stderr
    assert "o proxy foi recriado e já subiu com ele" in r.stdout
    assert "caddy reload" not in (tmp_path / "ctr" / "docker.log").read_text()


@precisa_do_git
async def test_caddyfile_que_nao_passa_na_conferencia_desfaz_a_atualizacao(tmp_path: Path) -> None:
    """Recarregado quebrado, o Caddy recusaria e seguiria com o de antes — mas o arquivo
    quebrado ficaria no disco, esperando o próximo reinício do proxy para derrubar a loja."""
    env = _maquina(tmp_path, FAKE_API="echo ok", FAKE_PROXY='[ "$2" != validate ]') | GIT_ISOLADO
    servidor = _servidor(tmp_path, env, antes={"docker/caddy/Caddyfile": "v1\n"},
                         depois={"docker/caddy/Caddyfile": "quebrado {\n"})

    r = _atualizar(servidor, env, "--sem-backup")

    assert r.returncode == 1, r.stdout + r.stderr
    assert "não passou na conferência" in r.stdout
    assert (servidor / "docker/caddy/Caddyfile").read_text() == "v1\n"
    assert "caddy reload" not in (tmp_path / "ctr" / "docker.log").read_text()
    assert (servidor / "docker/estado/falhou").read_text().strip() == _cabeca_do_github(tmp_path)


# A versão nova derruba o proxy: depois de cada `up`, o proxy cai se o código no disco tem o
# arquivo `quebra-proxy`, e volta se não tem. O resto é o docker de mentira do test_backup.
DOCKER_QUE_DERRUBA_O_PROXY = r"""#!/usr/bin/env bash
"$(dirname "$0")/docker-de-mentira" "$@" || exit $?
if [ "$1 $2" = "compose up" ]; then
    if [ -f quebra-proxy ]; then : > "$FAKE_CTR/proxy-fora"; else rm -f "$FAKE_CTR/proxy-fora"; fi
fi
exit 0
"""


@precisa_do_git
async def test_loja_que_nao_abre_pelo_proxy_volta_atras(tmp_path: Path) -> None:
    """O /health por dentro da API dizia "subiu" com a loja fechada para o navegador. Agora o
    "Atualizado" só sai depois de a loja abrir PELO PROXY — se ela abria antes."""
    env = _maquina(tmp_path, FAKE_API="echo ok") | GIT_ISOLADO
    docker = tmp_path / "bin" / "docker"
    docker.rename(tmp_path / "bin" / "docker-de-mentira")
    docker.write_text(DOCKER_QUE_DERRUBA_O_PROXY)
    docker.chmod(0o755)
    servidor = _servidor(tmp_path, env, antes={}, depois={"quebra-proxy": ""})

    r = _atualizar(servidor, env, "--sem-backup")

    assert r.returncode == 1, r.stdout + r.stderr
    assert "a loja não abre pelo proxy (http://127.0.0.1:80/health)" in r.stderr
    assert "Atualizado." not in r.stdout
    assert not (servidor / "quebra-proxy").exists()
    assert not (tmp_path / "ctr" / "proxy-fora").exists()  # a de antes voltou a abrir


@precisa_do_git
async def test_proxy_que_ja_nao_abria_nao_desfaz_a_atualizacao(tmp_path: Path) -> None:
    """Se a loja já não abria pelo proxy ANTES (porta bloqueada, um problema de antes), a
    conferida de depois não é juiz: senão toda atualização voltaria atrás por um defeito que
    não é dela. Atualiza, e avisa."""
    env = _maquina(tmp_path, FAKE_API="echo ok") | GIT_ISOLADO
    servidor = _servidor(tmp_path, env, antes={}, depois={"novidade.txt": "v2"})
    (tmp_path / "ctr" / "proxy-fora").touch()

    r = _atualizar(servidor, env, "--sem-backup")

    assert r.returncode == 0, r.stdout + r.stderr
    assert "Atualizado." in r.stdout
    assert "já não abria antes desta atualização" in r.stdout


@precisa_do_git
async def test_volta_atras_nao_mexe_na_demo(tmp_path: Path) -> None:
    """A demonstração só passa para a versão nova na segunda fase, depois de a loja estar de pé
    e conferida — e a volta atrás vem sempre antes. Ela segue na imagem e no banco de antes:
    apagar o banco dela e semear de novo (como fazia) só a tirava do ar, com /demo em 503, e
    derrubava a sessão de quem estava nela, o revisor da Apple inclusive."""
    env = _maquina(tmp_path, FAKE_API="[ ! -f quebrada ]") | GIT_ISOLADO
    servidor = _servidor(tmp_path, env, antes={}, depois={"quebrada": ""})
    (servidor / ".env").write_text(ENV_COM_DEMO)

    r = _atualizar(servidor, env, "--sem-backup")

    assert r.returncode == 1, r.stdout + r.stderr
    assert not (servidor / "quebrada").exists()
    assert "O sistema voltou para a versão de antes e está no ar" in r.stdout
    log = (tmp_path / "ctr" / "docker.log").read_text()
    # Nem o contêiner, nem o banco dela: nada da demonstração passa pelo docker na volta atrás.
    assert "api-demo" not in log and "demo-banco" not in log, log
    assert "loja_demo" not in log, log
    assert "A demonstração volta do zero" not in r.stdout + r.stderr


@precisa_do_git
async def test_orfao_de_qualquer_servico_sai_antes_do_up(tmp_path: Path) -> None:
    """O órfão de uma recriação interrompida trava o `up` seguinte, e não só o da api: o do
    proxy fecha as portas da loja, e o da demonstração faria a atualização da loja voltar
    atrás. Quem decide é o nome inteiro — contêiner de outro projeto nunca sai."""
    orfaos = ("3f2a9c1b7d4e_loja-api-1", "9a8b7c6d5e4f_loja-api-demo-1", "0a1b2c3d4e5f_loja-proxy-1",
              "aabbccddeeff_loja-demo-banco-1")
    alheios = ("loja-db-1", "minha_loja-web-1", "3f2a9c1b7d4e_outro-api-1")
    env = _maquina(tmp_path, FAKE_PS=" ".join(orfaos + alheios), FAKE_API="echo ok") | GIT_ISOLADO
    servidor = _servidor(tmp_path, env, antes={}, depois={"novidade.txt": "v2"})

    r = _atualizar(servidor, env, "--sem-backup")

    assert r.returncode == 0, r.stdout + r.stderr
    log = (tmp_path / "ctr" / "docker.log").read_text()
    for nome in orfaos:
        assert f"docker rm -f {nome}" in log
        assert log.index(f"docker rm -f {nome}") < log.index("compose up -d --build")
    for nome in alheios:
        assert f"docker rm -f {nome}" not in log


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

# O Docker do instalador: tudo sobe, e cada serviço responde "healthy" na primeira conferida
# — menos os de $FAKE_DOENTE. O `up` que pede um serviço de $FAKE_UP_FALHA falha.
DOCKER_DO_INSTALADOR = r"""#!/usr/bin/env bash
echo "docker $*" >> "$FAKE_CTR/docker.log"
case "$1 $2" in
    "volume inspect") exit 1 ;;
    "compose ps") echo "id-${4:-da-api}" ;;
    "inspect -f") case " ${FAKE_DOENTE:-} " in *" ${4#id-} "*) echo starting ;; *) echo healthy ;; esac ;;
    "compose up") for s in ${FAKE_UP_FALHA:-}; do case " $* " in *" $s "*) exit 1 ;; esac; done ;;
esac
exit 0
"""

# O resolvedor da máquina: ahostsv4/ahostsv6 dão os endereços de ctr/dns-v4 e ctr/dns-v6 (um
# por linha), no formato do getent; sem nada, "não achei" (sai 2), como o de verdade. Cada
# pergunta vai para ctr/getent.log, com as opções. Como o de verdade, sem `-s dns` entra também
# o /etc/hosts da máquina (ctr/hosts-v4, ctr/hosts-v6), e sem `-A` (o AI_ADDRCONFIG ligado) uma
# máquina sem IPv6 (ctr/sem-ipv6) não vê AAAA nenhum. Com FAKE_GETENT_ANTIGO, é o getent de
# antes do -A: recusa a opção com o "uso" do argp, saída 64.
GETENT_DE_MENTIRA = r"""#!/usr/bin/env bash
echo "getent $*" >> "$FAKE_CTR/getent.log"
sem_addrconfig=0; so_dns=0
while :; do
    case "${1:-}" in
        -A) if [ -n "${FAKE_GETENT_ANTIGO:-}" ]; then
                echo "getent: invalid option -- 'A'" >&2
                echo "Try \`getent --help' or \`getent --usage' for more information." >&2
                exit 64
            fi
            sem_addrconfig=1; shift ;;
        -s) [ "$2" = dns ] && so_dns=1; shift 2 ;;
        -*) echo "getent: invalid option -- '${1#-}'" >&2; exit 64 ;;
        *) break ;;
    esac
done
v="${1#ahosts}"
[ "$v" = v6 ] && [ -e "$FAKE_CTR/sem-ipv6" ] && [ "$sem_addrconfig" -eq 0 ] && exit 2
arquivos="$FAKE_CTR/dns-$v"
[ "$so_dns" -eq 1 ] || arquivos="$FAKE_CTR/hosts-$v $arquivos"
achou=0
for arquivo in $arquivos; do
    [ -s "$arquivo" ] || continue
    while read -r ip; do [ -n "$ip" ] && printf '%-15s STREAM %s\n' "$ip" "$2" && achou=1; done < "$arquivo"
done
[ "$achou" -eq 1 ] || exit 2
exit 0
"""


def _instalador(tmp_path: Path) -> tuple[Path, dict[str, str]]:
    env = _maquina(tmp_path)
    for nome, corpo in (("docker", DOCKER_DO_INSTALADOR), ("curl", CURL_DE_MENTIRA),
                        ("getent", GETENT_DE_MENTIRA)):
        (tmp_path / "bin" / nome).write_text(corpo)
        (tmp_path / "bin" / nome).chmod(0o755)
    loja = tmp_path / "loja"
    loja.mkdir()
    for nome in ("instalar.sh", "backup.sh", "vigia.sh", "notificar.sh", "demo.sh",
                 "docker-compose.yml"):
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


# ------------------------------------------------------------- a demonstração na instalação
#
# ADR-46: a demonstração (outra API, outro banco, dados fictícios) vem ligada com a loja, em
# <endereço>/demo. As senhas dela moram no .env, que só o instalar.sh e o demo.sh escrevem.

DEMO = ("DEMO_SENHA_BANCO", "DEMO_JWT_SECRET", "DEMO_ADMIN_EMAIL", "DEMO_ADMIN_SENHA")

# Um .env de antes da demonstração, do jeito que o instalar.sh o gravava.
ENV_DE_ANTES = (
    "DOMINIO=192.168.0.10\nENDERECO_PROXY=:80\nPORTA_HTTP=80\nPORTA_HTTPS=443\n\n"
    "SENHA_BANCO=senhaDoBancoDeAntes123\nJWT_SECRET=" + "j" * 48 + "\n\n"
    "AMBIENTE=local\nCORS_ORIGINS=*\nTIMEZONE_LOJA=America/Sao_Paulo\n\n"
    "BACKUP_REMOTO=\n\nNOTIFICAR_URL=\n"
)


def _ler_env(pasta: Path) -> dict[str, str]:
    linhas = (pasta / ".env").read_text().splitlines()
    return dict(linha.split("=", 1) for linha in linhas if "=" in linha and not linha.startswith("#"))


def _mascarar(texto: str, *segredos: str) -> str:
    """A saída para a mensagem de um assert que falhou, sem as senhas que ela pode ter."""
    for segredo in segredos:
        if segredo:
            texto = texto.replace(segredo, "***")
    return texto


def _saida(r: subprocess.CompletedProcess, loja: Path) -> str:
    segredos = _ler_env(loja).values() if (loja / ".env").exists() else ()
    return _mascarar(r.stdout + r.stderr, *[s for s in segredos if len(s) >= 12])


def _religar(loja: Path, env: dict[str, str], *mais: str) -> subprocess.CompletedProcess:
    """O instalador de novo, reaproveitando o .env (o "religar depois de um down")."""
    return subprocess.run(["bash", "./instalar.sh", "--sim", *mais], cwd=loja, env=env,
                          capture_output=True, text=True, timeout=300)


def _dns(tmp_path: Path, ip: str | None = None, v4: tuple[str, ...] = (),
         v6: tuple[str, ...] = (), ip6: str | None = None) -> None:
    """O IP público desta máquina (o que os serviços de eco veem) e para onde o domínio aponta."""
    ctr = tmp_path / "ctr"
    for nome, valor in (("ip-publico", ip), ("ip6-publico", ip6)):
        (ctr / nome).unlink(missing_ok=True)
        if valor:
            (ctr / nome).write_text(valor + "\n")
    (ctr / "dns-v4").write_text("".join(f"{a}\n" for a in v4))
    (ctr / "dns-v6").write_text("".join(f"{a}\n" for a in v6))


@precisa_do_bash
async def test_instalacao_nova_vem_com_a_demo_e_mostra_a_senha_uma_vez(tmp_path: Path) -> None:
    """"A conta demo já vai vir pronta": instalação nova grava as senhas da demonstração no
    .env (600, segredo do login diferente do da loja), sobe a loja e DEPOIS a demonstração,
    agenda a renovação diária e mostra a senha no resumo — uma vez. Rodar de novo não a repete."""
    loja, env = _instalador(tmp_path)
    _dns(tmp_path, ip="203.0.113.10", v4=("203.0.113.10",))

    r = _instalar(loja, env, "loja.exemplo.com.br")

    assert r.returncode == 0, _saida(r, loja)
    dotenv = _ler_env(loja)
    assert dotenv["COMPOSE_PROFILES"] == "demo"
    assert dotenv["DEMO_ADMIN_EMAIL"] == "dono@demo.example"
    for chave, minimo in (("DEMO_SENHA_BANCO", 20), ("DEMO_JWT_SECRET", 32), ("DEMO_ADMIN_SENHA", 20)):
        assert re.fullmatch(r"[A-Za-z0-9_-]{%d,}" % minimo, dotenv[chave]), chave
    # O token só leva o id do usuário: com o mesmo segredo, o da demo abriria a loja.
    assert dotenv["DEMO_JWT_SECRET"] != dotenv["JWT_SECRET"]
    assert _modo(loja / ".env") == 0o600
    senha = dotenv["DEMO_ADMIN_SENHA"]
    assert r.stdout.count(senha) == 1, _saida(r, loja)
    assert "https://loja.exemplo.com.br/demo" in r.stdout
    assert "loja.exemplo.com.br aponta para este servidor (203.0.113.10)" in r.stdout
    log = (tmp_path / "ctr" / "docker.log").read_text()
    # A loja sobe sozinha e conferida; a demonstração vem depois, pelo nome.
    assert log.index("compose up -d --build db api proxy") < log.index("compose up -d demo-banco api-demo")
    assert "caddy reload --config /etc/caddy/Caddyfile" in log
    # A conta nasce dentro do contêiner, pelo ambiente: a senha não passa em linha de comando.
    assert senha not in log
    unidades = tmp_path / "systemd"
    assert "OnCalendar=*-*-* 04:30:00 America/Sao_Paulo" in (unidades / "loja-demo-renovar.timer").read_text()
    servico = (unidades / "loja-demo-renovar.service").read_text()
    assert "OnFailure=loja-aviso@%N.service" in servico
    assert f"ExecStart={loja}/demo.sh --renovar" in servico

    de_novo = _religar(loja, env)

    assert de_novo.returncode == 0, _saida(de_novo, loja)
    assert senha not in de_novo.stdout + de_novo.stderr
    assert "veja com ./demo.sh --mostrar" in de_novo.stdout
    assert _ler_env(loja) == dotenv


@precisa_do_bash
async def test_sem_demo_nao_grava_nada_da_demo_e_a_decisao_fica(tmp_path: Path) -> None:
    """--sem-demo: nenhuma senha, nenhum serviço, nenhum timer da demonstração. E a decisão
    fica no .env (a linha vazia): religar a loja depois não liga a demo por conta própria."""
    loja, env = _instalador(tmp_path)

    r = _instalar(loja, env, "192.168.0.10", "--sem-demo")

    assert r.returncode == 0, _saida(r, loja)
    texto = (loja / ".env").read_text()
    assert "DEMO_" not in texto
    assert _ler_env(loja)["COMPOSE_PROFILES"] == ""
    log = (tmp_path / "ctr" / "docker.log").read_text()
    assert "api-demo" not in log and "demo-banco" not in log
    assert not (tmp_path / "systemd" / "loja-demo-renovar.timer").exists()
    assert "Demonstração: desligada — para ligar: ./demo.sh --ligar" in r.stdout

    de_novo = _religar(loja, env)

    assert de_novo.returncode == 0, _saida(de_novo, loja)
    assert "DEMO_" not in (loja / ".env").read_text()
    assert "api-demo" not in (tmp_path / "ctr" / "docker.log").read_text()

    # Ligada depois pelo demo.sh: o recado de "desligada" sai do .env junto com a decisão.
    ligada = subprocess.run(["bash", "./demo.sh", "--ligar"], cwd=loja, env=env, input="",
                            capture_output=True, text=True, timeout=120)
    assert ligada.returncode == 0, _saida(ligada, loja)
    assert _ler_env(loja)["COMPOSE_PROFILES"] == "demo"
    assert all(_ler_env(loja)[chave] for chave in DEMO)
    assert "desligada" not in (loja / ".env").read_text()


@precisa_do_bash
async def test_forcar_mantem_as_senhas_da_demo(tmp_path: Path) -> None:
    """O --forcar regrava o .env inteiro e sorteia o segredo do login de novo. A senha da
    conta da demonstração é a que está na Apple: sorteada de novo, o revisor ficaria de fora."""
    loja, env = _instalador(tmp_path)
    assert _instalar(loja, env, "192.168.0.10").returncode == 0
    antes = _ler_env(loja)

    r = _instalar(loja, env, "192.168.0.10", "--forcar")

    assert r.returncode == 0, _saida(r, loja)
    depois = _ler_env(loja)
    for chave in DEMO:
        assert depois[chave] == antes[chave], chave
    assert depois["COMPOSE_PROFILES"] == "demo"
    assert depois["JWT_SECRET"] != antes["JWT_SECRET"]
    assert depois["DEMO_JWT_SECRET"] != depois["JWT_SECRET"]
    # Não nasceu agora: o resumo não a repete.
    assert antes["DEMO_ADMIN_SENHA"] not in r.stdout
    assert "veja com ./demo.sh --mostrar" in r.stdout


# O que o dono pôs no .env e o modelo do instalador não escreve: a NFC-e (ADR-41: só o .env a
# liga), o teto de memória da demonstração e uma linha à mão (com aspas, como veio).
DO_DONO = {
    "FISCAL_EMISSOR": "focusnfe", "FOCUSNFE_TOKEN": "tokenDoEmissorFiscal0123456789abc",
    "FOCUSNFE_AMBIENTE": "producao", "FISCAL_EMITIR_AUTOMATICO": "true",
    "DEMO_MEMORIA": "768m", "LINHA_A_MAO": '"com aspas = e espaço"',
}
# E o que o modelo escreve vazio quando a rodada não traz outro: a cópia de fora e os avisos.
DO_DONO_NO_MODELO = {"BACKUP_REMOTO": "gdrive:loja-backups", "NOTIFICAR_URL": "https://ntfy.sh/loja-de-antes"}


@precisa_do_bash
async def test_forcar_leva_adiante_o_que_o_modelo_nao_escreve(tmp_path: Path) -> None:
    """O --forcar (o caminho que o ./demo.sh --mostrar indica para pôr um domínio) refazia o .env
    pelo modelo e só levava as DEMO_*: a NFC-e voltava a "desligado" calada e as vendas seguiam
    sem nota, a cópia de fora e os avisos paravam, e a demonstração voltava a 512m. Agora o que
    o modelo não escreve vem junto, com o valor exato, e a saída diz quais — só os nomes."""
    loja, env = _instalador(tmp_path)
    assert _instalar(loja, env, "192.168.0.10").returncode == 0
    texto = (loja / ".env").read_text()
    for chave, valor in DO_DONO_NO_MODELO.items():
        assert f"\n{chave}=\n" in texto
        texto = texto.replace(f"\n{chave}=\n", f"\n{chave}={valor}\n")
    (loja / ".env").write_text(texto + "".join(f"{c}={v}\n" for c, v in DO_DONO.items()))

    r = _instalar(loja, env, "loja.exemplo.com.br", "--forcar")

    assert r.returncode == 0, _saida(r, loja)
    depois = _ler_env(loja)
    assert depois["DOMINIO"] == "loja.exemplo.com.br"
    linhas = (loja / ".env").read_text().splitlines()
    for chave, valor in (DO_DONO | DO_DONO_NO_MODELO).items():
        assert depois[chave] == valor, chave
        assert sum(linha.startswith(f"{chave}=") for linha in linhas) == 1, chave
    mantidas = next(linha for linha in r.stdout.splitlines() if "do .env de antes, mantidas:" in linha)
    assert set(mantidas.split("mantidas:")[1].replace(",", " ").split()) == set(DO_DONO | DO_DONO_NO_MODELO)
    # Os nomes, nunca os valores: o token do emissor fiscal é segredo.
    assert DO_DONO["FOCUSNFE_TOKEN"] not in r.stdout + r.stderr
    # O tópico de antes não foi informado agora: nada de apitar o celular.
    assert "Avisos da loja ligados" not in _avisos(tmp_path)

    # De novo, com um tópico novo: ele vale no lugar do de antes, e nada se duplica.
    de_novo = _instalar(loja, env, "loja.exemplo.com.br", "--forcar", "--avisos", "loja-nova")

    assert de_novo.returncode == 0, _saida(de_novo, loja)
    depois = _ler_env(loja)
    assert depois["NOTIFICAR_URL"] == "https://ntfy.sh/loja-nova"
    linhas = (loja / ".env").read_text().splitlines()
    for chave, valor in DO_DONO.items():
        assert depois[chave] == valor, chave
        assert sum(linha.startswith(f"{chave}=") for linha in linhas) == 1, chave
    assert depois["BACKUP_REMOTO"] == DO_DONO_NO_MODELO["BACKUP_REMOTO"]
    assert "Avisos da loja ligados" in _avisos(tmp_path)


@precisa_do_bash
async def test_religar_sem_loja_chega_ao_fim_e_ganha_a_demo(tmp_path: Path) -> None:
    """O caminho que reaproveita o .env morria em "LOJA: unbound variable" depois do `up`:
    sem rotinas religadas e sem resumo. É por ele que a loja de antes ganha a demonstração,
    sem mexer no que o .env já tinha."""
    loja, env = _instalador(tmp_path)
    (loja / ".env").write_text(ENV_DE_ANTES)
    (loja / ".env").chmod(0o600)

    r = _religar(loja, env)

    assert r.returncode == 0, _saida(r, loja)
    assert "unbound variable" not in r.stderr
    assert "Pronto — o sistema está rodando" in r.stdout
    dotenv = _ler_env(loja)
    assert dotenv["SENHA_BANCO"] == "senhaDoBancoDeAntes123"
    assert dotenv["JWT_SECRET"] == "j" * 48
    assert dotenv["COMPOSE_PROFILES"] == "demo"
    assert all(dotenv[chave] for chave in DEMO)
    assert dotenv["DEMO_JWT_SECRET"] != dotenv["JWT_SECRET"]
    assert (loja / ".env").read_text().startswith(ENV_DE_ANTES)
    assert _modo(loja / ".env") == 0o600
    # A senha nasceu agora: aparece uma vez.
    assert r.stdout.count(dotenv["DEMO_ADMIN_SENHA"]) == 1
    assert "compose up -d demo-banco api-demo" in (tmp_path / "ctr" / "docker.log").read_text()


@precisa_do_bash
@pytest.mark.skipif(os.geteuid() != 0, reason="só o root dá um arquivo a outro dono (no CI, o runner não é root)")
async def test_religar_com_sudo_deixa_o_env_com_quem_instalou(tmp_path: Path) -> None:
    """O espelho do demo.sh: completar o .env com a demonstração troca o arquivo, e um `sudo
    ./instalar.sh` numa loja instalada pelo usuário comum o deixava de root — o docker compose
    dele parava em "permission denied". O dono e o grupo de antes ficam, e o modo, 600."""
    loja, env = _instalador(tmp_path)
    (loja / ".env").write_text(ENV_DE_ANTES)
    (loja / ".env").chmod(0o600)
    os.chown(loja / ".env", 4242, 4343)

    r = _religar(loja, env)

    assert r.returncode == 0, _saida(r, loja)
    assert _ler_env(loja)["COMPOSE_PROFILES"] == "demo"  # regravado, e não só lido
    dono = (loja / ".env").stat()
    assert (dono.st_uid, dono.st_gid) == (4242, 4343)
    assert _modo(loja / ".env") == 0o600


@precisa_do_bash
async def test_religar_com_sem_demo_so_guarda_a_decisao(tmp_path: Path) -> None:
    """A loja de antes religada com --sem-demo: nenhuma senha nasce, nada da demo sobe, e o
    .env só ganha a linha que diz que ela ficou de fora — o próximo religar respeita."""
    loja, env = _instalador(tmp_path)
    (loja / ".env").write_text(ENV_DE_ANTES)

    r = _religar(loja, env, "--sem-demo")

    assert r.returncode == 0, _saida(r, loja)
    texto = (loja / ".env").read_text()
    assert texto.startswith(ENV_DE_ANTES)
    assert "DEMO_" not in texto
    assert _ler_env(loja)["COMPOSE_PROFILES"] == ""
    assert "api-demo" not in (tmp_path / "ctr" / "docker.log").read_text()

    assert _religar(loja, env).returncode == 0
    assert "DEMO_" not in (loja / ".env").read_text()


@precisa_do_bash
@pytest.mark.parametrize(("defeito", "recado"), [
    ({"FAKE_UP_FALHA": "api-demo"}, "a demonstração não subiu"),
    ({"FAKE_DOENTE": "api-demo"}, "a demonstração ainda não respondeu"),
])
async def test_demo_que_nao_sobe_nao_derruba_a_instalacao(
    tmp_path: Path, defeito: dict[str, str], recado: str
) -> None:
    """A loja não depende da vitrine: a demonstração que não sobe, ou não responde no tempo,
    vira um recado — e a instalação da loja termina igual, com rotinas e resumo."""
    loja, env = _instalador(tmp_path)

    r = _instalar(loja, env | defeito, "192.168.0.10")

    assert r.returncode == 0, _saida(r, loja)
    assert recado in r.stdout
    assert "Pronto — o sistema está rodando" in r.stdout
    assert "enable --now loja-backup.timer" in (tmp_path / "ctr" / "systemctl.log").read_text()


@precisa_do_bash
async def test_sem_demo_numa_loja_com_demo_desliga_e_guarda(tmp_path: Path) -> None:
    """--sem-demo onde a demonstração estava ligada: desliga de verdade (os contêineres dela
    não saem do ar sozinhos) e guarda as senhas, para o ./demo.sh --ligar voltar igual."""
    loja, env = _instalador(tmp_path)
    assert _instalar(loja, env, "192.168.0.10").returncode == 0
    antes = _ler_env(loja)

    r = _religar(loja, env, "--sem-demo")

    assert r.returncode == 0, _saida(r, loja)
    depois = _ler_env(loja)
    assert depois["COMPOSE_PROFILES"] == ""
    assert all(depois[chave] == antes[chave] for chave in DEMO)
    assert "compose --profile demo rm -sf api-demo demo-banco" in (tmp_path / "ctr" / "docker.log").read_text()
    assert not (tmp_path / "systemd" / "loja-demo-renovar.timer").exists()


@precisa_do_bash
async def test_dns_errado_diz_o_registro_e_repete_no_resumo(tmp_path: Path) -> None:
    """Com --sim ninguém espera o DNS: a conferida diz o registro exato que falta (como o
    painel do domínio pede) e o resumo repete. Um AAAA para outra máquina tem de sair: o Let's
    Encrypt tenta o IPv6 primeiro, e o certificado não sairia."""
    loja, env = _instalador(tmp_path)
    _dns(tmp_path, ip="203.0.113.10", v4=("198.51.100.7",), v6=("2001:db8::99",))

    r = _instalar(loja, env, "loja.seudominio.com.br")

    assert r.returncode == 0, _saida(r, loja)
    # Ao lado do "Nome", o nome inteiro, para a pessoa conferir com o painel.
    registro = "Tipo A  ·  Nome loja — o registro completo é loja.seudominio.com.br  ·  Valor 203.0.113.10"
    assert r.stdout.count(registro) == 2, _saida(r, loja)
    assert "aponta para 198.51.100.7, não para este servidor" in r.stdout
    assert r.stdout.count("Apague o registro AAAA de loja.seudominio.com.br (2001:db8::99)") == 2
    # Conferido ANTES de subir: o Let's Encrypt limita as tentativas que falham. E antes de
    # gravar o .env: uma espera interrompida não deixa meia instalação para a próxima rodada.
    assert r.stdout.index("Conferindo o DNS") < r.stdout.index("Gravando a configuração")
    assert r.stdout.index("Conferindo o DNS") < r.stdout.index("Construindo e subindo")
    assert "Falta acertar o DNS de loja.seudominio.com.br" in r.stdout

    _dns(tmp_path, ip="203.0.113.10", v4=())
    sem_registro = _instalar(loja, env, "loja.seudominio.com.br", "--forcar")
    assert f"Crie no painel do domínio:   {registro}" in sem_registro.stdout

    _dns(tmp_path, ip="203.0.113.10", v4=("203.0.113.10",), v6=("2001:db8::10",), ip6="2001:db8::10")
    certo = _instalar(loja, env, "loja.seudominio.com.br", "--forcar")
    assert "aponta para este servidor (203.0.113.10)" in certo.stdout
    assert "Falta acertar o DNS" not in certo.stdout


@precisa_do_bash
async def test_dns_interativo_espera_e_segue_quando_o_registro_aparece(tmp_path: Path) -> None:
    """Com gente na frente, o instalador espera o DNS conferindo de novo (a cada 15 s) e segue
    sozinho quando o registro aparece — sem ninguém teclar nada."""
    loja, env = _instalador(tmp_path)
    _dns(tmp_path, ip="203.0.113.10", v4=())
    # O registro "aparece" na segunda pergunta ao resolvedor (o banco e o nome vêm depois das
    # opções, -A -s dns).
    getent = tmp_path / "bin" / "getent"
    getent.write_text(
        '#!/usr/bin/env bash\n'
        'n="$(cat "$FAKE_CTR/perguntas" 2>/dev/null || echo 0)"; echo $((n + 1)) > "$FAKE_CTR/perguntas"\n'
        'banco="${*: -2:1}"; nome="${*: -1}"\n'
        '[ "$banco" = ahostsv4 ] && [ "$n" -ge 2 ] && echo "203.0.113.10    STREAM $nome"\n'
        'exit 0\n'
    )
    saida, erros = tmp_path / "saida.txt", tmp_path / "erros.txt"
    with saida.open("w") as o, erros.open("w") as e:
        processo = subprocess.Popen(
            ["bash", "./instalar.sh", "--dominio", "loja.seudominio.com.br", "--nome", "Dona Maria",
             "--email", "dona@loja.com", "--senha", "senha12345", "--senha-banco", "senhaDoBanco123",
             "--loja", "Boutique", "--segmento", "ROUPAS", "--avisos", "loja-teste"],
            cwd=loja, env=env | {"INTERVALO_DNS": "1"}, stdin=subprocess.PIPE, stdout=o, stderr=e,
        )
        try:
            assert processo.wait(timeout=120) == 0, _mascarar(saida.read_text() + erros.read_text())
        finally:
            processo.stdin.close()
            if processo.poll() is None:
                processo.kill()
    texto = saida.read_text()
    assert "Conferindo de novo a cada 1 s" in texto
    assert "agora sim: loja.seudominio.com.br aponta para este servidor" in texto
    assert "Falta acertar o DNS" not in texto


@precisa_do_bash
async def test_espera_do_dns_interrompida_nao_deixa_env_e_a_volta_cria_o_dono(tmp_path: Path) -> None:
    """A espera do DNS não tem teto e convida a sair: o Ctrl+C de quem vai acertar o painel, o
    SSH que cai. Ela vinha DEPOIS de gravar o .env, e a rodada seguinte o reaproveitava sem
    perguntar nada: terminava "com sucesso", sem a conta do dono e sem o nome e o ramo da loja
    ("Entrar: <a conta já existente>", conta nenhuma). Agora a conferida vem antes de gravar."""
    loja, env = _instalador(tmp_path)
    _dns(tmp_path, ip="203.0.113.10", v4=("9.9.9.9",))
    saida = tmp_path / "saida.txt"
    with saida.open("w") as o:
        processo = subprocess.Popen(
            ["bash", "./instalar.sh", "--dominio", "loja.seudominio.com.br", "--nome", "Dona Maria",
             "--email", "dona@loja.com", "--senha", "senha12345", "--senha-banco", "senhaDoBanco123",
             "--loja", "Boutique", "--segmento", "ROUPAS", "--avisos", "loja-teste"],
            cwd=loja, env=env | {"INTERVALO_DNS": "1"}, stdin=subprocess.PIPE, stdout=o,
            stderr=subprocess.STDOUT,
        )
        try:
            prazo = time.monotonic() + 60
            while "Conferindo de novo a cada 1 s" not in saida.read_text():
                assert processo.poll() is None and time.monotonic() < prazo, _mascarar(saida.read_text())
                time.sleep(0.1)
            processo.send_signal(signal.SIGINT)  # o Ctrl+C, no meio da espera
            processo.wait(timeout=30)
        finally:
            processo.stdin.close()
            if processo.poll() is None:
                processo.kill()
    assert processo.returncode != 0
    assert not (loja / ".env").exists(), _mascarar(saida.read_text())
    assert not list(loja.glob(".env.*"))
    assert "compose up" not in (tmp_path / "ctr" / "docker.log").read_text()

    # Com o DNS acertado, quem volta roda só ./instalar.sh: as perguntas vêm de novo, do começo
    # (loja, ramo, domínio, dono, e-mail, senha duas vezes, senha do banco sorteada, sem ntfy).
    _dns(tmp_path, ip="203.0.113.10", v4=("203.0.113.10",))
    respostas = "Boutique\n1\nloja.seudominio.com.br\nDona Maria\ndona@loja.com\nsenha12345\nsenha12345\n\n\n"
    r = subprocess.run(["bash", "./instalar.sh"], cwd=loja, env=env, input=respostas,
                       capture_output=True, text=True, timeout=300)

    assert r.returncode == 0, _saida(r, loja)
    assert "Configuração reaproveitada" not in r.stdout
    assert "Entrar:    dona@loja.com" in r.stdout
    log = (tmp_path / "ctr" / "docker.log").read_text()
    assert "app.cli configurar-loja --nome Boutique --segmento ROUPAS" in log
    assert "app.cli create-admin --nome Dona Maria --email dona@loja.com" in log


# O que o instalador diz quando pergunta e a entrada acabou (sem terminal, ninguém responde).
SEM_TERMINAL = "a entrada acabou: sem terminal, rode com --sim e os parâmetros"


def _sem_terminal(loja: Path, env: dict[str, str], *parametros: str,
                  entrada: str | None = None) -> subprocess.CompletedProcess:
    """O instalador sem gente na frente: a entrada é /dev/null, ou o texto dado e depois o fim.
    O prazo curto é parte da prova: o laço de antes não terminava nunca."""
    if entrada is None:
        entradas: dict[str, object] = {"stdin": subprocess.DEVNULL}
    else:
        entradas = {"input": entrada}
    try:
        return subprocess.run(["bash", "./instalar.sh", *parametros], cwd=loja, env=env,
                              capture_output=True, text=True, timeout=30, **entradas)
    except subprocess.TimeoutExpired:
        pytest.fail("o instalador não terminou em 30 s: uma pergunta ficou em laço")


def _nada_subiu(tmp_path: Path) -> bool:
    log = tmp_path / "ctr" / "docker.log"
    return not log.exists() or "compose up" not in log.read_text()


@precisa_do_bash
@pytest.mark.parametrize("parametros", [
    # Do jeito que a revisão rodou: instalação nova, nada por parâmetro.
    (),
    # Tudo por parâmetro menos o e-mail — a pergunta sem padrão, que era o laço sem fim.
    ("--loja", "Boutique", "--segmento", "ROUPAS", "--dominio", "localhost", "--nome", "Dona Maria",
     "--senha", "senha12345"),
])
async def test_sem_terminal_a_pergunta_para_com_a_frase_e_sem_laco(
    tmp_path: Path, parametros: tuple[str, ...]
) -> None:
    """`./instalar.sh < /dev/null`: o `read` engolia o fim da entrada (`|| true`), o padrão entrava
    calado e o laço do e-mail repetia "e-mail inválido." milhares de vezes por segundo, para
    sempre. Agora a primeira pergunta sem resposta para e diz o caminho: --sim e os parâmetros.
    Nada é gravado, nada sobe."""
    loja, env = _instalador(tmp_path)

    r = _sem_terminal(loja, env, *parametros)

    assert r.returncode != 0
    assert SEM_TERMINAL in r.stderr, _saida(r, loja)
    assert "e-mail inválido" not in r.stdout + r.stderr
    assert not (loja / ".env").exists()
    assert _nada_subiu(tmp_path)


@precisa_do_bash
async def test_email_errado_pergunta_de_novo_e_a_ultima_linha_sem_enter_vale(tmp_path: Path) -> None:
    """O e-mail errado ficava na variável, e o perguntar não pergunta o que já tem valor: o laço
    repetia "e-mail inválido." para sempre sem perguntar de novo. Agora pergunta de novo — e, se
    a entrada acabou, para com a frase. A última linha sem o Enter no fim é resposta, não o fim:
    a instalação vai até o fim com ela."""
    loja, env = _instalador(tmp_path)

    errado = _sem_terminal(loja, env, entrada="Boutique\n1\nlocalhost\nDona Maria\nnao-e-email\n")

    assert errado.returncode != 0
    assert errado.stdout.count("e-mail inválido.") == 1, _saida(errado, loja)
    assert SEM_TERMINAL in errado.stderr
    assert not (loja / ".env").exists()

    # Loja, ramo, domínio, dono, o e-mail errado e o certo, a senha duas vezes, Enter (a senha do
    # banco, sorteada) e o tópico do ntfy sem o Enter no fim.
    certo = _sem_terminal(loja, env, entrada=(
        "Boutique\n1\nlocalhost\nDona Maria\nnao-e-email\ndona@loja.com\nsenha12345\nsenha12345\n\n"
        "loja-teste"))

    assert certo.returncode == 0, _saida(certo, loja)
    assert certo.stdout.count("e-mail inválido.") == 1
    assert _ler_env(loja)["NOTIFICAR_URL"] == "https://ntfy.sh/loja-teste"
    assert "Entrar:    dona@loja.com" in certo.stdout


@precisa_do_bash
@pytest.mark.parametrize(("email", "recado"), [
    ((), "faltou --email"),
    (("--email", "nao-e-email"), "e-mail inválido: nao-e-email"),
])
async def test_sim_sem_email_bom_para_na_validacao_e_nao_em_laco(
    tmp_path: Path, email: tuple[str, ...], recado: str
) -> None:
    """Com --sim ninguém responde: o laço do e-mail rodava para sempre sem e-mail (ou com um
    errado) em vez de chegar à validação, que diz o parâmetro que faltou."""
    loja, env = _instalador(tmp_path)

    r = _sem_terminal(loja, env, "--sim", "--dominio", "localhost", "--nome", "Dona Maria",
                      "--senha", "senha12345", *email)

    assert r.returncode == 1
    assert recado in r.stderr, _saida(r, loja)
    assert "e-mail inválido." not in r.stdout
    assert not (loja / ".env").exists()
    assert _nada_subiu(tmp_path)


@precisa_do_bash
@pytest.mark.parametrize(("maquina", "recado"), [
    # Sem IPv6 na máquina, o AI_ADDRCONFIG do getent escondia o AAAA velho do domínio (o da zona
    # padrão do provedor, que leva ao estacionamento): passava por certo, e o Let's Encrypt, que
    # tenta o IPv6 primeiro, não emitia o certificado.
    ("sem-ipv6", "Apague o registro AAAA de loja.seudominio.com.br (2001:db8::dead)"),
    # O nome no /etc/hosts da máquina, no IP dela, passava sem registro público nenhum.
    ("hosts-v4", "Crie no painel do domínio:   Tipo A  ·  Nome loja — o registro completo é "
                 "loja.seudominio.com.br  ·  Valor 203.0.113.10"),
])
async def test_dns_e_conferido_no_dns_e_nao_no_que_a_maquina_acha(
    tmp_path: Path, maquina: str, recado: str
) -> None:
    """A conferida pergunta ao DNS (`-s dns`, sem o /etc/hosts) e sem o AI_ADDRCONFIG (`-A`):
    é o que o Let's Encrypt vê, e não o que esta máquina acha."""
    loja, env = _instalador(tmp_path)
    if maquina == "sem-ipv6":
        _dns(tmp_path, ip="203.0.113.10", v4=("203.0.113.10",), v6=("2001:db8::dead",))
        (tmp_path / "ctr" / "sem-ipv6").touch()
    else:
        _dns(tmp_path, ip="203.0.113.10", v4=())
        (tmp_path / "ctr" / "hosts-v4").write_text("203.0.113.10\n")

    r = _instalar(loja, env, "loja.seudominio.com.br")

    assert r.returncode == 0, _saida(r, loja)
    assert recado in r.stdout, _saida(r, loja)
    assert "aponta para este servidor" not in r.stdout
    assert "Falta acertar o DNS de loja.seudominio.com.br" in r.stdout
    perguntas = (tmp_path / "ctr" / "getent.log").read_text()
    assert "getent -A -s dns ahostsv4 loja.seudominio.com.br" in perguntas
    assert "getent -A -s dns ahostsv6 loja.seudominio.com.br" in perguntas


@precisa_do_bash
async def test_getent_antigo_diz_que_o_aaaa_nao_foi_conferido(tmp_path: Path) -> None:
    """O getent de antes do -A recusa as opções (saída 64): a conferida pergunta do jeito
    antigo, e, numa máquina sem IPv6, onde ele esconde o AAAA, diz que o AAAA não foi conferido
    — em vez de dar ✓ só pelo registro A."""
    loja, env = _instalador(tmp_path)
    _dns(tmp_path, ip="203.0.113.10", v4=("203.0.113.10",), v6=("2001:db8::dead",))
    (tmp_path / "ctr" / "sem-ipv6").touch()

    r = _instalar(loja, env | {"FAKE_GETENT_ANTIGO": "1"}, "loja.seudominio.com.br")

    assert r.returncode == 0, _saida(r, loja)
    assert "loja.seudominio.com.br aponta para este servidor (203.0.113.10), pelo registro A" in r.stdout
    assert "o AAAA (IPv6) de loja.seudominio.com.br não foi conferido" in r.stdout, _saida(r, loja)
    assert "✓ loja.seudominio.com.br aponta para este servidor" not in r.stdout
    # Não é pendência: ninguém sabe se há um AAAA para apagar, e a instalação segue.
    assert "Falta acertar o DNS" not in r.stdout
    perguntas = (tmp_path / "ctr" / "getent.log").read_text().splitlines()
    recusada = perguntas.index("getent -A -s dns ahostsv6 loja.seudominio.com.br")
    assert perguntas[recusada + 1] == "getent ahostsv6 loja.seudominio.com.br"


def _nome_no_painel(dominio: str) -> str:
    funcoes = f'eval "$(sed -n "/^nome_no_painel() {{/,/^}}/p" {RAIZ / "instalar.sh"})"'
    feito = subprocess.run(["bash", "-c", f'{funcoes}; nome_no_painel "$1"', "_", dominio],
                           capture_output=True, text=True, timeout=30)
    return feito.stdout.strip()


@precisa_do_bash
@pytest.mark.parametrize(("dominio", "nome"), [
    ("loja.seudominio.com.br", "loja"), ("seudominio.com.br", "@"), ("loja.exemplo.com", "loja"),
    ("exemplo.com", "@"), ("a.b.loja.com.br", "a.b"), ("loja.exemplo.co.uk", "loja"),
    ("vendas.loja.net.br", "vendas"),
    # No .br não se registra direto sob o TLD: o segundo nível é sempre uma categoria — e as
    # que não estavam na lista mandavam criar o nome em dobro (minhaloja.minhaloja.tec.br).
    ("minhaloja.tec.br", "@"), ("loja.minhaloja.tec.br", "loja"), ("minhaloja.app.br", "@"),
    ("minhaloja.dev.br", "@"), ("escritorio.adv.br", "@"), ("entregas.log.br", "@"),
    ("a.b.minhaloja.blog.br", "a.b"),
    # As categorias do .uk além do co.uk; um país sem categoria continua com dois pedaços.
    ("minhaloja.me.uk", "@"), ("loja.minhaloja.me.uk", "loja"), ("loja.empresa.org.uk", "loja"),
    ("empresa.ltd.uk", "@"), ("empresa.plc.uk", "@"), ("loja.empresa.net.uk", "loja"),
    ("loja.exemplo.de", "loja"),
])
async def test_o_nome_do_registro_e_o_que_o_painel_pede(dominio: str, nome: str) -> None:
    """O painel do domínio pede o pedaço antes do domínio registrado (ou @ para ele mesmo)."""
    assert _nome_no_painel(dominio) == nome


@precisa_do_bash
async def test_dns_num_tec_br_pede_o_arroba_e_mostra_o_nome_inteiro(tmp_path: Path) -> None:
    """Na zona minhaloja.tec.br, "Nome minhaloja" criava minhaloja.minhaloja.tec.br: o DNS nunca
    ficava certo e o certificado não saía. Agora o recado pede o @ e mostra ao lado o nome
    inteiro do registro, para conferir com o painel (e não para pôr NO campo)."""
    loja, env = _instalador(tmp_path)
    _dns(tmp_path, ip="203.0.113.10", v4=())

    r = _instalar(loja, env, "minhaloja.tec.br")

    assert r.returncode == 0, _saida(r, loja)
    assert ("Crie no painel do domínio:   Tipo A  ·  Nome @ — o registro completo é minhaloja.tec.br"
            "  ·  Valor 203.0.113.10") in r.stdout, _saida(r, loja)


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
    for unidade in ("loja-vigia", "loja-backup", "loja-backup-nuvem", "loja-atualizar",
                    "loja-demo-renovar"):
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
    # A renovação da demonstração também para: com a loja desligada, ela falharia todo dia.
    assert "disable --now loja-demo-renovar.timer" in desligados
    # O `down` só alcança serviço de perfil LIGADO: sem nomear a demonstração, um contêiner
    # dela (perfil desligado no .env) ficava no ar depois do "desinstalado".
    assert "docker compose --profile demo down" in (tmp_path / "ctr" / "docker.log").read_text()


@precisa_do_bash
async def test_desinstalar_tudo_leva_a_demo_junto(tmp_path: Path) -> None:
    """Apagar tudo apaga também os volumes da demonstração (o `down -v` sem o perfil dela
    deixava o das fotos para trás) e o .env com as senhas dela."""
    env = _maquina(tmp_path)
    loja = tmp_path / "loja"
    loja.mkdir()
    for nome in ("desinstalar.sh", "docker-compose.yml"):
        shutil.copy(RAIZ / nome, loja / nome)
    (loja / ".env").write_text(ENV_COM_DEMO + "DEMO_ADMIN_SENHA=senhaDaDemo123456789\n")

    r = subprocess.run(["bash", "./desinstalar.sh", "--sim"], cwd=loja,
                       env=env, capture_output=True, text=True, timeout=60)

    assert r.returncode == 0, r.stdout + r.stderr
    assert "docker compose --profile demo down -v" in (tmp_path / "ctr" / "docker.log").read_text()
    assert not (loja / ".env").exists()
    assert "a demonstração (/demo) junto" in r.stdout
