#!/bin/sh
# Banco da DEMONSTRAÇÃO (ADR-46): cria e ajusta, a cada `docker compose up`, o banco
# `loja_demo` e a role `loja_demo` no MESMO Postgres da loja — e fecha a porta do banco real.
#
# Roda no serviço one-shot `demo-banco` (imagem do Postgres, profile `demo`), conectado ao
# `db` como o superusuário `loja`. Tudo aqui é idempotente e CONVERGE: role que já existe tem
# a senha e os limites reaplicados, banco que já existe só tem dono, permissões e marco
# conferidos. Assim a senha do .env manda, mesmo depois de um restore ou de um volume antigo.
#
# O que isola a demonstração da loja de verdade, e por quê:
#   - a role `loja_demo` NÃO é superusuário e não cria banco nem role: dentro do Postgres ela
#     só enxerga o que é dela;
#   - `REVOKE CONNECT ON DATABASE loja FROM PUBLIC`: a role da demo nem CONECTA no banco real
#     (superusuário passa por cima, e só a loja e o backup usam o superusuário);
#   - `CONNECTION LIMIT 20`: um revisor (ou um robô) martelando a demo não toma as conexões da
#     loja — o `max_connections` do Postgres é um só para os dois bancos;
#   - o marco `loja.demonstracao = 'sim'` no banco da demo é a segunda chave das rotinas que
#     APAGAM dados (renovar a demo): elas exigem o marco além da variável de ambiente, e o
#     banco real nunca tem o marco.
set -eu

case "${SENHA_DEMO:-}" in
    "")
        echo "✗ DEMO_SENHA_BANCO está vazia no .env: a demonstração não sobe." >&2
        echo "  Para ligá-la numa loja já instalada: ./demo.sh --ligar" >&2
        exit 1
        ;;
    *[!A-Za-z0-9_-]*)
        # Mesma régua da SENHA_BANCO (instalar.sh): o compose expande $ no .env, e / ou # na
        # URL de conexão quebram o endereço inteiro. E a senha entra numa string SQL abaixo.
        echo "✗ DEMO_SENHA_BANCO tem caractere fora de A-Z, a-z, 0-9, _ e -." >&2
        exit 1
        ;;
esac
if [ "${#SENHA_DEMO}" -lt 16 ]; then
    echo "✗ DEMO_SENHA_BANCO curta demais (mínimo 16)." >&2
    exit 1
fi

# O healthcheck do `db` já passou (depends_on), mas pelo socket de dentro do contêiner; daqui
# é pela rede, que pode demorar um instante a mais.
tentativa=0
until pg_isready -q; do
    tentativa=$((tentativa + 1))
    if [ "$tentativa" -ge 30 ]; then
        echo "✗ o banco não respondeu pela rede em 30 tentativas." >&2
        exit 1
    fi
    sleep 1
done

# A senha vai DENTRO do SQL, pelo stdin (here-doc): nunca na linha de comando, onde qualquer
# processo da máquina a leria em /proc. A régua acima garante que ela não fecha a aspa.
psql -v ON_ERROR_STOP=1 --quiet --no-psqlrc <<SQL
SELECT 'CREATE ROLE loja_demo'
 WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'loja_demo') \gexec
ALTER ROLE loja_demo WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
    CONNECTION LIMIT 20 PASSWORD '${SENHA_DEMO}';

SELECT 'CREATE DATABASE loja_demo OWNER loja_demo'
 WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'loja_demo') \gexec
ALTER DATABASE loja_demo OWNER TO loja_demo;

REVOKE CONNECT, TEMPORARY ON DATABASE loja FROM PUBLIC;
REVOKE CONNECT, TEMPORARY ON DATABASE postgres FROM PUBLIC;
REVOKE ALL ON DATABASE loja_demo FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE loja_demo TO loja_demo;

ALTER DATABASE loja_demo SET loja.demonstracao = 'sim';
SQL

echo "✓ banco da demonstração pronto (loja_demo, sem acesso ao banco da loja)"
