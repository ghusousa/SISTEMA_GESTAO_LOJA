@echo off
REM Instalador para Windows.
REM
REM Este .bat existe porque o Windows recusa .ps1 nao assinado por padrao ("nao esta
REM assinado digitalmente / PSSecurityException"), e ainda bloqueia arquivos vindos de
REM ZIP baixado da internet (Mark of the Web). Arquivo .bat nao passa por nenhuma das
REM duas travas: da para clicar duas vezes, e ele chama o PowerShell do jeito certo.
setlocal
if not exist "%~dp0instalar.ps1" (
  echo.
  echo   [x] Nao encontrei o instalar.ps1 nesta pasta.
  echo.
  echo       Se voce clicou no arquivo DENTRO do ZIP, ele nao foi extraido de verdade.
  echo       Feche esta janela, clique com o botao direito no ZIP, escolha "Extrair
  echo       tudo" e rode o instalar.bat de dentro da pasta extraida.
  echo.
  pause
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0instalar.ps1" %*
set CODIGO=%ERRORLEVEL%
if "%~1"=="" pause
exit /b %CODIGO%
