#!/bin/sh
# Sobe a API depois de garantir que o banco existe e está no schema mais novo.
#
# A migration roda aqui, e não no instalador, para que ATUALIZAR também funcione: quem
# der `git pull` e reconstruir a imagem ganha o schema novo sem precisar lembrar de um
# segundo comando. Só existe um container de API, então não há duas migrations correndo
# juntas.
set -e

echo "→ esperando o banco responder…"
tentativa=0
until python -c "
import asyncio, os, sys, asyncpg
url = os.environ['DATABASE_URL'].replace('postgresql+asyncpg://', 'postgresql://')
async def principal():
    conexao = await asyncpg.connect(url)
    await conexao.close()
try:
    asyncio.run(principal())
except Exception:
    sys.exit(1)
" 2>/dev/null; do
    tentativa=$((tentativa + 1))
    if [ "$tentativa" -ge 60 ]; then
        echo "✗ o banco não respondeu em 60 tentativas. Veja: docker compose logs db" >&2
        exit 1
    fi
    sleep 1
done

echo "→ aplicando migrations…"
alembic upgrade head

echo "→ subindo a API"
exec "$@"
