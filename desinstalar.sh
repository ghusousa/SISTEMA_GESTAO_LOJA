#!/usr/bin/env bash
#
# Desinstalador do Sistema de Gestão da Loja.
#
# Por padrão faz um backup do banco antes de apagar qualquer coisa. Apagar os dados leva
# junto o histórico de vendas, o estoque e as despesas — e não tem desfazer.
#
#   ./desinstalar.sh                  pergunta tudo, com backup
#   ./desinstalar.sh --manter-dados   só desliga; volumes e backup ficam
#   ./desinstalar.sh --sim            sem perguntar (para automação)
#
set -euo pipefail

cd "$(dirname "$0")"

VERMELHO=$'\033[31m'; VERDE=$'\033[32m'; AMARELO=$'\033[33m'
AZUL=$'\033[36m'; FORTE=$'\033[1m'; NORMAL=$'\033[0m'
if [ ! -t 1 ]; then VERMELHO=""; VERDE=""; AMARELO=""; AZUL=""; FORTE=""; NORMAL=""; fi

titulo() { printf '\n%s%s%s\n' "$FORTE$AZUL" "$1" "$NORMAL"; }
certo()  { printf '  %s✓%s %s\n' "$VERDE" "$NORMAL" "$1"; }
alerta() { printf '  %s!%s %s\n' "$AMARELO" "$NORMAL" "$1"; }
morrer() { printf '\n%s✗ %s%s\n\n' "$VERMELHO" "$1" "$NORMAL" >&2; exit 1; }

INTERATIVO=1; MANTER_DADOS=0; FAZER_BACKUP=1; APAGAR_IMAGENS=0

while [ $# -gt 0 ]; do
    case "$1" in
        --sim|-y)       INTERATIVO=0; shift ;;
        --manter-dados) MANTER_DADOS=1; shift ;;
        --sem-backup)   FAZER_BACKUP=0; shift ;;
        --apagar-imagens) APAGAR_IMAGENS=1; shift ;;
        -h|--help)      sed -n '3,11p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *)              morrer "opção desconhecida: $1" ;;
    esac
done

command -v docker >/dev/null 2>&1 || morrer "Docker não encontrado — nada a desinstalar por aqui."

# Mesmo motivo do instalador: numa máquina onde o Docker foi instalado há pouco, o usuário
# ainda não faz parte do grupo `docker` até sair e entrar na sessão. Sem isto, o
# desinstalador levaria "permission denied" e diria que não há nada para remover.
PREFIXO_DOCKER=""
if ! docker info >/dev/null 2>&1; then
    if [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1 && sudo docker info >/dev/null 2>&1; then
        PREFIXO_DOCKER="sudo"
    else
        morrer "O Docker não responde. Ligue-o (sudo systemctl start docker) e tente de novo."
    fi
fi
dk() {
    if [ -n "$PREFIXO_DOCKER" ]; then sudo docker "$@"; else docker "$@"; fi
}

titulo "Desinstalar o Sistema de Gestão da Loja"

if [ "$MANTER_DADOS" -eq 1 ]; then
    echo "  Modo: desligar e apagar os containers. Os DADOS ficam guardados."
    echo "  Para voltar depois, rode ./instalar.sh — o banco estará como estava."
else
    printf '  %sModo: apagar TUDO, inclusive o banco.%s\n' "$VERMELHO$FORTE" "$NORMAL"
    echo "  Vai embora: histórico de vendas, estoque, despesas, usuários e fotos."
fi

# ------------------------------------------------------------------ backup

if [ "$MANTER_DADOS" -eq 0 ] && [ "$FAZER_BACKUP" -eq 1 ]; then
    titulo "Backup antes de apagar"
    if dk compose ps --status running --format '{{.Service}}' 2>/dev/null | grep -qx db; then
        ARQUIVO_BACKUP="loja-backup-$(date +%Y-%m-%d-%H%M).dump"
        # O dump é escrito DENTRO do container e depois copiado, em vez de vir pelo cano da
        # saída padrão. É um formato binário: qualquer shell no meio do caminho (o cmd do
        # Windows, sobretudo) pode traduzir fim de linha e corromper o arquivo — e um backup
        # corrompido só se descobre no dia em que ele é necessário.
        # `chmod 600`: é o banco inteiro (CPF, telefones, hashes de senha), e o `docker cp`
        # traz a permissão de dentro do contêiner, legível por qualquer usuário da máquina.
        if dk compose exec -T db pg_dump -U loja -Fc -f /tmp/backup.dump loja 2>/dev/null \
           && dk compose cp db:/tmp/backup.dump "$ARQUIVO_BACKUP" >/dev/null 2>&1 \
           && chmod 600 "$ARQUIVO_BACKUP"; then
            dk compose exec -T db rm -f /tmp/backup.dump >/dev/null 2>&1 || true
            certo "salvo em $(pwd)/$ARQUIVO_BACKUP ($(du -h "$ARQUIVO_BACKUP" | cut -f1))"
            echo
            echo "  Para restaurar num sistema novo, depois de instalar:"
            echo "    docker compose exec -T db pg_restore -U loja -d loja --clean < $ARQUIVO_BACKUP"
        else
            rm -f "$ARQUIVO_BACKUP"
            alerta "não foi possível gerar o backup (o banco respondeu?)."
            [ "$INTERATIVO" -eq 1 ] && {
                read -r -p "  Continuar mesmo assim e apagar os dados? [s/N]: " r || true
                case "${r:-n}" in [Ss]*) ;; *) morrer "cancelado." ;; esac
            }
        fi
    else
        alerta "o banco não está no ar; não há o que salvar por aqui."
        alerta "se os dados ainda existem, suba com ./instalar.sh e rode este script de novo."
    fi
fi

# ------------------------------------------------------------------ confirmação

if [ "$INTERATIVO" -eq 1 ]; then
    titulo "Confirmação"
    if [ "$MANTER_DADOS" -eq 1 ]; then
        read -r -p "  Desligar e apagar os containers? [s/N]: " r || true
        case "${r:-n}" in [Ss]*) ;; *) morrer "cancelado." ;; esac
    else
        echo "  Isto apaga o banco de dados por completo."
        read -r -p "  Digite ${FORTE}APAGAR${NORMAL} para confirmar: " r || true
        [ "$r" = "APAGAR" ] || morrer "cancelado (nada foi apagado)."
    fi
fi

# ------------------------------------------------------------------ remoção

como_root() { if [ "$(id -u)" -eq 0 ]; then "$@"; else sudo "$@"; fi; }

# As rotinas da máquina param junto. Com a loja desligada, cada uma falharia na hora marcada,
# o vigia mandaria "loja fora do ar" ao celular de quem acabou de desligá-la, e a atualização
# sozinha faria `up -d` e ligaria de novo a loja que se quis desligar.
#
# Com --manter-dados ("só desligar"), quais estavam ligadas fica anotado em
# docker/estado/rotinas, e o ./instalar.sh religa AS MESMAS: o backup do Drive continua
# "ligado" na tela e no banco, e sem o timer dele a loja voltaria do desligamento sem cópia
# de fora nenhuma — calada, porque nada falha quando um timer simplesmente não existe.
desligar_rotinas() {
    local dir="${DIR_SYSTEMD:-/etc/systemd/system}" u desligou=0 minutos
    local plist="${HOME:-/root}/Library/LaunchAgents/br.loja.backup.plist"
    if [ -f "$plist" ]; then
        launchctl unload -w "$plist" >/dev/null 2>&1 || true
        rm -f "$plist"
        certo "cópia diária desligada (launchd)"
    fi
    command -v systemctl >/dev/null 2>&1 || return 0
    if [ "$MANTER_DADOS" -eq 1 ]; then
        mkdir -p docker/estado
        : > docker/estado/rotinas
        for u in loja-backup-nuvem loja-atualizar; do
            [ -f "$dir/$u.timer" ] || continue
            if [ "$u" = "loja-atualizar" ]; then
                minutos="$(sed -n 's/^OnUnitActiveSec=\([0-9][0-9]*\)min$/\1/p' "$dir/$u.timer" | head -1)"
                printf '%s %s\n' "$u" "${minutos:-10}" >> docker/estado/rotinas
            else
                printf '%s\n' "$u" >> docker/estado/rotinas
            fi
        done
    fi
    for u in loja-vigia loja-backup loja-backup-nuvem loja-atualizar; do
        [ -f "$dir/$u.timer" ] || continue
        como_root systemctl disable --now "$u.timer" >/dev/null 2>&1 || true
        como_root rm -f "$dir/$u.timer" "$dir/$u.service"
        desligou=1
        certo "$u desligado"
    done
    if [ "$desligou" -eq 1 ]; then como_root systemctl daemon-reload >/dev/null 2>&1 || true; fi
}

titulo "Removendo"
desligar_rotinas
if [ "$MANTER_DADOS" -eq 1 ]; then
    dk compose down
    certo "containers removidos; volumes preservados"
else
    dk compose down -v
    certo "containers e dados removidos"
    rm -f .env && certo ".env removido"
fi

if [ "$APAGAR_IMAGENS" -eq 1 ]; then
    dk image rm -f loja-api:local >/dev/null 2>&1 || true
    certo "imagem loja-api:local removida"
    alerta "as imagens base (postgres, caddy, python) continuam no cache do Docker."
    alerta "para limpar tudo que não está em uso: docker system prune -a"
fi

titulo "Pronto"
if [ "$MANTER_DADOS" -eq 1 ]; then
    echo "  Os dados continuam guardados nos volumes do Docker."
    echo "  Rode ./instalar.sh para voltar do jeito que estava."
else
    echo "  O sistema saiu desta máquina. Se fez backup, o arquivo .dump está nesta pasta."
    echo "  Para remover também o Docker: sudo apt purge docker-ce docker-ce-cli containerd.io"
fi
echo
