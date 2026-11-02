#!/usr/bin/env bash
#
# Avisa o dono da loja no celular — ou, sem canal configurado, só no journal da máquina.
#
#     ./notificar.sh "Título" "mensagem"
#     ./notificar.sh --assunto disco --prioridade alta "Disco quase cheio" "92% usado"
#     ./notificar.sh --unidade loja-backup     o que o OnFailure= do systemd chama
#     ./notificar.sh --testar                  manda um aviso de teste agora
#     ./notificar.sh --instalar                grava a unidade loja-aviso@ do systemd
#
# O canal é o NOTIFICAR_URL do .env: o endereço de um tópico do ntfy
# (https://ntfy.sh/loja-k3x9q…). Quem instala o app ntfy no celular e assina o tópico recebe.
# Só o nome do tópico também serve (vira https://ntfy.sh/<nome>). Sem NOTIFICAR_URL o aviso
# vai para o journal (`journalctl -t loja-aviso`) — que é onde tudo ia parar antes, e onde
# ninguém olha: loja caída, atualização falhando e backup parado só eram descobertos pela
# vendedora com fila no caixa.
#
# O mesmo assunto não se repete antes de NOTIFICAR_INTERVALO_MIN minutos (padrão 60): a
# atualização que falha de 10 em 10 minutos manda UM aviso por hora, não seis — aviso que
# vira barulho é aviso que o dono silencia, e aí o próximo, o que importa, não chega.
#
# Opções:
#   --assunto CHAVE      o que conta como "o mesmo aviso" (padrão: o título)
#   --prioridade NIVEL   baixa, normal ou alta (padrão normal)
#   --a-cada MIN         intervalo mínimo entre dois avisos do mesmo assunto
#   --sempre             ignora o intervalo (para o --testar e para o "voltou")

set -euo pipefail
cd "$(dirname "$0")"

# O nome da unidade que falhou, e o que ela significa para quem lê no celular.
frase_da_unidade() {
    case "$1" in
        loja-atualizar)    echo "A atualização automática da loja falhou" ;;
        loja-backup)       echo "A cópia diária do banco falhou" ;;
        loja-backup-nuvem) echo "O backup para o Google Drive falhou" ;;
        loja-vigia)        echo "O vigia da loja falhou" ;;
        *)                 echo "$1 falhou" ;;
    esac
}

ASSUNTO=""; PRIORIDADE="normal"; SEMPRE=0; UNIDADE=""; ACAO="enviar"
INTERVALO="${NOTIFICAR_INTERVALO_MIN:-60}"
while [ $# -gt 0 ]; do
    case "$1" in
        --assunto)    ASSUNTO="${2:-}"; shift ;;
        --prioridade) PRIORIDADE="${2:-normal}"; shift ;;
        --a-cada)     INTERVALO="${2:-60}"; shift ;;
        --sempre)     SEMPRE=1 ;;
        --unidade)    UNIDADE="${2:-}"; shift ;;
        --testar)     ACAO="testar" ;;
        --instalar)   ACAO="instalar" ;;
        -h|--help)    sed -n '2,27p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        --*)          echo "Opção desconhecida: $1" >&2; exit 1 ;;
        *)            break ;;
    esac
    shift
done

DIR_SYSTEMD="${DIR_SYSTEMD:-/etc/systemd/system}"
PASTA="$(pwd)"

# ------------------------------------------------------------------ a unidade do systemd

# Uma unidade-modelo só, para todas: `OnFailure=loja-aviso@%N.service` nas unidades da loja
# faz o systemd chamar esta, com o nome de quem falhou em %i. Quem grava é o --automatico
# do atualizar.sh, do backup.sh e do vigia.sh, antes das próprias unidades.
if [ "$ACAO" = "instalar" ]; then
    sudo_se_preciso() { if [ "$(id -u)" -eq 0 ]; then "$@"; else sudo "$@"; fi; }
    sudo_se_preciso tee "$DIR_SYSTEMD/loja-aviso@.service" >/dev/null <<UNIDADE
[Unit]
Description=Avisa o dono da loja que %i falhou

[Service]
Type=oneshot
WorkingDirectory=$PASTA
Environment=HOME=/root
ExecStart=$PASTA/notificar.sh --unidade %i
TimeoutStartSec=60
UNIDADE
    exit 0
fi

# ------------------------------------------------------------------ o que dizer

case "$ACAO" in
    testar)
        set -- "Avisos da loja ligados" \
            "Se este chegou no celular, os avisos da loja vão chegar também. $(hostname 2>/dev/null || true)"
        SEMPRE=1
        ;;
esac
if [ -n "$UNIDADE" ]; then
    set -- "$(frase_da_unidade "$UNIDADE")" \
        "Em $(hostname 2>/dev/null || echo 'o servidor'), às $(date '+%d/%m %H:%M'). Para ver o motivo: journalctl -u $UNIDADE -n 40"
    ASSUNTO="${ASSUNTO:-falhou-$UNIDADE}"
    PRIORIDADE="alta"
fi
[ $# -ge 1 ] || { echo "Uso: ./notificar.sh \"Título\" \"mensagem\"" >&2; exit 1; }
TITULO="$1"
MENSAGEM="${2:-$1}"
ASSUNTO="${ASSUNTO:-$TITULO}"

# ------------------------------------------------------------------ não repetir

# O carimbo do último envio de cada assunto. Fica com o estado da máquina (docker/estado/,
# fora do git); não é segredo, é só "quando".
DIR_AVISOS="${DIR_AVISOS:-docker/estado/avisos}"
CARIMBO="$DIR_AVISOS/$(printf '%s' "$ASSUNTO" | tr -c 'A-Za-z0-9._-' '_')"

if [ "$SEMPRE" -eq 0 ] && [ -f "$CARIMBO" ]; then
    antes="$(head -1 "$CARIMBO" 2>/dev/null || echo 0)"
    case "$antes" in ''|*[!0-9]*) antes=0 ;; esac
    if [ $(( $(date +%s) - antes )) -lt $(( INTERVALO * 60 )) ]; then
        echo "aviso repetido segurado (\"$ASSUNTO\", já enviado há menos de $INTERVALO min): $TITULO"
        exit 0
    fi
fi

# ------------------------------------------------------------------ enviar

registrar() {
    # Sempre no journal também: é o histórico do que foi avisado, com ou sem celular.
    if command -v logger >/dev/null 2>&1; then logger -t loja-aviso -- "$1" 2>/dev/null || true; fi
    printf '%s\n' "$1"
}

carimbar() {
    mkdir -p "$DIR_AVISOS" 2>/dev/null || true
    date +%s > "$CARIMBO" 2>/dev/null || true
}

URL="${NOTIFICAR_URL:-$(grep -E '^NOTIFICAR_URL=' .env 2>/dev/null | cut -d= -f2- | tr -d '"' || true)}"
case "$URL" in
    '') ;;
    http://*|https://*) ;;
    *) URL="https://ntfy.sh/$URL" ;;
esac

if [ -z "$URL" ]; then
    # O limite de repetição vale aqui também: o journal não pode virar um "loja fora do ar" a
    # cada 5 minutos, escondendo o resto.
    registrar "[aviso] $TITULO — $MENSAGEM (sem NOTIFICAR_URL no .env: ficou só aqui)"
    carimbar
    exit 0
fi

# Cabeçalho HTTP é ASCII; o título tem acento. O ntfy aceita a forma da RFC 2047.
titulo_ascii="=?UTF-8?B?$(printf '%s' "$TITULO" | base64 | tr -d '\n')?="
case "$PRIORIDADE" in
    alta)  prioridade=high; etiqueta=rotating_light ;;
    baixa) prioridade=low;  etiqueta=information_source ;;
    *)     prioridade=default; etiqueta=warning ;;
esac

if ! command -v curl >/dev/null 2>&1; then
    registrar "[aviso] $TITULO — $MENSAGEM (o curl não está instalado: não deu para mandar ao celular)"
    exit 1
fi
if curl -fsS --max-time 20 -o /dev/null \
        -H "Title: $titulo_ascii" -H "Priority: $prioridade" -H "Tags: $etiqueta" \
        --data-binary "$MENSAGEM" "$URL"; then
    carimbar
    registrar "[aviso enviado] $TITULO — $MENSAGEM"
else
    # Sem carimbo: o próximo tenta de novo, em vez de achar que o dono já sabe.
    registrar "[aviso NÃO enviado: o ntfy não respondeu] $TITULO — $MENSAGEM"
    exit 1
fi
