#!/usr/bin/env bash
#
# Abre o app no celular pelo Expo Go, para testar sem gerar instalador.
#
#   ./testar.sh              celular e computador na mesma rede Wi-Fi
#   ./testar.sh --tunel      redes diferentes, ou Wi-Fi que isola aparelhos
#
set -euo pipefail
cd "$(dirname "$0")"

VERDE=$'\033[32m'; AMARELO=$'\033[33m'; AZUL=$'\033[36m'; FORTE=$'\033[1m'; NORMAL=$'\033[0m'
[ -t 1 ] || { VERDE=""; AMARELO=""; AZUL=""; FORTE=""; NORMAL=""; }

TUNEL=0
[ "${1:-}" = "--tunel" ] && TUNEL=1

command -v node >/dev/null 2>&1 || {
    printf '\n%s✗ Node.js não está instalado.%s\n' "$AMARELO" "$NORMAL"
    echo "  Ubuntu: sudo apt install -y nodejs npm"
    echo "  Mac:    brew install node"
    echo "  Ou baixe em https://nodejs.org (versão LTS)"
    echo
    exit 1
}

printf '\n%sPreparando o app%s\n' "$FORTE$AZUL" "$NORMAL"
if [ ! -d node_modules ]; then
    echo "  → instalando as dependências (só na primeira vez, demora alguns minutos)…"
    npm install
fi

cat <<FIM

${FORTE}${AZUL}Como abrir no celular${NORMAL}

  1. Instale o ${FORTE}Expo Go${NORMAL} no celular (Play Store ou App Store).
  2. Deixe o celular na ${FORTE}mesma rede Wi-Fi${NORMAL} deste computador.
  3. Aponte a câmera para o QR que vai aparecer aqui embaixo.
     No Android, use o botão "Scan QR code" dentro do próprio Expo Go.
  4. Na primeira abertura o app pede o ${FORTE}endereço do servidor${NORMAL} da loja —
     é o mesmo que você digita no navegador do balcão.

  ${AMARELO}Se o QR não carregar:${NORMAL} o Wi-Fi pode estar isolando os aparelhos, ou o
  firewall bloqueando a porta 8081. Encerre com Ctrl+C e rode:

      ./testar.sh --tunel

FIM

if [ "$TUNEL" -eq 1 ]; then
    printf '%s→ modo túnel: funciona em qualquer rede, porém mais lento%s\n\n' "$VERDE" "$NORMAL"
    exec npx expo start --tunnel
fi
exec npx expo start
