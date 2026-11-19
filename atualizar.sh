#!/usr/bin/env bash
#
# Atualiza o sistema da loja com o que está no GitHub.
#
#     ./atualizar.sh
#
# Faz nesta ordem, e a ordem importa:
#
#   0. só segue com commit de CI verde no GitHub, e que não tenha falhado aqui antes;
#   1. backup do banco ANTES de qualquer coisa, conferido (é o que permite voltar atrás);
#   2. baixa o código novo;
#   3. reconstrói e sobe a LOJA (db, api, proxy);
#   4. as migrations, quem aplica é o contêiner ao subir (docker/entrada.sh);
#   5. confere que o sistema respondeu — por dentro e pelo proxy, com o Caddyfile novo
#      conferido e aplicado — e, se não respondeu, VOLTA sozinho para a versão anterior
#      (com o banco do passo 1, se uma migration chegou a rodar);
#   6. só então sobe a demonstração em /demo (ADR-46), se ela está ligada. Ela nunca desfaz
#      a atualização da loja: se não subir, avisa.
#
# O passo 5 é o motivo de este script existir em vez de um `git pull && docker compose up`
# escrito no papel: quem atualiza a loja às 8h50 de um sábado precisa que uma atualização
# ruim se desfaça sozinha, e não que alguém descubra o `git reset` certo com a fila
# esperando no caixa.
#
# Este script nunca escreve no .env: ligar e desligar a demonstração é do ./demo.sh e do
# ./instalar.sh. E a atualização que traz um atualizar.sh novo roda o TEXTO VELHO (o `git
# reset` troca o arquivo; o bash segue lendo o que abriu): nada que essa primeira rodada
# precise pode depender do que se acrescenta aqui — por isso a demo chega desligada a quem já
# tinha a loja, e só liga com o ./demo.sh --ligar (ou rodando o ./instalar.sh de novo).
#
# Opções:
#   --sem-backup     pula o backup (mais rápido; só se você acabou de fazer um). Sem esta
#                    opção, backup que falha ou não abre faz o --sim desistir de atualizar
#   --forcar         desfaz edições feitas nos arquivos DO SISTEMA neste servidor
#   --sim            não pergunta nada
#   --ignorar-ci     implanta mesmo sem o CI verde no GitHub (vermelho ou rodando). Sem
#                    esta opção o --sim não implanta, e o interativo pergunta. Se não dá
#                    nem para ler o CI (token sem "Checks"), o --sim sobe e avisa
#   --automatico [N] liga a atualização sozinha, de N em N minutos (padrão 10)
#   --sem-automatico desliga a atualização sozinha

set -euo pipefail
cd "$(dirname "$0")"

# Se a demonstração sobe é o COMPOSE_PROFILES do .env que diz. Exportada no terminal, a
# variável venceria o arquivo para o `docker compose` (e o `sudo docker` a jogaria fora): cada
# execução valeria uma coisa. Aqui manda o .env.
unset COMPOSE_PROFILES

VERDE=$'\033[32m'; AMARELO=$'\033[33m'; VERMELHO=$'\033[31m'; AZUL=$'\033[36m'
FORTE=$'\033[1m'; NORMAL=$'\033[0m'
[ -t 1 ] || { VERDE=""; AMARELO=""; VERMELHO=""; AZUL=""; FORTE=""; NORMAL=""; }

titulo() { printf '\n%s%s%s\n' "$FORTE$AZUL" "$1" "$NORMAL"; }
ok()     { printf '  %s✓%s %s\n' "$VERDE" "$NORMAL" "$1"; }
aviso()  { printf '  %s!%s %s\n' "$AMARELO" "$NORMAL" "$1"; }
erro()   { printf '\n%s✗ %s%s\n' "$VERMELHO" "$1" "$NORMAL" >&2; }

valor_no_env() { grep -E "^$1=" .env 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"' || true; }

# A demonstração (ADR-46) está ligada quando o perfil "demo" está no COMPOSE_PROFILES.
demo_ligada() { case ",$(valor_no_env COMPOSE_PROFILES)," in *,demo,*) return 0 ;; *) return 1 ;; esac; }

SEM_BACKUP=0
FORCAR=0
IGNORAR_CI=0
INTERATIVO=1
AUTOMATICO=""
MINUTOS=10
while [ $# -gt 0 ]; do
    case "$1" in
        --sem-backup)     SEM_BACKUP=1 ;;
        --forcar)         FORCAR=1 ;;
        --ignorar-ci)     IGNORAR_CI=1 ;;
        --sim)            INTERATIVO=0 ;;
        --automatico)
            AUTOMATICO="ligar"
            case "${2:-}" in [0-9]*) MINUTOS="$2"; shift ;; esac
            ;;
        --sem-automatico) AUTOMATICO="desligar" ;;
        -h|--help)        sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
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

# O que a API vai mostrar na tela. Escrito aqui porque é aqui que existe a credencial do
# GitHub: a API nunca conversa com o repositório — se conversasse, precisaria de um token
# do código-fonte dentro do contêiner que só deveria saber vender roupa.
ESTADO=docker/estado
anotar_versao() {
    local atualizada="$1"   # true = não havia nada novo na última conferida
    local commit="${2:-HEAD}"   # o que está NO AR — no meio de uma atualização, não é o HEAD
    mkdir -p "$ESTADO"
    cat > "$ESTADO/versao.json" <<FIM
{
  "commit": "$(git rev-parse --short "$commit" 2>/dev/null)",
  "data": "$(git log -1 --format=%cI "$commit" 2>/dev/null)",
  "conferido_em": "$(date -u +%Y-%m-%dT%H:%M:%S+00:00)",
  "atualizada": $atualizada
}
FIM
}

# O commit que SUBIU e respondeu ao /health por último. Não é o HEAD: o `git reset` lá
# embaixo troca o disco minutos antes de o contêiner novo existir, e uma morte nesse meio
# (o TimeoutStartSec matando um build lento, queda de luz) deixava o código novo no disco e
# a imagem velha no ar. Comparando o GitHub com o HEAD, toda execução seguinte dizia "nada a
# fazer" — para sempre. Comparando com o que subiu de verdade, a próxima reconstrói.
IMPLANTADO="$ESTADO/implantado"
gravar_implantado() {
    mkdir -p "$ESTADO"
    printf '%s\n' "$1" > "$IMPLANTADO.novo" && mv -f "$IMPLANTADO.novo" "$IMPLANTADO"
}

# O commit que subiu, não respondeu e foi desfeito pela volta atrás. Sem este registro, a
# execução seguinte via "GitHub diferente do que está no ar" e tentava de novo — e um commit
# quebrado no main derrubava a loja por 3 a 4 minutos a cada 10, o dia inteiro, em horário
# de venda. Com ele, o --sim espera um commit NOVO; o arquivo some quando um commit sobe bem.
FALHOU="$ESTADO/falhou"

# ------------------------------------------------------------------ o CI do GitHub
#
# Só se implanta commit que o CI aprovou. Quem pergunta é este script, com a credencial que
# o git já usa para buscar o código (a do `remote.origin.url`, que o --automatico manda
# gravar, ou a do ajudante de credenciais) — a API continua sem falar com o GitHub (ADR-18).

# dono/repositório, da URL CRUA do origin (`git config`, não `git remote get-url`, que
# aplicaria um `insteadOf` e esconderia o endereço do GitHub).
repositorio_github() {
    local url; url="$(git config --get remote.origin.url 2>/dev/null || true)"
    case "$url" in *github.com[:/]*) ;; *) return 1 ;; esac
    url="${url#*github.com}"; url="${url#[:/]}"; url="${url%/}"; url="${url%.git}"
    case "$url" in */*) printf '%s' "$url" ;; *) return 1 ;; esac
}

token_github() {
    local url credencial; url="$(git config --get remote.origin.url 2>/dev/null || true)"
    case "$url" in
        https://*@github.com/*)
            credencial="${url#https://}"; credencial="${credencial%%@*}"
            # `x-access-token:TOKEN` ou `usuario:TOKEN` → o que vem depois do ':'; um
            # `TOKEN@github.com` sozinho é o próprio token.
            printf '%s' "${credencial#*:}"; return 0 ;;
    esac
    # O ajudante de credenciais do git, se houver, sem nunca abrir pergunta para ninguém.
    printf 'protocol=https\nhost=github.com\n\n' \
        | GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=/bin/false SSH_ASKPASS=/bin/false \
            git credential fill 2>/dev/null | sed -n 's/^password=//p'
}

# Pergunta ao GitHub como está o CI do commit e responde em CI_SITUACAO:
#   verde        todas as verificações terminaram, nenhuma reprovou
#   vermelho     alguma reprovou (ou foi cancelada, ou estourou o tempo)
#   pendente     alguma ainda roda — ou o CI nem começou (zero verificações)
#   indisponivel não deu para perguntar (sem curl, origem fora do GitHub, token sem a
#                permissão "Checks: leitura", GitHub fora do ar)
# Por que check-runs e não o "status" combinado: é onde o GitHub Actions publica.
situacao_do_ci() {
    local sha="$1" repo token resposta total vermelhos rodando
    CI_SITUACAO="indisponivel"; CI_DETALHE=""
    command -v curl >/dev/null 2>&1 || { CI_DETALHE="o curl não está instalado"; return 0; }
    repo="$(repositorio_github)" || { CI_DETALHE="a origem do código não é o GitHub"; return 0; }
    token="$(token_github || true)"
    # O token vai pela configuração em stdin (`-K -`), nunca na linha de comando: ali
    # qualquer usuário da máquina o leria com um `ps`.
    if ! resposta="$(
        { printf 'header = "Accept: application/vnd.github+json"\n'
          printf 'header = "X-GitHub-Api-Version: 2022-11-28"\n'
          # `if`, não `&&`: sem token (repositório público), o `&&` faria o bloco sair 1 e,
          # com pipefail, uma resposta boa do GitHub viraria "não respondeu".
          if [ -n "$token" ]; then printf 'header = "Authorization: Bearer %s"\n' "$token"; fi
        } | curl -fsS --max-time 20 -K - \
            "https://api.github.com/repos/$repo/commits/$sha/check-runs?per_page=100" 2>&1
    )"; then
        CI_DETALHE="o GitHub não respondeu ($(printf '%s' "$resposta" | tail -1 | cut -c1-120))"
        return 0
    fi
    # Sem jq nem python na máquina: o JSON do GitHub tem estas chaves no nível de cada
    # verificação, e dentro de um texto as aspas viriam escapadas (\"status\") — não casam.
    total="$(printf '%s' "$resposta" | grep -oE '"total_count": *[0-9]+' | head -1 | grep -oE '[0-9]+$' || true)"
    [ -n "$total" ] || { CI_DETALHE="o GitHub respondeu algo que não entendi"; return 0; }
    # `-o` e contar linhas, não `-c`: o JSON pode vir numa linha só, e `-c` conta LINHAS.
    vermelhos="$(printf '%s' "$resposta" \
        | grep -oE '"conclusion": *"(failure|cancelled|timed_out|action_required|startup_failure|stale)"' \
        | wc -l | tr -d ' ' || true)"
    rodando="$(printf '%s' "$resposta" | grep -oE '"status": *"[a-z_]+"' | grep -vc '"completed"' || true)"
    if [ "${vermelhos:-0}" -gt 0 ]; then
        CI_SITUACAO="vermelho"; CI_DETALHE="$vermelhos de $total verificações reprovaram"
    elif [ "$total" -eq 0 ]; then
        CI_SITUACAO="pendente"; CI_DETALHE="o CI ainda não começou"
    elif [ "${rodando:-0}" -gt 0 ]; then
        CI_SITUACAO="pendente"; CI_DETALHE="$rodando de $total verificações ainda rodando"
    else
        CI_SITUACAO="verde"; CI_DETALHE="$total verificações aprovadas"
    fi
}

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
DIR_SYSTEMD="${DIR_SYSTEMD:-/etc/systemd/system}"
SERVICO="$DIR_SYSTEMD/loja-atualizar.service"
TIMER="$DIR_SYSTEMD/loja-atualizar.timer"

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

    # Sozinha, a atualização só sobe commit de CI verde. Token que lê o código mas não lê o
    # CI faria a loja parar de atualizar para sempre — melhor dizer agora, com alguém olhando.
    situacao_do_ci "$(git rev-parse HEAD)"
    if [ "$CI_SITUACAO" = "indisponivel" ]; then
        aviso "Não consigo ler o CI do GitHub: $CI_DETALHE."
        aviso "Sozinha, a atualização só sobe commit com CI verde: assim, não subiria nada."
        printf '  Dê ao token a permissão "Checks: leitura" (fine-grained) ou "repo" (clássico).\n'
    else
        ok "o CI do GitHub responde (o commit de agora está $CI_SITUACAO)"
    fi

    # Falhou? Avisa o dono (ntfy, ou o journal), pela unidade-modelo do notificar.sh.
    umask 022
    DIR_SYSTEMD="$DIR_SYSTEMD" ./notificar.sh --instalar \
        || aviso "não consegui gravar o aviso de falha (loja-aviso@); a atualização liga mesmo assim"

    sudo_se_preciso tee "$SERVICO" >/dev/null <<UNIDADE
[Unit]
Description=Atualiza o sistema da loja com o que está no GitHub
After=network-online.target docker.service
Wants=network-online.target
OnFailure=loja-aviso@%N.service

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
CABECA="$(git rev-parse HEAD)"
# ANTES é a versão que está no ar: a de onde se parte e para onde se volta se der errado.
# Sem registro (servidor recém-instalado, ou atualizado pela versão antiga deste script)
# vale o que sempre valeu: o que está no disco é o que está no ar.
ANTES="$CABECA"
if [ -s "$IMPLANTADO" ]; then
    ANTES="$(git rev-parse --verify --quiet "$(head -1 "$IMPLANTADO")^{commit}" || echo "$CABECA")"
fi

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

if [ "$ANTES" = "$DEPOIS" ] && [ "$CABECA" = "$DEPOIS" ]; then
    # Registrar a conferida mesmo sem novidade é o ponto: é isto que deixa a tela dizer
    # "está em dia" com convicção, em vez de só mostrar um hash que ninguém sabe ler.
    anotar_versao true
    ok "Já está na versão mais nova. Nada a fazer."
    exit 0
fi

if [ "$ANTES" != "$CABECA" ]; then
    aviso "A última atualização não chegou ao fim: o código de $(git rev-parse --short "$CABECA") está no disco,"
    aviso "mas quem subiu por último foi $(git rev-parse --short "$ANTES"). Subindo de novo."
fi

printf '\n  %sNovidades (%s):%s\n' "$FORTE" "$RAMO" "$NORMAL"
git --no-pager log --oneline --no-decorate "$ANTES..$DEPOIS" | sed 's/^/    /' | head -20
# Simétrica (`...`): se o GitHub reverteu alguma coisa, andamos para trás e a contagem
# de mão única daria zero — "atualizado, 0 mudanças" não explica nada a ninguém.
QUANTOS="$(git rev-list --count "$ANTES...$DEPOIS")"
[ "$QUANTOS" -gt 20 ] && printf '    … e mais %s\n' "$((QUANTOS - 20))"

# ------------------------------------------------------------------ pode subir?

# Sozinho (o --sim), nada de novo sobe sem resposta: a loja fica na versão que já roda, a
# tela passa a dizer que há uma nova esperando, e a próxima conferida pergunta de novo.
nao_sobe() {
    anotar_versao false "$ANTES"
    printf '  Nada foi mudado: a loja continua na versão de antes.\n'
}

JA_CONFIRMOU=0
# A versão que já subiu aqui e não respondeu não muda sozinha: tentar de novo é derrubar a
# loja de novo. Só um commit NOVO no GitHub (a correção) faz o --sim seguir.
if [ -s "$FALHOU" ] && [ "$(head -1 "$FALHOU")" = "$DEPOIS" ]; then
    aviso "A versão $(git rev-parse --short "$DEPOIS") já subiu neste servidor, não respondeu e foi desfeita."
    if [ "$INTERATIVO" -eq 1 ]; then
        printf '  Tentar de novo mesmo assim? [s/N] '
        read -r resposta </dev/tty || resposta="n"
        case "${resposta:-n}" in [Ss]*) JA_CONFIRMOU=1 ;; *) printf '  Cancelado.\n'; exit 0 ;; esac
    else
        nao_sobe
        printf '  A próxima tentativa é quando chegar um commit novo no GitHub.\n\n'
        exit 0
    fi
fi

titulo "Conferindo o CI no GitHub"
situacao_do_ci "$DEPOIS"
CURTO="$(git rev-parse --short "$DEPOIS")"
case "$CI_SITUACAO" in
    verde)    ok "CI verde em $CURTO ($CI_DETALHE)" ;;
    vermelho) aviso "CI VERMELHO em $CURTO: $CI_DETALHE. Esta versão reprovou nos testes." ;;
    pendente) aviso "CI de $CURTO ainda sem resposta final: $CI_DETALHE." ;;
    *)        aviso "Não deu para conferir o CI de $CURTO: $CI_DETALHE." ;;
esac
if [ "$CI_SITUACAO" != "verde" ]; then
    if [ "$IGNORAR_CI" -eq 1 ]; then
        aviso "--ignorar-ci: subindo mesmo assim."
    elif [ "$INTERATIVO" -eq 1 ]; then
        printf '  Atualizar mesmo assim, sem o CI verde? [s/N] '
        read -r resposta </dev/tty || resposta="n"
        case "${resposta:-n}" in [Ss]*) JA_CONFIRMOU=1 ;; *) printf '  Cancelado.\n'; exit 0 ;; esac
    elif [ "$CI_SITUACAO" = "indisponivel" ]; then
        # Não deu nem para PERGUNTAR (token antigo sem "Checks", origem fora do GitHub):
        # segue como sempre seguiu antes desta conferência existir — a volta atrás
        # automática continua de guarda — e avisa, no journal e no celular. Parar aqui
        # deixava as lojas instaladas com o token que o README pedia sem atualizar nunca
        # mais, caladas. Vermelho e pendente, sim, seguram: ali o CI respondeu "não".
        aviso "Subindo sem conferir o CI (o mesmo de antes desta checagem existir)."
        printf '  Para o CI valer aqui, o token do GitHub precisa ler o CI:\n'
        printf '  permissão "Checks: leitura" (token fine-grained) ou "repo" (clássico).\n'
        if [ -x ./notificar.sh ]; then
            ./notificar.sh --assunto ci-indisponivel "Atualização sem conferir o CI" \
                "O atualizar.sh não conseguiu ler o CI do GitHub ($CI_DETALHE) e atualizou sem essa conferência. Dê ao token a permissão Checks: leitura." \
                >/dev/null 2>&1 || true
        fi
    else
        nao_sobe
        printf '  A próxima conferida pergunta de novo ao GitHub.\n\n'
        exit 0
    fi
fi

if [ "$INTERATIVO" -eq 1 ] && [ "$JA_CONFIRMOU" -eq 0 ]; then
    printf '\n  Atualizar agora? A loja fica fora do ar por cerca de um minuto. [S/n] '
    read -r resposta </dev/tty || resposta="s"
    case "${resposta:-s}" in [Nn]*) printf '  Cancelado.\n'; exit 0 ;; esac
fi

# ------------------------------------------------------------------ backup

# Dump que não abre não é backup — e só se descobre na hora de restaurar, que aqui é a volta
# atrás de uma migration ruim. Mesma conferida do backup.sh, com o pg_restore DO CONTÊINER:
# o da máquina pode ser de outra versão e recusar um dump bom ("unsupported version").
dump_abre() {
    local arquivo="$1" abre=1
    [ -s "$arquivo" ] || return 1
    if dk compose cp "$arquivo" db:/tmp/conferir.dump >/dev/null 2>&1 \
        && dk compose exec -T db pg_restore -l /tmp/conferir.dump >/dev/null 2>&1; then
        abre=0
    fi
    dk compose exec -T db rm -f /tmp/conferir.dump >/dev/null 2>&1 || true
    return "$abre"
}

ARQUIVO_BACKUP=""
if [ "$SEM_BACKUP" -eq 0 ]; then
    titulo "Guardando uma cópia do banco"
    # O nome começa com `loja-backup-` porque é o que o .gitignore cobre. Fora desse
    # padrão, o dump ficaria como arquivo não rastreado e a PRÓXIMA execução deste
    # script se recusaria a rodar, reclamando de alterações locais.
    ARQUIVO_BACKUP="loja-backup-antes-de-atualizar-$(date +%Y%m%d-%H%M%S).dump"
    # `pg_dump -Fc` dentro do contêiner e depois `cp` para fora: o formato comprimido do
    # Postgres restaura com pg_restore e não depende da versão do cliente na máquina.
    # `chmod 600`: é o banco inteiro (CPF, telefones, hashes de senha), e o `docker cp` traz
    # a permissão de dentro do contêiner, legível por qualquer usuário da máquina.
    if dk compose exec -T db pg_dump -U loja -d loja -Fc -f /tmp/backup.dump 2>/dev/null \
        && dk compose cp db:/tmp/backup.dump "$ARQUIVO_BACKUP" 2>/dev/null \
        && chmod 600 "$ARQUIVO_BACKUP" \
        && dump_abre "$ARQUIVO_BACKUP"; then
        ok "$ARQUIVO_BACKUP ($(du -h "$ARQUIVO_BACKUP" | cut -f1)) — e ela abre"
    else
        rm -f "$ARQUIVO_BACKUP"
        ARQUIVO_BACKUP=""
        aviso "Não consegui uma cópia do banco que abra (o banco está no ar?)."
        if [ "$INTERATIVO" -eq 1 ]; then
            aviso "Sem ela, uma migration da versão nova que dê errado não tem volta."
            printf '  Continuar SEM backup? [s/N] '
            read -r resposta </dev/tty || resposta="n"
            case "${resposta:-n}" in [Ss]*) ;; *) printf '  Cancelado.\n'; exit 1 ;; esac
        else
            # Sozinho (o timer, de madrugada) ninguém responde "pode seguir sem cópia": seguir
            # era aplicar migrations sem nada de antes para voltar. A loja fica na versão que
            # já roda, e a tela passa a dizer que há uma nova esperando.
            anotar_versao false "$ANTES"
            erro "Sem uma cópia do banco que abra, a atualização sozinha não segue."
            printf '  Nada foi mudado: a loja continua na versão de antes.\n'
            printf '  Se você acabou de fazer uma cópia: %s./atualizar.sh --sem-backup%s\n\n' \
                "$FORTE" "$NORMAL"
            exit 1
        fi
    fi
fi

# ------------------------------------------------------------------ atualizar

# Espera a API responder. Devolve a resposta do /health, ou vazio se desistiu. A da
# demonstração responde debaixo do prefixo dela: esperar_saude 60 api-demo /demo/health.
esperar_saude() {
    local tentativas="${1:-30}" servico="${2:-api}" caminho="${3:-/health}"
    local resposta=""
    for _ in $(seq 1 "$tentativas"); do
        if resposta="$(dk compose exec -T "$servico" python -c \
            'import urllib.request, sys
try:
    print(urllib.request.urlopen("http://127.0.0.1:8000" + sys.argv[1], timeout=3).read().decode())
except Exception:
    sys.exit(1)' "$caminho" 2>/dev/null)"; then
            printf '%s' "$resposta"
            return 0
        fi
        sleep 2
    done
    return 1
}

# Contêiner órfão de uma recriação interrompida.
#
# Para trocar um contêiner, o Docker o substitui por um de nome provisório
# `<hash>_loja-<serviço>-1` e só no fim o renomeia. Se a recriação morre no meio (build lento,
# máquina ocupada, SIGKILL no desligamento), esse provisório fica para trás — e o `up -d`
# seguinte tropeça nele. Com a api, o sintoma na loja é 502: o Caddy fica de pé, mas não acha
# `api` no DNS interno; com o proxy, é a loja inteira fora, porta 80/443 fechada.
#
# Já aconteceu de verdade, e o dono só descobriu pelo diagnóstico. Vale para QUALQUER serviço
# (a demonstração e o proxy também se recriam), e quem decide é o nome inteiro, aqui no grep.
limpar_orfaos() {
    local orfaos
    orfaos="$(dk ps -a --filter "name=_loja-" --format '{{.Names}}' 2>/dev/null \
        | grep -E '^[0-9a-f]{8,}_loja-[A-Za-z0-9_.-]+-[0-9]+$' || true)"
    [ -z "$orfaos" ] && return 0
    aviso "Sobrou contêiner de uma atualização interrompida. Removendo:"
    printf '%s\n' "$orfaos" | while read -r nome; do
        [ -n "$nome" ] || continue
        printf '    %s\n' "$nome"
        dk rm -f "$nome" >/dev/null 2>&1 || true
    done
}

# Em que migration o banco está. Lida antes de subir o código novo, é o que diz na volta
# atrás se a versão nova chegou a mexer no schema.
revisao_do_banco() {
    dk compose exec -T db psql -U loja -d loja -tAc "SELECT version_num FROM alembic_version" \
        2>/dev/null | tr -d '\r' | head -1
}

# ------------------------------------------------------------------ o proxy
#
# O /health por dentro da API não diz se a loja ABRE: o Caddy pode estar caído, recarregado
# com um Caddyfile quebrado, ou levando a outro lugar. A conferida que vale é a do navegador —
# pela porta do proxy. Com domínio, pelo nome (o Caddy escolhe o site e o certificado por ele),
# sem sair da máquina: o --resolve leva o nome a 127.0.0.1. O -k é de propósito: a pergunta é
# "a loja chega até a API?", e um certificado vencendo não é culpa desta atualização.
PELO_PROXY=(); URL_PELO_PROXY=""
endereco_pelo_proxy() {
    local endereco porta
    endereco="$(valor_no_env ENDERECO_PROXY)"
    case "${endereco:-:80}" in
        :*)
            porta="$(valor_no_env PORTA_HTTP)"
            URL_PELO_PROXY="http://127.0.0.1:${porta:-80}/health"
            PELO_PROXY=("$URL_PELO_PROXY") ;;
        *)
            porta="$(valor_no_env PORTA_HTTPS)"
            URL_PELO_PROXY="https://$endereco:${porta:-443}/health"
            PELO_PROXY=(--resolve "$endereco:${porta:-443}:127.0.0.1" "$URL_PELO_PROXY") ;;
    esac
}

loja_abre_pelo_proxy() {  # loja_abre_pelo_proxy <tentativas>
    local i
    command -v curl >/dev/null 2>&1 || return 1
    for i in $(seq 1 "$1"); do
        if curl -fsS -k -o /dev/null --max-time 5 "${PELO_PROXY[@]}" >/dev/null 2>&1; then return 0; fi
        if [ "$i" -lt "$1" ]; then sleep 2; fi
    done
    return 1
}

id_do_proxy() { dk compose ps -q proxy 2>/dev/null | head -1 || true; }

# O que a atualização trocou na pasta do Caddyfile (montada inteira no proxy: docker/caddy/).
caddyfile_mudou() { ! git diff --quiet "$1" "$2" -- docker/caddy 2>/dev/null; }

# O proxy só lê o Caddyfile ao subir, e o `up` só o recria quando muda a configuração DELE no
# compose: um Caddyfile novo (a CSP, o /demo) ficaria esperando o próximo reboot, numa hora que
# ninguém escolheu. Antes de recarregar, confere: recarregado quebrado, o Caddy recusaria e
# seguiria com o de antes — mas o arquivo quebrado ficaria no disco, esperando o próximo
# reinício para derrubar a loja.
recarregar_proxy() {
    local saida
    if ! saida="$(dk compose exec -T proxy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile 2>&1)"; then
        aviso "O Caddyfile não passou na conferência do proxy:"
        printf '%s\n' "$saida" | tail -5 | sed 's/^/    /'
        return 1
    fi
    if ! saida="$(dk compose exec -T proxy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile 2>&1)"; then
        aviso "O proxy não aceitou o Caddyfile novo:"
        printf '%s\n' "$saida" | tail -5 | sed 's/^/    /'
        return 1
    fi
    return 0
}

# ------------------------------------------------------------------ a demonstração

# Avisa no terminal e no celular: a demonstração é a vitrine da revisão da Apple, e ela fora
# do ar ninguém nota até a Apple recusar.
avisar_demo() {
    aviso "$1"
    aviso "A loja está atualizada e no ar; ela não depende da demonstração."
    printf '  Veja: %sdocker compose logs --tail 50 api-demo%s   e religue: %s./demo.sh --ligar%s\n' \
        "$FORTE" "$NORMAL" "$FORTE" "$NORMAL"
    if [ -x ./notificar.sh ]; then
        ./notificar.sh --assunto demo-na-atualizacao "A demonstração não subiu" \
            "A loja foi atualizada e está no ar, mas a demonstração (/demo) não: $1 Veja: docker compose logs --tail 50 api-demo" \
            >/dev/null 2>&1 || true
    fi
}

# A segunda fase: só os serviços da demonstração, pelo nome, depois de a loja estar de pé e
# conferida. Nada daqui volta atrás: a demonstração é descartável, a loja não.
DEMO_SITUACAO=""
subir_demo() {
    demo_ligada || return 0
    titulo "Subindo a demonstração (/demo)"
    if ! dk compose up -d demo-banco api-demo; then
        DEMO_SITUACAO="não subiu"
        avisar_demo "A demonstração não subiu."
        return 0
    fi
    if esperar_saude 60 api-demo /demo/health >/dev/null; then
        DEMO_SITUACAO="no ar"
        ok "a demonstração respondeu"
    else
        DEMO_SITUACAO="não respondeu"
        avisar_demo "A demonstração subiu, mas não respondeu ao /health."
    fi
}

# ------------------------------------------------------------------ voltar atrás

voltar_atras() {
    local revisao_agora="" proxy_antes
    erro "A atualização falhou. Voltando para a versão anterior."
    # Antes de tudo: mesmo que a volta morra no meio, a próxima conferida já sabe que esta
    # versão não sobe aqui, e não derruba a loja de novo para descobrir outra vez.
    mkdir -p "$ESTADO"
    printf '%s\n' "$DEPOIS" > "$FALHOU"
    git reset --hard --quiet "$ANTES"
    # Agora a instalada é a velha e existe uma nova parada no GitHub: a tela precisa dizer
    # isso, senão ninguém descobre que a loja ficou para trás numa madrugada.
    anotar_versao false
    limpar_orfaos
    proxy_antes="$(id_do_proxy)"
    # `|| true`: subir a de antes que falha não pode calar o resto — a espera e o recado abaixo
    # são o que diz à pessoa o que aconteceu.
    dk compose up -d --build --remove-orphans db api proxy 2>&1 | tail -3 || true
    # O proxy que não foi recriado agora ainda roda o Caddyfile da versão desfeita, se ela o
    # tinha aplicado: volta para o de antes, que já estava no ar.
    if caddyfile_mudou "$ANTES" "$DEPOIS" && [ "$(id_do_proxy)" = "$proxy_antes" ]; then
        recarregar_proxy || aviso "o proxy não recarregou o Caddyfile de antes: docker compose restart proxy"
    fi

    # Esperar aqui também, e não só no caminho feliz: dizer "voltou" enquanto o
    # contêiner ainda sobe faz a pessoa abrir o site, ver erro e achar que perdeu a loja.
    printf '\n  aguardando a loja voltar…\n'
    if esperar_saude 30 >/dev/null; then
        printf '  %s✓ O sistema voltou para a versão de antes e está no ar.%s\n' "$VERDE" "$NORMAL"
        [ -n "$ARQUIVO_BACKUP" ] && printf '  A cópia do banco de antes está em %s\n' "$ARQUIVO_BACKUP"
    elif [ -n "$ARQUIVO_BACKUP" ] && [ -n "$REVISAO_ANTES" ] \
        && revisao_agora="$(revisao_do_banco || true)" && [ -n "$revisao_agora" ] \
        && [ "$revisao_agora" != "$REVISAO_ANTES" ]; then
        # O contêiner novo chegou a aplicar uma migration, e o código velho não sabe ler o
        # banco assim: o alembic dele não acha a revisão nova ("Can't locate revision") e a
        # API não sobe. Voltar o código sem voltar o banco deixava a loja fora até alguém
        # mexer à mão. A cópia de antes da atualização é o banco que esta versão conhece; o
        # --restaurar guarda o de agora antes de trocar (com o que se vendeu no meio tempo).
        aviso "Uma migration da versão nova chegou a rodar, e a anterior não sobe com o banco assim."
        aviso "Voltando o banco para a cópia de antes da atualização: $ARQUIVO_BACKUP"
        if ./backup.sh --restaurar "$ARQUIVO_BACKUP" --sim; then
            printf '  %s✓ Código e banco voltaram para antes da atualização, e a loja está no ar.%s\n' \
                "$VERDE" "$NORMAL"
        else
            printf '  %s✗ A versão anterior não subiu nem com o banco de antes.%s\n' "$VERMELHO" "$NORMAL"
            printf '  Veja o que aconteceu com: %sdocker compose logs --tail 50 api%s\n' "$FORTE" "$NORMAL"
        fi
    else
        printf '  %s✗ A versão anterior também não subiu.%s\n' "$VERMELHO" "$NORMAL"
        printf '  Veja o que aconteceu com: %sdocker compose logs --tail 50 api%s\n' "$FORTE" "$NORMAL"
        [ -n "$ARQUIVO_BACKUP" ] && printf '  A cópia do banco de antes está em %s\n' "$ARQUIVO_BACKUP"
    fi
    # A demonstração não é tocada: ela só passa para a versão nova na segunda fase (subir_demo),
    # depois de a loja estar de pé e conferida, e toda volta atrás vem antes dela. O `up` da
    # primeira fase e o daqui só nomeiam db, api e proxy, então ela segue na imagem e no banco
    # de antes — apagá-la e semeá-la de novo só a tirava do ar e derrubava a sessão de quem
    # estava nela (o revisor da Apple inclusive).
    printf '  A versão %s não será tentada de novo sozinha: a próxima é quando chegar um commit\n' \
        "$(git rev-parse --short "$DEPOIS")"
    printf '  novo no GitHub.\n'
    printf '  Mande a mensagem de erro acima para quem cuida do sistema.\n\n'
    exit 1
}

titulo "Baixando a versão nova"
# Gravado ANTES de mexer no disco: daqui até o /health responder, quem está no ar é a de
# antes, com uma nova esperando — e é isso que a tela diz e a próxima execução lê se esta
# morrer no meio. No servidor que ainda não tinha registro, é esta linha que cria o primeiro.
gravar_implantado "$ANTES"
anotar_versao false "$ANTES"
# Antes de mexer: a loja abre pelo proxy agora? Só uma loja que abria pode ter sido derrubada
# por esta atualização. Se já não abria (sem curl, porta bloqueada, um problema de antes), a
# conferida de depois não serve de juiz — senão toda atualização daqui para frente voltaria
# atrás por um defeito que não é dela.
endereco_pelo_proxy
PROXY_RESPONDIA=0
if loja_abre_pelo_proxy 1; then PROXY_RESPONDIA=1; fi
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
# difícil de entender. Só os serviços DA LOJA, pelo nome: a demonstração sobe depois, e o
# que acontece com ela nunca decide se esta atualização fica ou volta.
REVISAO_ANTES="$(revisao_do_banco || true)"
limpar_orfaos
PROXY_ANTES="$(id_do_proxy)"
if ! dk compose up -d --build --remove-orphans db api proxy; then
    voltar_atras
fi
PROXY_DEPOIS="$(id_do_proxy)"

# ------------------------------------------------------------------ conferir

titulo "Conferindo se a loja voltou"
# Quem aplica as migrations é o entrada.sh do contêiner, ao subir, e a API só responde ao
# /health depois que elas terminaram — por isso esperar o /health basta. Este script rodava
# um segundo `alembic upgrade head` por `exec`, e os dois corriam JUNTOS (o `up -d` não
# espera o contêiner ficar pronto, e o alembic não tem trava): quando as transações se
# cruzavam, o daqui caía em UniqueViolation e uma atualização boa virava volta atrás. Mais
# tempo de espera que antes, porque agora a migration corre dentro dele.

URL_LOCAL="http://localhost:$(grep -E '^PORTA_HTTP=' .env | cut -d= -f2 || echo 80)"

if ! SAUDE="$(esperar_saude 60)"; then
    # O motivo (uma migration que falhou, um import quebrado) está no log do contêiner;
    # mostrar aqui é o que mantém o erro NESTE terminal, e não escondido lá.
    dk compose logs --tail 30 api 2>&1 | sed 's/^/    /' || true
    voltar_atras
fi
ok "migrations aplicadas e a API respondeu: $SAUDE"

# O Caddyfile novo, se veio um: recriado agora, o proxy já subiu com ele; senão, conferido e
# recarregado. Que não passa na conferência é versão quebrada — volta atrás inteira, para o
# arquivo ruim não ficar no disco esperando o próximo reinício do proxy.
if caddyfile_mudou "$ANTES" "$DEPOIS"; then
    if [ "$PROXY_DEPOIS" != "$PROXY_ANTES" ]; then
        ok "Caddyfile novo: o proxy foi recriado e já subiu com ele"
    elif recarregar_proxy; then
        ok "Caddyfile novo conferido e aplicado ao proxy"
    else
        voltar_atras
    fi
fi

if ! command -v curl >/dev/null 2>&1; then
    aviso "Sem o curl nesta máquina, não deu para conferir a loja pelo proxy."
elif [ "$PROXY_RESPONDIA" -eq 1 ]; then
    if ! loja_abre_pelo_proxy 15; then
        erro "A API responde por dentro, mas a loja não abre pelo proxy ($URL_PELO_PROXY)."
        dk compose logs --tail 20 proxy 2>&1 | sed 's/^/    /' || true
        voltar_atras
    fi
    ok "a loja abre pelo proxy ($URL_PELO_PROXY)"
elif loja_abre_pelo_proxy 15; then
    ok "a loja abre pelo proxy ($URL_PELO_PROXY)"
else
    aviso "A loja não abre pelo proxy ($URL_PELO_PROXY) — e já não abria antes desta atualização."
    aviso "Veja o porquê com: ./diagnostico.sh"
fi
# Só agora a versão nova é a que está no ar.
gravar_implantado "$DEPOIS"
rm -f "$FALHOU"
anotar_versao true

subir_demo

# Cada `--build` deixa a imagem antiga para trás, sem nome, ocupando disco. Vinte
# atualizações depois são vários GB — e num servidor de loja o disco acaba antes.
# `image prune -f` sem `-a` só apaga imagem órfã: nada em uso, nenhum dado, nada de volume.
# Depois da demonstração: até ela ser recriada, a imagem antiga ainda era dela.
LIXO="$(dk image prune -f 2>/dev/null | grep -i 'reclaimed' | sed 's/.*: *//')"
[ -n "$LIXO" ] && [ "$LIXO" != "0B" ] && ok "disco liberado das imagens antigas: $LIXO"

# Backup a cada atualização é o certo; guardar TODOS eles não é. Com a atualização sozinha
# ligada isso vira um dump por versão nova, para sempre, até o disco encher — e disco cheio
# derruba o Postgres. Ficam os 5 últimos, que cobrem qualquer volta atrás plausível.
GUARDAR=5
# O padrão é o nome COMPLETO que este script usa: `loja-backup-*.dump` pegaria também os
# backups do desinstalador, que são de quem os fez, não meus para apagar.
# `|| true`: sem dump nenhum (--sem-backup num servidor novo), o `ls` sai 2 e, com
# `pipefail`, o script morria AQUI — atualizado, mas sem o "✓ Atualizado" e com o serviço
# do systemd marcado como falho.
SOBRANDO="$(ls -1t loja-backup-antes-de-atualizar-*.dump 2>/dev/null | tail -n +$((GUARDAR + 1)) || true)"
if [ -n "$SOBRANDO" ]; then
    printf '%s\n' "$SOBRANDO" | xargs -r rm -f
    ok "backups antigos apagados (ficam os $GUARDAR mais novos)"
fi
# O mesmo para os logs guardados antes de cada reconstrução.
ls -1t loja-backup-log-antes-de-atualizar-*.txt 2>/dev/null | tail -n +$((GUARDAR + 1)) | xargs -r rm -f || true

# ------------------------------------------------------------------ pronto

printf '\n%s%s✓ Atualizado.%s\n' "$FORTE" "$VERDE" "$NORMAL"
printf '  De %s para %s (%s %s).\n' \
    "$(git rev-parse --short "$ANTES")" "$(git rev-parse --short "$DEPOIS")" \
    "$QUANTOS" "$([ "$QUANTOS" -eq 1 ] && echo mudança || echo mudanças)"
printf '  Endereço: %s\n' "$URL_LOCAL"
[ -n "$DEMO_SITUACAO" ] && printf '  Demonstração (/demo): %s\n' "$DEMO_SITUACAO"
[ -n "$ARQUIVO_BACKUP" ] && printf '  Backup de antes: %s\n' "$ARQUIVO_BACKUP"
printf '\n  %sNo celular:%s feche e abra o app para pegar a versão nova.\n' "$FORTE" "$NORMAL"
printf '  %sNo balcão:%s aperte Ctrl+F5 no navegador.\n\n' "$FORTE" "$NORMAL"
