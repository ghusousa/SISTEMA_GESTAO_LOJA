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

.NOTES
    Se o Docker Desktop não estiver instalado, o instalador instala pelo winget.
    Use -SemDocker para impedir.
    No fim, agenda a cópia diária do banco (Tarefa Agendada que roda o backup.ps1).
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
    [switch]$Forcar,
    [switch]$SemDocker
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

function EhIp($d) { return ($d -match '^\d{1,3}(\.\d{1,3}){3}$') }

# IP que só existe dentro da loja (ou da própria máquina): 10/8, 172.16/12, 192.168/16 e
# 127/8. Ali HTTP puro é o esperado: não há certificado público para o que a internet não
# alcança. Espelho do ip_de_rede_local do instalar.sh — mudou lá, mude aqui.
function IpDeRedeLocal($d) {
    if (-not (EhIp $d)) { return $false }
    $p = $d.Split('.') | ForEach-Object { [int]$_ }
    if (($p | Where-Object { $_ -gt 255 }).Count -gt 0) { return $false }
    if ($p[0] -eq 10 -or $p[0] -eq 127) { return $true }
    if ($p[0] -eq 192 -and $p[1] -eq 168) { return $true }
    if ($p[0] -eq 172 -and $p[1] -ge 16 -and $p[1] -le 31) { return $true }
    # CGNAT/Tailscale (100.64/10) e link-local (169.254/16): fora do alcance da internet.
    if ($p[0] -eq 100 -and $p[1] -ge 64 -and $p[1] -le 127) { return $true }
    if ($p[0] -eq 169 -and $p[1] -eq 254) { return $true }
    return $false
}

# Endereço que decide HTTP puro em vez de HTTPS: vazio, localhost ou IP da rede da loja.
# Era "qualquer IP", e o IP PÚBLICO de uma máquina na internet virava AMBIENTE=local: /docs
# aberto, CORS para qualquer origem e senha trafegando sem criptografia.
function EnderecoLocal($d) {
    return (-not $d) -or ($d -eq "localhost") -or (IpDeRedeLocal $d)
}

function IpPublico($d) { return (EhIp $d) -and -not (IpDeRedeLocal $d) }

function ExplicarIpPublico($d) {
    return ("`"$d`" é um IP PÚBLICO: a loja ficaria aberta na internet em HTTP puro - senha,`n" +
            "      token e CPF trafegando sem criptografia.`n" +
            "      Use um domínio apontado para este computador (o HTTPS é pedido sozinho):`n" +
            "          .\instalar.bat -Dominio loja.seudominio.com.br`n" +
            "      Sem domínio? O sslip.io dá um de graça, que já aponta para este IP:`n" +
            "          .\instalar.bat -Dominio $d.sslip.io`n" +
            "      Com um .env de antes, acrescente -Forcar (os dados do banco não são apagados).")
}

# ---------------------------------------------------------------- verificações

# Depois de instalar, o docker.exe existe mas o PATH desta janela ainda é o de antes.
# Sem recarregar, o instalador diria que o Docker não foi instalado - logo depois de
# instalá-lo com sucesso.
# $env:OS existe no Windows tanto no PowerShell 5.1 quanto no 7 ($IsWindows só existe no 7).
$EhWindows = ($env:OS -eq 'Windows_NT')

function AtualizarPath {
    if (-not $EhWindows) { return }
    # Os dois podem vir nulos; juntar sem filtrar produziria um PATH começando com ";" e
    # apagaria o que já estava lá - o instalador passaria a não achar nem o docker nem nada.
    $partes = @(
        [System.Environment]::GetEnvironmentVariable("Path", "Machine")
        [System.Environment]::GetEnvironmentVariable("Path", "User")
    ) | Where-Object { $_ }
    if ($partes) { $env:Path = ($partes -join ";") }

    if ($env:ProgramFiles) {
        $extra = Join-Path $env:ProgramFiles "Docker\Docker\resources\bin"
        if ((Test-Path $extra) -and ($env:Path -notlike "*$extra*")) { $env:Path += ";$extra" }
    }
}

function DockerResponde {
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { return $false }
    return ((RodarDocker info) -eq 0)
}

function EsperarDocker([int]$segundos = 180) {
    $fim = (Get-Date).AddSeconds($segundos)
    while ((Get-Date) -lt $fim) {
        AtualizarPath
        if (DockerResponde) { return $true }
        Start-Sleep -Seconds 5
    }
    return $false
}

function AbrirDockerDesktop {
    if (-not $env:ProgramFiles) { return $false }
    $exe = Join-Path $env:ProgramFiles "Docker\Docker\Docker Desktop.exe"
    if (Test-Path $exe) {
        Start-Process -FilePath $exe | Out-Null
        return $true
    }
    return $false
}

function InstalarDockerDesktop {
    # winget vem de fábrica no Windows 11 e no 10 atualizado (via App Installer).
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) { return 2 }

    Write-Host "  → instalando o Docker Desktop pelo winget…"
    Write-Host "     (o Windows vai pedir permissão de administrador; aceite)"
    Write-Host "     isto demora vários minutos e baixa cerca de 500 MB"

    $anterior = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    winget install --exact --id Docker.DockerDesktop `
        --accept-package-agreements --accept-source-agreements --disable-interactivity
    $codigo = $LASTEXITCODE
    $ErrorActionPreference = $anterior

    # winget devolve códigos próprios; alguns significam "já está instalado" ou
    # "precisa reiniciar", que não são falha de verdade.
    if ($codigo -eq 0) { return 0 }
    if ($codigo -eq -1978335189) { return 0 }   # já instalado
    if ($codigo -eq -1978335212) { return 2 }   # pacote não encontrado
    if ($codigo -eq 3010) { return 4 }          # instalado, exige reiniciar
    return 1
}

function GarantirDocker {
    AtualizarPath
    if (DockerResponde) { Certo "Docker pronto"; return }

    # Instalado mas parado - o caso mais comum no Windows, porque o Docker Desktop não
    # sobe junto com a sessão a menos que esteja configurado para isso.
    if (Get-Command docker -ErrorAction SilentlyContinue) {
        Write-Host "  → o Docker está instalado mas não respondeu; abrindo o Docker Desktop…"
        if (AbrirDockerDesktop) {
            Write-Host "     ele leva de um a três minutos para ficar pronto"
            if (EsperarDocker 240) { Certo "Docker respondendo"; return }
        }
        Morrer ("O Docker está instalado mas não responde.`n" +
                "      Abra o Docker Desktop pelo menu Iniciar, espere o ícone da baleia`n" +
                "      ficar verde no canto da tela, e rode .\instalar.bat de novo.")
    }

    Alerta "O Docker não está instalado - é o único programa de que este sistema precisa."

    if ($SemDocker) {
        Morrer ("Instalação automática desligada por -SemDocker.`n" +
                "      Baixe em https://www.docker.com/products/docker-desktop e rode de novo.")
    }

    if (-not $Sim) {
        Write-Host "  Ele é gratuito e é o que faz o banco, a API e o site rodarem isolados."
        $r = Read-Host "  Instalar o Docker Desktop agora? [S/n]"
        if ($r -match '^[Nn]') { Morrer "instalação cancelada. Nada foi mexido no sistema." }
    }

    Titulo "Instalando o Docker Desktop"
    $resultado = InstalarDockerDesktop

    switch ($resultado) {
        0 { }
        2 { Morrer ("Não achei o winget para instalar automaticamente.`n" +
                    "      Baixe o Docker Desktop em https://www.docker.com/products/docker-desktop,`n" +
                    "      instale, abra, espere o ícone ficar verde e rode .\instalar.bat de novo.") }
        4 { Morrer ("O Docker Desktop foi instalado, mas o Windows precisa REINICIAR para`n" +
                    "      terminar (ele liga o WSL2, que o Docker usa por baixo).`n" +
                    "      Reinicie o computador, abra o Docker Desktop, espere ficar verde`n" +
                    "      e rode .\instalar.bat de novo.") }
        default { Morrer ("A instalação do Docker Desktop falhou (código $resultado).`n" +
                          "      Baixe e instale à mão: https://www.docker.com/products/docker-desktop") }
    }

    AtualizarPath
    Write-Host "  → abrindo o Docker Desktop…"
    AbrirDockerDesktop | Out-Null
    Write-Host "     a primeira abertura leva alguns minutos"

    if (-not (EsperarDocker 300)) {
        Morrer ("O Docker foi instalado, mas não respondeu a tempo.`n" +
                "      Isso costuma significar uma de duas coisas:`n" +
                "        1. o Windows precisa reiniciar para ligar o WSL2 - reinicie e tente de novo;`n" +
                "        2. o Docker Desktop ainda está subindo - espere o ícone da baleia ficar`n" +
                "           verde no canto da tela.`n" +
                "      Depois rode .\instalar.bat de novo: ele continua de onde parou.")
    }

    Certo "Docker instalado e no ar"
}

Titulo "Sistema de Gestão da Loja - instalação"

GarantirDocker

if ((RodarDocker compose version) -ne 0) {
    Morrer "O Docker está sem o plugin 'compose'. Atualize o Docker Desktop."
}

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
    Write-Host "  HTTPS é pedido e renovado sozinho. Deixe 'localhost' para usar só nesta máquina;"
    Write-Host "  o IP da rede da loja (ex.: 192.168.0.10) também serve, sem HTTPS."
    while ($true) {
        $Dominio = Perguntar "Domínio (DNS)" "localhost" $Dominio
        if ($Sim -or -not (IpPublico $Dominio)) { break }
        Alerta (ExplicarIpPublico $Dominio)
        $Dominio = ""
    }

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

# Recusa em vez de avisar: um aviso no fim não fecha a porta que a instalação abriu. Vale
# também para o .env reaproveitado.
if (IpPublico $Dominio) { Morrer (ExplicarIpPublico $Dominio) }

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
    # -Forcar redesenha a CONFIGURAÇÃO, mas a senha do banco tem uma peculiaridade: o
    # Postgres só a grava quando cria os dados pela primeira vez. Com o volume já existente,
    # sortear uma senha nova trancaria a API fora do próprio banco.
    if ((Test-Path .env) -and ((RodarDocker volume inspect loja_dados-do-banco) -eq 0)) {
        $linhaSenha = Select-String -Path .env -Pattern '^SENHA_BANCO=(.*)$' | Select-Object -First 1
        if ($linhaSenha) {
            $senhaExistente = $linhaSenha.Matches[0].Groups[1].Value
            if ($senhaExistente -and ($senhaExistente -ne $SenhaBanco)) {
                $SenhaBanco = $senhaExistente
                Alerta "o banco já existe: mantendo a senha atual dele"
            }
        }
    }

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

function SincronizarSenhaBanco {
    # O Postgres grava POSTGRES_PASSWORD só quando CRIA os dados. Num banco que já existia -
    # depois de um -Forcar, de um .env refeito, ou de restaurar um backup noutra máquina - a
    # senha do arquivo e a do banco divergem, e a API fica batendo numa porta que não abre.
    #
    # A imagem oficial do Postgres confia em conexões pelo socket local dentro do container,
    # então dá para alinhar as duas sem saber a senha antiga: o .env passa a ser a verdade.
    #
    # A senha entra no SQL sem escape, e isso é seguro porque SenhaBancoValida já a
    # restringiu a letras, números, hífen e sublinhado.
    $anterior = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    foreach ($i in 1..30) {
        docker compose exec -T db pg_isready -U loja -d loja 2>&1 | Out-Null
        if ($LASTEXITCODE -eq 0) { break }
        Start-Sleep -Seconds 2
    }
    docker compose exec -T db psql -q -v ON_ERROR_STOP=1 -U loja -d loja `
        -c "ALTER USER loja PASSWORD '$SenhaBanco';" 2>&1 | Out-Null
    $ErrorActionPreference = $anterior
}

Titulo "Esperando o sistema responder"

SincronizarSenhaBanco

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

# ---------------------------------------------------------------- cópia diária

# A instalação terminava sem cópia NENHUMA do banco, e no Windows nem havia como ligar uma:
# o ./backup.sh --automatico depende do systemd. Agora uma Tarefa Agendada roda o
# backup.ps1 todo dia às 03:15 — e, com o computador do balcão desligado nessa hora (o caso
# comum), assim que ele ligar. Na sessão de quem instalou, que é onde o Docker Desktop roda.
function AgendarBackupDiario {
    if (-not $EhWindows) {
        Alerta "fora do Windows, a cópia diária é do ./backup.sh --automatico."
        return
    }
    try {
        $copiador = Join-Path $PSScriptRoot "backup.ps1"
        $acao = New-ScheduledTaskAction -Execute "powershell.exe" `
            -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$copiador`"" `
            -WorkingDirectory $PSScriptRoot
        $gatilho = New-ScheduledTaskTrigger -Daily -At "03:15"
        $ajustes = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries `
            -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
        $quem = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" `
            -LogonType Interactive -RunLevel Limited
        Register-ScheduledTask -TaskName "Loja - copia diaria do banco" -Action $acao `
            -Trigger $gatilho -Settings $ajustes -Principal $quem -Force `
            -Description "Copia o banco da loja para a pasta backups (backup.ps1)." | Out-Null
        Certo "cópia diária do banco às 03:15 (ou assim que o computador ligar), em backups\"
    } catch {
        Alerta "não consegui agendar a cópia diária: $($_.Exception.Message)"
        Alerta "faça uma cópia à mão quando quiser: powershell -ExecutionPolicy Bypass -File backup.ps1"
    }
}

Titulo "Cópia diária do banco"
AgendarBackupDiario

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
Write-Host "    powershell -ExecutionPolicy Bypass -File backup.ps1   uma cópia do banco agora"
Write-Host ""

if ($ambiente -eq "producao") {
    Alerta "Confira que o DNS de $Dominio aponta para o IP deste computador e que as portas"
    Alerta "80 e 443 estão liberadas - é o que o Let's Encrypt precisa para emitir o"
    Alerta "certificado. Acompanhe em: docker compose logs -f proxy"
    Write-Host ""
}
