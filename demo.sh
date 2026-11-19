#!/usr/bin/env bash
#
# A demonstração da loja, em <endereço>/demo (ADR-46): outra API, outro banco e outra conta,
# só com dados fictícios. É ela que a revisão da Apple usa — e quem quer conhecer o sistema —
# sem chegar perto da loja de verdade: a conta da demonstração não entra na loja.
#
#     ./demo.sh --mostrar            endereço, e-mail e senha (e o que levar à Apple)
#     ./demo.sh --ligar              liga: completa o .env, sobe e agenda a renovação
#     ./demo.sh --renovar            volta os dados fictícios ao começo, agora
#     ./demo.sh --desligar           desliga; o banco e a senha ficam guardados
#     ./demo.sh --desligar --apagar  desliga e apaga tudo dela: banco, fotos e senhas
#     ./demo.sh --automatico         renova sozinha todo dia às 04:30, no fuso da loja
#     ./demo.sh --sem-automatico     para de renovar sozinha
#
# Opções:
#   --sim   não pergunta nada (sem ele, o --apagar pede confirmação)
#
# Numa instalação nova a demonstração já vem ligada pelo ./instalar.sh (o --sem-demo a deixa
# desligada). O .env só é escrito por ele e por este script.

set -euo pipefail
cd "$(dirname "$0")"

# O .env carrega senhas: tudo que este script cria nele é só do dono do arquivo. Quem grava
# as unidades do systemd volta para 022 lá embaixo, onde é preciso.
umask 077

# Quais serviços sobem é o COMPOSE_PROFILES do .env. Uma variável exportada no terminal
# venceria o arquivo para o `docker compose` — e o `sudo docker` a jogaria fora —, cada
# execução valendo uma coisa. Aqui manda o .env, sempre.
unset COMPOSE_PROFILES

VERDE=$'\033[32m'; AMARELO=$'\033[33m'; VERMELHO=$'\033[31m'; AZUL=$'\033[36m'
FORTE=$'\033[1m'; NORMAL=$'\033[0m'
[ -t 1 ] || { VERDE=""; AMARELO=""; VERMELHO=""; AZUL=""; FORTE=""; NORMAL=""; }

titulo() { printf '\n%s%s%s\n' "$FORTE$AZUL" "$1" "$NORMAL"; }
ok()     { printf '  %s✓%s %s\n' "$VERDE" "$NORMAL" "$1"; }
aviso()  { printf '  %s!%s %s\n' "$AMARELO" "$NORMAL" "$1"; }
erro()   { printf '\n%s✗ %s%s\n' "$VERMELHO" "$1" "$NORMAL" >&2; }

ACAO="mostrar"; APAGAR=0; INTERATIVO=1
while [ $# -gt 0 ]; do
    case "$1" in
        --mostrar)        ACAO="mostrar" ;;
        --ligar)          ACAO="ligar" ;;
        --renovar)        ACAO="renovar" ;;
        --desligar)       ACAO="desligar" ;;
        --apagar)         APAGAR=1 ;;
        --automatico)     ACAO="automatico" ;;
        --sem-automatico) ACAO="sem-automatico" ;;
        --sim|-y)         INTERATIVO=0 ;;
        -h|--help)        sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *)                erro "Opção desconhecida: $1"; exit 1 ;;
    esac
    shift
done
if [ "$APAGAR" -eq 1 ] && [ "$ACAO" != "desligar" ]; then
    erro "--apagar só vale junto com --desligar: ./demo.sh --desligar --apagar"
    exit 1
fi

[ -f docker-compose.yml ] || { erro "Rode este script de dentro da pasta do sistema."; exit 1; }

#: A conta do revisor. `.example` é reservado (RFC 2606): o e-mail nunca é de ninguém, e
#: ninguém o confunde com a conta de uma pessoa da loja.
EMAIL_DA_DEMO="dono@demo.example"
BANCO_DA_DEMO="loja_demo"
VOLUME_DE_FOTOS="loja_fotos-da-demo"
HORA_DA_RENOVACAO="04:30"

DIR_SYSTEMD="${DIR_SYSTEMD:-/etc/systemd/system}"
PASTA="$(pwd)"
SERVICO="$DIR_SYSTEMD/loja-demo-renovar.service"
TIMER="$DIR_SYSTEMD/loja-demo-renovar.timer"

sudo_se_preciso() { if [ "$(id -u)" -eq 0 ]; then "$@"; else sudo "$@"; fi; }

# ------------------------------------------------------------------ o .env
#
# Espelho do bloco de mesmo nome no ./instalar.sh: os dois escrevem o .env, e uma conta da
# demonstração gerada de um jeito num e de outro no outro é a que não entra na Apple.

valor_no_env() { grep -E "^$1=" .env 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"' || true; }
tem_no_env()   { grep -qE "^$1=" .env 2>/dev/null; }

# A cópia que vira o .env nasce ao lado dele, 600, e o substitui de uma vez: nem um instante
# com senha legível, nem um .env pela metade se a máquina cair no meio.
TEMPORARIO=""
trap 'if [ -n "${TEMPORARIO:-}" ]; then rm -f -- "$TEMPORARIO"; fi' EXIT
trocar_o_env() {  # o novo conteúdo já está em $TEMPORARIO
    chmod 600 "$TEMPORARIO"
    mv -f "$TEMPORARIO" .env
    TEMPORARIO=""
}

gravar_no_env() {  # gravar_no_env CHAVE VALOR — troca o valor, ou acrescenta a chave no fim
    TEMPORARIO="$(mktemp ./.env.XXXXXX)"
    if tem_no_env "$1"; then
        # ENVIRON e não -v: o awk interpretaria barras invertidas de um valor passado por -v.
        CHAVE="$1" VALOR="$2" awk 'index($0, ENVIRON["CHAVE"] "=") == 1 {
                if (!feito) print ENVIRON["CHAVE"] "=" ENVIRON["VALOR"]; feito = 1; next
            } { print }' .env > "$TEMPORARIO"
    else
        { cat .env; if [ -n "$(tail -c1 .env)" ]; then printf '\n'; fi
          printf '%s=%s\n' "$1" "$2"; } > "$TEMPORARIO"
    fi
    trocar_o_env
}

acrescentar_no_env() {  # acrescentar_no_env LINHA... — no fim, mesmo sem \n na última linha
    TEMPORARIO="$(mktemp ./.env.XXXXXX)"
    { cat .env; if [ -n "$(tail -c1 .env)" ]; then printf '\n'; fi
      printf '%s\n' "$@"; } > "$TEMPORARIO"
    trocar_o_env
}

tirar_do_env() {  # tirar_do_env REGEX — tira as linhas que casam
    TEMPORARIO="$(mktemp ./.env.XXXXXX)"
    grep -vE "$1" .env > "$TEMPORARIO" || true
    trocar_o_env
}

# O COMPOSE_PROFILES é uma lista separada por vírgula; "demo" é o perfil da demonstração.
tem_demo() { case ",$1," in *,demo,*) return 0 ;; *) return 1 ;; esac; }
com_demo() { if tem_demo "$1"; then printf '%s' "$1"; else printf '%s' "${1:+$1,}demo"; fi; }
sem_demo() {
    printf '%s' "$1" | awk -F, '{ s = ""; for (i = 1; i <= NF; i++)
        if ($i != "demo" && $i != "") s = s (s == "" ? "" : ",") $i; print s }'
}
demo_ligada() { tem_demo "$(valor_no_env COMPOSE_PROFILES)"; }

sortear() {
    if command -v openssl >/dev/null 2>&1; then
        openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c "${1:-32}"
    elif command -v python3 >/dev/null 2>&1; then
        python3 -c "import secrets,sys;print(secrets.token_urlsafe(64)[:int(sys.argv[1])])" "${1:-32}"
    else
        head -c 200 /dev/urandom | tr -dc 'A-Za-z0-9' | head -c "${1:-32}"
    fi
}

# As duas linhas que abrem o bloco da demonstração no .env (o --apagar as tira junto), e a
# que o ./instalar.sh deixa quando ela fica de fora.
COMENTARIO_DA_DEMO=(
    "# Demonstração em /demo (ADR-46): outra API, outro banco e outra conta, só com dados fictícios."
    "# Demonstração: endereço e senha com ./demo.sh --mostrar; desligar com ./demo.sh --desligar."
)
COMENTARIO_DA_DEMO_DESLIGADA="# Demonstração em /demo (ADR-46) desligada. Para ligar: ./demo.sh --ligar."

# Completa o .env com o que a demonstração precisa e ainda não está lá, e liga o perfil. O
# que já existe NÃO muda: a senha da conta é a que está na Apple, e trocá-la sem ninguém ver
# deixaria o revisor de fora. SENHA_DEMO_NOVA=1 diz que a senha nasceu agora — a única vez em
# que ela aparece sem alguém pedir.
completar_env_da_demo() {
    local banco jwt jwt_da_loja email senha bloco
    SENHA_DEMO_NOVA=0
    banco="$(valor_no_env DEMO_SENHA_BANCO)"
    jwt="$(valor_no_env DEMO_JWT_SECRET)"
    jwt_da_loja="$(valor_no_env JWT_SECRET)"
    email="$(valor_no_env DEMO_ADMIN_EMAIL)"
    senha="$(valor_no_env DEMO_ADMIN_SENHA)"
    [ -n "$banco" ] || banco="$(sortear 32)"
    # NUNCA o segredo da loja: o token só leva o id do usuário, e com o mesmo segredo o token
    # da conta de demonstração (senha nas notas da Apple) valeria na loja como o mesmo id.
    while [ -z "$jwt" ] || [ "$jwt" = "$jwt_da_loja" ]; do jwt="$(sortear 64)"; done
    [ -n "$email" ] || email="$EMAIL_DA_DEMO"
    if [ -z "$senha" ]; then senha="$(sortear 20)"; SENHA_DEMO_NOVA=1; fi
    if [ -z "$banco" ] || [ -z "$senha" ]; then erro "Não consegui sortear as senhas da demonstração."; exit 1; fi

    # O recado de "desligada" (de um --sem-demo) deixa de valer.
    if grep -qF "$COMENTARIO_DA_DEMO_DESLIGADA" .env; then tirar_do_env "^# Demonstração em /demo \(ADR-46\) desligada"; fi
    if ! grep -qE '^DEMO_[A-Z_]+=' .env; then
        # .env de antes da demonstração: o bloco inteiro, com o recado de onde mexer.
        bloco=("" "${COMENTARIO_DA_DEMO[@]}")
        tem_no_env COMPOSE_PROFILES || bloco+=("COMPOSE_PROFILES=demo")
        bloco+=("DEMO_SENHA_BANCO=$banco" "DEMO_JWT_SECRET=$jwt"
                "DEMO_ADMIN_EMAIL=$email" "DEMO_ADMIN_SENHA=$senha")
        acrescentar_no_env "${bloco[@]}"
    else
        gravar_no_env DEMO_SENHA_BANCO "$banco"
        gravar_no_env DEMO_JWT_SECRET "$jwt"
        gravar_no_env DEMO_ADMIN_EMAIL "$email"
        gravar_no_env DEMO_ADMIN_SENHA "$senha"
    fi
    gravar_no_env COMPOSE_PROFILES "$(com_demo "$(valor_no_env COMPOSE_PROFILES)")"
}

# O endereço que o navegador e o app usam. A mesma regra do resumo do ./instalar.sh: o
# ENDERECO_PROXY ":80" é a instalação local (HTTP, nesta máquina); o resto é o domínio.
endereco_da_demo() {
    local endereco porta
    endereco="$(valor_no_env ENDERECO_PROXY)"
    case "${endereco:-:80}" in
        :*)
            porta="$(valor_no_env PORTA_HTTP)"
            if [ "${porta:-80}" = "80" ]; then printf 'http://localhost/demo'
            else printf 'http://localhost:%s/demo' "$porta"; fi ;;
        *)  printf 'https://%s/demo' "$endereco" ;;
    esac
}

# ------------------------------------------------------------------ o Docker

PREFIXO_DOCKER=""
dk() { if [ -n "$PREFIXO_DOCKER" ]; then sudo docker "$@"; else docker "$@"; fi; }

falar_com_o_docker() {
    if docker info >/dev/null 2>&1; then PREFIXO_DOCKER=""; return 0; fi
    if command -v sudo >/dev/null 2>&1 && sudo -n docker info >/dev/null 2>&1; then
        PREFIXO_DOCKER="sudo"; return 0
    fi
    if [ "$INTERATIVO" -eq 1 ] && command -v sudo >/dev/null 2>&1 && sudo docker info >/dev/null 2>&1; then
        PREFIXO_DOCKER="sudo"; return 0
    fi
    return 1
}

precisa_do_docker() {
    falar_com_o_docker && return 0
    erro "Não consegui falar com o Docker. Ele está rodando?"
    exit 1
}

precisa_do_env() {
    [ -f .env ] && return 0
    erro "Não achei o .env. A loja já foi instalada com ./instalar.sh?"
    exit 1
}

# O /health da demonstração, de dentro do contêiner dela (o caminho leva o /demo: a API da
# demonstração só responde debaixo do prefixo).
demo_responde() {
    dk compose exec -T api-demo python -c \
        'import urllib.request; urllib.request.urlopen("http://127.0.0.1:8000/demo/health", timeout=5)' \
        >/dev/null 2>&1
}

esperar_demo() {  # esperar_demo <tentativas>
    local i
    for i in $(seq 1 "$1"); do
        demo_responde && return 0
        if [ "$i" -lt "$1" ]; then sleep 2; fi
    done
    return 1
}

# O proxy só lê o Caddyfile ao subir. Uma loja que recebeu o /demo por uma atualização em que
# o proxy não foi recriado ainda roda o Caddyfile de antes — e ali /demo não leva à
# demonstração. Conferido antes de recarregar: um Caddyfile que não passa nunca troca o que
# está no ar.
recarregar_proxy() {
    dk compose exec -T proxy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 \
        && dk compose exec -T proxy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1
}

# ------------------------------------------------------------------ renovar sozinha

fuso_da_loja() {
    local fuso
    fuso="$(valor_no_env TIMEZONE_LOJA)"
    fuso="${fuso:-America/Sao_Paulo}"
    # Só um fuso que esta máquina conhece vai para a unidade: com um nome que o systemd não
    # entende, o timer inteiro não carrega — e a renovação nunca acontece, calada.
    if printf '%s' "$fuso" | grep -Eq '^[A-Za-z0-9_+-]+(/[A-Za-z0-9_+-]+)*$' \
        && [ -f "/usr/share/zoneinfo/$fuso" ]; then
        printf '%s' "$fuso"
    fi
}

ligar_automatico() {
    local fuso
    titulo "Renovação diária da demonstração"
    if ! command -v systemctl >/dev/null 2>&1 || ! sudo_se_preciso systemctl daemon-reload >/dev/null 2>&1; then
        aviso "Este servidor não tem o systemd respondendo: a renovação diária não foi agendada."
        printf '  Alternativa, no cron do root (%scrontab -e%s):\n\n' "$FORTE" "$NORMAL"
        printf '    30 4 * * * cd %s && ./demo.sh --renovar >> /var/log/loja-demo.log 2>&1\n\n' "$PASTA"
        return 1
    fi
    fuso="$(fuso_da_loja)"
    [ -n "$fuso" ] || aviso "o fuso do .env não é conhecido nesta máquina: 04:30 no horário do servidor."
    umask 022
    # Falhou? Avisa o dono (ntfy, ou o journal), pela unidade-modelo do notificar.sh.
    DIR_SYSTEMD="$DIR_SYSTEMD" ./notificar.sh --instalar \
        || aviso "não consegui gravar o aviso de falha (loja-aviso@); a renovação liga mesmo assim"
    sudo_se_preciso tee "$SERVICO" >/dev/null <<UNIDADE
[Unit]
Description=Volta a demonstração da loja ao começo (dados fictícios de novo)
After=docker.service
OnFailure=loja-aviso@%N.service

[Service]
Type=oneshot
WorkingDirectory=$PASTA
Environment=HOME=/root
ExecStart=$PASTA/demo.sh --renovar
TimeoutStartSec=900
UNIDADE
    # Sem Persistent=: renovar é refazer a vitrine, e a renovação perdida (servidor desligado
    # às 04:30) rodaria na volta — no meio do dia, talvez no meio de uma revisão da Apple.
    sudo_se_preciso tee "$TIMER" >/dev/null <<UNIDADE
[Unit]
Description=Renova a demonstração da loja todo dia às $HORA_DA_RENOVACAO${fuso:+ ($fuso)}

[Timer]
OnCalendar=*-*-* $HORA_DA_RENOVACAO:00${fuso:+ $fuso}

[Install]
WantedBy=timers.target
UNIDADE
    umask 077
    if ! sudo_se_preciso systemctl daemon-reload \
        || ! sudo_se_preciso systemctl enable --now loja-demo-renovar.timer >/dev/null 2>&1; then
        erro "Não consegui ligar a renovação diária da demonstração."
        sudo_se_preciso rm -f "$TIMER" "$SERVICO"
        return 1
    fi
    ok "todo dia às $HORA_DA_RENOVACAO${fuso:+ ($fuso)}: os dados fictícios voltam ao começo"
    printf '  Ver o que aconteceu: %sjournalctl -u loja-demo-renovar -n 30%s\n' "$FORTE" "$NORMAL"
}

desligar_automatico() {
    if [ ! -f "$TIMER" ] && [ ! -f "$SERVICO" ]; then return 1; fi
    sudo_se_preciso systemctl disable --now loja-demo-renovar.timer >/dev/null 2>&1 || true
    sudo_se_preciso rm -f "$TIMER" "$SERVICO"
    sudo_se_preciso systemctl daemon-reload >/dev/null 2>&1 || true
    ok "renovação diária desligada"
}

# ------------------------------------------------------------------ as ações

mostrar() {
    local email senha endereco local_=0 situacao
    precisa_do_env
    email="$(valor_no_env DEMO_ADMIN_EMAIL)"
    senha="$(valor_no_env DEMO_ADMIN_SENHA)"
    if [ -z "$senha" ]; then
        aviso "Esta instalação não tem demonstração. Para ligar: ./demo.sh --ligar"
        exit 1
    fi
    endereco="$(endereco_da_demo)"
    case "$endereco" in http://localhost*) local_=1 ;; esac
    if ! demo_ligada; then
        situacao="${VERMELHO}DESLIGADA${NORMAL} — para ligar: ./demo.sh --ligar"
    elif falar_com_o_docker && demo_responde; then
        situacao="${VERDE}ligada e respondendo${NORMAL}"
    else
        situacao="${AMARELO}ligada, mas não respondeu agora${NORMAL} (veja: docker compose logs --tail 50 api-demo)"
    fi

    titulo "Demonstração da loja (dados fictícios; a conta dela não entra na loja)"
    printf '\n  Endereço:  %s%s%s\n' "$FORTE" "$endereco" "$NORMAL"
    printf '  Situação:  %s\n' "$situacao"
    printf '  Entrar:    %s\n' "${email:-$EMAIL_DA_DEMO}"
    printf '  Senha:     %s%s%s\n' "$FORTE" "$senha" "$NORMAL"

    titulo "Para a revisão da Apple (no GitHub do projeto)"
    if [ "$local_" -eq 1 ]; then
        aviso "A Apple só alcança um endereço https:// na internet. Nesta instalação local a"
        aviso "demonstração serve para testar aqui; com um domínio: ./instalar.sh --forcar --dominio ..."
    fi
    printf '  Settings > Secrets and variables > Actions > Variables:\n'
    printf '      APPLE_SERVIDOR_DEMO = %s\n' "$endereco"
    printf '      APPLE_EMAIL_DEMO    = %s\n' "${email:-$EMAIL_DA_DEMO}"
    printf '  A senha: Actions > "Senha da conta demo na Apple", com a senha acima\n'
    printf '  (ou o Secret APPLE_DEMO_PASSWORD).\n\n'
    printf '  A senha só muda com ./demo.sh --desligar --apagar; aí ela volta a ser sorteada.\n\n'
}

ligar() {
    precisa_do_env
    precisa_do_docker
    titulo "Ligando a demonstração"
    completar_env_da_demo
    ok "configuração da demonstração no .env (só o dono do arquivo lê)"
    if [ "$SENHA_DEMO_NOVA" -eq 1 ]; then
        aviso "a conta da demonstração ganhou senha nova: ela vai para a Apple (veja no fim)"
    fi
    if ! recarregar_proxy; then
        aviso "não consegui recarregar o proxy; se /demo não abrir: docker compose restart proxy"
    fi

    titulo "Subindo a demonstração"
    # Só os serviços dela, pelo nome: nada da loja é recriado para a vitrine subir.
    if ! dk compose up -d demo-banco api-demo; then
        erro "A demonstração não subiu (a loja não depende dela e segue no ar)."
        printf '  Veja o motivo com: %sdocker compose logs --tail 50 api-demo%s\n\n' "$FORTE" "$NORMAL"
        exit 1
    fi
    # A primeira subida migra e carrega os dados fictícios antes de responder.
    if esperar_demo 90; then
        ok "a demonstração respondeu"
    else
        aviso "a demonstração ainda não respondeu — a primeira carga dos dados leva alguns minutos."
    fi
    ligar_automatico || aviso "sem a renovação diária; renove quando quiser com ./demo.sh --renovar"
    mostrar
}

renovar() {
    precisa_do_env
    if ! demo_ligada; then
        ok "A demonstração está desligada: nada a renovar."
        exit 0
    fi
    precisa_do_docker
    titulo "Renovando a demonstração"
    # O comando confere sozinho que o banco é o da demonstração (o marco que só ele tem) e
    # nunca imprime senha nem a URL do banco: a saída vai para o journal.
    if ! dk compose exec -T api-demo python -m app.cli renovar-demonstracao; then
        erro "A renovação da demonstração falhou (o motivo está logo acima)."
        printf '  Veja também: %sdocker compose logs --tail 50 api-demo%s\n\n' "$FORTE" "$NORMAL"
        exit 1
    fi
    ok "dados fictícios de volta ao começo"
}

desligar() {
    local perfis resposta=""
    precisa_do_env
    precisa_do_docker
    if [ "$APAGAR" -eq 1 ] && [ "$INTERATIVO" -eq 1 ]; then
        printf '\n  Isto apaga o banco da demonstração, as fotos dela e a senha da conta (a que\n'
        printf '  está na Apple: depois de religar, ela é outra). A loja não é tocada.\n'
        printf '  Digite %sAPAGAR%s para confirmar: ' "$FORTE" "$NORMAL"
        read -r resposta || true
        [ "$resposta" = "APAGAR" ] || { printf '  Cancelado (nada foi mudado).\n\n'; exit 1; }
    fi

    titulo "Desligando a demonstração"
    # Pelo nome, e com o perfil dela: tirar "demo" do .env sozinho não desliga nada — o `up`
    # nunca derruba serviço de perfil desligado, e ela seguiria no ar, com a imagem velha.
    if dk compose --profile demo rm -sf api-demo demo-banco >/dev/null 2>&1; then
        ok "contêineres da demonstração parados e removidos"
    else
        aviso "não consegui remover os contêineres da demonstração (veja: docker compose ps -a)"
    fi
    # O .env decide o que sobe no próximo `up` (o da atualização, inclusive). A linha fica,
    # mesmo vazia: ela diz que a demonstração foi desligada de propósito, e o ./instalar.sh
    # não a liga de novo por conta própria.
    perfis="$(valor_no_env COMPOSE_PROFILES)"
    if tem_demo "$perfis" || ! tem_no_env COMPOSE_PROFILES; then
        gravar_no_env COMPOSE_PROFILES "$(sem_demo "$perfis")"
    fi
    desligar_automatico || true

    if [ "$APAGAR" -eq 0 ]; then
        ok "desligada. O banco, as fotos e a senha ficam guardados: ./demo.sh --ligar volta igual"
        printf '\n'
        return 0
    fi
    # Duas instruções, não uma: DROP DATABASE não roda dentro de transação, e um -c só com as
    # duas viraria uma transação implícita.
    if dk compose exec -T db psql -U loja -d postgres -v ON_ERROR_STOP=1 -q \
            -c "DROP DATABASE IF EXISTS $BANCO_DA_DEMO WITH (FORCE)" \
            -c "DROP ROLE IF EXISTS $BANCO_DA_DEMO" >/dev/null 2>&1; then
        ok "banco da demonstração apagado"
    else
        aviso "não consegui apagar o banco da demonstração (o banco está no ar?)"
    fi
    if dk volume inspect "$VOLUME_DE_FOTOS" >/dev/null 2>&1; then
        if dk volume rm "$VOLUME_DE_FOTOS" >/dev/null 2>&1; then
            ok "fotos da demonstração apagadas"
        else
            aviso "não consegui apagar as fotos da demonstração ($VOLUME_DE_FOTOS)"
        fi
    fi
    tirar_do_env '^(DEMO_[A-Z_]+=|# Demonstração)'
    ok "senhas da demonstração tiradas do .env: religada, ela nasce de novo, com senha nova"
    printf '\n'
}

case "$ACAO" in
    mostrar)  mostrar ;;
    ligar)    ligar ;;
    renovar)  renovar ;;
    desligar) desligar ;;
    automatico)
        precisa_do_env
        ligar_automatico || exit 1
        printf '  Desligar: %s./demo.sh --sem-automatico%s\n\n' "$FORTE" "$NORMAL"
        ;;
    sem-automatico)
        titulo "Desligando a renovação diária da demonstração"
        desligar_automatico || ok "já estava desligada"
        printf '\n'
        ;;
esac
