@echo off
REM Abre o app no celular pelo Expo Go, para testar sem gerar instalador.
REM
REM   testar.bat           celular e computador na mesma rede Wi-Fi
REM   testar.bat --tunel   redes diferentes, ou Wi-Fi que isola aparelhos
setlocal
cd /d "%~dp0"

where node >/dev/null 2>&1
if errorlevel 1 (
  echo.
  echo   [x] O Node.js nao esta instalado - o Expo precisa dele.
  echo.
  echo       Instale com:  winget install -e --id OpenJS.NodeJS.LTS
  echo       Ou baixe em https://nodejs.org (versao LTS).
  echo.
  echo       Depois de instalar, FECHE esta janela e abra outra, senao o
  echo       Windows ainda nao enxerga o node.
  echo.
  pause
  exit /b 1
)

if not exist node_modules (
  echo.
  echo   Instalando as dependencias. So na primeira vez, demora alguns minutos...
  echo.
  call npm install
  if errorlevel 1 (
    echo.
    echo   [x] A instalacao falhou. A mensagem acima diz o motivo.
    pause
    exit /b 1
  )
)

echo.
echo   COMO ABRIR NO CELULAR
echo.
echo   1. Instale o Expo Go no celular (Play Store ou App Store).
echo   2. Deixe o celular na MESMA rede Wi-Fi deste computador.
echo   3. Aponte a camera para o QR que vai aparecer aqui embaixo.
echo      No Android, use o botao "Scan QR code" dentro do Expo Go.
echo   4. Na primeira abertura o app pede o ENDERECO DO SERVIDOR da loja -
echo      e o mesmo que voce digita no navegador do balcao.
echo.
echo   Se o QR nao carregar, o firewall do Windows pode estar bloqueando.
echo   Abra o PowerShell COMO ADMINISTRADOR e rode uma vez:
echo.
echo      New-NetFirewallRule -DisplayName "Expo" -Direction Inbound -LocalPort 8081 -Protocol TCP -Action Allow -Profile Private
echo.
echo   Ainda assim sem carregar? Feche com Ctrl+C e rode:  testar.bat --tunel
echo.

if "%~1"=="--tunel" (
  npx expo start --tunnel
) else (
  npx expo start
)
pause
