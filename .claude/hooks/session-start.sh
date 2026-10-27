#!/bin/bash
# Prepara a sessão do Claude Code na nuvem, para ela já nascer pronta:
#
#   1. Graphify — o grafo do código (tree-sitter, local, sem LLM e sem token). O Claude
#      consulta o grafo em vez de reler arquivos inteiros para achar onde as coisas estão.
#   2. O que os testes precisam: venv da API, Postgres com os bancos, node_modules do mobile.
#
# Só roda na nuvem ($CLAUDE_CODE_REMOTE): na máquina de quem desenvolve, cada um tem o seu
# ambiente. Idempotente: o que já está instalado não é reinstalado (o contêiner é guardado
# depois que o hook termina, então a segunda sessão só confere).
set -euo pipefail

[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0

RAIZ="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"
ENV_FILE="${CLAUDE_ENV_FILE:-/dev/null}"

# Versão FIXA, de propósito: o hook roda sozinho em toda sessão, e instalar sempre "a mais
# nova" de um pacote de terceiros deixaria uma versão comprometida entrar sem ninguém olhar.
# Subir de versão é uma linha neste arquivo, revisada num commit.
GRAPHIFY_VERSAO="0.9.96"

passo() { printf '→ %s\n' "$*" >&2; }

# ------------------------------------------------------------------ 1. Graphify
VENV_G="$HOME/.local/graphify-venv"
if [ "$("$VENV_G/bin/python" -c 'import importlib.metadata as m; print(m.version("graphifyy"))' 2>/dev/null || true)" != "$GRAPHIFY_VERSAO" ]; then
    passo "instalando graphifyy $GRAPHIFY_VERSAO"
    python3 -m venv "$VENV_G"
    "$VENV_G/bin/pip" install -q --disable-pip-version-check "graphifyy==$GRAPHIFY_VERSAO"
fi
mkdir -p "$HOME/.local/bin"
ln -sf "$VENV_G/bin/graphify" "$HOME/.local/bin/graphify"
echo "export PATH=\"$HOME/.local/bin:\$PATH\"" >> "$ENV_FILE"
export PATH="$HOME/.local/bin:$PATH"

# O grafo não vai para o git (graphify-out/ tem ~7 MB e é reescrito inteiro a cada build):
# nasce aqui, em ~10 s. `--code-only` e `--no-label`: só AST local, nenhuma chamada de LLM,
# custo zero de token. Com o grafo de uma sessão anterior no contêiner, só o que mudou.
cd "$RAIZ"
if [ -f graphify-out/graph.json ]; then
    passo "atualizando o grafo do código"
    graphify update . >/dev/null 2>&1 || true
else
    passo "gerando o grafo do código (graphify, local)"
    graphify extract . --code-only >/dev/null 2>&1 \
        && graphify cluster-only . --no-label >/dev/null 2>&1 || true
fi

# ------------------------------------------------------------------ 2. API
cd "$RAIZ/api"
if [ ! -x .venv/bin/pytest ] || [ ! -x .venv/bin/ruff ]; then
    passo "instalando dependências da API"
    python3 -m venv .venv
    .venv/bin/pip install -q --disable-pip-version-check -e ".[dev]" ruff
fi

# Postgres da imagem: os testes rodam contra banco de verdade (loja_test), nunca SQLite.
if command -v pg_lsclusters >/dev/null 2>&1; then
    if ! pg_lsclusters --no-header 2>/dev/null | grep -q online; then
        passo "subindo o Postgres"
        service postgresql start >/dev/null
    fi
    su postgres -c "psql -qc \"ALTER USER postgres PASSWORD 'postgres';\"" >/dev/null
    for banco in loja_test loja; do
        su postgres -c "psql -tAc \"SELECT 1 FROM pg_database WHERE datname='$banco'\"" | grep -q 1 \
            || su postgres -c "createdb $banco"
    done
fi

# ------------------------------------------------------------------ 3. Mobile
cd "$RAIZ/mobile"
if [ ! -d node_modules ] || [ package-lock.json -nt node_modules ]; then
    passo "instalando node_modules do mobile"
    npm install --no-audit --no-fund --loglevel=error
fi

passo "ambiente pronto"
