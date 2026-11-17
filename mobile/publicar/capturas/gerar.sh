#!/usr/bin/env bash
# Gera as 10 capturas da App Store com o app de verdade, nos dois tamanhos:
#   media/app-store/iphone-6.5/  1242 × 2688  (obrigatório)
#   media/app-store/iphone-6.9/  1320 × 2868  (extra)
#
#   mobile/publicar/capturas/gerar.sh               # tudo, do zero
#   mobile/publicar/capturas/gerar.sh --sem-build   # reaproveita o mobile/dist-web
#
# Do zero mesmo: banco de teste novo, migrations, API local, a dona de teste e a loja de
# exemplo da seed (api/scripts/seed_demo.py), nome "Loja Tria" e ramo roupas pela rota de
# configuração (como na demonstração), o export web do app servido aqui, as fotos
# (gerar.mjs) e a arte (compor.mjs). Nada sai desta máquina. Sai com erro se um passo
# falhar, e derruba o que subiu de qualquer jeito.
#
# Variáveis (todas opcionais):
#   CAPTURAS_BANCO       banco de teste, APAGADO e recriado          (loja_capturas)
#   CAPTURAS_PORTA_API   porta da API local                          (8131)
#   CAPTURAS_PORTA_WEB   porta do export web                         (8092)
#   CAPTURAS_PYTHON      Python com as dependências da API           (api/.venv/bin/python)
#   PGHOST PGPORT PGUSER PGPASSWORD   o Postgres local    (localhost 5432 postgres postgres)
#   CAPTURAS_SO=01-vender,07-caixa    fotografa só essas (as outras pastas ficam como estão)
#   CAPTURAS_ACEITAR_PREJUIZO=1       segue mesmo com o Resultado do mês negativo (cena 03)
set -euo pipefail

AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RAIZ="$(cd "$AQUI/../../.." && pwd)"

SEM_BUILD=0
for arg in "$@"; do
  case "$arg" in
    --sem-build) SEM_BUILD=1 ;;
    -h|--help) awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "Opção desconhecida: $arg (use --sem-build ou --help)" >&2; exit 2 ;;
  esac
done

BANCO="${CAPTURAS_BANCO:-loja_capturas}"
PORTA_API="${CAPTURAS_PORTA_API:-8131}"
PORTA_WEB="${CAPTURAS_PORTA_WEB:-8092}"
PY="${CAPTURAS_PYTHON:-$RAIZ/api/.venv/bin/python}"
export PGHOST="${PGHOST:-localhost}" PGPORT="${PGPORT:-5432}" PGUSER="${PGUSER:-postgres}"
export PGPASSWORD="${PGPASSWORD:-postgres}"

# A conta de teste é a da seed: e-mail e senha conhecidos, só neste banco local.
EMAIL="dona@loja.com"
SENHA="senha12345"
LOJA="Loja Tria"

API="http://127.0.0.1:$PORTA_API"
WEB="http://127.0.0.1:$PORTA_WEB"
URL_DO_BANCO="postgresql+asyncpg://$PGUSER:$PGPASSWORD@$PGHOST:$PGPORT/$BANCO"

passo() { printf '\n▶ %s\n' "$*"; }
falha() { printf '\n✗ %s\n' "$*" >&2; exit 1; }

case "$BANCO" in
  loja|postgres|template0|template1) falha "CAPTURAS_BANCO=$BANCO: use um banco só de teste (ele é apagado)." ;;
esac

# ------------------------------------------------------------------ o que precisa existir
passo "Conferindo o que a geração precisa"
command -v node >/dev/null || falha "Falta o Node (20 ou mais novo)."
# O Playwright costuma estar instalado globalmente (npm i -g): deixa o require achá-lo.
NODE_PATH="${NODE_PATH:+$NODE_PATH:}$(npm root -g 2>/dev/null || true)"
export NODE_PATH
command -v createdb >/dev/null && command -v dropdb >/dev/null && command -v psql >/dev/null \
  || falha "Faltam os programas do Postgres (createdb, dropdb, psql)."
[ -x "$PY" ] || falha "Não achei o Python da API em $PY (crie api/.venv ou passe CAPTURAS_PYTHON)."
"$PY" -c 'import alembic, uvicorn, httpx' 2>/dev/null || falha "O Python em $PY não tem as dependências da API."
node -e "require('playwright')" 2>/dev/null \
  || falha "Falta o Playwright para o Node (npm i -g playwright && npx playwright install chromium)."
FONTES="$(fc-list : family 2>/dev/null || true)"  # numa variável: grep -q no pipe + pipefail = SIGPIPE
grep -q '^Inter Display' <<<"$FONTES" && grep -q '^Inter' <<<"$FONTES" \
  || falha "Falta a fonte Inter (Inter e Inter Display; no Ubuntu: fonts-inter)."
psql -d postgres -tAc 'select 1' >/dev/null 2>&1 || falha "O Postgres em $PGHOST:$PGPORT não respondeu como $PGUSER."
for porta in "$PORTA_API" "$PORTA_WEB"; do
  if curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$porta/"; then
    falha "A porta $porta já está em uso. Libere-a ou escolha outra (CAPTURAS_PORTA_API/WEB)."
  fi
done
echo "ok"

TMP="$(mktemp -d)"
PID_API=""
PID_WEB=""
encerrar() {
  local codigo=$?
  for pid in $PID_WEB $PID_API; do
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  done
  if [ "$codigo" -ne 0 ] && [ -s "$TMP/api.log" ]; then
    echo "--- últimas linhas da API ($TMP/api.log) ---" >&2
    tail -n 20 "$TMP/api.log" >&2
  else
    rm -rf "$TMP"
  fi
  exit "$codigo"
}
trap encerrar EXIT
trap 'exit 130' INT TERM

esperar() {  # esperar <url> <segundos> <o que é>
  for _ in $(seq 1 $(( $2 * 2 ))); do
    curl -sf -o /dev/null --max-time 2 "$1" && return 0
    sleep 0.5
  done
  falha "$3 não respondeu em $1."
}

# ------------------------------------------------------------------ banco e API
passo "Banco de teste $BANCO (apagado e recriado)"
dropdb --if-exists "$BANCO"
createdb "$BANCO"
(cd "$RAIZ/api" && DATABASE_URL="$URL_DO_BANCO" "$PY" -m alembic upgrade head) >"$TMP/alembic.log" 2>&1 \
  || { cat "$TMP/alembic.log" >&2; falha "As migrations não rodaram."; }
echo "migrations aplicadas"

passo "API local em $API"
mkdir -p "$TMP/estado" "$TMP/media"
(
  cd "$RAIZ/api"
  export DATABASE_URL="$URL_DO_BANCO" AMBIENTE=dev ESTADO_DIR="$TMP/estado" MEDIA_DIR="$TMP/media"
  JWT_SECRET="$("$PY" -c 'import secrets; print(secrets.token_urlsafe(48))')"
  export JWT_SECRET
  exec "$PY" -m uvicorn app.main:app --host 127.0.0.1 --port "$PORTA_API" --log-level warning
) >"$TMP/api.log" 2>&1 &
PID_API=$!
esperar "$API/health" 60 "A API"
echo "no ar (PID $PID_API)"

passo "Loja de exemplo (api/scripts/seed_demo.py)"
(
  cd "$RAIZ/api"
  DATABASE_URL="$URL_DO_BANCO" SEED_API_URL="$API" \
    SEED_ADMIN_NOME="Dona Maria" SEED_ADMIN_EMAIL="$EMAIL" SEED_ADMIN_SENHA="$SENHA" \
    "$PY" scripts/seed_demo.py
) || falha "A seed não terminou."

passo "Nome e ramo da loja, pela rota de configuração"
"$PY" - "$API" "$EMAIL" "$SENHA" "$LOJA" <<'PYTHON' || falha "Não deu para configurar a loja."
import sys

import httpx

api, email, senha, nome = sys.argv[1:5]
with httpx.Client(base_url=f"{api}/api/v1", timeout=30) as cliente:
    entrou = cliente.post("/auth/login", json={"email": email, "senha": senha})
    entrou.raise_for_status()
    cracha = {"Authorization": f"Bearer {entrou.json()['access_token']}"}
    loja = cliente.patch("/configuracao", headers=cracha, json={"nome": nome, "segmento": "ROUPAS"})
    loja.raise_for_status()
    print(f"{loja.json()['nome']} · {loja.json()['segmento']}")
PYTHON

# ------------------------------------------------------------------ o app
cd "$RAIZ/mobile"
if [ "$SEM_BUILD" -eq 1 ]; then
  passo "Export web: reaproveitando mobile/dist-web"
  [ -f dist-web/index.html ] || falha "Não há mobile/dist-web: rode sem --sem-build."
else
  passo "Export web do app (npm run web:build)"
  [ -d node_modules ] || falha "Falta mobile/node_modules (npm ci dentro de mobile/)."
  npm run web:build >"$TMP/web-build.log" 2>&1 || { tail -n 30 "$TMP/web-build.log" >&2; falha "O export web falhou."; }
  echo "pronto"
fi
node servir-web.mjs dist-web "$PORTA_WEB" >"$TMP/web.log" 2>&1 &
PID_WEB=$!
esperar "$WEB/" 30 "O export web"
echo "servido em $WEB (PID $PID_WEB)"

# ------------------------------------------------------------------ fotos e arte
passo "Fotografando o app (gerar.mjs)"
CAPTURAS_WEB="$WEB" CAPTURAS_API="$API" CAPTURAS_EMAIL="$EMAIL" CAPTURAS_SENHA="$SENHA" \
  CAPTURAS_LOJA="$LOJA" node "$AQUI/gerar.mjs"

passo "Montando a arte (compor.mjs)"
node "$AQUI/compor.mjs"

printf '\n✓ Capturas prontas em media/app-store/iphone-6.5 e media/app-store/iphone-6.9.\n'
printf '  Confira cada uma com os olhos antes do commit.\n'
