#!/usr/bin/env bash
# A pilha INTEIRA no Docker de verdade — db, api, proxy e a demonstração (ADR-46) — e a prova
# de que a loja e a demonstração não se enxergam. É o teste que os testes de script (com
# docker de mentira) não fazem: interpolação do compose, profile, Caddy, cookie por caminho,
# banco e segredo separados, tudo junto.
#
#   testes/pilha/pilha.sh                 constrói a imagem, sobe, confere e derruba
#   SEM_BUILD=1 testes/pilha/pilha.sh     usa a loja-api:local que já existe
#   MANTER=1 testes/pilha/pilha.sh        deixa a pilha de pé no fim (para olhar)
#   PORTA=18080                           porta HTTP do proxy (padrão 18080)
#
# Roda num projeto compose PRÓPRIO (`lojapilha`) e num .env temporário: não encosta na loja
# desta máquina, se houver uma. Roda no CI (job `imagem`).
set -euo pipefail

cd "$(dirname "$0")/../.."
RAIZ_REPO=$PWD
PROJETO=lojapilha
PORTA=${PORTA:-18080}
BASE="http://127.0.0.1:${PORTA}"
TMP=$(mktemp -d)
FALHAS=0

dc() { docker compose -p "$PROJETO" --env-file "$TMP/env" "$@"; }

ok() { printf '  ✓ %s\n' "$*"; }
falhou() { printf '  ✗ %s\n' "$*" >&2; FALHAS=$((FALHAS + 1)); }
conferir() {  # conferir <descrição> <comando...>
    local descricao=$1; shift
    if "$@"; then ok "$descricao"; else falhou "$descricao"; fi
}

limpar() {
    local saida=$?
    if [ "$FALHAS" -gt 0 ] || [ "$saida" -ne 0 ]; then
        echo "── logs (fim) ──" >&2
        dc --profile demo logs --no-color --tail 80 2>&1 | tail -200 >&2 || true
    fi
    if [ "${MANTER:-0}" != "1" ]; then
        dc --profile demo down -v --remove-orphans >/dev/null 2>&1 || true
    else
        echo "pilha de pé (MANTER=1): docker compose -p $PROJETO --env-file $TMP/env ..."
    fi
    rm -rf "$TMP"
}
trap limpar EXIT

aleatorio() { python3 -c "import secrets,sys; print(secrets.token_hex(int(sys.argv[1])//2))" "$1"; }

json() {  # json <expressão python sobre d> — lê JSON do stdin
    python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"
}

# --- 1. O compose aceita o .env de uma loja ANTIGA e o de uma NOVA -------------------------
# O .env antigo é o que o instalar.sh gravava antes da demo: sem COMPOSE_PROFILES e sem DEMO_*.
# Se o compose novo exigisse uma variável nova, TODO `docker compose` dessas lojas quebraria
# (backup, vigia, atualizar) — e a atualização voltaria atrás para sempre.
echo "1. compose com .env antigo e novo"
cat > "$TMP/env" <<EOF
DOMINIO=
ENDERECO_PROXY=:80
PORTA_HTTP=${PORTA}
PORTA_HTTPS=18443
SENHA_BANCO=$(aleatorio 32)
JWT_SECRET=$(aleatorio 64)
AMBIENTE=local
CORS_ORIGINS=*
TIMEZONE_LOJA=America/Sao_Paulo
BACKUP_REMOTO=
NOTIFICAR_URL=
EOF
conferir "config -q com .env antigo" dc config -q
servicos_antigos=$(dc config --services | sort | tr '\n' ' ')
conferir ".env antigo não liga a demo ($servicos_antigos)" \
    test "$servicos_antigos" = "api db proxy "

SENHA_DEMO=$(aleatorio 20)
cat >> "$TMP/env" <<EOF
COMPOSE_PROFILES=demo
DEMO_SENHA_BANCO=$(aleatorio 32)
DEMO_JWT_SECRET=$(aleatorio 64)
DEMO_ADMIN_EMAIL=dono@demo.example
DEMO_ADMIN_SENHA=${SENHA_DEMO}
EOF
conferir "config -q com .env novo" dc config -q
servicos_novos=$(dc config --services | sort | tr '\n' ' ')
conferir ".env novo liga a demo ($servicos_novos)" \
    test "$servicos_novos" = "api api-demo db demo-banco proxy "
segredo_loja=$(dc config --format json | json 'd["services"]["api"]["environment"]["JWT_SECRET"]')
segredo_demo=$(dc config --format json | json 'd["services"]["api-demo"]["environment"]["JWT_SECRET"]')
conferir "a demo tem segredo de login próprio" test "$segredo_loja" != "$segredo_demo"
conferir "a demo não recebe o token do emissor de NFC-e" \
    test "$(dc config --format json | json '"FOCUSNFE_TOKEN" in d["services"]["api-demo"]["environment"]')" = "False"

# --- 2. O Caddyfile vale nos dois modos ----------------------------------------------------
echo "2. Caddyfile"
for endereco in ":80" "loja.exemplo.com.br"; do
    conferir "caddy validate com ENDERECO=$endereco" \
        docker run --rm -v "$RAIZ_REPO/docker/caddy:/etc/caddy:ro" -e "ENDERECO=$endereco" \
            caddy:2-alpine caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
done 2>/dev/null

# --- 3. Sobe tudo ----------------------------------------------------------------------------
echo "3. subindo a loja e a demonstração"
if [ "${SEM_BUILD:-0}" != "1" ]; then
    dc build api
fi
dc up -d
saudavel() {  # saudavel <serviço> <segundos>
    local id fim=$((SECONDS + $2))
    while [ "$SECONDS" -lt "$fim" ]; do
        id=$(dc ps -q "$1" 2>/dev/null || true)
        if [ -n "$id" ] && [ "$(docker inspect -f '{{.State.Health.Status}}' "$id" 2>/dev/null)" = "healthy" ]; then
            return 0
        fi
        sleep 3
    done
    return 1
}
conferir "api saudável" saudavel api 240
conferir "api-demo saudável (semeada)" saudavel api-demo 420
[ "$FALHAS" -eq 0 ] || exit 1

SENHA_REAL=$(aleatorio 20)
dc exec -T api python -m app.cli create-admin --nome "Dona Real" --email dona@loja.example \
    --senha "$SENHA_REAL" >/dev/null

# --- 4. Endereços ----------------------------------------------------------------------------
echo "4. endereços"
status() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
conferir "/health da loja" test "$(status "$BASE/health")" = 200
conferir "/demo/health" test "$(status "$BASE/demo/health")" = 200
conferir "/demo redireciona para /demo/" \
    test "$(curl -s -o /dev/null -w '%{redirect_url}' "$BASE/demo")" = "$BASE/demo/"
conferir "/demo/ abre /demo/app/" \
    test "$(curl -s -o /dev/null -w '%{redirect_url}' "$BASE/demo/")" = "$BASE/demo/app/"
conferir "/demo/app/ é a página" test "$(status "$BASE/demo/app/")" = 200
conferir "a loja não é demonstração" \
    test "$(curl -s "$BASE/api/v1/configuracao" | json 'd.get("demonstracao", False)')" = "False"
conferir "a demo é demonstração" \
    test "$(curl -s "$BASE/demo/api/v1/configuracao" | json 'd.get("demonstracao")')" = "True"
conferir "a demo se chama Loja de Demonstração" \
    test "$(curl -s "$BASE/demo/api/v1/configuracao" | json 'd["nome"]')" = "Loja de Demonstração"

# --- 5. Contas e sessões não atravessam ------------------------------------------------------
echo "5. contas, tokens e cookies"
login() {  # login <raiz> <email> <senha> → corpo; cabeçalhos em $TMP/cab
    curl -s -D "$TMP/cab" -H 'Content-Type: application/json' \
        -d "{\"email\":\"$2\",\"senha\":\"$3\"}" "$BASE$1/api/v1/auth/login"
}
token_demo=$(login /demo dono@demo.example "$SENHA_DEMO" | json 'd.get("access_token","")')
conferir "o revisor entra na demo" test -n "$token_demo"
conferir "cookie da demo preso a /demo/api/v1/auth" \
    grep -qi '^set-cookie: loja_refresh=.*path=/demo/api/v1/auth' "$TMP/cab"
conferir "o revisor NÃO entra na loja" \
    test "$(login "" dono@demo.example "$SENHA_DEMO" >/dev/null; sed -n '1s/.* \([0-9]\{3\}\).*/\1/p' "$TMP/cab")" = 401
token_real=$(login "" dona@loja.example "$SENHA_REAL" | json 'd.get("access_token","")')
conferir "a dona entra na loja" test -n "$token_real"
conferir "cookie da loja preso a /api/v1/auth" \
    grep -qi '^set-cookie: loja_refresh=.*path=/api/v1/auth' "$TMP/cab"
conferir "a dona NÃO entra na demo" \
    test "$(login /demo dona@loja.example "$SENHA_REAL" >/dev/null; sed -n '1s/.* \([0-9]\{3\}\).*/\1/p' "$TMP/cab")" = 401
conferir "token da demo é recusado na loja" \
    test "$(status -H "Authorization: Bearer $token_demo" "$BASE/api/v1/auth/me")" = 401
conferir "token da loja é recusado na demo" \
    test "$(status -H "Authorization: Bearer $token_real" "$BASE/demo/api/v1/auth/me")" = 401
total() {  # total <raiz> <token> <rota>
    curl -s -H "Authorization: Bearer $2" "$BASE$1/api/v1/$3?page=1&size=1" | json 'd["total"]'
}
conferir "a demo tem produtos fictícios" test "$(total /demo "$token_demo" produtos)" -gt 0
conferir "a loja não ganhou produto nenhum" test "$(total "" "$token_real" produtos)" -eq 0

# --- 6. A conta do revisor se defende ------------------------------------------------------
echo "6. conta do revisor"
conferir "não se exclui (409 CONTA_DE_DEMONSTRACAO, antes da senha)" \
    test "$(curl -s -X DELETE -H "Authorization: Bearer $token_demo" -H 'Content-Type: application/json' \
        -d '{"senha":"senha-errada-1234"}' "$BASE/demo/api/v1/usuarios/me" | json 'd.get("code")')" = CONTA_DE_DEMONSTRACAO
for _ in $(seq 1 11); do login /demo dono@demo.example "errada-$RANDOM-xyz" >/dev/null; done
conferir "11 senhas erradas não trancam o revisor" \
    test -n "$(login /demo dono@demo.example "$SENHA_DEMO" | json 'd.get("access_token","")')"

# --- 7. O banco da demo não alcança o da loja ----------------------------------------------
echo "7. banco"
SENHA_BANCO_DEMO=$(sed -n 's/^DEMO_SENHA_BANCO=//p' "$TMP/env")
conferir "a role loja_demo não conecta no banco loja" \
    sh -c "! docker compose -p $PROJETO --env-file '$TMP/env' exec -T -e PGPASSWORD='$SENHA_BANCO_DEMO' db \
        psql -h 127.0.0.1 -U loja_demo -d loja -c 'select 1' >/dev/null 2>&1"
conferir "o banco da demo tem o marco" \
    test "$(dc exec -T db psql -U loja -d loja_demo -Atc "select current_setting('loja.demonstracao', true)")" = sim
conferir "o banco da loja NÃO tem o marco" \
    test -z "$(dc exec -T db psql -U loja -d loja -Atc "select coalesce(current_setting('loja.demonstracao', true), '')")"

# --- 8. Renovar, e a demo fora do ar --------------------------------------------------------
echo "8. renovar e cair"
conferir "renovar-demonstracao" dc exec -T api-demo python -m app.cli renovar-demonstracao
token_demo=$(login /demo dono@demo.example "$SENHA_DEMO" | json 'd.get("access_token","")')
conferir "depois de renovar o revisor entra e há produtos" \
    test "$(total /demo "$token_demo" produtos)" -gt 0
conferir "renovar se recusa no contêiner da loja" \
    sh -c "! docker compose -p $PROJETO --env-file '$TMP/env' exec -T api python -m app.cli renovar-demonstracao >/dev/null 2>&1"
conferir "a loja continua sem produto" test "$(total "" "$token_real" produtos)" -eq 0
dc stop api-demo >/dev/null 2>&1
conferir "demo parada: /demo/api responde 503 DEMONSTRACAO_FORA_DO_AR" \
    test "$(curl -s "$BASE/demo/api/v1/configuracao" | json 'd.get("code")')" = DEMONSTRACAO_FORA_DO_AR
conferir "demo parada: a loja segue no ar" test "$(status "$BASE/api/v1/configuracao")" = 200
dc start api-demo >/dev/null 2>&1

echo
if [ "$FALHAS" -gt 0 ]; then
    echo "✗ $FALHAS conferência(s) falharam" >&2
    exit 1
fi
echo "✓ loja e demonstração de pé, lado a lado, sem se enxergar"
