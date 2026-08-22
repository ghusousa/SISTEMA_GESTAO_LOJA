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

# Programas externos (docker) escrevem em stderr sem que isso seja um erro de PowerShell.
# Com ErrorActionPreference=Stop e os fluxos redirecionados, o 5.1 transforma essa saída em
# exceção e mata o script antes de a mensagem explicativa aparecer. Esta função isola a
# preferência e devolve só o código de saída, que é o que interessa.
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

function Titulo($t) { Write-Host ""; Write-Host $t -ForegroundColor Cyan }
function Certo($t)  { Write-Host "  [ok] $t" -ForegroundColor Green }
function Alerta($t) { Write-Host "  [!] $t" -ForegroundColor Yellow }
function Morrer($t) { Write-Host ""; Write-Host "  [x] $t" -ForegroundColor Red; Write-Host ""; exit 1 }

function Sortear([int]$tamanho = 32) {
    # Create() + GetBytes() de instância funciona tanto no Windows PowerShell 5.1
    # (.NET Framework) quanto no PowerShell 7 (.NET moderno). O estático ::Fill() só
    # existe no segundo — usá-lo matava a instalação logo no começo, ao gerar a senha
    # do banco, com "does not contain a method named 'Fill'".
    $gerador = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $bytes = New-Object byte[] 96
        $gerador.GetBytes($bytes)
        ([Convert]::ToBase64String($bytes) -replace '[^A-Za-z0-9]', '').Substring(0, $tamanho)
    } finally {
        $gerador.Dispose()
    }
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

# A senha do banco viaja por dois lugares que mastigam pontuação, e por isso é restrita a
# letras, números, hífen e sublinhado:
#
#   1. o .env, onde o docker compose EXPANDE $: uma senha "abc$def" vira "abc" caladamente,
#      e a pessoa acha que configurou algo forte;
#   2. a URL de conexão (postgresql://loja:SENHA@db:5432/loja), onde "/" e "#" quebram o
#      endereço inteiro - o Python passa a ler "loja" como se fosse o servidor.
#
# Ninguém digita esta senha no dia a dia; 32 caracteres alfanuméricos sobram de força.
function SenhaBancoValida($s) { return $s -match '^[A-Za-z0-9_-]{8,}$' }

# Endereço sem DNS: localhost, vazio ou um IP. Decide HTTP puro em vez de HTTPS.
function EnderecoLocal($d) {
    return (-not $d) -or ($d -eq "localhost") -or ($d -match '^\d+(\.\d+){3}$')
}

# ---------------------------------------------------------------- verificações

Titulo "Sistema de Gestão da Loja - instalação"

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Morrer "O Docker Desktop não está instalado.`n      Baixe em: https://www.docker.com/products/docker-desktop"
}
if ((RodarDocker compose version) -ne 0) {
    Morrer "O Docker está sem o plugin 'compose'. Atualize o Docker Desktop."
}
if ((RodarDocker info) -ne 0) {
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
        if ($gerar -match '^[Nn]') {
            while ($true) {
                $SenhaBanco = PerguntarSenha "Senha do banco" ""
                if (SenhaBancoValida $SenhaBanco) { break }
                Alerta "use só letras, números, hífen e sublinhado (mínimo 8)."
                Alerta "pontuação quebra a URL de conexão do banco."
                $SenhaBanco = ""
            }
        }
    }
    if (-not $SenhaBanco) { $SenhaBanco = Sortear 32; Certo "senha do banco gerada" }
    if (-not (SenhaBancoValida $SenhaBanco)) {
        Morrer ("a senha do banco só aceita letras, números, hífen e sublinhado (mínimo 8).`n" +
                "      Pontuação quebra a URL de conexão - e um '`$' seria comido pelo compose.`n" +
                "      Omita -SenhaBanco para o instalador gerar uma forte.")
    }

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
    # Linha a linha, unidas com LF na marra: se o arquivo saísse com CRLF (o fim de linha
    # natural deste script no Windows), o docker compose levaria o \r junto DENTRO do valor
    # e a senha do banco ganharia um carriage return invisível no fim.
    $linhas = @(
        "# Gerado por instalar.ps1 - contém senhas. NÃO versione, não compartilhe."
        "DOMINIO=$Dominio"
        "ENDERECO_PROXY=$enderecoProxy"
        "PORTA_HTTP=$PortaHttp"
        "PORTA_HTTPS=$PortaHttps"
        ""
        "SENHA_BANCO=$SenhaBanco"
        "JWT_SECRET=$(Sortear 64)"
        ""
        "AMBIENTE=$ambiente"
        "CORS_ORIGINS=$cors"
        "TIMEZONE_LOJA=$Fuso"
    )
    # UTF8 sem BOM: o docker compose não entende o marcador de byte-order no começo do .env.
    [System.IO.File]::WriteAllText((Join-Path $PSScriptRoot ".env"), (($linhas -join "`n") + "`n"),
        (New-Object System.Text.UTF8Encoding $false))
    Certo ".env gravado"
}

# ---------------------------------------------------------------- subir

Titulo "Construindo e subindo os containers"
Write-Host "  isto demora alguns minutos na primeira vez"

# A saída é mostrada E guardada: o build é longo e a pessoa precisa ver o progresso, mas se
# falhar queremos ler o motivo para traduzir a mensagem do Docker em algo acionável.
# GetTempPath() em vez de $env:TEMP: funciona em qualquer sistema onde o PowerShell rode.
$registroUp = Join-Path ([System.IO.Path]::GetTempPath()) "loja-instalacao.log"
$anteriorEAP = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
docker compose up -d --build 2>&1 | Tee-Object -FilePath $registroUp
$codigoUp = $LASTEXITCODE
$ErrorActionPreference = $anteriorEAP

if ($codigoUp -ne 0) {
    $motivo = ""
    if (Test-Path $registroUp) { $motivo = (Get-Content $registroUp -Raw) }
    if ($motivo -match 'ports are not available|address already in use|forbidden by its access permissions') {
        Morrer ("A porta $PortaHttp já está sendo usada por outro programa.`n" +
                "      Descubra quem está nela:  netstat -ano | findstr :$PortaHttp`n" +
                "      No Windows costuma ser o IIS ou o serviço 'World Wide Web Publishing'.`n" +
                "      Ou instale numa porta livre:  .\instalar.bat -Forcar -PortaHttp 8080")
    }
    Morrer "não foi possível subir os containers. O motivo está logo acima."
}

Titulo "Esperando o sistema responder"
$pronto = $false
$anteriorEAP = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
foreach ($i in 1..90) {
    # `ps -q` + `inspect` em vez de `ps --format`: o template Go não é aceito por versões
    # antigas do Compose, e ali o instalador acusaria a API de doente sem ela estar.
    $idApi = @(docker compose ps -q api 2>$null) | Select-Object -First 1
    if ($idApi) {
        $estado = docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' $idApi 2>$null
        if ($estado -eq 'healthy') { $pronto = $true; break }
    }
    Start-Sleep -Seconds 2
}
$ErrorActionPreference = $anteriorEAP
if (-not $pronto) {
    Write-Host "A API não ficou saudável. Os últimos registros:" -ForegroundColor Red
    docker compose logs --tail 40 api
    Morrer "instalação interrompida. Corrija o erro acima e rode .\instalar.bat de novo."
}
Certo "API no ar, banco migrado"

# A API estar saudável não garante que o proxy esteja publicando a porta. Antes de anunciar
# o endereço, abre ele de verdade.
try {
    Invoke-WebRequest -UseBasicParsing -Uri "$urlFinal/app/" -TimeoutSec 15 | Out-Null
    Certo "sistema web respondendo em $urlFinal/app/"
} catch {
    if ($ambiente -eq "producao") {
        Alerta "o endereço ainda não responde - o certificado pode estar sendo emitido."
        Alerta "acompanhe com: docker compose logs -f proxy"
    } else {
        Alerta "a API subiu, mas $urlFinal/app/ não respondeu."
        Alerta "veja o proxy com: docker compose logs proxy"
    }
}

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
    Alerta "Para criar uma conta nova de administrador:"
    Write-Host "    docker compose exec api python -m app.cli create-admin --nome ... --email ... --senha ..."
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
Write-Host "    .\instalar.bat                  religar depois de um down"
Write-Host ""

if ($ambiente -eq "producao") {
    Alerta "Confira que o DNS de $Dominio aponta para o IP deste computador e que as portas"
    Alerta "80 e 443 estão liberadas - é o que o Let's Encrypt precisa para emitir o"
    Alerta "certificado. Acompanhe em: docker compose logs -f proxy"
    Write-Host ""
}
