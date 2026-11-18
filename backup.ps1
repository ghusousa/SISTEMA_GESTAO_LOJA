<#
.SYNOPSIS
    Cópia de segurança do banco da loja, no Windows.

.DESCRIPTION
    O equivalente do ./backup.sh para quem instalou pelo instalar.bat: um dump do banco em
    backups\, conferido (dump que não abre não é backup) e com os de mais de 14 dias
    apagados. A Tarefa Agendada "Loja - copia diaria do banco", que o instalador registra,
    roda isto todo dia — sem ela o backup não existia no Windows, e o ./backup.sh depende do
    systemd, que o Windows não tem.

    Restaurar uma cópia: ver "Restaurar um backup" no README.

.EXAMPLE
    .\backup.ps1
#>
[CmdletBinding()]
param([int]$DiasParaGuardar = 14)

$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot

$destino = Join-Path $PSScriptRoot "backups"
$registro = Join-Path $destino "backup.log"
New-Item -ItemType Directory -Force -Path $destino | Out-Null

# A pasta das cópias só para quem instalou (o "umask 077" do backup.sh): o dump é o banco
# inteiro, com CPF, telefones e hashes de senha. A tarefa roda com esse mesmo usuário.
try {
    & icacls $destino /inheritance:r /grant:r "$($env:USERNAME):(OI)(CI)F" 2>&1 | Out-Null
} catch { }

function Registrar($texto) {
    $linha = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $texto"
    Write-Host $linha
    Add-Content -Path $registro -Value $linha -Encoding UTF8
}

# Programas externos escrevem em stderr sem que isso seja erro; com Stop, o PowerShell 5.1
# transformaria essa saída em exceção. Devolve só o código de saída (como no instalar.ps1).
function RodarDocker {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Argumentos)
    $anterior = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & docker @Argumentos 2>&1 | Out-Null
        return $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $anterior
    }
}

# Computador recém-ligado: a tarefa roda assim que ele liga, e o Docker Desktop ainda está
# subindo. Espera até 5 minutos antes de desistir.
$pronto = $false
foreach ($i in 1..60) {
    if ((RodarDocker info) -eq 0) { $pronto = $true; break }
    Start-Sleep -Seconds 5
}
if (-not $pronto) { Registrar "ERRO: o Docker Desktop não respondeu. Abra-o e rode .\backup.ps1"; exit 1 }

# Caminho RELATIVO, como no desinstalar.ps1: "C:\..." tem dois-pontos, e o `docker cp`
# leria o "C" como nome de contêiner.
$arquivo = "backups\loja-" + (Get-Date -Format "yyyyMMdd-HHmmss") + ".dump"

# O dump é escrito DENTRO do contêiner e depois copiado: é binário, e passar pelo cano do
# PowerShell traduziria fim de linha e corromperia o arquivo sem aviso.
if ((RodarDocker compose exec -T db pg_dump -U loja -d loja -Fc -f /tmp/backup.dump) -ne 0) {
    Registrar "ERRO: o pg_dump falhou. O banco está no ar? (docker compose ps)"
    exit 1
}
$copiou = RodarDocker compose cp db:/tmp/backup.dump $arquivo
RodarDocker compose exec -T db rm -f /tmp/backup.dump | Out-Null
if ($copiou -ne 0 -or -not (Test-Path $arquivo)) { Registrar "ERRO: não consegui copiar o dump para $destino"; exit 1 }

# Dump que não abre não é backup — e só se descobre na hora de restaurar, a pior hora.
RodarDocker compose cp $arquivo db:/tmp/conferir.dump | Out-Null
$abre = RodarDocker compose exec -T db pg_restore -l /tmp/conferir.dump
RodarDocker compose exec -T db rm -f /tmp/conferir.dump | Out-Null
if ($abre -ne 0) {
    Remove-Item -Force $arquivo
    Registrar "ERRO: a cópia saiu ilegível e foi descartada. Não confie no backup até resolver."
    exit 1
}
$tamanho = [math]::Round((Get-Item $arquivo).Length / 1MB, 1)
Registrar "ok: $arquivo ($tamanho MB) - e ela abre"

# Duas semanas: cobre o "só percebi na segunda que estragou na quarta passada" sem encher
# o disco do computador do balcão.
Get-ChildItem -Path $destino -Filter "loja-*.dump" |
    Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-$DiasParaGuardar) } |
    Remove-Item -Force

Registrar "aviso: a cópia só existe NESTE computador. Se o disco morrer, ela morre junto - copie a pasta backups para um pendrive ou para a nuvem de vez em quando."
