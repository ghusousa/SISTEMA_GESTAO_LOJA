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
fotos_demo() {  # fotos_demo [VAR=valor] → o DEMO_FOTOS_MAX_BYTES que chega à api-demo
    env "$@" docker compose -p "$PROJETO" --env-file "$TMP/env" --profile demo config --format json |
        json 'd["services"]["api-demo"]["environment"].get("DEMO_FOTOS_MAX_BYTES")'
}
conferir "o teto das fotos da demo tem padrão (sem DEMO_FOTOS_MAX_BYTES)" test "$(fotos_demo)" = 209715200
conferir "DEMO_FOTOS_MAX_BYTES vazio fica o padrão (vazio derrubaria a api-demo)" \
    test "$(fotos_demo DEMO_FOTOS_MAX_BYTES=)" = 209715200
conferir "DEMO_FOTOS_MAX_BYTES chega à api-demo" test "$(fotos_demo DEMO_FOTOS_MAX_BYTES=1048576)" = 1048576

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

# --- 9. Pool da demo e teto do corpo no proxy -----------------------------------------------
# A role loja_demo tem CONNECTION LIMIT 20: com o pool padrão (10 + 20) uma rajada passava de
# 20 conexões e o excesso saía 500, em vez de esperar a vez no pool. E o FastAPI lê o corpo
# inteiro ANTES de conferir o login: sem teto no Caddy, um PUT de foto gigante SEM login
# enchia o disco (o mesmo do banco) com o temporário — na loja e na demo. O teto vale por
# pedido (N conexões seguram N vezes ele), então é POR ROTA: 6 MB no envio da foto, 2 MB em
# todo o resto, que é JSON.
echo "9. pool da demo e teto do corpo"
conferir "a api-demo volta depois de parada" saudavel api-demo 240
conferir "a api-demo roda com pool 5 + 8 (cabe no CONNECTION LIMIT 20)" \
    test "$(dc exec -T api-demo python -c \
        'from app.core.config import settings as s; print(s.db_pool_size, s.db_max_overflow)')" = "5 8"
rajada() {  # rajada <caminho> <n> <vezes> → "status:quantos ..." de <vezes> rajadas de n GET
    # Cada rajada abre as n conexões ANTES e manda os n pedidos no mesmo instante: com uma
    # thread por pedido o escalonamento os espalhava, e nem o pool antigo estourava. E são
    # três porque a primeira pega o pool quase vazio, e abrir conexão nova é lento o bastante
    # para as primeiras voltarem a tempo: com o pool antigo ela dava 60 × 200. Da segunda em
    # diante o pool já guarda as ociosas — o dia a dia de uma demo em uso — e cada uma dava
    # 10 × 500.
    python3 - "$PORTA" "$1" "$2" "$3" <<'EOF'
import asyncio, collections, sys
porta, caminho, n, vezes = int(sys.argv[1]), sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
pedido = f"GET {caminho} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n".encode()
async def status(leitor):
    linha = await leitor.readline()
    return int(linha.split()[1]) if linha.startswith(b"HTTP/") else 0
async def rajada():
    conexoes = await asyncio.gather(
        *(asyncio.open_connection("127.0.0.1", porta) for _ in range(n)))
    for _, escritor in conexoes:
        escritor.write(pedido)
    codigos = await asyncio.wait_for(
        asyncio.gather(*(status(leitor) for leitor, _ in conexoes)), 90)
    for _, escritor in conexoes:
        escritor.close()
    return codigos
codigos = [c for _ in range(vezes) for c in asyncio.run(rajada())]
print(" ".join(f"{c}:{q}" for c, q in sorted(collections.Counter(codigos).items())))
EOF
}
placar=$(rajada /demo/api/v1/configuracao 60 3)
conferir "3 rajadas de 60 GET simultâneos na demo, nenhum 500 ($placar)" test "$placar" = "200:180"

# Um JPEG para a API (ela confere a assinatura): 7 MB passa do teto da foto (e não dos 10 MB
# de antes); 3 MB passa do teto do JSON, e a foto tem de passar mesmo assim (os dois tetos não
# se empilham); 200 KB é o que a web e o app mandam depois de encolher a foto. E um login de
# 3 MB, sem conta nenhuma: o JSON que o FastAPI guardaria na memória antes de olhar a senha.
{ printf '\377\330\377\340'; head -c 7000000 /dev/zero; } > "$TMP/grande.jpg"
{ printf '\377\330\377\340'; head -c 3000000 /dev/urandom; } > "$TMP/media.jpg"
{ printf '\377\330\377\340'; head -c $((200 * 1024)) /dev/urandom; } > "$TMP/peca.jpg"
python3 -c 'import sys; sys.stdout.write("{\"email\":\"x@x.example\",\"senha\":\"" + "a" * 3000000 + "\"}")' \
    > "$TMP/grande.json"
put_foto() {  # put_foto <arquivo> <url> [args do curl...] → status
    local arquivo=$1 url=$2; shift 2
    # Sem `Expect: 100-continue`: quem ataca manda o corpo de uma vez, sem pedir licença.
    curl -s -o "$TMP/resposta" -w '%{http_code}' -X PUT -H 'Expect:' "$@" \
        -F "arquivo=@$arquivo;type=image/jpeg" "$url"
}
for raiz in "" /demo; do
    # Na demo, 413 e nunca 503: o corpo grande não é "demonstração desligada".
    conferir "JSON de 3 MB sem login em ${raiz}/api/v1/auth/login: 413 do proxy" \
        test "$(curl -s -o "$TMP/resposta" -w '%{http_code}' -H 'Expect:' \
            -H 'Content-Type: application/json' --data-binary "@$TMP/grande.json" \
            "$BASE$raiz/api/v1/auth/login")" = 413
    conferir "PUT de 7 MB sem login em ${raiz}/api/v1/produtos/1/foto: 413 do proxy" \
        test "$(put_foto "$TMP/grande.jpg" "$BASE$raiz/api/v1/produtos/1/foto")" = 413
    conferir "o mesmo em pedaços, sem Content-Length (${raiz:-loja}): 413 do proxy" \
        test "$(put_foto "$TMP/grande.jpg" "$BASE$raiz/api/v1/produtos/1/foto" \
            -H 'Transfer-Encoding: chunked')" = 413
done
token_demo=$(login /demo dono@demo.example "$SENHA_DEMO" | json 'd.get("access_token","")')
token_real=$(login "" dona@loja.example "$SENHA_REAL" | json 'd.get("access_token","")')
produto_demo=$(curl -s -H "Authorization: Bearer $token_demo" \
    "$BASE/demo/api/v1/produtos?page=1&size=1" | json 'd["items"][0]["id"]')
categoria_real=$(curl -s -H "Authorization: Bearer $token_real" -H 'Content-Type: application/json' \
    -d '{"nome":"Pilha"}' "$BASE/api/v1/categorias" | json 'd["id"]')
produto_real=$(curl -s -H "Authorization: Bearer $token_real" -H 'Content-Type: application/json' \
    -d "{\"categoria_id\":$categoria_real,\"nome\":\"Peça da pilha\",\"variantes\":[{\"tamanho\":\"U\",\"preco_custo\":\"10.00\",\"preco_venda\":\"20.00\"}]}" \
    "$BASE/api/v1/produtos" | json 'd["id"]')
for foto in "peca:200 KB" "media:3 MB (acima do teto do JSON)"; do
    conferir "foto de ${foto#*:} com login passa pelo proxy (loja)" \
        test "$(put_foto "$TMP/${foto%%:*}.jpg" "$BASE/api/v1/produtos/$produto_real/foto" \
            -H "Authorization: Bearer $token_real")" = 200
    conferir "foto de ${foto#*:} com login passa pelo proxy (demo)" \
        test "$(put_foto "$TMP/${foto%%:*}.jpg" "$BASE/demo/api/v1/produtos/$produto_demo/foto" \
            -H "Authorization: Bearer $token_demo")" = 200
done

# --- 10. O tempo real atravessa o proxy ----------------------------------------------------
# O teto é do corpo do pedido HTTP. O WebSocket entra por um GET sem corpo e, depois do
# upgrade, o Caddy liga as duas pontas direto: o teto não vale para o que passa por ele, e a
# tela que fica aberta o dia inteiro não pode cair por causa dele.
echo "10. tempo real pelo proxy"
tempo_real() {  # tempo_real <raiz> <token> → "ok" se o aviso chega pelo socket
    # Entra, espera o "conectado", manda 3 MiB pelo socket (mais que o teto do JSON) e cria
    # uma categoria pela API: o aviso "catalogo" tem de chegar pelo MESMO socket.
    python3 - "$PORTA" "$1" "$2" <<'EOF'
import base64, json, os, socket, sys, urllib.request
porta, raiz, token = int(sys.argv[1]), sys.argv[2], sys.argv[3]
s = socket.create_connection(("127.0.0.1", porta), timeout=30)
s.sendall((f"GET {raiz}/api/v1/tempo-real HTTP/1.1\r\nHost: 127.0.0.1:{porta}\r\n"
           "Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\n"
           f"Sec-WebSocket-Key: {base64.b64encode(os.urandom(16)).decode()}\r\n\r\n").encode())
resto = b""
while b"\r\n\r\n" not in resto:
    pedaco = s.recv(4096)
    if not pedaco:
        sys.exit("o proxy fechou no aperto de mão")
    resto += pedaco
cabecalho, resto = resto.split(b"\r\n\r\n", 1)
if not cabecalho.startswith(b"HTTP/1.1 101"):
    sys.exit(cabecalho.split(b"\r\n")[0].decode())
def quadro(opcode, dados):  # do cliente para o servidor, sempre com máscara
    n, mascara = len(dados), os.urandom(4)
    if n < 126:
        tamanho = bytes([0x80 | n])
    elif n < 65536:
        tamanho = bytes([0x80 | 126]) + n.to_bytes(2, "big")
    else:
        tamanho = bytes([0x80 | 127]) + n.to_bytes(8, "big")
    m = int.from_bytes((mascara * (n // 4 + 1))[:n], "big")
    s.sendall(bytes([0x80 | opcode]) + tamanho + mascara
              + (int.from_bytes(dados, "big") ^ m).to_bytes(n, "big"))
def ler(n):
    global resto
    while len(resto) < n:
        pedaco = s.recv(65536)
        if not pedaco:
            raise EOFError("o socket fechou")
        resto += pedaco
    dados, resto = resto[:n], resto[n:]
    return dados
def assunto():  # o próximo aviso do servidor; o ping do protocolo é respondido no caminho
    while True:
        b0, b1 = ler(2)
        n = b1 & 0x7F
        if n >= 126:
            n = int.from_bytes(ler(2 if n == 126 else 8), "big")
        dados = ler(n)
        if b0 & 0x0F == 0x8:
            raise EOFError("o servidor fechou o socket")
        if b0 & 0x0F == 0x9:
            quadro(0xA, dados)
        elif b0 & 0x0F == 0x1:
            return json.loads(dados)["assunto"]
quadro(0x1, json.dumps({"tipo": "entrar", "token": token}).encode())
while assunto() != "conectado":
    pass
for _ in range(48):
    quadro(0x1, b"a" * 65536)
pedido = urllib.request.Request(
    f"http://127.0.0.1:{porta}{raiz}/api/v1/categorias", method="POST",
    data=json.dumps({"nome": f"Tempo real {os.urandom(3).hex()}"}).encode(),
    headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
urllib.request.urlopen(pedido, timeout=30).read()
while assunto() != "catalogo":
    pass
print("ok")
EOF
}
conferir "WebSocket da loja pelo proxy: 3 MiB pelo socket e o aviso ainda chega" \
    test "$(tempo_real "" "$token_real")" = ok
conferir "WebSocket da demo pelo proxy: 3 MiB pelo socket e o aviso ainda chega" \
    test "$(tempo_real /demo "$token_demo")" = ok

echo
if [ "$FALHAS" -gt 0 ]; then
    echo "✗ $FALHAS conferência(s) falharam" >&2
    exit 1
fi
echo "✓ loja e demonstração de pé, lado a lado, sem se enxergar"
