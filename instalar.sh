#!/usr/bin/env bash
#
# Instalador do Sistema de Gestão da Loja.
#
# Pergunta o endereço, os dados do dono e a senha do banco, sobe tudo em Docker e termina
# com o sistema no ar. Rodar de novo é seguro: reaproveita o que já existe.
#
#   ./instalar.sh
#   ./instalar.sh --dominio loja.exemplo.com.br --email dona@loja.com \
#                 --nome "Dona Maria" --senha "..." --senha-banco "..." --sim
#
# Se o Docker não estiver instalado, o instalador instala. Use --sem-docker para impedir.
#
set -euo pipefail

cd "$(dirname "$0")"

VERMELHO=$'\033[31m'; VERDE=$'\033[32m'; AMARELO=$'\033[33m'
AZUL=$'\033[36m'; FORTE=$'\033[1m'; NORMAL=$'\033[0m'
if [ ! -t 1 ]; then VERMELHO=""; VERDE=""; AMARELO=""; AZUL=""; FORTE=""; NORMAL=""; fi

titulo()  { printf '\n%s%s%s\n' "$FORTE$AZUL" "$1" "$NORMAL"; }
passo()   { printf '  %s→%s %s\n' "$AZUL" "$NORMAL" "$1"; }
certo()   { printf '  %s✓%s %s\n' "$VERDE" "$NORMAL" "$1"; }
alerta()  { printf '  %s!%s %s\n' "$AMARELO" "$NORMAL" "$1"; }
morrer()  { printf '\n%s✗ %s%s\n\n' "$VERMELHO" "$1" "$NORMAL" >&2; exit 1; }

# ------------------------------------------------------------------ argumentos

DOMINIO=""; EMAIL=""; NOME=""; SENHA=""; SENHA_BANCO=""
FUSO="America/Sao_Paulo"; PORTA_HTTP="80"; PORTA_HTTPS="443"
INTERATIVO=1; FORCAR=0; INSTALAR_DOCKER=1

while [ $# -gt 0 ]; do
    case "$1" in
        --dominio)      DOMINIO="${2:-}"; shift 2 ;;
        --email)        EMAIL="${2:-}"; shift 2 ;;
        --nome)         NOME="${2:-}"; shift 2 ;;
        --senha)        SENHA="${2:-}"; shift 2 ;;
        --senha-banco)  SENHA_BANCO="${2:-}"; shift 2 ;;
        --fuso)         FUSO="${2:-}"; shift 2 ;;
        --porta-http)   PORTA_HTTP="${2:-}"; shift 2 ;;
        --porta-https)  PORTA_HTTPS="${2:-}"; shift 2 ;;
        --sim|-y)       INTERATIVO=0; shift ;;
        --forcar)       FORCAR=1; shift ;;
        --sem-docker)   INSTALAR_DOCKER=0; shift ;;
        -h|--help)      sed -n '3,11p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *)              morrer "opção desconhecida: $1" ;;
    esac
done

# ------------------------------------------------------------------ utilidades

sortear() {
    if command -v openssl >/dev/null 2>&1; then
        openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c "${1:-32}"
    elif command -v python3 >/dev/null 2>&1; then
        python3 -c "import secrets,sys;print(secrets.token_urlsafe(64)[:int(sys.argv[1])])" "${1:-32}"
    else
        head -c 200 /dev/urandom | tr -dc 'A-Za-z0-9' | head -c "${1:-32}"
    fi
}

# Um valor já informado por parâmetro nunca é perguntado de novo, e nada lê do teclado
# quando o instalador roda sem gente na frente (--sim). Sem essas duas guardas, chamar o
# instalador com --senha travava para sempre esperando uma digitação que não vinha.
perguntar() {  # perguntar <texto> <padrão> <variável>
    local texto="$1" padrao="$2" alvo="$3" resposta=""
    [ -n "${!alvo:-}" ] && return
    if [ "$INTERATIVO" -eq 0 ]; then printf -v "$alvo" '%s' "$padrao"; return; fi
    if [ -n "$padrao" ]; then
        read -r -p "  $texto [$padrao]: " resposta || true
    else
        read -r -p "  $texto: " resposta || true
    fi
    printf -v "$alvo" '%s' "${resposta:-$padrao}"
}

perguntar_senha() {  # perguntar_senha <texto> <variável>
    local texto="$1" alvo="$2" a="" b=""
    [ -n "${!alvo:-}" ] && return
    # Sem teclado, sai em branco de propósito: a validação logo abaixo diz qual
    # parâmetro faltou, em vez de o instalador ficar pendurado.
    [ "$INTERATIVO" -eq 0 ] && return
    while :; do
        read -r -s -p "  $texto: " a; echo
        if [ "${#a}" -lt 8 ]; then alerta "mínimo de 8 caracteres."; continue; fi
        read -r -s -p "  repita a senha: " b; echo
        [ "$a" = "$b" ] && break
        alerta "as senhas não são iguais."
    done
    printf -v "$alvo" '%s' "$a"
}

email_valido() { printf '%s' "$1" | grep -Eq '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'; }

# A senha do banco viaja por dois lugares que mastigam pontuação, e por isso é restrita a
# letras, números, hífen e sublinhado:
#
#   1. o .env, onde o docker compose EXPANDE $: uma senha "abc$def" vira "abc" caladamente,
#      e a pessoa acha que configurou algo forte;
#   2. a URL de conexão (postgresql://loja:SENHA@db:5432/loja), onde "/" e "#" quebram o
#      endereço inteiro — o Python passa a ler "loja" como se fosse o servidor e a API não
#      conecta em lugar nenhum.
#
# Ninguém digita esta senha no dia a dia, então restringir os caracteres não custa nada;
# 32 caracteres alfanuméricos sobram de força.
senha_banco_valida() { printf '%s' "$1" | grep -Eq '^[A-Za-z0-9_-]{8,}$'; }

# Endereço sem DNS: localhost, vazio ou um IP. Decide HTTP puro em vez de HTTPS.
endereco_local() {
    [ -z "$1" ] || [ "$1" = "localhost" ] || printf '%s' "$1" | grep -Eq '^[0-9]+(\.[0-9]+){3}$'
}

# Deriva tudo que depende do endereço. Existe uma vez só porque três caminhos precisam
# disso (instalação nova interativa, por parâmetro, e reaproveitando um .env), e uma cópia
# esquecida deixava o resumo final quebrar com "URL_FINAL: unbound variable".
definir_endereco() {
    if endereco_local "$DOMINIO"; then
        # HTTP puro: aqui o AMBIENTE precisa ser 'local', senão o cookie de sessão sai
        # marcado como Secure, o navegador se recusa a guardá-lo em http:// e ninguém
        # consegue continuar logado.
        ENDERECO_PROXY=":80"
        AMBIENTE="local"
        CORS_ORIGINS="*"
        URL_FINAL="http://localhost"
        [ "${PORTA_HTTP:-80}" != "80" ] && URL_FINAL="http://localhost:$PORTA_HTTP"
        MODO="local, sem HTTPS"
    else
        ENDERECO_PROXY="$DOMINIO"
        AMBIENTE="producao"
        CORS_ORIGINS="https://$DOMINIO"
        URL_FINAL="https://$DOMINIO"
        MODO="domínio $DOMINIO, com HTTPS automático"
    fi
}

# ------------------------------------------------------- instalação do Docker

# Todo comando de Docker passa por aqui.
#
# O motivo é o grupo `docker`: numa instalação recém-feita, o usuário é adicionado ao grupo,
# mas essa participação SÓ VALE na próxima sessão. Se o instalador insistisse em `docker`
# puro, ele instalaria o Docker com sucesso e morreria na linha seguinte com "permission
# denied" — obrigando a pessoa a sair, entrar e recomeçar. Com o prefixo, a mesma execução
# vai até o fim.
PREFIXO_DOCKER=""
dk() {
    if [ -n "$PREFIXO_DOCKER" ]; then sudo docker "$@"; else docker "$@"; fi
}

como_root() {
    if [ "$(id -u)" -eq 0 ]; then "$@"; else sudo "$@"; fi
}

tem_root() { [ "$(id -u)" -eq 0 ] || command -v sudo >/dev/null 2>&1; }

# Descobre se o Docker responde e se é preciso sudo. Devolve 1 se não responder de jeito
# nenhum.
definir_prefixo_docker() {
    if docker info >/dev/null 2>&1; then PREFIXO_DOCKER=""; return 0; fi
    if [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null \
       && sudo docker info >/dev/null 2>&1; then
        PREFIXO_DOCKER="sudo"; return 0
    fi
    if [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1 && sudo docker info >/dev/null 2>&1; then
        PREFIXO_DOCKER="sudo"; return 0
    fi
    return 1
}

esperar_docker() {  # esperar_docker <segundos>
    local limite="${1:-60}" i=0
    while [ "$i" -lt "$limite" ]; do
        definir_prefixo_docker && return 0
        i=$((i + 2)); sleep 2
    done
    return 1
}

instalar_docker_linux() {
    tem_root || return 3

    local baixador=""
    if command -v curl >/dev/null 2>&1; then baixador="curl"
    elif command -v wget >/dev/null 2>&1; then baixador="wget"
    else
        passo "instalando o curl primeiro…"
        if command -v apt-get >/dev/null 2>&1; then
            como_root apt-get update -qq >/dev/null 2>&1 || true
            como_root apt-get install -y -qq curl >/dev/null 2>&1 || true
        elif command -v dnf >/dev/null 2>&1; then
            como_root dnf install -y -q curl >/dev/null 2>&1 || true
        fi
        command -v curl >/dev/null 2>&1 && baixador="curl" || return 2
    fi

    passo "baixando o instalador oficial do Docker (get.docker.com)…"
    local script; script="$(mktemp)"
    if [ "$baixador" = "curl" ]; then
        curl -fsSL https://get.docker.com -o "$script" || { rm -f "$script"; return 1; }
    else
        wget -qO "$script" https://get.docker.com || { rm -f "$script"; return 1; }
    fi

    passo "instalando — isto demora alguns minutos e não pede nada…"
    # O script oficial cobre Ubuntu, Debian, Fedora, CentOS e derivados, e já traz o plugin
    # `docker compose` v2 junto. É a rota que a própria Docker recomenda para servidor.
    if ! como_root sh "$script" >/dev/null 2>&1; then
        rm -f "$script"; return 1
    fi
    rm -f "$script"

    passo "ligando o serviço…"
    if command -v systemctl >/dev/null 2>&1; then
        como_root systemctl enable --now docker >/dev/null 2>&1 || true
    else
        # Sem systemd (WSL antigo, alguns containers): tenta o init tradicional.
        como_root service docker start >/dev/null 2>&1 || true
    fi

    if [ "$(id -u)" -ne 0 ]; then
        # Vale a partir do próximo login. Nesta execução, quem resolve é o PREFIXO_DOCKER.
        como_root usermod -aG docker "$(id -un)" >/dev/null 2>&1 || true
    fi
    return 0
}

instalar_docker_mac() {
    command -v brew >/dev/null 2>&1 || return 2
    passo "instalando o Docker Desktop pelo Homebrew…"
    brew install --cask docker >/dev/null 2>&1 || return 1
    passo "abrindo o Docker Desktop…"
    open -a Docker >/dev/null 2>&1 || true
    return 0
}

garantir_docker() {
    if command -v docker >/dev/null 2>&1 && definir_prefixo_docker; then
        certo "Docker pronto ($(dk --version 2>/dev/null | cut -d, -f1))"
        return 0
    fi

    # Instalado mas parado: tentar ligar antes de sair instalando de novo.
    if command -v docker >/dev/null 2>&1; then
        passo "o Docker está instalado mas não respondeu; tentando ligar…"
        if command -v systemctl >/dev/null 2>&1 && tem_root; then
            como_root systemctl start docker >/dev/null 2>&1 || true
        elif [ "$(uname -s)" = "Darwin" ]; then
            open -a Docker >/dev/null 2>&1 || true
        fi
        if esperar_docker 60; then
            certo "Docker respondendo"
            return 0
        fi
        morrer \
"O Docker está instalado mas não responde.
  Linux:  sudo systemctl start docker
  Mac:    abra o Docker Desktop e espere o ícone ficar verde.
  Se acabou de instalar, pode ser preciso sair e entrar na sessão de novo."
    fi

    # Não está instalado.
    alerta "O Docker não está instalado — é o único programa de que este sistema precisa."

    if [ "$INSTALAR_DOCKER" -eq 0 ]; then
        morrer \
"Instalação automática desligada por --sem-docker.
  Instale à mão e rode de novo:
      Linux:  curl -fsSL https://get.docker.com | sudo sh
      Mac:    brew install --cask docker"
    fi

    if [ "$INTERATIVO" -eq 1 ]; then
        echo "  Ele é gratuito e é o que faz o banco, a API e o site rodarem isolados."
        local resposta=""
        read -r -p "  Instalar o Docker agora? [S/n]: " resposta || true
        case "${resposta:-s}" in
            [Nn]*) morrer "instalação cancelada. Nada foi mexido no sistema." ;;
        esac
    fi

    titulo "Instalando o Docker"
    local resultado=0
    case "$(uname -s)" in
        Linux)  instalar_docker_linux || resultado=$? ;;
        Darwin) instalar_docker_mac   || resultado=$? ;;
        *)      resultado=9 ;;
    esac

    case "$resultado" in
        0) ;;
        2) morrer \
"Não encontrei como baixar o Docker nesta máquina.
  Instale à mão e rode ./instalar.sh de novo:
      Linux:  curl -fsSL https://get.docker.com | sudo sh
      Mac:    instale o Homebrew (https://brew.sh) ou baixe o Docker Desktop." ;;
        3) morrer \
"Instalar o Docker precisa de permissão de administrador, e este usuário não tem sudo.
  Peça a quem administra o servidor para rodar:
      curl -fsSL https://get.docker.com | sudo sh
      sudo usermod -aG docker $(id -un)
  Depois entre de novo na sessão e rode ./instalar.sh." ;;
        9) morrer \
"Não sei instalar o Docker automaticamente em $(uname -s).
  Baixe em https://www.docker.com/products/docker-desktop e rode ./instalar.sh de novo." ;;
        *) morrer \
"A instalação do Docker falhou.
  Tente à mão para ver a mensagem completa:
      curl -fsSL https://get.docker.com | sudo sh" ;;
    esac

    passo "esperando o Docker subir…"
    if ! esperar_docker 120; then
        morrer \
"O Docker foi instalado, mas não respondeu a tempo.
  No Mac, abra o Docker Desktop e espere o ícone ficar verde.
  No Linux, tente: sudo systemctl start docker
  Depois rode ./instalar.sh de novo — ele continua de onde parou."
    fi

    certo "Docker instalado e no ar ($(dk --version 2>/dev/null | cut -d, -f1))"
    [ -n "$PREFIXO_DOCKER" ] && \
        alerta "usando 'sudo docker' nesta execução; saia e entre na sessão para dispensar o sudo"
    return 0
}

# ------------------------------------------------------------------ verificações

titulo "Sistema de Gestão da Loja — instalação"

garantir_docker

dk compose version >/dev/null 2>&1 || morrer \
"O Docker está instalado, mas sem o plugin 'compose'.
  Ubuntu: sudo apt install docker-compose-plugin
  Ou reinstale pelo caminho oficial: curl -fsSL https://get.docker.com | sudo sh"

# ------------------------------------------------------------------ perguntas

if [ -f .env ] && [ "$FORCAR" -eq 0 ]; then
    alerta "Já existe um .env — a instalação vai reaproveitar as configurações dele."
    alerta "Para começar do zero, rode com --forcar (isto NÃO apaga os dados do banco)."
    # shellcheck disable=SC1091
    set -a; . ./.env; set +a
    REAPROVEITADO=1
    definir_endereco
else
    REAPROVEITADO=0

    titulo "1. Endereço do sistema"
    echo "  Se a loja tem um domínio apontado para este servidor, informe-o: o certificado"
    echo "  HTTPS é pedido e renovado sozinho. Deixe 'localhost' para usar só nesta máquina."
    perguntar "Domínio (DNS)" "localhost" DOMINIO

    definir_endereco

    titulo "2. Dono da loja"
    echo "  É a conta de administrador: vê custo, lucro, despesas e relatórios."
    while :; do
        perguntar "Nome" "Dona da Loja" NOME
        [ -n "$NOME" ] && break
    done
    while :; do
        perguntar "E-mail (é com ele que você entra)" "" EMAIL
        email_valido "$EMAIL" && break
        alerta "e-mail inválido."
    done
    perguntar_senha "Senha do dono (mínimo 8 caracteres)" SENHA

    titulo "3. Banco de dados"
    echo "  Esta senha fica só entre os containers; ninguém digita no dia a dia."
    if [ "$INTERATIVO" -eq 1 ] && [ -z "$SENHA_BANCO" ]; then
        read -r -p "  Gerar uma senha forte automaticamente? [S/n]: " gerar || true
        case "${gerar:-s}" in
            [Nn]*)
                while :; do
                    perguntar_senha "Senha do banco" SENHA_BANCO
                    senha_banco_valida "$SENHA_BANCO" && break
                    alerta "use só letras, números, hífen e sublinhado (mínimo 8)."
                    alerta "pontuação quebra a URL de conexão do banco."
                    SENHA_BANCO=""
                done
                ;;
            *)     SENHA_BANCO="$(sortear 32)"; certo "senha do banco gerada" ;;
        esac
    fi

    titulo "4. Fuso horário"
    echo "  Define o que é 'hoje' no caixa e nos relatórios."
    perguntar "Fuso" "America/Sao_Paulo" FUSO
fi

# --------------------------------------------------- validação do modo não-interativo

if [ "$REAPROVEITADO" -eq 0 ]; then
    [ -n "$NOME" ]  || morrer "faltou --nome"
    [ -n "$EMAIL" ] || morrer "faltou --email"
    email_valido "$EMAIL" || morrer "e-mail inválido: $EMAIL"
    [ -n "$SENHA" ] || morrer "faltou --senha"
    [ "${#SENHA}" -ge 8 ] || morrer "a senha do dono precisa de ao menos 8 caracteres"
    [ -n "$SENHA_BANCO" ] || SENHA_BANCO="$(sortear 32)"
    senha_banco_valida "$SENHA_BANCO" || morrer \
"a senha do banco só aceita letras, números, hífen e sublinhado (mínimo 8).
  Pontuação quebra a URL de conexão — e um '\$' seria comido pelo docker compose.
  Deixe em branco para o instalador gerar uma forte."

    definir_endereco

    # --forcar redesenha a CONFIGURAÇÃO (domínio, portas, fuso), mas a senha do banco tem uma
    # peculiaridade: o Postgres só a grava quando cria os dados pela primeira vez. Se o volume
    # já existe e o instalador sorteasse uma senha nova, a API ficaria trancada fora do próprio
    # banco — "esperando o banco responder" para sempre, com o banco saudável ao lado.
    if [ -f .env ] && dk volume inspect loja_dados-do-banco >/dev/null 2>&1; then
        senha_existente="$(grep -E '^SENHA_BANCO=' .env | cut -d= -f2- || true)"
        if [ -n "$senha_existente" ] && [ "$senha_existente" != "$SENHA_BANCO" ]; then
            SENHA_BANCO="$senha_existente"
            alerta "o banco já existe: mantendo a senha atual dele"
            alerta "(para trocá-la de verdade é preciso apagar os dados com ./desinstalar.sh)"
        fi
    fi

    titulo "Gravando a configuração"
    umask 077                      # o .env carrega senhas: só o dono do arquivo lê.
    cat > .env <<FIM
# Gerado por ./instalar.sh — contém senhas. NÃO versione, não compartilhe.
DOMINIO=$DOMINIO
ENDERECO_PROXY=$ENDERECO_PROXY
PORTA_HTTP=$PORTA_HTTP
PORTA_HTTPS=$PORTA_HTTPS

SENHA_BANCO=$SENHA_BANCO
JWT_SECRET=$(sortear 64)

AMBIENTE=$AMBIENTE
CORS_ORIGINS=$CORS_ORIGINS
TIMEZONE_LOJA=$FUSO
FIM
    chmod 600 .env
    certo ".env gravado (só você consegue ler)"
fi

# ------------------------------------------------------------------ subir

sincronizar_senha_banco() {
    # O Postgres grava POSTGRES_PASSWORD só quando CRIA os dados. Num banco que já existia —
    # depois de um --forcar, de um .env refeito, ou de restaurar um backup noutra máquina — a
    # senha do arquivo e a do banco divergem, e a API fica batendo numa porta que não abre,
    # repetindo "esperando o banco responder" com o banco saudável ao lado.
    #
    # A imagem oficial do Postgres confia em conexões pelo socket local dentro do container,
    # então dá para alinhar as duas sem saber a senha antiga: o .env passa a ser a verdade.
    #
    # A senha entra no SQL sem escape, e isso é seguro porque `senha_banco_valida` já a
    # restringiu a letras, números, hífen e sublinhado.
    local i=0
    while [ "$i" -lt 30 ]; do
        dk compose exec -T db pg_isready -U loja -d loja >/dev/null 2>&1 && break
        i=$((i + 1)); sleep 2
    done
    dk compose exec -T db psql -q -v ON_ERROR_STOP=1 -U loja -d loja \
        -c "ALTER USER loja PASSWORD '$SENHA_BANCO';" >/dev/null 2>&1 || true
}

titulo "Construindo e subindo os containers"
passo "isto demora alguns minutos na primeira vez"

# A saída é mostrada E guardada: o build é longo e a pessoa precisa ver o progresso, mas se
# falhar queremos ler o motivo para traduzir a mensagem do Docker em algo acionável.
registro_up="$(mktemp)"
set +e
dk compose up -d --build 2>&1 | tee "$registro_up"
codigo_up=${PIPESTATUS[0]}
set -e

if [ "$codigo_up" -ne 0 ]; then
    if grep -qiE "ports are not available|address already in use|bind: permission denied|forbidden by its access permissions" "$registro_up"; then
        rm -f "$registro_up"
        morrer \
"A porta $PORTA_HTTP já está sendo usada por outro programa.
  Descubra quem está nela:
      Linux/Mac:  sudo lsof -i :$PORTA_HTTP
      Windows:    netstat -ano | findstr :$PORTA_HTTP
  Ou instale numa porta livre:
      ./instalar.sh --forcar --porta-http 8080"
    fi
    rm -f "$registro_up"
    morrer "não foi possível subir os containers. O motivo está logo acima."
fi
rm -f "$registro_up"

titulo "Esperando o sistema responder"

sincronizar_senha_banco

pronto=0
for _ in $(seq 1 90); do
    # `ps -q` + `inspect` em vez de `ps --format`: o template Go não é aceito por versões
    # antigas do Compose, e ali o instalador acusaria a API de doente sem ela estar.
    id_api="$(dk compose ps -q api 2>/dev/null | head -1)"
    if [ -n "$id_api" ]; then
        estado="$(dk inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id_api" 2>/dev/null)"
        [ "$estado" = "healthy" ] && { pronto=1; break; }
    fi
    sleep 2
done
[ "$pronto" -eq 1 ] || {
    printf '\n%s' "$VERMELHO"
    echo "A API não ficou saudável. Os últimos registros:"; printf '%s\n' "$NORMAL"
    dk compose logs --tail 40 api
    morrer "instalação interrompida. Corrija o erro acima e rode ./instalar.sh de novo."
}
certo "API no ar, banco migrado"

# A API estar saudável não garante que o proxy esteja publicando a porta. Antes de anunciar
# o endereço, abre ele de verdade.
if command -v curl >/dev/null 2>&1; then
    if curl -skf -o /dev/null --max-time 15 "$URL_FINAL/app/"; then
        certo "sistema web respondendo em $URL_FINAL/app/"
    elif [ "$AMBIENTE" = "producao" ]; then
        alerta "o endereço ainda não responde — o certificado pode estar sendo emitido."
        alerta "acompanhe com: docker compose logs -f proxy"
    else
        alerta "a API subiu, mas $URL_FINAL/app/ não respondeu."
        alerta "veja o proxy com: docker compose logs proxy"
    fi
fi

# ------------------------------------------------------------------ dono da loja

if [ -n "$EMAIL" ] && [ -n "$SENHA" ]; then
    # `create-admin` não duplica: se a conta já existe e está ativa, ele avisa e sai bem.
    titulo "Criando a conta do dono"
    if dk compose exec -T api python -m app.cli create-admin \
            --nome "$NOME" --email "$EMAIL" --senha "$SENHA"; then
        certo "conta pronta"
    else
        alerta "não foi possível criar a conta (veja a mensagem acima)."
        alerta "o sistema está no ar; crie a conta depois com:"
        echo "    ${PREFIXO_DOCKER:+sudo }docker compose exec api python -m app.cli create-admin --nome ... --email ... --senha ..."
    fi
elif [ "$REAPROVEITADO" -eq 1 ]; then
    alerta "Configuração reaproveitada — a conta do dono não foi mexida."
    alerta "Para criar uma conta nova de administrador:"
    echo "    ${PREFIXO_DOCKER:+sudo }docker compose exec api python -m app.cli create-admin --nome ... --email ... --senha ..."
fi

# ------------------------------------------------------------------ fim

titulo "Pronto — o sistema está rodando"
CMD_DOCKER="docker"
[ -n "$PREFIXO_DOCKER" ] && CMD_DOCKER="sudo docker"
cat <<FIM

  Endereço:  ${FORTE}${URL_FINAL}/app/${NORMAL}
  Modo:      ${MODO}
  Entrar:    ${EMAIL:-<a conta já existente>}

  Comandos do dia a dia:
    ${CMD_DOCKER} compose ps               ver se está no ar
    ${CMD_DOCKER} compose logs -f api      acompanhar o que acontece
    ${CMD_DOCKER} compose restart          reiniciar
    ${CMD_DOCKER} compose down             desligar (os dados ficam guardados)
    ./instalar.sh                   religar depois de um down

FIM
if [ "$AMBIENTE" = "producao" ]; then
    alerta "Confira que o DNS de $DOMINIO aponta para o IP deste servidor e que as"
    alerta "portas 80 e 443 estão liberadas — é o que o Let's Encrypt precisa para"
    alerta "emitir o certificado. Acompanhe em: docker compose logs -f proxy"
    echo
fi
