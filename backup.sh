#!/usr/bin/env bash
#
# Cópia de segurança do banco da loja.
#
#     ./backup.sh                    faz uma cópia agora
#     ./backup.sh --automatico       passa a copiar todo dia, sozinho
#     ./backup.sh --listar           mostra as cópias que existem
#     ./backup.sh --restaurar ARQ    volta o banco para o estado daquela cópia
#
# Perder o banco é perder o histórico de vendas E o estoque inteiro — não existe como
# recontar seis meses de venda. E o backup que o `./atualizar.sh` faz não serve para isso:
# ele só acontece quando há versão nova, e fica na mesma máquina que pode queimar.
#
# **A cópia de fora do servidor é a que importa.** Backup que só existe no mesmo disco não
# é backup: é uma segunda chance contra engano humano, e nenhuma contra o disco morrer.
# Configure `BACKUP_REMOTO` no .env (ex.: `BACKUP_REMOTO=gdrive:loja-backups`) e instale o
# rclone; sem isso este script avisa toda vez, de propósito.
#
# Opções:
#   --automatico [HH:MM]  liga a cópia diária (padrão 03:15, loja fechada)
#   --sem-automatico      desliga
#   --listar              lista as cópias, da mais nova para a mais velha
#   --restaurar ARQUIVO   restaura (pede confirmação e guarda uma cópia de antes)
#   --sim                 não pergunta nada (para o agendamento)

set -euo pipefail
cd "$(dirname "$0")"

VERDE=$'\033[32m'; AMARELO=$'\033[33m'; VERMELHO=$'\033[31m'; AZUL=$'\033[36m'
FORTE=$'\033[1m'; NORMAL=$'\033[0m'
[ -t 1 ] || { VERDE=""; AMARELO=""; VERMELHO=""; AZUL=""; FORTE=""; NORMAL=""; }

titulo() { printf '\n%s%s%s\n' "$FORTE$AZUL" "$1" "$NORMAL"; }
ok()     { printf '  %s✓%s %s\n' "$VERDE" "$NORMAL" "$1"; }
aviso()  { printf '  %s!%s %s\n' "$AMARELO" "$NORMAL" "$1"; }
erro()   { printf '\n%s✗ %s%s\n' "$VERMELHO" "$1" "$NORMAL" >&2; }

DESTINO=backups
#: Duas semanas cobrem o "só percebi na segunda que estragou na quarta passada" sem que o
#: disco de um servidor pequeno vire um cemitério de dumps.
DIAS_PARA_GUARDAR=14
HORA_PADRAO="03:15"

ACAO="copiar"
ARQUIVO_ALVO=""
HORA="$HORA_PADRAO"
INTERATIVO=1

while [ $# -gt 0 ]; do
    case "$1" in
        --automatico)
            ACAO="ligar"
            case "${2:-}" in [0-9]*:[0-9]*) HORA="$2"; shift ;; esac
            ;;
        --sem-automatico) ACAO="desligar" ;;
        --listar)         ACAO="listar" ;;
        --restaurar)      ACAO="restaurar"; ARQUIVO_ALVO="${2:-}"; shift ;;
        --sim)            INTERATIVO=0 ;;
        -h|--help)        sed -n '2,28p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *)                erro "Opção desconhecida: $1"; exit 1 ;;
    esac
    shift
done

# ------------------------------------------------------------------ ferramentas

PREFIXO_DOCKER=""
dk() { if [ -n "$PREFIXO_DOCKER" ]; then sudo docker "$@"; else docker "$@"; fi; }

sudo_se_preciso() { if [ "$(id -u)" -eq 0 ]; then "$@"; else sudo "$@"; fi; }

[ -f docker-compose.yml ] || { erro "Rode este script de dentro da pasta do sistema."; exit 1; }

if docker info >/dev/null 2>&1; then
    PREFIXO_DOCKER=""
elif command -v sudo >/dev/null 2>&1 && sudo -n docker info >/dev/null 2>&1; then
    PREFIXO_DOCKER="sudo"
else
    erro "Não consegui falar com o Docker. Ele está rodando?"
    exit 1
fi

REMOTO="$(grep -E '^BACKUP_REMOTO=' .env 2>/dev/null | cut -d= -f2- | tr -d '"' || true)"

# ------------------------------------------------------------------ listar

listar() {
    titulo "Cópias que existem"
    if [ ! -d "$DESTINO" ] || [ -z "$(ls -A "$DESTINO" 2>/dev/null)" ]; then
        aviso "Nenhuma ainda. Rode ./backup.sh para fazer a primeira."
        printf '\n'
        return
    fi
    ls -1t "$DESTINO"/loja-*.dump 2>/dev/null | while read -r arq; do
        printf '  %s  %s  %s\n' \
            "$(date -r "$arq" '+%d/%m/%Y %H:%M')" \
            "$(du -h "$arq" | cut -f1 | xargs printf '%6s')" \
            "$arq"
    done
    printf '\n  Para voltar o banco para uma delas: %s./backup.sh --restaurar ARQUIVO%s\n\n' \
        "$FORTE" "$NORMAL"
}

# ------------------------------------------------------------------ copiar

copiar() {
    titulo "Copiando o banco"
    mkdir -p "$DESTINO"

    local arquivo="$DESTINO/loja-$(date +%Y%m%d-%H%M%S).dump"

    # `-Fc` (formato próprio do Postgres, comprimido): restaura com pg_restore, permite
    # restaurar tabela por tabela e não depende da versão do cliente na máquina.
    if ! dk compose exec -T db pg_dump -U loja -d loja -Fc -f /tmp/backup.dump 2>/dev/null; then
        erro "O pg_dump falhou. O banco está no ar? (docker compose ps)"
        exit 1
    fi
    dk compose cp db:/tmp/backup.dump "$arquivo" >/dev/null 2>&1
    dk compose exec -T db rm -f /tmp/backup.dump >/dev/null 2>&1 || true

    # Dump que não abre não é backup — e só se descobre isso na hora de restaurar, que é a
    # pior hora possível. Conferir agora custa um segundo.
    if ! command -v pg_restore >/dev/null 2>&1; then
        dk compose cp "$arquivo" db:/tmp/conferir.dump >/dev/null 2>&1
        if ! dk compose exec -T db pg_restore -l /tmp/conferir.dump >/dev/null 2>&1; then
            rm -f "$arquivo"
            erro "A cópia saiu ilegível e foi descartada. Não confie no backup até resolver."
            exit 1
        fi
        dk compose exec -T db rm -f /tmp/conferir.dump >/dev/null 2>&1 || true
    elif ! pg_restore -l "$arquivo" >/dev/null 2>&1; then
        rm -f "$arquivo"
        erro "A cópia saiu ilegível e foi descartada. Não confie no backup até resolver."
        exit 1
    fi

    ok "$arquivo ($(du -h "$arquivo" | cut -f1)) — e ela abre"

    # ------------------------------------------------------ fora do servidor
    if [ -n "$REMOTO" ]; then
        if command -v rclone >/dev/null 2>&1; then
            if rclone copy "$arquivo" "$REMOTO" 2>/dev/null; then
                ok "cópia enviada para $REMOTO"
            else
                erro "NÃO consegui enviar para $REMOTO. A cópia só existe neste servidor."
                printf '  Teste com: %srclone lsd %s%s\n' "$FORTE" "${REMOTO%%:*}:" "$NORMAL"
            fi
        else
            aviso "BACKUP_REMOTO está no .env mas o rclone não está instalado."
            printf '    Instale com: %scurl https://rclone.org/install.sh | sudo bash%s\n' \
                "$FORTE" "$NORMAL"
        fi
    else
        aviso "A cópia só existe NESTE servidor."
        printf '    Se o disco morrer, ela morre junto. Para mandar para fora, ponha no .env:\n'
        printf '      %sBACKUP_REMOTO=gdrive:loja-backups%s   (e configure o rclone)\n' \
            "$FORTE" "$NORMAL"
    fi

    # ------------------------------------------------------ faxina
    local velhos
    velhos="$(find "$DESTINO" -name 'loja-*.dump' -mtime "+$DIAS_PARA_GUARDAR" 2>/dev/null || true)"
    if [ -n "$velhos" ]; then
        printf '%s\n' "$velhos" | xargs -r rm -f
        ok "cópias com mais de $DIAS_PARA_GUARDAR dias apagadas"
    fi
    printf '\n'
}

# ------------------------------------------------------------------ restaurar

restaurar() {
    titulo "Restaurar o banco"

    [ -n "$ARQUIVO_ALVO" ] || { erro "Diga qual cópia: ./backup.sh --restaurar ARQUIVO"; exit 1; }
    [ -f "$ARQUIVO_ALVO" ] || { erro "Não achei o arquivo: $ARQUIVO_ALVO"; exit 1; }

    printf '  Cópia: %s (%s, de %s)\n' \
        "$ARQUIVO_ALVO" "$(du -h "$ARQUIVO_ALVO" | cut -f1)" \
        "$(date -r "$ARQUIVO_ALVO" '+%d/%m/%Y %H:%M')"
    printf '\n  %sIsto APAGA o banco de agora%s e põe no lugar o daquele momento.\n' \
        "$VERMELHO$FORTE" "$NORMAL"
    printf '  Tudo que foi vendido depois daquela hora se perde.\n'

    if [ "$INTERATIVO" -eq 1 ]; then
        printf '\n  Para confirmar, escreva %sRESTAURAR%s: ' "$FORTE" "$NORMAL"
        read -r resposta </dev/tty || resposta=""
        [ "$resposta" = "RESTAURAR" ] || { printf '  Cancelado.\n\n'; exit 0; }
    fi

    # Uma cópia do estado ATUAL antes de sobrescrever. Restaurar o arquivo errado é o erro
    # mais fácil de cometer aqui, e sem isto ele não teria volta.
    titulo "Guardando o banco de agora, antes de trocar"
    mkdir -p "$DESTINO"
    local antes="$DESTINO/loja-antes-de-restaurar-$(date +%Y%m%d-%H%M%S).dump"
    if dk compose exec -T db pg_dump -U loja -d loja -Fc -f /tmp/antes.dump 2>/dev/null \
        && dk compose cp db:/tmp/antes.dump "$antes" >/dev/null 2>&1; then
        ok "$antes"
    else
        aviso "não consegui guardar o estado atual (o banco está no ar?)"
        if [ "$INTERATIVO" -eq 1 ]; then
            printf '  Continuar mesmo assim, SEM volta? [s/N] '
            read -r r </dev/tty || r="n"
            case "${r:-n}" in [Ss]*) ;; *) printf '  Cancelado.\n\n'; exit 1 ;; esac
        fi
    fi

    # A API fica fora enquanto o banco troca de baixo dela: uma venda gravada no meio da
    # restauração vira registro órfão, e o pg_restore não consegue derrubar tabela em uso.
    titulo "Desligando a API durante a troca"
    dk compose stop api >/dev/null 2>&1 || true
    ok "API parada"

    titulo "Restaurando"
    dk compose cp "$ARQUIVO_ALVO" db:/tmp/restaurar.dump >/dev/null 2>&1
    # `--clean --if-exists`: derruba o que existe antes de recriar. Sem isso o restore
    # empilharia dados por cima dos atuais e o estoque sairia dobrado.
    if dk compose exec -T db pg_restore -U loja -d loja --clean --if-exists --no-owner \
        /tmp/restaurar.dump 2>&1 | grep -vi "^pg_restore: warning" | tail -20; then
        :
    fi
    dk compose exec -T db rm -f /tmp/restaurar.dump >/dev/null 2>&1 || true

    titulo "Religando"
    dk compose start api >/dev/null 2>&1 || dk compose up -d api >/dev/null 2>&1

    printf '  aguardando a loja voltar…\n'
    local i
    for i in $(seq 1 30); do
        if dk compose exec -T api python -c \
            'import urllib.request; urllib.request.urlopen("http://127.0.0.1:8000/health", timeout=3)' \
            >/dev/null 2>&1; then
            ok "a loja voltou, com os dados de $(date -r "$ARQUIVO_ALVO" '+%d/%m/%Y %H:%M')"
            printf '\n  O banco de antes ficou em: %s\n' "${antes:-—}"
            printf '  %sNo balcão:%s Ctrl+F5. %sNo celular:%s feche e abra o app.\n\n' \
                "$FORTE" "$NORMAL" "$FORTE" "$NORMAL"
            return 0
        fi
        sleep 2
    done
    erro "A API não voltou. Veja: docker compose logs --tail 50 api"
    exit 1
}

# ------------------------------------------------------------------ agendar

SERVICO=/etc/systemd/system/loja-backup.service
TIMER=/etc/systemd/system/loja-backup.timer
PASTA="$(pwd)"

ligar_automatico() {
    titulo "Ligando a cópia diária"

    command -v systemctl >/dev/null 2>&1 || { erro "Este servidor não usa systemd."; exit 1; }
    if ! sudo_se_preciso systemctl daemon-reload >/dev/null 2>&1; then
        erro "O systemd não responde neste servidor; não dá para agendar por aqui."
        printf '  Alternativa, no cron do root (%scrontab -e%s):\n\n' "$FORTE" "$NORMAL"
        printf '    %s %s * * * cd %s && ./backup.sh --sim >> /var/log/loja-backup.log 2>&1\n\n' \
            "${HORA#*:}" "${HORA%%:*}" "$PASTA"
        exit 1
    fi

    sudo_se_preciso tee "$SERVICO" >/dev/null <<UNIDADE
[Unit]
Description=Copia de seguranca do banco da loja
After=docker.service

[Service]
Type=oneshot
WorkingDirectory=$PASTA
ExecStart=$PASTA/backup.sh --sim
TimeoutStartSec=1800
UNIDADE

    sudo_se_preciso tee "$TIMER" >/dev/null <<UNIDADE
[Unit]
Description=Copia o banco da loja todo dia as $HORA

[Timer]
OnCalendar=*-*-* $HORA:00
# Servidor desligado na hora marcada: copia assim que voltar, em vez de pular o dia.
Persistent=true

[Install]
WantedBy=timers.target
UNIDADE

    if ! sudo_se_preciso systemctl daemon-reload \
        || ! sudo_se_preciso systemctl enable --now loja-backup.timer >/dev/null 2>&1; then
        erro "Não consegui ligar o agendamento."
        sudo_se_preciso rm -f "$TIMER" "$SERVICO"
        exit 1
    fi
    ok "todo dia às $HORA, sem comando nenhum"
    [ -z "$REMOTO" ] && aviso "sem BACKUP_REMOTO no .env, a cópia continua só neste servidor"
    printf '\n  Ver o que aconteceu: %sjournalctl -u loja-backup -n 30%s\n' "$FORTE" "$NORMAL"
    printf '  Desligar: %s./backup.sh --sem-automatico%s\n\n' "$FORTE" "$NORMAL"
}

desligar_automatico() {
    titulo "Desligando a cópia diária"
    sudo_se_preciso systemctl disable --now loja-backup.timer >/dev/null 2>&1 || true
    sudo_se_preciso rm -f "$TIMER" "$SERVICO"
    sudo_se_preciso systemctl daemon-reload >/dev/null 2>&1 || true
    ok "desligada. O banco só é copiado quando você rodar ./backup.sh"
    printf '\n'
}

# ------------------------------------------------------------------ ação

case "$ACAO" in
    copiar)    copiar ;;
    listar)    listar ;;
    restaurar) restaurar ;;
    ligar)     ligar_automatico ;;
    desligar)  desligar_automatico ;;
esac
