#!/usr/bin/env bash
#
# Vigia da loja: confere se ela está de pé e avisa o dono quando não está.
#
#     ./vigia.sh                   confere agora e avisa o que estiver errado
#     ./vigia.sh --automatico      passa a conferir de 5 em 5 minutos (timer do systemd)
#     ./vigia.sh --sem-automatico  desliga
#
# Confere as três coisas que já pararam loja sem ninguém saber:
#
#   1. a API responde ao /health — de dentro do contêiner, como o atualizar.sh confere;
#   2. o disco tem folga — acima de 90%, o Postgres está perto de parar de gravar, e a loja
#      "para e não volta" sem nada de errado no log da aplicação;
#   3. o backup da nuvem não está atrasado — ligado na tela e a última cópia com mais de
#      2× o intervalo configurado (lido do banco, como o backup.sh lê).
#
# Cada problema vira um aviso pelo ./notificar.sh (no celular, com NOTIFICAR_URL no .env), e
# quando ele some, um aviso de que voltou — para ninguém ficar na dúvida se ainda está fora.
# Sai 1 se achou problema, 0 se está tudo bem.

set -euo pipefail
cd "$(dirname "$0")"

VERDE=$'\033[32m'; AMARELO=$'\033[33m'; VERMELHO=$'\033[31m'; AZUL=$'\033[36m'
FORTE=$'\033[1m'; NORMAL=$'\033[0m'
[ -t 1 ] || { VERDE=""; AMARELO=""; VERMELHO=""; AZUL=""; FORTE=""; NORMAL=""; }

titulo() { printf '\n%s%s%s\n' "$FORTE$AZUL" "$1" "$NORMAL"; }
ok()     { printf '  %s✓%s %s\n' "$VERDE" "$NORMAL" "$1"; }
mal()    { printf '  %s✗%s %s\n' "$VERMELHO" "$NORMAL" "$1"; }
erro()   { printf '\n%s✗ %s%s\n' "$VERMELHO" "$1" "$NORMAL" >&2; }

ACAO="conferir"
case "${1:-}" in
    --automatico)     ACAO="ligar" ;;
    --sem-automatico) ACAO="desligar" ;;
    -h|--help)        sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    '') ;;
    *)                erro "Opção desconhecida: $1"; exit 1 ;;
esac

[ -f docker-compose.yml ] || { erro "Rode este script de dentro da pasta do sistema."; exit 1; }

#: Acima disto, o disco é problema. O Postgres para de gravar em 100%, e entre 90% e 100% um
#: dia de log ou um dump a mais basta.
LIMITE_DISCO=90
#: Quantas conferidas seguidas com a API fora antes de avisar. Uma atualização deixa a loja
#: fora por um a quatro minutos; com 2 conferidas (5 minutos entre elas), uma atualização
#: normal não vira alarme, e uma queda de verdade avisa em até 10 minutos.
SEGUIDAS_PARA_AVISAR=2

DIR_SYSTEMD="${DIR_SYSTEMD:-/etc/systemd/system}"
PASTA="$(pwd)"
SERVICO="$DIR_SYSTEMD/loja-vigia.service"
TIMER="$DIR_SYSTEMD/loja-vigia.timer"

sudo_se_preciso() { if [ "$(id -u)" -eq 0 ]; then "$@"; else sudo "$@"; fi; }

# ------------------------------------------------------------------ ligar e desligar

if [ "$ACAO" = "ligar" ]; then
    titulo "Ligando o vigia da loja"
    command -v systemctl >/dev/null 2>&1 || { erro "Este servidor não usa systemd."; exit 1; }
    if ! sudo_se_preciso systemctl daemon-reload >/dev/null 2>&1; then
        erro "O systemd não responde neste servidor; não dá para agendar por aqui."
        printf '  Alternativa, no cron do root (%scrontab -e%s):\n\n' "$FORTE" "$NORMAL"
        printf '    */5 * * * * cd %s && ./vigia.sh >> /var/log/loja-vigia.log 2>&1\n\n' "$PASTA"
        exit 1
    fi
    umask 022
    # Sem OnFailure=: quem avisa é o próprio vigia. Sair 1 ao achar problema só deixa a
    # unidade marcada como falha, que é o que `systemctl --failed` deve mostrar.
    sudo_se_preciso tee "$SERVICO" >/dev/null <<UNIDADE
[Unit]
Description=Vigia da loja: /health, disco e backup
After=docker.service

[Service]
Type=oneshot
WorkingDirectory=$PASTA
Environment=HOME=/root
ExecStart=$PASTA/vigia.sh
TimeoutStartSec=240
UNIDADE
    sudo_se_preciso tee "$TIMER" >/dev/null <<UNIDADE
[Unit]
Description=Confere a loja de 5 em 5 minutos

[Timer]
OnBootSec=5min
OnUnitActiveSec=5min

[Install]
WantedBy=timers.target
UNIDADE
    if ! sudo_se_preciso systemctl daemon-reload \
        || ! sudo_se_preciso systemctl enable --now loja-vigia.timer >/dev/null 2>&1; then
        erro "Não consegui ligar o vigia."
        sudo_se_preciso rm -f "$TIMER" "$SERVICO"
        exit 1
    fi
    ok "de 5 em 5 minutos: /health, disco e backup da nuvem"
    if grep -qE '^NOTIFICAR_URL=.' .env 2>/dev/null; then
        ok "os avisos vão para o celular (NOTIFICAR_URL do .env)"
    else
        printf '  %s!%s sem NOTIFICAR_URL no .env, os avisos ficam só em: journalctl -t loja-aviso\n' \
            "$AMARELO" "$NORMAL"
    fi
    printf '  Desligar: %s./vigia.sh --sem-automatico%s\n\n' "$FORTE" "$NORMAL"
    exit 0
fi

if [ "$ACAO" = "desligar" ]; then
    titulo "Desligando o vigia da loja"
    sudo_se_preciso systemctl disable --now loja-vigia.timer >/dev/null 2>&1 || true
    sudo_se_preciso rm -f "$TIMER" "$SERVICO"
    sudo_se_preciso systemctl daemon-reload >/dev/null 2>&1 || true
    ok "desligado. Ninguém mais confere a loja sozinho."
    printf '\n'
    exit 0
fi

# ------------------------------------------------------------------ conferir

PREFIXO_DOCKER=""
dk() { if [ -n "$PREFIXO_DOCKER" ]; then sudo docker "$@"; else docker "$@"; fi; }

# O estado de cada conferida (quantas vezes seguidas falhou), para saber quando o problema
# COMEÇOU e quando ACABOU: avisar "voltou" só faz sentido para quem foi avisado da queda.
ESTADO="${DIR_VIGIA:-docker/estado/vigia}"
mkdir -p "$ESTADO" 2>/dev/null || true

PROBLEMAS=0

falhas_seguidas() { head -1 "$ESTADO/$1" 2>/dev/null | grep -E '^[0-9]+$' || echo 0; }

# resultado <conferida> <ok|falha> <título do aviso> <mensagem> [seguidas para avisar]
resultado() {
    local nome="$1" situacao="$2" aviso="$3" mensagem="$4" limiar="${5:-1}" antes agora
    antes="$(falhas_seguidas "$nome")"
    if [ "$situacao" = "ok" ]; then
        printf '0\n' > "$ESTADO/$nome" 2>/dev/null || true
        if [ "$antes" -ge "$limiar" ]; then
            # Voltou depois de um aviso de queda: avisa, e libera o assunto da queda para a
            # próxima ser avisada na hora, sem esperar o limite de repetição.
            rm -f "${DIR_AVISOS:-docker/estado/avisos}/vigia-$nome" 2>/dev/null || true
            ./notificar.sh --sempre --assunto "vigia-$nome-voltou" "$aviso" "$mensagem" || true
        fi
        return 0
    fi
    PROBLEMAS=$((PROBLEMAS + 1))
    agora=$((antes + 1))
    printf '%s\n' "$agora" > "$ESTADO/$nome" 2>/dev/null || true
    mal "$mensagem"
    # Enquanto o problema durar, um lembrete a cada 6 h; o primeiro sai na hora.
    if [ "$agora" -ge "$limiar" ]; then
        ./notificar.sh --assunto "vigia-$nome" --prioridade alta --a-cada 360 "$aviso" "$mensagem" \
            || true
    fi
}

titulo "Conferindo a loja"

if docker info >/dev/null 2>&1; then
    PREFIXO_DOCKER=""
elif command -v sudo >/dev/null 2>&1 && sudo -n docker info >/dev/null 2>&1; then
    PREFIXO_DOCKER="sudo"
else
    resultado docker falha "A loja está fora do ar" \
        "O Docker não responde neste servidor — sem ele, nada da loja roda." "$SEGUIDAS_PARA_AVISAR"
    exit 1
fi
resultado docker ok "O Docker voltou a responder" "O Docker respondeu de novo." "$SEGUIDAS_PARA_AVISAR"

# ---------------------------------------------------------------- 1. a API
if dk compose exec -T api python -c \
    'import urllib.request; urllib.request.urlopen("http://127.0.0.1:8000/health", timeout=10)' \
    >/dev/null 2>&1; then
    ok "a API responde"
    resultado api ok "A loja voltou" "A API voltou a responder ao /health." "$SEGUIDAS_PARA_AVISAR"
else
    resultado api falha "A loja está fora do ar" \
        "A API não responde ao /health (veja: docker compose logs --tail 50 api)." \
        "$SEGUIDAS_PARA_AVISAR"
fi

# ---------------------------------------------------------------- 2. o disco
# A pasta do sistema (backups e dumps) e a pasta do Docker (o banco e as imagens) podem ser
# discos diferentes; vale o mais cheio.
uso_do_disco() { df -P "$1" 2>/dev/null | awk 'NR==2 {gsub("%", "", $5); print $5}'; }
pior=0; onde="$PASTA"
for pasta in "$PASTA" "$(dk info -f '{{.DockerRootDir}}' 2>/dev/null || true)"; do
    if [ -z "$pasta" ] || [ ! -d "$pasta" ]; then continue; fi
    uso="$(uso_do_disco "$pasta")"
    case "$uso" in ''|*[!0-9]*) continue ;; esac
    if [ "$uso" -gt "$pior" ]; then pior="$uso"; onde="$pasta"; fi
done
if [ "$pior" -gt "$LIMITE_DISCO" ]; then
    resultado disco falha "Disco quase cheio" \
        "O disco de $onde está $pior% cheio. Com 100% o banco para de gravar e a loja para (rode ./diagnostico.sh)."
else
    ok "disco com folga ($pior% usado)"
    resultado disco ok "O disco tem folga de novo" "O disco voltou a ter folga ($pior% usado)."
fi

# ---------------------------------------------------------------- 3. o backup da nuvem
# Ligado na tela e sem cópia há mais de 2× o intervalo. Sem cópia NENHUMA, conta desde
# quando foi ligado (updated_at). A hora sai no fuso da loja, que é o de quem lê.
FUSO="$(grep -E '^TIMEZONE_LOJA=' .env 2>/dev/null | cut -d= -f2- | tr -d '"' || true)"
FUSO="${FUSO:-America/Sao_Paulo}"
backup="$(dk compose exec -T db psql -U loja -d loja -tA -F '|' -c "
    SELECT CASE
               WHEN NOT ativo THEN 'desligado'
               WHEN COALESCE(ultimo_em, updated_at)
                    < now() - make_interval(mins => 2 * intervalo_min) THEN 'atrasado'
               ELSE 'em_dia' END,
           COALESCE(to_char(ultimo_em AT TIME ZONE '$FUSO', 'DD/MM HH24:MI'), 'nunca'),
           intervalo_min
    FROM backup_config WHERE id = 1" 2>/dev/null | tr -d '\r' | head -1 || true)"
case "${backup%%|*}" in
    atrasado)
        IFS='|' read -r _ ultima intervalo <<< "$backup"
        resultado backup falha "Backup da nuvem atrasado" \
            "A última cópia para o Drive foi em $ultima, e devia ser a cada $intervalo min. Veja Sistema > Backup."
        ;;
    em_dia)
        ok "backup da nuvem em dia"
        resultado backup ok "O backup da nuvem voltou" "O backup para o Drive voltou a copiar."
        ;;
    desligado)
        # Desligar na tela não é "voltou": zera calado, para a próxima ligada começar do zero.
        printf '0\n' > "$ESTADO/backup" 2>/dev/null || true
        ;;
    *)  # sem resposta do banco: a API fora já foi avisada acima, e nada muda aqui
        ;;
esac

printf '\n'
[ "$PROBLEMAS" -eq 0 ]
