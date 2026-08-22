<#
.SYNOPSIS
    Desinstalador do Sistema de Gestão da Loja para Windows.

.DESCRIPTION
    Por padrão faz um backup do banco antes de apagar qualquer coisa. Apagar os dados leva
    junto o histórico de vendas, o estoque e as despesas — e não tem desfazer.

.EXAMPLE
    .\desinstalar.ps1

.EXAMPLE
    .\desinstalar.ps1 -ManterDados
#>
[CmdletBinding()]
param(
    [switch]$Sim,
    [switch]$ManterDados,
    [switch]$SemBackup,
    [switch]$ApagarImagens
)

$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot

function Titulo($t) { Write-Host ""; Write-Host $t -ForegroundColor Cyan }
function Certo($t)  { Write-Host "  [ok] $t" -ForegroundColor Green }
function Alerta($t) { Write-Host "  [!] $t" -ForegroundColor Yellow }
function Morrer($t) { Write-Host ""; Write-Host "  [x] $t" -ForegroundColor Red; Write-Host ""; exit 1 }

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Morrer "Docker não encontrado - nada a desinstalar por aqui."
}

Titulo "Desinstalar o Sistema de Gestão da Loja"

if ($ManterDados) {
    Write-Host "  Modo: desligar e apagar os containers. Os DADOS ficam guardados."
    Write-Host "  Para voltar depois, rode .\instalar.ps1 - o banco estará como estava."
} else {
    Write-Host "  Modo: apagar TUDO, inclusive o banco." -ForegroundColor Red
    Write-Host "  Vai embora: histórico de vendas, estoque, despesas, usuários e fotos."
}

# ---------------------------------------------------------------- backup

if ((-not $ManterDados) -and (-not $SemBackup)) {
    Titulo "Backup antes de apagar"
    $rodando = docker compose ps --status running --format '{{.Service}}' 2>$null
    if ($rodando -contains 'db') {
        $arquivo = "loja-backup-$(Get-Date -Format 'yyyy-MM-dd-HHmm').dump"
        # cmd /c porque o redirecionamento do PowerShell converteria o dump binário em texto.
        cmd /c "docker compose exec -T db pg_dump -U loja -Fc loja > `"$arquivo`""
        if ((Test-Path $arquivo) -and ((Get-Item $arquivo).Length -gt 0)) {
            Certo "salvo em $(Join-Path $PSScriptRoot $arquivo) ($([math]::Round((Get-Item $arquivo).Length/1KB)) KB)"
            Write-Host ""
            Write-Host "  Para restaurar num sistema novo, depois de instalar:"
            Write-Host "    cmd /c `"docker compose exec -T db pg_restore -U loja -d loja --clean < $arquivo`""
        } else {
            Remove-Item $arquivo -ErrorAction SilentlyContinue
            Alerta "não foi possível gerar o backup (o banco respondeu?)."
            if (-not $Sim) {
                $r = Read-Host "  Continuar mesmo assim e apagar os dados? [s/N]"
                if ($r -notmatch '^[Ss]') { Morrer "cancelado." }
            }
        }
    } else {
        Alerta "o banco não está no ar; não há o que salvar por aqui."
        Alerta "se os dados ainda existem, suba com .\instalar.ps1 e rode este script de novo."
    }
}

# ---------------------------------------------------------------- confirmação

if (-not $Sim) {
    Titulo "Confirmação"
    if ($ManterDados) {
        $r = Read-Host "  Desligar e apagar os containers? [s/N]"
        if ($r -notmatch '^[Ss]') { Morrer "cancelado." }
    } else {
        Write-Host "  Isto apaga o banco de dados por completo."
        $r = Read-Host "  Digite APAGAR para confirmar"
        if ($r -ne "APAGAR") { Morrer "cancelado (nada foi apagado)." }
    }
}

# ---------------------------------------------------------------- remoção

Titulo "Removendo"
if ($ManterDados) {
    docker compose down
    Certo "containers removidos; volumes preservados"
} else {
    docker compose down -v
    Certo "containers e dados removidos"
    Remove-Item .env -ErrorAction SilentlyContinue
    Certo ".env removido"
}

if ($ApagarImagens) {
    docker image rm -f loja-api:local *> $null
    Certo "imagem loja-api:local removida"
    Alerta "as imagens base (postgres, caddy, python) continuam no cache do Docker."
    Alerta "para limpar tudo que não está em uso: docker system prune -a"
}

Titulo "Pronto"
if ($ManterDados) {
    Write-Host "  Os dados continuam guardados nos volumes do Docker."
    Write-Host "  Rode .\instalar.ps1 para voltar do jeito que estava."
} else {
    Write-Host "  O sistema saiu desta máquina. Se fez backup, o arquivo .dump está nesta pasta."
    Write-Host "  Para remover também o Docker: Configurações > Aplicativos > Docker Desktop."
}
Write-Host ""
