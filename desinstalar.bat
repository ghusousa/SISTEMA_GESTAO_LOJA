@echo off
REM Desinstalador para Windows. Ver o comentario em instalar.bat: .bat nao esbarra na
REM politica de execucao do PowerShell nem no bloqueio de arquivo baixado.
setlocal
if not exist "%~dp0desinstalar.ps1" (
  echo.
  echo   [x] Nao encontrei o desinstalar.ps1 nesta pasta. Extraia o ZIP antes de rodar.
  echo.
  pause
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0desinstalar.ps1" %*
set CODIGO=%ERRORLEVEL%
if "%~1"=="" pause
exit /b %CODIGO%
