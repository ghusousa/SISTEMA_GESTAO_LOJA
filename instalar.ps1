<#
.SYNOPSIS
    Instalador do Sistema de Gestão da Loja para Windows.

.DESCRIPTION
    Pergunta o endereço, os dados do dono e a senha do banco, sobe tudo em Docker e termina
    com o sistema no ar. Rodar de novo é seguro: reaproveita o que já existe.

.EXAMPLE
    .\instalar.ps1

.EXAMPLE
    .\instalar.ps1 -Dominio loja.exemplo.com.br -Email dona@loja.com -Nome "Dona Maria" -Senha "..." -Sim
#>
[CmdletBinding()]
param(
    [string]$Dominio = "",
    [string]$Email = "",
    [string]$Nome = "",
    [string]$Senha = "",
    [string]$SenhaBanco = "",
    [string]$Fuso = "America/Sao_Paulo",
    [string]$PortaHttp = "80",
    [string]$PortaHttps = "443",
    [switch]$Sim,
    [switch]$Forcar
)

$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot

function Titulo($t) { Write-Host ""; Write-Host $t -ForegroundColor Cyan }
function Certo($t)  { Write-Host "  [ok] $t" -ForegroundColor Green }
function Alerta($t) { Write-Host "  [!] $t" -ForegroundColor Yellow }
function Morrer($t) { Write-Host ""; Write-Host "  [x] $t" -ForegroundColor Red; Write-Host ""; exit 1 }

function Sortear([int]$tamanho = 32) {
    $bytes = [byte[]]::new(64)
    [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
    ([Convert]::ToBase64String($bytes) -replace '[^A-Za-z0-9]', '').Substring(0, $tamanho)
}

function Perguntar($texto, $padrao, $valorAtual) {
    # Valor já passado por parâmetro nunca é perguntado de novo.
    if ($valorAtual) { return $valorAtual }
    if (-not $Sim) {
        $r = if ($padrao) { Read-Host "  $texto [$padrao]" } else { Read-Host "  $texto" }
        if ($r) { return $r }
    }
    return $padrao
}

function PerguntarSenha($texto, $valorAtual) {
    if ($valorAtual) { return $valorAtual }
    # Sem teclado (modo -Sim), volta vazio de propósito: a validação abaixo diz o que faltou
    # em vez de o instalador ficar pendurado esperando digitação.
    if ($Sim) { return "" }
    while ($true) {
        $a = Read-Host "  $texto" -AsSecureString
        $b = Read-Host "  repita a senha"  -AsSecureString
        $textoA = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
            [Runtime.InteropServices.Marshal]::SecureStringToBSTR($a))
        $textoB = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
            [Runtime.InteropServices.Marshal]::SecureStringToBSTR($b))
        if ($textoA.Length -lt 8) { Alerta "mínimo de 8 caracteres."; continue }
        if ($textoA -ne $textoB)  { Alerta "as senhas não são iguais."; continue }
        return $textoA
    }
}

function EmailValido($e) { return $e -match '^[^@\s]+@[^@\s]+\.[^@\s]+$' }

# Endereço sem DNS: localhost, vazio ou um IP. Decide HTTP puro em vez de HTTPS.
function EnderecoLocal($d) {
    return (-not $d) -or ($d -eq "localhost") -or ($d -match '^\d+(\.\d+){3}$')
}

# ---------------------------------------------------------------- verificações

Titulo "Sistema de Gestão da Loja - instalação"

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Morrer "O Docker Desktop não está instalado.`n      Baixe em: https://www.docker.com/products/docker-desktop"
}
docker compose version *> $null
if ($LASTEXITCODE -ne 0) { Morrer "O Docker está sem o plugin 'compose'. Atualize o Docker Desktop." }
docker info *> $null
if ($LASTEXITCODE -ne 0) {
    Morrer "O Docker está instalado mas não responde.`n      Abra o Docker Desktop e espere o ícone ficar verde."
}
Certo "Docker pronto"

# ---------------------------------------------------------------- perguntas

$reaproveitado = $false

if ((Test-Path .env) -and (-not $Forcar)) {
    Alerta "Já existe um .env - a instalação vai reaproveitar as configurações dele."
    Alerta "Para começar do zero, rode com -Forcar (isto NÃO apaga os dados do banco)."
    $reaproveitado = $true
    Get-Content .env | ForEach-Object {
        if ($_ -match '^\s*([A-Z_]+)=(.*)$') { Set-Variable -Name "env_$($Matches[1])" -Value $Matches[2] }
    }
    $Dominio    = (Get-Variable -Name "env_DOMINIO" -ValueOnly -ErrorAction SilentlyContinue)
    $PortaHttp  = (Get-Variable -Name "env_PORTA_HTTP" -ValueOnly -ErrorAction SilentlyContinue)
} else {
    Titulo "1. Endereço do sistema"
    Write-Host "  Se a loja tem um domínio apontado para este computador, informe-o: o certificado"
    Write-Host "  HTTPS é pedido e renovado sozinho. Deixe 'localhost' para usar só nesta máquina."
    $Dominio = Perguntar "Domínio (DNS)" "localhost" $Dominio

    Titulo "2. Dono da loja"
    Write-Host "  É a conta de administrador: vê custo, lucro, despesas e relatórios."
    $Nome = Perguntar "Nome" "Dona da Loja" $Nome
    while ($true) {
        $Email = Perguntar "E-mail (é com ele que você entra)" "" $Email
        if (EmailValido $Email) { break }
        Alerta "e-mail inválido."; $Email = ""
        if ($Sim) { break }
    }
    $Senha = PerguntarSenha "Senha do dono (mínimo 8 caracteres)" $Senha

    Titulo "3. Banco de dados"
    Write-Host "  Esta senha fica só entre os containers; ninguém digita no dia a dia."
    if ((-not $Sim) -and (-not $SenhaBanco)) {
        $gerar = Read-Host "  Gerar uma senha forte automaticamente? [S/n]"
        if ($gerar -match '^[Nn]') { $SenhaBanco = PerguntarSenha "Senha do banco" "" }
    }
    if (-not $SenhaBanco) { $SenhaBanco = Sortear 32; Certo "senha do banco gerada" }

    Titulo "4. Fuso horário"
    Write-Host "  Define o que é 'hoje' no caixa e nos relatórios."
    $Fuso = Perguntar "Fuso" "America/Sao_Paulo" $Fuso
}

# ---------------------------------------------------------------- endereço

if (EnderecoLocal $Dominio) {
    # HTTP puro: aqui o AMBIENTE precisa ser 'local', senão o cookie de sessão sai marcado
    # como Secure, o navegador se recusa a guardá-lo em http:// e ninguém continua logado.
    $enderecoProxy = ":80"
    $ambiente = "local"
    $cors = "*"
    $urlFinal = if ($PortaHttp -ne "80") { "http://localhost:$PortaHttp" } else { "http://localhost" }
    $modo = "local, sem HTTPS"
} else {
    $enderecoProxy = $Dominio
    $ambiente = "producao"
    $cors = "https://$Dominio"
    $urlFinal = "https://$Dominio"
    $modo = "domínio $Dominio, com HTTPS automático"
}

if (-not $reaproveitado) {
    if (-not $Nome)  { Morrer "faltou -Nome" }
    if (-not (EmailValido $Email)) { Morrer "e-mail inválido ou ausente (-Email)" }
    if ($Senha.Length -lt 8) { Morrer "a senha do dono precisa de ao menos 8 caracteres (-Senha)" }

    Titulo "Gravando a configuração"
    $conteudo = @"
# Gerado por instalar.ps1 - contém senhas. NÃO versione, não compartilhe.
DOMINIO=$Dominio
ENDERECO_PROXY=$enderecoProxy
PORTA_HTTP=$PortaHttp
PORTA_HTTPS=$PortaHttps

SENHA_BANCO=$SenhaBanco
JWT_SECRET=$(Sortear 64)

AMBIENTE=$ambiente
CORS_ORIGINS=$cors
TIMEZONE_LOJA=$Fuso
"@
    # UTF8 sem BOM: o docker compose não entende o marcador de byte-order no começo do .env.
    [System.IO.File]::WriteAllText((Join-Path $PSScriptRoot ".env"), $conteudo,
        (New-Object System.Text.UTF8Encoding $false))
    Certo ".env gravado"
}

# ---------------------------------------------------------------- subir

Titulo "Construindo e subindo os containers"
Write-Host "  isto demora alguns minutos na primeira vez"
docker compose up -d --build
if ($LASTEXITCODE -ne 0) { Morrer "falha ao subir os containers (veja o erro acima)." }

Titulo "Esperando o sistema responder"
$pronto = $false
foreach ($i in 1..90) {
    $estado = (docker compose ps --format '{{.Service}} {{.Health}}' 2>$null |
               Where-Object { $_ -like 'api *' }) -replace '^api\s+', ''
    if ($estado -eq 'healthy') { $pronto = $true; break }
    Start-Sleep -Seconds 2
}
if (-not $pronto) {
    Write-Host "A API não ficou saudável. Os últimos registros:" -ForegroundColor Red
    docker compose logs --tail 40 api
    Morrer "instalação interrompida. Corrija o erro acima e rode .\instalar.ps1 de novo."
}
Certo "API no ar, banco migrado"

# ---------------------------------------------------------------- dono da loja

if ($Email -and $Senha) {
    # 'create-admin' não duplica: se a conta já existe e está ativa, ele avisa e sai bem.
    Titulo "Criando a conta do dono"
    docker compose exec -T api python -m app.cli create-admin --nome $Nome --email $Email --senha $Senha
    if ($LASTEXITCODE -eq 0) { Certo "conta pronta" }
    else {
        Alerta "não foi possível criar a conta (veja a mensagem acima)."
        Alerta "o sistema está no ar; crie a conta depois com:"
        Write-Host "    docker compose exec api python -m app.cli create-admin --nome ... --email ... --senha ..."
    }
} elseif ($reaproveitado) {
    Alerta "Configuração reaproveitada - a conta do dono não foi mexida."
}

# ---------------------------------------------------------------- fim

Titulo "Pronto - o sistema está rodando"
Write-Host ""
Write-Host "  Endereço:  $urlFinal/app/" -ForegroundColor White
Write-Host "  Modo:      $modo"
if ($Email) { Write-Host "  Entrar:    $Email" }
Write-Host ""
Write-Host "  Comandos do dia a dia:"
Write-Host "    docker compose ps               ver se está no ar"
Write-Host "    docker compose logs -f api      acompanhar o que acontece"
Write-Host "    docker compose restart          reiniciar"
Write-Host "    docker compose down             desligar (os dados ficam guardados)"
Write-Host "    .\instalar.ps1                  religar depois de um down"
Write-Host ""

if ($ambiente -eq "producao") {
    Alerta "Confira que o DNS de $Dominio aponta para o IP deste computador e que as portas"
    Alerta "80 e 443 estão liberadas - é o que o Let's Encrypt precisa para emitir o"
    Alerta "certificado. Acompanhe em: docker compose logs -f proxy"
    Write-Host ""
}
