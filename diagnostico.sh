#!/usr/bin/env bash
#
# Coleta o estado do sistema para descobrir por que ele parou.
#
#     ./diagnostico.sh
#
# Só LÊ. Não reinicia, não muda nada, não apaga nada — dá para rodar com a loja aberta.
# RODE ANTES DE REINICIAR: reiniciar apaga o log do contêiner que caiu, e o motivo vai junto.
# Ao final, salva tudo num arquivo para você mandar por WhatsApp.
#
# Existe porque "parou e não voltou" pode ser meia dúzia de coisas bem diferentes —
# contêiner caído, disco cheio, banco fora, certificado vencido, memória estourada — e
# cada uma tem um comando próprio. Perguntar dez comandos por mensagem, um de cada vez,
# custa uma manhã de loja fechada.

set -uo pipefail
cd "$(dirname "$0")"

VERDE=$'\033[32m'; AMARELO=$'\033[33m'; VERMELHO=$'\033[31m'; AZUL=$'\033[36m'
FORTE=$'\033[1m'; NORMAL=$'\033[0m'
[ -t 1 ] || { VERDE=""; AMARELO=""; VERMELHO=""; AZUL=""; FORTE=""; NORMAL=""; }

SAIDA="diagnostico-$(date +%Y%m%d-%H%M%S).txt"
exec > >(tee "$SAIDA") 2>&1

titulo() { printf '\n%s━━ %s%s\n' "$FORTE$AZUL" "$1" "$NORMAL"; }
ok()     { printf '  %s✓%s %s\n' "$VERDE" "$NORMAL" "$1"; }
mal()    { printf '  %s✗%s %s\n' "$VERMELHO" "$NORMAL" "$1"; }
nota()   { printf '  %s!%s %s\n' "$AMARELO" "$NORMAL" "$1"; }

PREFIXO_DOCKER=""
dk() { if [ -n "$PREFIXO_DOCKER" ]; then sudo docker "$@"; else docker "$@"; fi; }

printf '%sDiagnóstico do sistema da loja%s — %s\n' "$FORTE" "$NORMAL" "$(date '+%d/%m/%Y %H:%M:%S')"

# --------------------------------------------------------------- 1. o básico

titulo "Máquina"
printf '  %s\n' "$(uname -a)"
printf '  tempo ligada: %s\n' "$(uptime -p 2>/dev/null || uptime)"

titulo "Memória"
free -h 2>/dev/null | sed 's/^/  /'
# Servidor pequeno com Postgres + API + proxy é onde a memória acaba, e o Linux mata o
# processo mais gordo em silêncio: o log da aplicação não registra nada.
if dmesg 2>/dev/null | grep -qi "out of memory\|oom-kill"; then
    mal "O Linux JÁ MATOU algum processo por falta de memória:"
    dmesg 2>/dev/null | grep -i "out of memory\|oom-kill" | tail -5 | sed 's/^/    /'
fi

titulo "Disco"
df -h / 2>/dev/null | sed 's/^/  /'
USO="$(df --output=pcent / 2>/dev/null | tail -1 | tr -dc '0-9')"
if [ -n "${USO:-}" ] && [ "$USO" -ge 90 ]; then
    mal "Disco em ${USO}% — o Postgres PARA DE ACEITAR ESCRITA perto de 100%."
    printf '    O que costuma ocupar: log do Docker e imagens antigas.\n'
    printf '    Ver os maiores: %sdu -sh /var/lib/docker/* | sort -h | tail%s\n' "$FORTE" "$NORMAL"
    printf '    Limpar imagens sem uso: %sdocker system prune -a%s (não apaga os dados)\n' "$FORTE" "$NORMAL"
else
    ok "disco em ${USO:-?}%"
fi

# --------------------------------------------------------------- 2. docker

titulo "Docker"
if docker info >/dev/null 2>&1; then
    PREFIXO_DOCKER=""; ok "respondendo"
elif command -v sudo >/dev/null 2>&1 && sudo -n docker info >/dev/null 2>&1; then
    PREFIXO_DOCKER="sudo"; ok "respondendo (com sudo)"
else
    mal "O Docker não responde. É por isso que a loja está fora."
    printf '    Tente: %ssudo systemctl start docker%s e depois %s./instalar.sh%s\n\n' \
        "$FORTE" "$NORMAL" "$FORTE" "$NORMAL"
    exit 1
fi

titulo "Contêineres"
dk compose ps 2>/dev/null | sed 's/^/  /'

printf '\n'
for id in $(dk compose ps -aq 2>/dev/null); do
    linha="$(dk inspect --format '{{.Name}}|{{.State.Status}}|{{.RestartCount}}|{{.State.OOMKilled}}|{{.State.ExitCode}}' "$id" 2>/dev/null)"
    IFS='|' read -r nome estado reinicios oom saiu <<< "$linha"
    if [ "$oom" = "true" ]; then
        mal "$nome foi MORTO POR FALTA DE MEMÓRIA (reinícios: $reinicios)"
    elif [ "$estado" != "running" ]; then
        mal "$nome está '$estado', saiu com código $saiu (reinícios: $reinicios)"
    elif [ "${reinicios:-0}" -gt 3 ]; then
        nota "$nome está de pé, mas já reiniciou $reinicios vezes — algo o derruba"
    elif [ "${reinicios:-0}" -gt 0 ]; then
        ok "$nome: $estado (reiniciou $reinicios vez(es))"
    else
        ok "$nome: $estado"
    fi
done

# Reiniciar APAGA o log de antes: o contêiner velho é removido e leva o motivo junto.
# É o que sempre acontece — a pessoa reinicia primeiro (certo: a loja precisa abrir) e
# só depois vai investigar. Dizer isso aqui evita procurar por horas o que não existe.
RECENTE=0
for id in $(dk compose ps -q 2>/dev/null); do
    # `.Created`, não `.State.StartedAt`: um `restart` reaproveita o contêiner e o log
    # continua inteiro. Quem apaga é `up -d --build` / `down`, que TROCAM o contêiner.
    inicio="$(dk inspect --format '{{.Created}}' "$id" 2>/dev/null)"
    segundos=$(( $(date +%s) - $(date -d "$inicio" +%s 2>/dev/null || echo 0) ))
    [ "$segundos" -lt 1800 ] && [ "$segundos" -ge 0 ] && RECENTE=1
done
if [ "$RECENTE" -eq 1 ]; then
    printf '\n'
    nota "os contêineres subiram há pouco — o log de ANTES disso não existe mais."
    printf '    Se o sistema tinha parado, o motivo se apagou junto com o contêiner velho.\n'
    printf '    Da próxima vez: rode %s./diagnostico.sh%s ANTES de reiniciar.\n' "$FORTE" "$NORMAL"
    printf '    (O %s./atualizar.sh%s guarda o log sozinho antes de reconstruir.)\n' "$FORTE" "$NORMAL"
fi

# --------------------------------------------------------------- 3. a aplicação

titulo "A API responde por dentro?"
if dk compose exec -T api python -c \
    'import urllib.request
print(urllib.request.urlopen("http://127.0.0.1:8000/health", timeout=5).read().decode())' 2>/dev/null; then
    ok "a API está viva dentro do contêiner"
    APLICACAO_OK=1
else
    mal "a API NÃO responde nem dentro do próprio contêiner"
    APLICACAO_OK=0
fi

titulo "O banco responde?"
if dk compose exec -T db pg_isready -U loja -d loja 2>/dev/null | sed 's/^/  /'; then
    ok "banco de pé"
else
    mal "o banco não responde — sem ele a API não sobe"
fi

titulo "E de fora, pelo endereço que a loja usa?"
PORTA="$(grep -E '^PORTA_HTTP=' .env 2>/dev/null | cut -d= -f2 | tr -d '"')"
PORTA="${PORTA:-80}"
DOMINIO="$(grep -E '^DOMINIO=' .env 2>/dev/null | cut -d= -f2 | tr -d '"')"

# Bater em localhost quando a loja tem domínio não prova nada: o Caddy responde 308
# mandando para o HTTPS, e "308" assusta quem lê sem dizer se a loja abre ou não.
# O teste tem de ser o endereço que a pessoa digita no navegador.
case "$DOMINIO" in
    ""|localhost|127.0.0.1) ALVO="http://localhost:${PORTA}/health" ;;
    *)                      ALVO="https://${DOMINIO}/health" ;;
esac

CODIGO="$(curl -s -o /dev/null -w '%{http_code}' -m 15 "$ALVO" 2>/dev/null)"
case "$CODIGO" in
    200)              ok "$ALVO → 200 (a loja abre)" ;;
    502|503)          mal "$CODIGO em $ALVO — o proxy está de pé, mas a API atrás dele não" ;;
    301|302|307|308)  ok "$ALVO → $CODIGO (manda para o HTTPS; é o esperado)" ;;
    000)
        mal "sem resposta em $ALVO"
        # Certificado vencido e DNS mudado derrubam a loja com TODOS os contêineres de
        # pé — o motivo só aparece no recado do curl, nunca no log dos contêineres.
        RECADO="$(curl -sS -o /dev/null -m 15 "$ALVO" 2>&1 | head -2)"
        [ -n "$RECADO" ] && printf '    %s\n' "$RECADO"
        ;;
    *) nota "respondeu $CODIGO em $ALVO" ;;
esac

# Certificado: o Caddy renova sozinho, mas renovação que falha só aparece no dia em que
# vence — e aí a loja "para" sem nenhum contêiner ter caído.
case "$DOMINIO" in
    ""|localhost|127.0.0.1) ;;
    *)
        if command -v openssl >/dev/null 2>&1; then
            VENCE="$(echo | openssl s_client -connect "${DOMINIO}:443" -servername "$DOMINIO" 2>/dev/null \
                | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)"
            if [ -n "$VENCE" ]; then
                DIAS=$(( ( $(date -d "$VENCE" +%s 2>/dev/null || echo 0) - $(date +%s) ) / 86400 ))
                if [ "$DIAS" -lt 0 ]; then
                    mal "o certificado VENCEU há $(( -DIAS )) dias — o navegador recusa o site"
                elif [ "$DIAS" -lt 10 ]; then
                    nota "o certificado vence em $DIAS dias e não renovou ainda"
                else
                    ok "certificado válido por mais $DIAS dias"
                fi
            fi
        fi
        ;;
esac

# --------------------------------------------------------------- 4. os logs

titulo "Últimos erros da API"
# grep pelo que importa: quem lê um log inteiro de madrugada não acha o traceback.
ERROS="$(dk compose logs --tail 400 api 2>/dev/null | grep -iE "traceback|error|exception|critical|refused|killed|no space" | tail -25)"
if [ -n "$ERROS" ]; then
    printf '%s\n' "$ERROS" | sed 's/^/  /'
else
    ok "nenhum erro nas últimas 400 linhas"
fi

titulo "Últimas 30 linhas da API (inteiras)"
# Fora o healthcheck: o Docker bate em /health de 10 em 10 segundos e, sem tirar essas
# linhas, as últimas 30 são sempre as mesmas 30 batidas — nunca o que deu errado.
dk compose logs --tail 200 api 2>/dev/null \
    | grep -v 'GET /health HTTP' | tail -30 | sed 's/^/  /'

titulo "Últimos erros do banco"
dk compose logs --tail 200 db 2>/dev/null | grep -iE "fatal|error|panic|shutting down" | tail -10 | sed 's/^/  /' \
    || ok "nada de grave no banco"

titulo "Últimos erros do proxy"
dk compose logs --tail 200 proxy 2>/dev/null | grep -iE "error|fail|obtain|certificate" | tail -10 | sed 's/^/  /' \
    || ok "nada de grave no proxy"

# --------------------------------------------------------------- 5. versão

titulo "Tamanho dos logs"
# Log sem teto é a causa silenciosa de "parou e não voltou": enche o disco, o Postgres
# para de aceitar escrita e nada no log da aplicação explica.
for id in $(dk compose ps -aq 2>/dev/null); do
    caminho="$(dk inspect --format '{{.LogPath}}' "$id" 2>/dev/null)"
    nome="$(dk inspect --format '{{.Name}}' "$id" 2>/dev/null)"
    tamanho="$(du -h "$caminho" 2>/dev/null | cut -f1)"
    # O arquivo pertence ao root; sem sudo o `du` não enxerga e não adianta insistir.
    [ -z "$tamanho" ] && [ -n "$PREFIXO_DOCKER" ] \
        && tamanho="$(sudo du -h "$caminho" 2>/dev/null | cut -f1)"
    printf '  %s: %s\n' "$nome" "${tamanho:-?}"
done

titulo "Atualização sozinha"
# Timer parado ou falhando é a diferença entre "o sistema está velho" e "o sistema não
# consegue mais se atualizar" — e as duas se parecem: nada acontece.
if systemctl list-unit-files loja-atualizar.timer >/dev/null 2>&1 \
    && systemctl is-enabled loja-atualizar.timer >/dev/null 2>&1; then
    ok "ligada — $(systemctl list-timers loja-atualizar.timer --no-pager 2>/dev/null | sed -n '2p' | awk '{print "próxima em", $3, $4}')"
    ULTIMA="$(systemctl show loja-atualizar.service -p Result --value 2>/dev/null)"
    if [ -n "$ULTIMA" ] && [ "$ULTIMA" != "success" ]; then
        mal "a última tentativa falhou ($ULTIMA):"
        journalctl -u loja-atualizar -n 12 --no-pager 2>/dev/null | tail -8 | sed 's/^/    /'
    fi
else
    nota "desligada — a loja só atualiza quando alguém rodar ./atualizar.sh"
    printf '    Para ligar: %s./atualizar.sh --automatico%s\n' "$FORTE" "$NORMAL"
fi

titulo "Versão instalada"
if git rev-parse --git-dir >/dev/null 2>&1; then
    printf '  %s\n' "$(git --no-pager log --oneline -1 2>/dev/null)"
    SUJO="$(git status --porcelain 2>/dev/null | head -5)"
    [ -n "$SUJO" ] && { nota "há alterações locais nesta pasta:"; printf '%s\n' "$SUJO" | sed 's/^/    /'; }
else
    nota "não é um clone do git (instalado por ZIP?)"
fi

# --------------------------------------------------------------- 6. o que fazer

titulo "O que fazer agora"
if [ "${APLICACAO_OK:-0}" = "1" ] && [ "$CODIGO" = "200" ]; then
    ok "O sistema está NO AR. Se a tela não abre, o problema é rede, DNS ou o navegador:"
    printf '    · tente %sCtrl+F5%s (o navegador pode estar mostrando cópia velha)\n' "$FORTE" "$NORMAL"
    printf '    · veja se o domínio ainda aponta para este servidor\n'
else
    printf '  Tente nesta ordem, parando quando voltar:\n\n'
    printf '    1. %sdocker compose up -d%s          religa o que caiu\n' "$FORTE" "$NORMAL"
    printf '    2. %sdocker compose restart%s        reinicia tudo\n' "$FORTE" "$NORMAL"
    printf '    3. %s./instalar.sh%s                 reconstrói e sobe (não apaga dados)\n' "$FORTE" "$NORMAL"
    printf '\n  Se nada resolver, mande o arquivo abaixo para quem cuida do sistema.\n'
fi

printf '\n%sSalvo em: %s%s\n' "$FORTE" "$SAIDA" "$NORMAL"
printf 'Mande esse arquivo por WhatsApp que dá para ver o que aconteceu.\n\n'
