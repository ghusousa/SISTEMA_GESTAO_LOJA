#!/usr/bin/env bash
#
# Atualiza o sistema da loja com o que está no GitHub.
#
#     ./atualizar.sh
#
# Faz nesta ordem, e a ordem importa:
#
#   1. backup do banco ANTES de qualquer coisa (é o que permite voltar atrás);
#   2. baixa o código novo;
#   3. reconstrói e sobe;
#   4. aplica as migrations;
#   5. confere que o sistema respondeu — e, se não respondeu, VOLTA sozinho para a
#      versão anterior.
#
# O passo 5 é o motivo de este script existir em vez de um `git pull && docker compose up`
# escrito no papel: quem atualiza a loja às 8h50 de um sábado precisa que uma atualização
# ruim se desfaça sozinha, e não que alguém descubra o `git reset` certo com a fila
# esperando no caixa.
#
# Opções:
#   --sem-backup     pula o backup (mais rápido; só se você acabou de fazer um)
#   --forcar         desfaz edições feitas nos arquivos DO SISTEMA neste servidor
#   --sim            não pergunta nada
#   --automatico [N] liga a atualização sozinha, de N em N minutos (padrão 10)
#   --sem-automatico desliga a atualização sozinha

set -euo pipefail
cd "$(dirname "$0")"

VERDE=$'\033[32m'; AMARELO=$'\033[33m'; VERMELHO=$'\033[31m'; AZUL=$'\033[36m'
FORTE=$'\033[1m'; NORMAL=$'\033[0m'
[ -t 1 ] || { VERDE=""; AMARELO=""; VERMELHO=""; AZUL=""; FORTE=""; NORMAL=""; }

titulo() { printf '\n%s%s%s\n' "$FORTE$AZUL" "$1" "$NORMAL"; }
ok()     { printf '  %s✓%s %s\n' "$VERDE" "$NORMAL" "$1"; }
aviso()  { printf '  %s!%s %s\n' "$AMARELO" "$NORMAL" "$1"; }
erro()   { printf '\n%s✗ %s%s\n' "$VERMELHO" "$1" "$NORMAL" >&2; }

SEM_BACKUP=0
FORCAR=0
INTERATIVO=1
AUTOMATICO=""
MINUTOS=10
while [ $# -gt 0 ]; do
    case "$1" in
        --sem-backup)     SEM_BACKUP=1 ;;
        --forcar)         FORCAR=1 ;;
        --sim)            INTERATIVO=0 ;;
        --automatico)
            AUTOMATICO="ligar"
            case "${2:-}" in [0-9]*) MINUTOS="$2"; shift ;; esac
            ;;
        --sem-automatico) AUTOMATICO="desligar" ;;
        -h|--help)        sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *)                erro "Opção desconhecida: $1"; exit 1 ;;
    esac
    shift
done

# Rodando sozinho, ninguém responde a prompt: o git ficaria pendurado para sempre
# esperando uma senha que não vem, e a atualização nunca mais aconteceria.
[ "$INTERATIVO" -eq 0 ] && export GIT_TERMINAL_PROMPT=0

# ------------------------------------------------------------------ ferramentas

PREFIXO_DOCKER=""
dk() {
    if [ -n "$PREFIXO_DOCKER" ]; then sudo docker "$@"; else docker "$@"; fi
}

command -v git >/dev/null 2>&1 || { erro "git não está instalado."; exit 1; }

if docker info >/dev/null 2>&1; then
    PREFIXO_DOCKER=""
elif command -v sudo >/dev/null 2>&1 && sudo -n docker info >/dev/null 2>&1; then
    PREFIXO_DOCKER="sudo"
elif command -v sudo >/dev/null 2>&1 && sudo docker info >/dev/null 2>&1; then
    PREFIXO_DOCKER="sudo"
else
    erro "Não consegui falar com o Docker. Ele está rodando?"
    exit 1
fi

[ -f docker-compose.yml ] || { erro "Rode este script de dentro da pasta do sistema."; exit 1; }

# ------------------------------------------------------ atualização sozinha

# Um timer do systemd, não uma linha no cron: o systemd já guarda o log de cada execução
# (`journalctl -u loja-atualizar`), sabe que não deve rodar duas ao mesmo tempo, e recupera
# o horário perdido se a máquina estava desligada. Cron não faz nada disso, e "por que não
# atualizou ontem?" vira adivinhação.
PASTA="$(pwd)"
SERVICO=/etc/systemd/system/loja-atualizar.service
TIMER=/etc/systemd/system/loja-atualizar.timer

sudo_se_preciso() {
    if [ "$(id -u)" -eq 0 ]; then "$@"; else sudo "$@"; fi
}

ligar_automatico() {
    titulo "Ligando a atualização sozinha"

    command -v systemctl >/dev/null 2>&1 || {
        erro "Este servidor não usa systemd; não sei agendar aqui."
        exit 1
    }
    # Prova de vida ANTES de escrever qualquer coisa: dentro de contêiner o systemctl
    # existe mas não responde, e aí o script deixaria dois arquivos órfãos em /etc e
    # morreria com um recado de systemd que não diz o que fazer.
    if ! sudo_se_preciso systemctl daemon-reload >/dev/null 2>&1; then
        erro "O systemd não responde neste servidor; não dá para agendar por aqui."
        printf '  Alternativa, no cron do root (%scrontab -e%s):\n\n' "$FORTE" "$NORMAL"
        printf '    */%s * * * * cd %s && ./atualizar.sh --sim >> /var/log/loja-atualizar.log 2>&1\n\n' \
            "$MINUTOS" "$PASTA"
        exit 1
    fi

    # Sem credencial gravada, o timer travaria pedindo senha do GitHub a ninguém. Melhor
    # descobrir agora, com alguém olhando, do que numa madrugada.
    if ! GIT_TERMINAL_PROMPT=0 git ls-remote --exit-code origin HEAD >/dev/null 2>&1; then
        erro "O git pede senha do GitHub e, sozinho, não há quem responda."
        printf '  Grave a credencial uma vez e tudo passa a funcionar sem perguntar:\n\n'
        printf '    %sgit remote set-url origin https://x-access-token:SEU_TOKEN@github.com/%s.git%s\n\n' \
            "$FORTE" "ghusousa/SISTEMA_GESTAO_LOJA" "$NORMAL"
        printf '  O token se cria em github.com/settings/tokens (acesso de leitura ao repositório).\n\n'
        exit 1
    fi
    ok "o git fala com o GitHub sem pedir senha"

    sudo_se_preciso tee "$SERVICO" >/dev/null <<UNIDADE
[Unit]
Description=Atualiza o sistema da loja com o que está no GitHub
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=oneshot
WorkingDirectory=$PASTA
ExecStart=$PASTA/atualizar.sh --sim
# Atualização que travou não pode segurar a próxima para sempre.
TimeoutStartSec=900
UNIDADE

    sudo_se_preciso tee "$TIMER" >/dev/null <<UNIDADE
[Unit]
Description=Confere de $MINUTOS em $MINUTOS minutos se há versão nova da loja

[Timer]
OnBootSec=5min
OnUnitActiveSec=${MINUTOS}min
# Se o servidor estava desligado na hora, roda assim que voltar em vez de esperar a próxima.
Persistent=true

[Install]
WantedBy=timers.target
UNIDADE

    if ! sudo_se_preciso systemctl daemon-reload \
        || ! sudo_se_preciso systemctl enable --now loja-atualizar.timer >/dev/null 2>&1; then
        erro "Não consegui ligar o agendamento."
        sudo_se_preciso rm -f "$TIMER" "$SERVICO"
        printf '  Veja o motivo com: %ssystemctl status loja-atualizar.timer%s\n\n' "$FORTE" "$NORMAL"
        exit 1
    fi
    ok "de $MINUTOS em $MINUTOS minutos, sem comando nenhum"

    printf '\n  Próxima conferida: %s\n' \
        "$(systemctl list-timers loja-atualizar.timer --no-pager 2>/dev/null | sed -n '2p' | awk '{print $1, $2, $3}')"
    printf '  Ver o que aconteceu: %sjournalctl -u loja-atualizar -n 40%s\n' "$FORTE" "$NORMAL"
    printf '  Desligar: %s./atualizar.sh --sem-automatico%s\n\n' "$FORTE" "$NORMAL"
    exit 0
}

desligar_automatico() {
    titulo "Desligando a atualização sozinha"
    sudo_se_preciso systemctl disable --now loja-atualizar.timer >/dev/null 2>&1
    sudo_se_preciso rm -f "$TIMER" "$SERVICO"
    sudo_se_preciso systemctl daemon-reload
    ok "desligada. A loja só atualiza quando você rodar ./atualizar.sh"
    printf '\n'
    exit 0
}

case "$AUTOMATICO" in
    ligar)    ligar_automatico ;;
    desligar) desligar_automatico ;;
esac


[ -f .env ] || { erro "Não achei o .env. Este servidor já foi instalado com ./instalar.sh?"; exit 1; }

# ------------------------------------------------------------------ o que vem por aí

titulo "Conferindo o que há de novo"

git rev-parse --git-dir >/dev/null 2>&1 || { erro "Esta pasta não é um clone do repositório."; exit 1; }

RAMO="$(git rev-parse --abbrev-ref HEAD)"
ANTES="$(git rev-parse HEAD)"

# Só o que o `git reset --hard` lá embaixo REALMENTE apagaria: arquivo rastreado que foi
# editado aqui no servidor. Arquivo não rastreado (uma pasta solta, um .txt esquecido, um
# clone dentro do clone) sobrevive ao reset intacto — barrar por causa dele era exigir um
# `--forcar` para proteger algo que nunca esteve em risco, e deixar a loja sem atualizar
# por causa de um arquivo que ninguém ia perder.
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    if [ "$FORCAR" -eq 1 ]; then
        aviso "Há arquivos do sistema editados aqui; --forcar foi passado e eles voltam ao original."
    else
        erro "Há arquivos do SISTEMA editados neste servidor, que seriam desfeitos."
        git status --porcelain --untracked-files=no | sed 's/^/    /'
        printf '  Para desfazer e atualizar: %s./atualizar.sh --forcar%s\n\n' "$FORTE" "$NORMAL"
        exit 1
    fi
fi

for tentativa in 1 2 3 4; do
    if git fetch --quiet origin "$RAMO"; then break; fi
    [ "$tentativa" -eq 4 ] && { erro "Não consegui falar com o GitHub."; exit 1; }
    aviso "Falha ao buscar do GitHub; tentando de novo em $((2 ** tentativa))s…"
    sleep $((2 ** tentativa))
done

DEPOIS="$(git rev-parse "origin/$RAMO")"

if [ "$ANTES" = "$DEPOIS" ]; then
    ok "Já está na versão mais nova. Nada a fazer."
    exit 0
fi

printf '\n  %sNovidades (%s):%s\n' "$FORTE" "$RAMO" "$NORMAL"
git --no-pager log --oneline --no-decorate "$ANTES..$DEPOIS" | sed 's/^/    /' | head -20
# Simétrica (`...`): se o GitHub reverteu alguma coisa, andamos para trás e a contagem
# de mão única daria zero — "atualizado, 0 mudanças" não explica nada a ninguém.
QUANTOS="$(git rev-list --count "$ANTES...$DEPOIS")"
[ "$QUANTOS" -gt 20 ] && printf '    … e mais %s\n' "$((QUANTOS - 20))"

if [ "$INTERATIVO" -eq 1 ]; then
    printf '\n  Atualizar agora? A loja fica fora do ar por cerca de um minuto. [S/n] '
    read -r resposta </dev/tty || resposta="s"
    case "${resposta:-s}" in [Nn]*) printf '  Cancelado.\n'; exit 0 ;; esac
fi

# ------------------------------------------------------------------ backup

ARQUIVO_BACKUP=""
if [ "$SEM_BACKUP" -eq 0 ]; then
    titulo "Guardando uma cópia do banco"
    # O nome começa com `loja-backup-` porque é o que o .gitignore cobre. Fora desse
    # padrão, o dump ficaria como arquivo não rastreado e a PRÓXIMA execução deste
    # script se recusaria a rodar, reclamando de alterações locais.
    ARQUIVO_BACKUP="loja-backup-antes-de-atualizar-$(date +%Y%m%d-%H%M%S).dump"
    # `pg_dump -Fc` dentro do contêiner e depois `cp` para fora: o formato comprimido do
    # Postgres restaura com pg_restore e não depende da versão do cliente na máquina.
    if dk compose exec -T db pg_dump -U loja -d loja -Fc -f /tmp/backup.dump 2>/dev/null \
        && dk compose cp db:/tmp/backup.dump "$ARQUIVO_BACKUP" 2>/dev/null; then
        ok "$ARQUIVO_BACKUP ($(du -h "$ARQUIVO_BACKUP" | cut -f1))"
    else
        aviso "Não consegui fazer o backup (o banco está no ar?)."
        if [ "$INTERATIVO" -eq 1 ]; then
            printf '  Continuar SEM backup? [s/N] '
            read -r resposta </dev/tty || resposta="n"
            case "${resposta:-n}" in [Ss]*) ;; *) printf '  Cancelado.\n'; exit 1 ;; esac
        fi
        ARQUIVO_BACKUP=""
    fi
fi

# ------------------------------------------------------------------ atualizar

# Espera a API responder. Devolve a resposta do /health, ou vazio se desistiu.
esperar_saude() {
    local tentativas="${1:-30}"
    local resposta=""
    for _ in $(seq 1 "$tentativas"); do
        if resposta="$(dk compose exec -T api python -c \
            'import urllib.request, sys
try:
    print(urllib.request.urlopen("http://127.0.0.1:8000/health", timeout=3).read().decode())
except Exception:
    sys.exit(1)' 2>/dev/null)"; then
            printf '%s' "$resposta"
            return 0
        fi
        sleep 2
    done
    return 1
}

voltar_atras() {
    erro "A atualização falhou. Voltando para a versão anterior."
    git reset --hard --quiet "$ANTES"
    dk compose up -d --build 2>&1 | tail -3

    # Esperar aqui também, e não só no caminho feliz: dizer "voltou" enquanto o
    # contêiner ainda sobe faz a pessoa abrir o site, ver erro e achar que perdeu a loja.
    printf '\n  aguardando a loja voltar…\n'
    if esperar_saude 30 >/dev/null; then
        printf '  %s✓ O sistema voltou para a versão de antes e está no ar.%s\n' "$VERDE" "$NORMAL"
    else
        printf '  %s✗ A versão anterior também não subiu.%s\n' "$VERMELHO" "$NORMAL"
        printf '  Veja o que aconteceu com: %sdocker compose logs --tail 50 api%s\n' "$FORTE" "$NORMAL"
    fi

    if [ -n "$ARQUIVO_BACKUP" ]; then
        printf '  O banco NÃO foi tocado por este script; a cópia está em %s\n' "$ARQUIVO_BACKUP"
        printf '  caso alguma migration tenha chegado a rodar.\n'
    fi
    printf '  Mande a mensagem de erro acima para quem cuida do sistema.\n\n'
    exit 1
}

titulo "Baixando a versão nova"
git reset --hard --quiet "$DEPOIS"
ok "código em $(git rev-parse --short HEAD)"

titulo "Guardando o log de agora"
# `up -d --build` REMOVE o contêiner velho, e o log dele vai junto. Se a loja estava com
# problema antes da atualização, é essa a única cópia do motivo — e sem ela a pergunta
# "por que parou ontem?" não tem mais resposta em lugar nenhum.
ARQUIVO_LOG="loja-backup-log-antes-de-atualizar-$(date +%Y%m%d-%H%M%S).txt"
if dk compose logs --tail 2000 > "$ARQUIVO_LOG" 2>&1; then
    ok "$ARQUIVO_LOG ($(du -h "$ARQUIVO_LOG" | cut -f1))"
else
    rm -f "$ARQUIVO_LOG"
    aviso "não consegui guardar o log (os contêineres estão de pé?)."
fi

titulo "Reconstruindo e subindo"
# `up -d --build` em vez de `restart`: dependência nova no requirements só entra na
# imagem se ela for reconstruída, e uma imagem velha com código novo quebra de um jeito
# difícil de entender.
if ! dk compose up -d --build; then
    voltar_atras
fi

titulo "Atualizando o banco"
# O entrada.sh do contêiner já roda `alembic upgrade head` ao subir. Rodar de novo aqui é
# de graça (migration aplicada não reaplica) e serve para o erro aparecer NESTE terminal,
# em vez de ficar escondido no log do contêiner.
if ! dk compose exec -T api alembic upgrade head; then
    voltar_atras
fi
ok "migrations aplicadas"

# ------------------------------------------------------------------ conferir

titulo "Conferindo se a loja voltou"

URL_LOCAL="http://localhost:$(grep -E '^PORTA_HTTP=' .env | cut -d= -f2 || echo 80)"

if ! SAUDE="$(esperar_saude 30)"; then
    voltar_atras
fi
ok "a API respondeu: $SAUDE"

# Cada `--build` deixa a imagem antiga para trás, sem nome, ocupando disco. Vinte
# atualizações depois são vários GB — e num servidor de loja o disco acaba antes.
# `image prune -f` sem `-a` só apaga imagem órfã: nada em uso, nenhum dado, nada de volume.
LIXO="$(dk image prune -f 2>/dev/null | grep -i 'reclaimed' | sed 's/.*: *//')"
[ -n "$LIXO" ] && [ "$LIXO" != "0B" ] && ok "disco liberado das imagens antigas: $LIXO"

# Backup a cada atualização é o certo; guardar TODOS eles não é. Com a atualização sozinha
# ligada isso vira um dump por versão nova, para sempre, até o disco encher — e disco cheio
# derruba o Postgres. Ficam os 5 últimos, que cobrem qualquer volta atrás plausível.
GUARDAR=5
# O padrão é o nome COMPLETO que este script usa: `loja-backup-*.dump` pegaria também os
# backups do desinstalador, que são de quem os fez, não meus para apagar.
SOBRANDO="$(ls -1t loja-backup-antes-de-atualizar-*.dump 2>/dev/null | tail -n +$((GUARDAR + 1)))"
if [ -n "$SOBRANDO" ]; then
    printf '%s\n' "$SOBRANDO" | xargs -r rm -f
    ok "backups antigos apagados (ficam os $GUARDAR mais novos)"
fi
# O mesmo para os logs guardados antes de cada reconstrução.
ls -1t loja-backup-log-antes-de-atualizar-*.txt 2>/dev/null | tail -n +$((GUARDAR + 1)) | xargs -r rm -f

# ------------------------------------------------------------------ pronto

printf '\n%s%s✓ Atualizado.%s\n' "$FORTE" "$VERDE" "$NORMAL"
printf '  De %s para %s (%s %s).\n' \
    "$(git rev-parse --short "$ANTES")" "$(git rev-parse --short "$DEPOIS")" \
    "$QUANTOS" "$([ "$QUANTOS" -eq 1 ] && echo mudança || echo mudanças)"
printf '  Endereço: %s\n' "$URL_LOCAL"
[ -n "$ARQUIVO_BACKUP" ] && printf '  Backup de antes: %s\n' "$ARQUIVO_BACKUP"
printf '\n  %sNo celular:%s feche e abra o app para pegar a versão nova.\n' "$FORTE" "$NORMAL"
printf '  %sNo balcão:%s aperte Ctrl+F5 no navegador.\n\n' "$FORTE" "$NORMAL"
