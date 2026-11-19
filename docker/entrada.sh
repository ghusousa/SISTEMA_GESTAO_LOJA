#!/bin/sh
# Sobe a API depois de garantir que o banco existe e está no schema mais novo.
#
# A migration roda aqui, e não no instalador, para que ATUALIZAR também funcione: quem
# der `git pull` e reconstruir a imagem ganha o schema novo sem precisar lembrar de um
# segundo comando. Só existe um container de API, então não há duas migrations correndo
# juntas — e é por isso que o ./atualizar.sh não roda outra por fora: ele espera o /health.
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

# A DEMONSTRAÇÃO (ADR-46) se prepara sozinha a cada subida do contêiner dela: semeia a loja
# fictícia se o banco está vazio, retoma uma carga que parou no meio, e confere a conta do
# revisor (existe, é dona, está ativa e com a senha do .env). É o ÚNICO gatilho da carga — dois
# gatilhos correriam juntos e duplicariam o que não tem chave única.
# Falhar aqui não impede a API de subir: sem isso o contêiner entraria num laço de reinícios e
# ninguém conseguiria olhar a demo para ver o porquê. O próximo boot (ou ./demo.sh --renovar)
# retoma de onde parou, sem duplicar.
if [ "${LOJA_DEMONSTRACAO:-}" = "1" ]; then
    echo "→ preparando a demonstração…"
    if ! python -m app.cli preparar-demonstracao; then
        echo "⚠ a preparação da demonstração falhou (veja acima); a API sobe assim mesmo e" \
             "o próximo reinício retoma de onde parou." >&2
    fi
fi

echo "→ subindo a API"
exec "$@"
