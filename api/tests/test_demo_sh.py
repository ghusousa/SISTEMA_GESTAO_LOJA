"""O ./demo.sh: a demonstração da loja em <endereço>/demo (ADR-46), ligada e desligada na
máquina — e o diagnóstico, que passa a enxergá-la.

Como os testes do atualizar.sh e do instalar.sh: o script de verdade, numa pasta de mentira,
com docker, curl e systemctl de mentira no PATH e as unidades numa DIR_SYSTEMD de mentira. O
banco da demonstração nunca existe aqui: o SQL dele só é anotado no docker.log.
"""

import os
import shutil
import subprocess
from pathlib import Path

import pytest

from tests.test_backup import RAIZ, _maquina, _modo
from tests.test_sistema import CURL_DE_MENTIRA, _avisos, _ler_env, _mascarar, precisa_do_bash

# O .env que o instalar.sh gravava antes da demonstração, numa loja com domínio.
ENV_DA_LOJA = (
    "DOMINIO=loja.exemplo.com.br\nENDERECO_PROXY=loja.exemplo.com.br\nPORTA_HTTP=80\nPORTA_HTTPS=443\n\n"
    "SENHA_BANCO=senhaDoBanco1234\nJWT_SECRET=" + "j" * 48 + "\n\n"
    "AMBIENTE=producao\nCORS_ORIGINS=https://loja.exemplo.com.br\nTIMEZONE_LOJA=America/Sao_Paulo\n\n"
    "BACKUP_REMOTO=\n\nNOTIFICAR_URL=\n"
)

# A mesma loja, já com a demonstração ligada.
SENHA_DA_DEMO = "senhaDaDemo2026abcdXYZ"
ENV_COM_A_DEMO = ENV_DA_LOJA + (
    "\n# Demonstração em /demo (ADR-46): outra API, outro banco e outra conta, só com dados fictícios.\n"
    "# Demonstração: endereço e senha com ./demo.sh --mostrar; desligar com ./demo.sh --desligar.\n"
    "COMPOSE_PROFILES=demo\nDEMO_SENHA_BANCO=senhaDoBancoDaDemo123456789012\n"
    "DEMO_JWT_SECRET=" + "d" * 48 + "\nDEMO_ADMIN_EMAIL=dono@demo.example\n"
    f"DEMO_ADMIN_SENHA={SENHA_DA_DEMO}\n"
)


def _loja(tmp_path: Path, dotenv: str) -> tuple[Path, dict[str, str]]:
    env = _maquina(tmp_path)
    curl = tmp_path / "bin" / "curl"
    curl.write_text(CURL_DE_MENTIRA)
    curl.chmod(0o755)
    loja = tmp_path / "loja"
    loja.mkdir()
    for nome in ("demo.sh", "notificar.sh", "docker-compose.yml"):
        shutil.copy(RAIZ / nome, loja / nome)
    (loja / ".env").write_text(dotenv)
    (loja / ".env").chmod(0o600)
    return loja, env


def _demo(loja: Path, env: dict[str, str], *args: str, entrada: str = "") -> subprocess.CompletedProcess:
    # Com a entrada fechada (e não o terminal de quem roda os testes): pergunta nenhuma trava.
    return subprocess.run(["bash", "./demo.sh", *args], cwd=loja, env=env, input=entrada,
                          capture_output=True, text=True, timeout=120)


def _saida(r: subprocess.CompletedProcess, loja: Path) -> str:
    return _mascarar(r.stdout + r.stderr, *[v for v in _ler_env(loja).values() if len(v) >= 12])


def _log(tmp_path: Path) -> str:
    log = tmp_path / "ctr" / "docker.log"
    return log.read_text() if log.exists() else ""


@precisa_do_bash
async def test_ligar_completa_o_env_sobe_agenda_e_mostra(tmp_path: Path) -> None:
    """A loja de antes da demonstração liga a dela: as senhas que faltam nascem no .env (600,
    o que já havia fica como estava, e o segredo do login nunca é o da loja), o proxy recarrega
    o Caddyfile do /demo, sobem só os serviços dela, a renovação diária é agendada — e no fim
    o que levar à Apple. Ligar de novo não sorteia nada."""
    loja, env = _loja(tmp_path, ENV_DA_LOJA)

    r = _demo(loja, env, "--ligar")

    assert r.returncode == 0, _saida(r, loja)
    dotenv = _ler_env(loja)
    assert dotenv["COMPOSE_PROFILES"] == "demo"
    assert dotenv["DEMO_ADMIN_EMAIL"] == "dono@demo.example"
    assert len(dotenv["DEMO_SENHA_BANCO"]) >= 20 and len(dotenv["DEMO_ADMIN_SENHA"]) >= 20
    assert dotenv["JWT_SECRET"] == "j" * 48
    assert len(dotenv["DEMO_JWT_SECRET"]) >= 32 and dotenv["DEMO_JWT_SECRET"] != dotenv["JWT_SECRET"]
    assert (loja / ".env").read_text().startswith(ENV_DA_LOJA)
    assert _modo(loja / ".env") == 0o600
    assert not list(loja.glob(".env.*"))  # nenhuma cópia com senha esquecida ao lado
    senha = dotenv["DEMO_ADMIN_SENHA"]
    log = _log(tmp_path)
    assert log.index("compose exec -T proxy caddy validate") < log.index("compose exec -T proxy caddy reload")
    assert "compose up -d demo-banco api-demo" in log
    assert "compose up -d --build" not in log  # nada da loja é recriado para a vitrine subir
    assert senha not in log
    unidades = tmp_path / "systemd"
    servico = (unidades / "loja-demo-renovar.service").read_text()
    assert f"ExecStart={loja}/demo.sh --renovar" in servico
    assert "OnFailure=loja-aviso@%N.service" in servico
    assert "OnCalendar=*-*-* 04:30:00 America/Sao_Paulo" in (unidades / "loja-demo-renovar.timer").read_text()
    assert (unidades / "loja-aviso@.service").exists()
    assert "enable --now loja-demo-renovar.timer" in (tmp_path / "ctr" / "systemctl.log").read_text()
    assert "https://loja.exemplo.com.br/demo" in r.stdout
    assert senha in r.stdout
    assert "APPLE_SERVIDOR_DEMO = https://loja.exemplo.com.br/demo" in r.stdout
    assert "APPLE_EMAIL_DEMO    = dono@demo.example" in r.stdout
    assert "ganhou senha nova" in r.stdout

    de_novo = _demo(loja, env, "--ligar")

    assert de_novo.returncode == 0, _saida(de_novo, loja)
    assert _ler_env(loja) == dotenv
    assert "ganhou senha nova" not in de_novo.stdout


@precisa_do_bash
async def test_ligar_nunca_usa_o_segredo_da_loja(tmp_path: Path) -> None:
    """Um .env mexido à mão com o segredo da demonstração igual ao da loja: o token da conta
    de demonstração (senha pública, nas notas da Apple) valeria na loja. Ligar troca o dela."""
    loja, env = _loja(tmp_path, ENV_COM_A_DEMO.replace("d" * 48, "j" * 48))

    r = _demo(loja, env, "--ligar")

    assert r.returncode == 0, _saida(r, loja)
    dotenv = _ler_env(loja)
    assert dotenv["DEMO_JWT_SECRET"] != dotenv["JWT_SECRET"] == "j" * 48
    assert dotenv["DEMO_ADMIN_SENHA"] == SENHA_DA_DEMO  # a senha da Apple não muda


@precisa_do_bash
@pytest.mark.skipif(os.geteuid() != 0, reason="só o root dá um arquivo a outro dono (no CI, o runner não é root)")
async def test_ligar_com_sudo_deixa_o_env_com_quem_instalou(tmp_path: Path) -> None:
    """O .env era trocado pelo temporário com `mv`, e o novo ficava de quem rodou o script: um
    `sudo ./demo.sh --ligar` numa loja instalada pelo usuário comum deixava o .env de root, e o
    docker compose, o ./atualizar.sh e o ./backup.sh desse usuário paravam em "permission
    denied". O dono (e o grupo) de antes ficam, e o modo continua 600."""
    loja, env = _loja(tmp_path, ENV_DA_LOJA)
    os.chown(loja / ".env", 4242, 4343)

    r = _demo(loja, env, "--ligar")

    assert r.returncode == 0, _saida(r, loja)
    assert _ler_env(loja)["COMPOSE_PROFILES"] == "demo"  # regravado, e não só lido
    dono = (loja / ".env").stat()
    assert (dono.st_uid, dono.st_gid) == (4242, 4343)
    assert _modo(loja / ".env") == 0o600


@precisa_do_bash
async def test_mostrar_diz_endereco_senha_e_o_que_levar_a_apple(tmp_path: Path) -> None:
    loja, env = _loja(tmp_path, ENV_COM_A_DEMO.replace("ENDERECO_PROXY=loja.exemplo.com.br",
                                                       "ENDERECO_PROXY=:80").replace("PORTA_HTTP=80", "PORTA_HTTP=8080"))

    r = _demo(loja, env, "--mostrar")

    assert r.returncode == 0, _saida(r, loja)
    assert "http://localhost:8080/demo" in r.stdout
    assert SENHA_DA_DEMO in r.stdout
    assert "ligada e respondendo" in r.stdout
    assert "APPLE_SERVIDOR_DEMO = http://localhost:8080/demo" in r.stdout
    # Instalação local: a Apple não alcança, e o recado diz.
    assert "A Apple só alcança um endereço https://" in r.stdout

    fora = _demo(loja, env | {"FAKE_API_DEMO": "exit 1"}, "--mostrar")
    assert "ligada, mas não respondeu agora" in fora.stdout


@precisa_do_bash
async def test_mostrar_lembra_do_play_console_antes_de_desligar_o_servidor_antigo(tmp_path: Path) -> None:
    """As fichas das lojas apontam para as páginas legais do servidor da demonstração. O Google
    Play não passa pelo publicador: quem troca a Vercel por esta demonstração e desliga a de lá
    sem trocar as URLs no Play Console deixa a ficha apontando para páginas fora do ar. Na App
    Store a URL de suporte segue sozinha, mas só quando a versão com ela estiver no ar."""
    loja, env = _loja(tmp_path, ENV_COM_A_DEMO)

    r = _demo(loja, env, "--mostrar")

    assert r.returncode == 0, _saida(r, loja)
    assert "ANTES de desligar o servidor antigo, troque no Play Console" in r.stdout
    assert "https://loja.exemplo.com.br/demo/privacidade\n" in r.stdout
    assert "https://loja.exemplo.com.br/demo/exclusao-de-dados\n" in r.stdout
    assert "a URL de suporte segue APPLE_SERVIDOR_DEMO sozinha (ou a Variable\n  APPLE_URL_SUPORTE)" in r.stdout
    assert "só vale lá quando a versão com ela estiver no ar" in r.stdout

    # Na instalação local, nenhuma loja de apps alcança o endereço: não há o que trocar.
    (loja / ".env").write_text(ENV_COM_A_DEMO.replace("ENDERECO_PROXY=loja.exemplo.com.br", "ENDERECO_PROXY=:80"))
    sem_https = _demo(loja, env, "--mostrar")
    assert sem_https.returncode == 0, _saida(sem_https, loja)
    assert "Play Console" not in sem_https.stdout


@precisa_do_bash
async def test_mostrar_sem_demonstracao_diz_como_ligar(tmp_path: Path) -> None:
    loja, env = _loja(tmp_path, ENV_DA_LOJA)

    r = _demo(loja, env)  # sem opção, é o --mostrar

    assert r.returncode == 1
    assert "./demo.sh --ligar" in r.stdout


@precisa_do_bash
async def test_desligar_guarda_tudo_e_apagar_leva_tudo(tmp_path: Path) -> None:
    """Desligar tira a demonstração do ar DE VERDADE (pelo nome: o `up` nunca derruba
    serviço de perfil desligado) e guarda banco, fotos e senha. Apagar leva os três — e
    a loja não é tocada."""
    loja, env = _loja(tmp_path, ENV_COM_A_DEMO)
    for tipo in ("service", "timer"):
        (tmp_path / "systemd" / f"loja-demo-renovar.{tipo}").write_text("")

    r = _demo(loja, env, "--desligar")

    assert r.returncode == 0, _saida(r, loja)
    assert "compose --profile demo rm -sf api-demo demo-banco" in _log(tmp_path)
    dotenv = _ler_env(loja)
    # A linha fica, vazia: o ./instalar.sh não liga de novo o que foi desligado de propósito.
    assert dotenv["COMPOSE_PROFILES"] == ""
    assert dotenv["DEMO_ADMIN_SENHA"] == SENHA_DA_DEMO
    assert "loja_demo" not in _log(tmp_path)
    assert not list((tmp_path / "systemd").glob("loja-demo-renovar.*"))
    assert "disable --now loja-demo-renovar.timer" in (tmp_path / "ctr" / "systemctl.log").read_text()

    apagada = _demo(loja, env, "--desligar", "--apagar", "--sim")

    assert apagada.returncode == 0, _saida(apagada, loja)
    log = _log(tmp_path)
    assert "DROP DATABASE IF EXISTS loja_demo WITH (FORCE)" in log
    assert "DROP ROLE IF EXISTS loja_demo" in log
    assert "volume rm loja_fotos-da-demo" in log
    texto = (loja / ".env").read_text()
    assert "DEMO_" not in texto and "# Demonstração" not in texto
    assert texto.startswith(ENV_DA_LOJA)
    assert _ler_env(loja)["COMPOSE_PROFILES"] == ""
    assert _modo(loja / ".env") == 0o600


@precisa_do_bash
async def test_apagar_pede_confirmacao(tmp_path: Path) -> None:
    """Apagar troca a senha que está na Apple: sem --sim, só com APAGAR digitado."""
    loja, env = _loja(tmp_path, ENV_COM_A_DEMO)

    r = _demo(loja, env, "--desligar", "--apagar", entrada="sim\n")

    assert r.returncode == 1
    assert "Cancelado" in r.stdout
    assert (loja / ".env").read_text() == ENV_COM_A_DEMO
    assert "rm -sf" not in _log(tmp_path) and "loja_demo" not in _log(tmp_path)


@precisa_do_bash
async def test_renovar_roda_dentro_da_demo_e_falha_alto(tmp_path: Path) -> None:
    """A renovação roda dentro do contêiner da demonstração (o comando confere sozinho que o
    banco é o dela); falhou, sai 1 — e o OnFailure do timer avisa o dono."""
    loja, env = _loja(tmp_path, ENV_COM_A_DEMO)

    r = _demo(loja, env, "--renovar")

    assert r.returncode == 0, _saida(r, loja)
    assert "compose exec -T api-demo python -m app.cli renovar-demonstracao" in _log(tmp_path)

    falhou = _demo(loja, env | {"FAKE_API_DEMO": '[ "$4" != renovar-demonstracao ]'}, "--renovar")
    assert falhou.returncode == 1
    assert "A renovação da demonstração falhou" in falhou.stderr


@precisa_do_bash
async def test_renovar_com_a_demonstracao_desligada_nao_faz_nada(tmp_path: Path) -> None:
    loja, env = _loja(tmp_path, ENV_COM_A_DEMO.replace("COMPOSE_PROFILES=demo", "COMPOSE_PROFILES="))

    r = _demo(loja, env, "--renovar")

    assert r.returncode == 0, _saida(r, loja)
    assert "desligada" in r.stdout
    assert "api-demo" not in _log(tmp_path)


@precisa_do_bash
async def test_automatico_sem_fuso_conhecido_usa_o_do_servidor(tmp_path: Path) -> None:
    """Um fuso que o systemd não conhece faz o timer inteiro não carregar — e a renovação
    nunca acontece, calada. Desconhecido, fica 04:30 no horário do servidor, com aviso."""
    loja, env = _loja(tmp_path, ENV_COM_A_DEMO.replace("America/Sao_Paulo", "Marte/Base_Alfa"))

    r = _demo(loja, env, "--automatico")

    assert r.returncode == 0, _saida(r, loja)
    timer = (tmp_path / "systemd" / "loja-demo-renovar.timer").read_text()
    assert "OnCalendar=*-*-* 04:30:00\n" in timer
    assert "o fuso do .env não é conhecido" in r.stdout

    desligado = _demo(loja, env, "--sem-automatico")
    assert desligado.returncode == 0
    assert not (tmp_path / "systemd" / "loja-demo-renovar.timer").exists()


@precisa_do_bash
async def test_a_renovacao_que_falha_chega_ao_celular_com_frase(tmp_path: Path) -> None:
    """O OnFailure= chama o notificar.sh com o nome da unidade: o celular recebe uma frase,
    não "loja-demo-renovar falhou"."""
    loja, env = _loja(tmp_path, "NOTIFICAR_URL=loja-k3x9q\n")

    r = subprocess.run(["bash", "./notificar.sh", "--unidade", "loja-demo-renovar"], cwd=loja,
                       env=env, capture_output=True, text=True, timeout=60)

    assert r.returncode == 0, r.stdout + r.stderr
    assert _avisos(tmp_path) == ["A renovação diária da demonstração falhou"]


# ------------------------------------------------------------------ o ./diagnostico.sh

# O docker do diagnóstico: a loja de pé, a demonstração ligada, o demo-banco que já terminou
# (saiu 0, como sempre), e os contêineres da máquina de $FAKE_PS (o --filter name= vale).
DOCKER_DO_DIAGNOSTICO = r"""#!/usr/bin/env bash
echo "docker $*" >> "$FAKE_CTR/docker.log"
ultimo="${*: -1}"
case "$1" in
    info) exit 0 ;;
    ps)
        filtro=""
        while [ $# -gt 0 ]; do case "$1" in --filter) filtro="${2#name=}"; shift 2 ;; *) shift ;; esac; done
        for nome in ${FAKE_PS:-}; do case "$nome" in *"$filtro"*) echo "$nome" ;; esac; done
        exit 0 ;;
    inspect)
        servico="${ultimo#id-}"
        case "$*" in
            *ExitCode*)
                if [ "$servico" = demo-banco ]; then echo "/loja-demo-banco-1|exited|0|false|0|demo-banco"
                else echo "/loja-$servico-1|running|0|false|0|$servico"; fi ;;
            *Created*) echo "2020-01-01T00:00:00Z" ;;
            *LogPath*) echo "/nao/existe/$servico.log" ;;
            *) echo "/loja-$servico-1" ;;
        esac
        exit 0 ;;
    compose) shift ;;
    *) exit 0 ;;
esac
case "$1" in
    ps)
        case "${2:-}" in
            -aq) printf 'id-%s\n' db api proxy demo-banco api-demo ;;
            -q)  printf 'id-%s\n' db api proxy api-demo ;;
            *)   echo "NAME   STATUS" ;;
        esac ;;
    exec)
        shift; [ "$1" = -T ] && shift
        case "$1" in
            api) exec bash -c "${FAKE_API:-exit 0}" ;;
            api-demo) exec bash -c "${FAKE_API_DEMO:-exit 0}" ;;
            db) echo "/var/run/postgresql:5432 - accepting connections" ;;
        esac ;;
    logs) echo "(log)" ;;
esac
exit 0
"""


def _diagnosticar(tmp_path: Path, dotenv: str, proxy_fora: bool = False,
                  **extra: str) -> subprocess.CompletedProcess:
    env = _maquina(tmp_path, **extra)
    if proxy_fora:
        (tmp_path / "ctr" / "proxy-fora").touch()
    for nome, corpo in (("docker", DOCKER_DO_DIAGNOSTICO), ("curl", CURL_DE_MENTIRA)):
        (tmp_path / "bin" / nome).write_text(corpo)
        (tmp_path / "bin" / nome).chmod(0o755)
    loja = tmp_path / "loja"
    loja.mkdir()
    for nome in ("diagnostico.sh", "docker-compose.yml"):
        shutil.copy(RAIZ / nome, loja / nome)
    (loja / ".env").write_text(dotenv)
    return subprocess.run(["bash", "./diagnostico.sh"], cwd=loja, env=env, input="",
                          capture_output=True, text=True, timeout=120)


@precisa_do_bash
async def test_diagnostico_ve_a_demonstracao_e_o_demo_banco_que_terminou_nao_e_queda(
    tmp_path: Path,
) -> None:
    """O demo-banco prepara o banco da demonstração e sai: "exited (0)" é o normal, não um
    contêiner caído. E a demonstração aparece: viva por dentro e pelo endereço."""
    r = _diagnosticar(tmp_path, "PORTA_HTTP=80\nCOMPOSE_PROFILES=demo\n")

    assert "loja-demo-banco-1: terminou bem" in r.stdout, r.stdout + r.stderr
    assert "/loja-demo-banco-1 está 'exited'" not in r.stdout
    assert "a demonstração está viva dentro do contêiner" in r.stdout
    assert "http://localhost:80/demo/health → 200 (a demonstração abre)" in r.stdout
    assert "O sistema está NO AR" in r.stdout


@precisa_do_bash
async def test_diagnostico_aponta_o_orfao_de_qualquer_servico(tmp_path: Path) -> None:
    """O órfão do proxy (porta fechada, a loja inteira fora) ou o da demonstração travam o
    `up` como o da api: o primeiro passo é removê-los — e contêiner de outro projeto, nunca."""
    r = _diagnosticar(tmp_path, "PORTA_HTTP=80\n", proxy_fora=True, FAKE_PS=(
        "0a1b2c3d4e5f_loja-proxy-1 9a8b7c6d5e4f_loja-api-demo-1 loja-db-1 minha_loja-web-1"))

    assert "docker rm -f 0a1b2c3d4e5f_loja-proxy-1 9a8b7c6d5e4f_loja-api-demo-1" in r.stdout, r.stdout
    assert "minha_loja-web-1" not in r.stdout.split("O que fazer agora")[1]
    # Demonstração desligada: só o recado de como ligar.
    assert "desligada — para ligar: ./demo.sh --ligar" in r.stdout
