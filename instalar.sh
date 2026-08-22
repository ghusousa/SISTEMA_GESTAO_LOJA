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
INTERATIVO=1; FORCAR=0

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

# ------------------------------------------------------------------ verificações

titulo "Sistema de Gestão da Loja — instalação"

command -v docker >/dev/null 2>&1 || morrer \
"O Docker não está instalado.
  Ubuntu:  curl -fsSL https://get.docker.com | sudo sh
  Windows/Mac: https://www.docker.com/products/docker-desktop"

docker compose version >/dev/null 2>&1 || morrer \
"O Docker está instalado, mas sem o plugin 'compose'.
  Ubuntu: sudo apt install docker-compose-plugin"

docker info >/dev/null 2>&1 || morrer \
"O Docker está instalado mas não responde.
  Ubuntu: sudo systemctl start docker  (e 'sudo usermod -aG docker \$USER' + relogar)
  Windows/Mac: abra o Docker Desktop e espere ficar verde."

certo "Docker pronto ($(docker --version | cut -d, -f1))"

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
            [Nn]*) perguntar_senha "Senha do banco" SENHA_BANCO ;;
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

    definir_endereco

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

titulo "Construindo e subindo os containers"
passo "isto demora alguns minutos na primeira vez"
docker compose up -d --build

titulo "Esperando o sistema responder"
pronto=0
for _ in $(seq 1 90); do
    estado="$(docker compose ps --format '{{.Service}} {{.Health}}' 2>/dev/null | awk '$1=="api"{print $2}')"
    if [ "$estado" = "healthy" ]; then pronto=1; break; fi
    sleep 2
done
[ "$pronto" -eq 1 ] || {
    printf '\n%s' "$VERMELHO"
    echo "A API não ficou saudável. Os últimos registros:"; printf '%s\n' "$NORMAL"
    docker compose logs --tail 40 api
    morrer "instalação interrompida. Corrija o erro acima e rode ./instalar.sh de novo."
}
certo "API no ar, banco migrado"

# ------------------------------------------------------------------ dono da loja

if [ -n "$EMAIL" ] && [ -n "$SENHA" ]; then
    # `create-admin` não duplica: se a conta já existe e está ativa, ele avisa e sai bem.
    titulo "Criando a conta do dono"
    if docker compose exec -T api python -m app.cli create-admin \
            --nome "$NOME" --email "$EMAIL" --senha "$SENHA"; then
        certo "conta pronta"
    else
        alerta "não foi possível criar a conta (veja a mensagem acima)."
        alerta "o sistema está no ar; crie a conta depois com:"
        echo "    docker compose exec api python -m app.cli create-admin --nome ... --email ... --senha ..."
    fi
elif [ "$REAPROVEITADO" -eq 1 ]; then
    alerta "Configuração reaproveitada — a conta do dono não foi mexida."
    alerta "Para criar uma conta nova de administrador:"
    echo "    docker compose exec api python -m app.cli create-admin --nome ... --email ... --senha ..."
fi

# ------------------------------------------------------------------ fim

titulo "Pronto — o sistema está rodando"
cat <<FIM

  Endereço:  ${FORTE}${URL_FINAL}/app/${NORMAL}
  Modo:      ${MODO}
  Entrar:    ${EMAIL:-<a conta já existente>}

  Comandos do dia a dia:
    docker compose ps               ver se está no ar
    docker compose logs -f api      acompanhar o que acontece
    docker compose restart          reiniciar
    docker compose down             desligar (os dados ficam guardados)
    ./instalar.sh                   religar depois de um down

FIM
if [ "$AMBIENTE" = "producao" ]; then
    alerta "Confira que o DNS de $DOMINIO aponta para o IP deste servidor e que as"
    alerta "portas 80 e 443 estão liberadas — é o que o Let's Encrypt precisa para"
    alerta "emitir o certificado. Acompanhe em: docker compose logs -f proxy"
    echo
fi
