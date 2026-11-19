#!/usr/bin/env bash
#
# Instalador do Sistema de Gestão da Loja.
#
# Pergunta o endereço, os dados do dono e a senha do banco, sobe tudo em Docker e termina
# com o sistema no ar. Rodar de novo é seguro: reaproveita o que já existe.
#
#   ./instalar.sh
#   ./instalar.sh --dominio loja.exemplo.com.br --email dona@loja.com \
#                 --nome "Dona Maria" --senha "..." --senha-banco "..." \
#                 --loja "Boutique da Ana" --segmento ROUPAS --avisos loja-k3x9q --sim
#
# Se o Docker não estiver instalado, o instalador instala. Use --sem-docker para impedir.
# Com domínio, confere o DNS antes de subir e diz o registro exato que falta.
# A demonstração (dados fictícios, em <endereço>/demo) vem junto; --sem-demo a deixa de fora.
# No fim, liga a cópia diária do banco (e, no Linux, o vigia que avisa quando a loja cai).
#
set -euo pipefail

cd "$(dirname "$0")"

VERMELHO=$'\033[31m'; VERDE=$'\033[32m'; AMARELO=$'\033[33m'
AZUL=$'\033[36m'; FORTE=$'\033[1m'; NORMAL=$'\033[0m'
if [ ! -t 1 ]; then VERMELHO=""; VERDE=""; AMARELO=""; AZUL=""; FORTE=""; NORMAL=""; fi

titulo()  { printf '\n%s%s%s\n' "$FORTE$AZUL" "$1" "$NORMAL"; }
passo()   { printf '  %s→%s %s\n' "$AZUL" "$NORMAL" "$1"; }
certo()   { printf '  %s✓%s %s\n' "$VERDE" "$NORMAL" "$1"; }
alerta()  { printf '  %s!%s %s\n' "$AMARELO" "$NORMAL" "$1"; }
morrer()  { printf '\n%s✗ %s%s\n\n' "$VERMELHO" "$1" "$NORMAL" >&2; exit 1; }

# ------------------------------------------------------------------ argumentos

DOMINIO=""; EMAIL=""; NOME=""; SENHA=""; SENHA_BANCO=""; NOTIFICAR_URL=""
# LOJA e SEGMENTO também começam vazios: só a instalação nova pergunta por eles, e o caminho
# que reaproveita o .env morria em "LOJA: unbound variable" depois do `up` — sem dono, sem as
# rotinas religadas e sem o resumo, justo em quem rodava o instalador de novo.
LOJA=""; SEGMENTO=""
FUSO="America/Sao_Paulo"; PORTA_HTTP="80"; PORTA_HTTPS="443"
INTERATIVO=1; FORCAR=0; INSTALAR_DOCKER=1; SEM_DEMO=0

while [ $# -gt 0 ]; do
    case "$1" in
        --dominio)      DOMINIO="${2:-}"; shift 2 ;;
        --email)        EMAIL="${2:-}"; shift 2 ;;
        --nome)         NOME="${2:-}"; shift 2 ;;
        --senha)        SENHA="${2:-}"; shift 2 ;;
        --senha-banco)  SENHA_BANCO="${2:-}"; shift 2 ;;
        --fuso)         FUSO="${2:-}"; shift 2 ;;
        --loja)         LOJA="${2:-}"; shift 2 ;;
        --segmento)     SEGMENTO="${2:-}"; shift 2 ;;
        --porta-http)   PORTA_HTTP="${2:-}"; shift 2 ;;
        --porta-https)  PORTA_HTTPS="${2:-}"; shift 2 ;;
        --avisos)       NOTIFICAR_URL="${2:-}"; shift 2 ;;
        --sim|-y)       INTERATIVO=0; shift ;;
        --forcar)       FORCAR=1; shift ;;
        --sem-docker)   INSTALAR_DOCKER=0; shift ;;
        --sem-demo)     SEM_DEMO=1; shift ;;
        -h|--help)      sed -n '3,16p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *)              morrer "opção desconhecida: $1" ;;
    esac
done

# ------------------------------------------------------------------ utilidades

sortear() {
    if command -v openssl >/dev/null 2>&1; then
        openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c "${1:-32}"
    elif command -v python3 >/dev/null 2>&1; then
        python3 -c "import secrets,sys;print(secrets.token_urlsafe(64)[:int(sys.argv[1])])" "${1:-32}"
    else
        head -c 200 /dev/urandom | tr -dc 'A-Za-z0-9' | head -c "${1:-32}"
    fi
}

# Toda resposta do teclado passa por aqui. O fim da entrada sem resposta nenhuma é erro, e não
# "a resposta vazia": sem terminal (`./instalar.sh < /dev/null`, um agendador, um ssh sem -t),
# o `read` volta na hora, toda vez — o padrão entrava calado e o laço do e-mail, que não tem
# padrão, repetia "e-mail inválido." para sempre. A última linha sem o Enter no fim ainda vale:
# o `read` a entrega, e só então diz que a entrada acabou.
ler() {  # ler <variável> <opções do read...>
    local _var="$1"; shift
    read -r "$@" "${_var?}" && return 0
    [ -n "${!_var:-}" ] && return 0
    morrer "a entrada acabou: sem terminal, rode com --sim e os parâmetros. Por exemplo:
      ./instalar.sh --sim --dominio loja.seudominio.com.br --nome \"Dona Maria\" \\
                    --email dona@loja.com --senha \"uma-senha-boa\"
  (todos em ./instalar.sh --help)"
}

# Um valor já informado por parâmetro nunca é perguntado de novo, e nada lê do teclado
# quando o instalador roda sem gente na frente (--sim). Sem essas duas guardas, chamar o
# instalador com --senha travava para sempre esperando uma digitação que não vinha.
perguntar() {  # perguntar <texto> <padrão> <variável>
    local texto="$1" padrao="$2" alvo="$3" resposta=""
    [ -n "${!alvo:-}" ] && return
    if [ "$INTERATIVO" -eq 0 ]; then printf -v "$alvo" '%s' "$padrao"; return; fi
    if [ -n "$padrao" ]; then
        ler resposta -p "  $texto [$padrao]: "
    else
        ler resposta -p "  $texto: "
    fi
    printf -v "$alvo" '%s' "${resposta:-$padrao}"
}

# O ramo da loja decide as PALAVRAS das telas, não as regras: em roupas o que varia é
# Tamanho e Cor; numa autopeças, Aplicação e Posição. A lista abaixo é um espelho de
# `api/app/core/segmentos.py` — mudou lá, mude aqui (o instalador não pode consultar a
# API, que ainda nem subiu quando esta pergunta acontece).
SEGMENTOS_VALOR=(ROUPAS CALCADOS AUTOPECAS INFORMATICA COSMETICOS ALIMENTOS CONSTRUCAO OUTRO)
SEGMENTOS_ROTULO=(
    "Roupas e confecção          (Tamanho / Cor)"
    "Calçados                    (Numeração / Cor)"
    "Peças de carro e moto       (Aplicação / Posição)"
    "Informática e eletrônicos   (Capacidade / Cor)"
    "Cosméticos e perfumaria     (Volume / Tom)"
    "Alimentos e mercearia       (Peso / Sabor)"
    "Material de construção      (Medida / Acabamento)"
    "Outro ramo                  (Variação / Tipo)"
)

segmento_valido() {  # segmento_valido <valor>
    local v
    for v in "${SEGMENTOS_VALOR[@]}"; do [ "$v" = "$1" ] && return 0; done
    return 1
}

perguntar_segmento() {  # perguntar_segmento <variável>
    local alvo="$1" i escolha=""
    # Veio por parâmetro: aceita em qualquer caixa, mas só se for um ramo que existe.
    if [ -n "${!alvo:-}" ]; then
        printf -v "$alvo" '%s' "$(printf '%s' "${!alvo}" | tr '[:lower:]' '[:upper:]')"
        segmento_valido "${!alvo}" && return
        morrer "segmento desconhecido: ${!alvo} (use um de: ${SEGMENTOS_VALOR[*]})"
    fi
    if [ "$INTERATIVO" -eq 0 ]; then printf -v "$alvo" '%s' "OUTRO"; return; fi
    for i in "${!SEGMENTOS_VALOR[@]}"; do
        printf '    %d) %s\n' "$((i + 1))" "${SEGMENTOS_ROTULO[$i]}"
    done
    while :; do
        ler escolha -p "  Número do ramo [1]: "
        escolha="${escolha:-1}"
        case "$escolha" in
            ''|*[!0-9]*) alerta "digite o número da linha." ;;
            *)
                if [ "$escolha" -ge 1 ] && [ "$escolha" -le "${#SEGMENTOS_VALOR[@]}" ]; then
                    printf -v "$alvo" '%s' "${SEGMENTOS_VALOR[$((escolha - 1))]}"
                    return
                fi
                alerta "escolha entre 1 e ${#SEGMENTOS_VALOR[@]}."
                ;;
        esac
    done
}

perguntar_senha() {  # perguntar_senha <texto> <variável>
    local texto="$1" alvo="$2" a="" b=""
    [ -n "${!alvo:-}" ] && return
    # Sem teclado, sai em branco de propósito: a validação logo abaixo diz qual
    # parâmetro faltou, em vez de o instalador ficar pendurado.
    [ "$INTERATIVO" -eq 0 ] && return
    while :; do
        ler a -s -p "  $texto: "; echo
        if [ "${#a}" -lt 8 ]; then alerta "mínimo de 8 caracteres."; continue; fi
        ler b -s -p "  repita a senha: "; echo
        [ "$a" = "$b" ] && break
        alerta "as senhas não são iguais."
    done
    printf -v "$alvo" '%s' "$a"
}

email_valido() { printf '%s' "$1" | grep -Eq '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'; }

# A senha do banco viaja por dois lugares que mastigam pontuação, e por isso é restrita a
# letras, números, hífen e sublinhado:
#
#   1. o .env, onde o docker compose EXPANDE $: uma senha "abc$def" vira "abc" caladamente,
#      e a pessoa acha que configurou algo forte;
#   2. a URL de conexão (postgresql://loja:SENHA@db:5432/loja), onde "/" e "#" quebram o
#      endereço inteiro — o Python passa a ler "loja" como se fosse o servidor e a API não
#      conecta em lugar nenhum.
#
# Ninguém digita esta senha no dia a dia, então restringir os caracteres não custa nada;
# 32 caracteres alfanuméricos sobram de força.
senha_banco_valida() { printf '%s' "$1" | grep -Eq '^[A-Za-z0-9_-]{8,}$'; }

eh_ip() { printf '%s' "$1" | grep -Eq '^[0-9]{1,3}(\.[0-9]{1,3}){3}$'; }

# IP que só existe dentro da loja (ou da própria máquina): 10/8, 172.16/12, 192.168/16 e
# 127/8. Quem chega nele já está na rede da loja, e ali HTTP puro é o esperado — não há
# certificado público para um endereço que a internet não alcança.
ip_de_rede_local() {
    local a b c d
    eh_ip "$1" || return 1
    IFS=. read -r a b c d <<< "$1"
    [ "$a" -le 255 ] && [ "$b" -le 255 ] && [ "$c" -le 255 ] && [ "$d" -le 255 ] || return 1
    case "$a" in
        10|127) return 0 ;;
        192)    [ "$b" -eq 168 ] ;;
        172)    [ "$b" -ge 16 ] && [ "$b" -le 31 ] ;;
        # CGNAT e redes sobrepostas como o Tailscale (100.64/10) e link-local (169.254/16):
        # não se alcançam da internet, e não há como tirar certificado para eles.
        100)    [ "$b" -ge 64 ] && [ "$b" -le 127 ] ;;
        169)    [ "$b" -eq 254 ] ;;
        *)      return 1 ;;
    esac
}

# Endereço que decide HTTP puro em vez de HTTPS: vazio, localhost ou IP da rede da loja.
#
# Era "qualquer IP", e o IP PÚBLICO de uma VPS caía aqui: AMBIENTE=local, /docs aberto na
# internet, CORS para qualquer origem e senha, token e CPF trafegando sem criptografia. Ser
# um IP não diz que o ambiente é de desenvolvimento; dizer que a rede é da loja, sim.
endereco_local() {
    [ -z "$1" ] || [ "$1" = "localhost" ] || ip_de_rede_local "$1"
}

ip_publico() { eh_ip "$1" && ! ip_de_rede_local "$1"; }

explicar_ip_publico() {
    printf '%s' "\"$1\" é um IP PÚBLICO: a loja ficaria aberta na internet em HTTP puro — senha,
  token e CPF trafegando sem criptografia, e a documentação da API à vista de quem passar.
  Use um domínio apontado para este servidor; o HTTPS é pedido e renovado sozinho:
      ./instalar.sh --dominio loja.seudominio.com.br
  Sem domínio? O sslip.io dá um de graça, que já aponta para este IP:
      ./instalar.sh --dominio $1.sslip.io
  Com um .env de antes, acrescente --forcar (os dados do banco não são apagados)."
}

# Deriva tudo que depende do endereço. Existe uma vez só porque três caminhos precisam
# disso (instalação nova interativa, por parâmetro, e reaproveitando um .env), e uma cópia
# esquecida deixava o resumo final quebrar com "URL_FINAL: unbound variable".
definir_endereco() {
    # Em minúsculas, venha de onde vier (parâmetro, pergunta, .env reaproveitado): nome de
    # domínio não diferencia caixa, e o navegador manda a Origin em minúsculas — com o domínio
    # como foi digitado, "MINHALOJA.TEC.BR" dava "Nome MINHALOJA" (o certo é @) e um
    # CORS_ORIGINS que não casava com a Origin de ninguém.
    DOMINIO="$(printf '%s' "$DOMINIO" | tr '[:upper:]' '[:lower:]')"
    # Recusa em vez de "instalar e avisar": um aviso no fim da instalação não fecha a porta
    # que a instalação acabou de abrir. Vale também para o .env reaproveitado.
    ip_publico "$DOMINIO" && morrer "$(explicar_ip_publico "$DOMINIO")"
    if endereco_local "$DOMINIO"; then
        # HTTP puro: aqui o AMBIENTE precisa ser 'local', senão o cookie de sessão sai
        # marcado como Secure, o navegador se recusa a guardá-lo em http:// e ninguém
        # consegue continuar logado.
        ENDERECO_PROXY=":80"
        AMBIENTE="local"
        CORS_ORIGINS="*"
        URL_FINAL="http://localhost"
        [ "${PORTA_HTTP:-80}" != "80" ] && URL_FINAL="http://localhost:$PORTA_HTTP"
        MODO="local, sem HTTPS"
    else
        ENDERECO_PROXY="$DOMINIO"
        AMBIENTE="producao"
        CORS_ORIGINS="https://$DOMINIO"
        URL_FINAL="https://$DOMINIO"
        MODO="domínio $DOMINIO, com HTTPS automático"
    fi
}

# ------------------------------------------------------------------ o .env e a demonstração
#
# Espelho do bloco de mesmo nome no ./demo.sh: os dois escrevem o .env (e mais ninguém), e
# uma conta da demonstração gerada de um jeito aqui e de outro lá é a que não entra na Apple.

valor_no_env() { grep -E "^$1=" .env 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"' || true; }
tem_no_env()   { grep -qE "^$1=" .env 2>/dev/null; }

# A cópia que vira o .env nasce ao lado dele, 600, e o substitui de uma vez: nem um instante
# com senha legível, nem um .env pela metade se a máquina cair no meio. E com o dono do .env
# de antes: o arquivo novo seria de quem roda o script, e um `sudo` deixava o .env de root —
# o docker compose, o ./atualizar.sh e o ./backup.sh de quem instalou a loja paravam em
# "permission denied". Sem o chown do GNU (o Mac), segue como antes.
TEMPORARIO=""
trap 'if [ -n "${TEMPORARIO:-}" ]; then rm -f -- "$TEMPORARIO"; fi' EXIT
trocar_o_env() {  # o novo conteúdo já está em $TEMPORARIO
    chmod 600 "$TEMPORARIO"
    if [ -e .env ]; then chown --reference=.env "$TEMPORARIO" 2>/dev/null || true; fi
    mv -f "$TEMPORARIO" .env
    TEMPORARIO=""
}

gravar_no_env() {  # gravar_no_env CHAVE VALOR — troca o valor, ou acrescenta a chave no fim
    TEMPORARIO="$(mktemp ./.env.XXXXXX)"
    if tem_no_env "$1"; then
        # ENVIRON e não -v: o awk interpretaria barras invertidas de um valor passado por -v.
        CHAVE="$1" VALOR="$2" awk 'index($0, ENVIRON["CHAVE"] "=") == 1 {
                if (!feito) print ENVIRON["CHAVE"] "=" ENVIRON["VALOR"]; feito = 1; next
            } { print }' .env > "$TEMPORARIO"
    else
        { cat .env; if [ -n "$(tail -c1 .env)" ]; then printf '\n'; fi
          printf '%s=%s\n' "$1" "$2"; } > "$TEMPORARIO"
    fi
    trocar_o_env
}

acrescentar_no_env() {  # acrescentar_no_env LINHA... — no fim, mesmo sem \n na última linha
    TEMPORARIO="$(mktemp ./.env.XXXXXX)"
    { cat .env; if [ -n "$(tail -c1 .env)" ]; then printf '\n'; fi
      printf '%s\n' "$@"; } > "$TEMPORARIO"
    trocar_o_env
}

tirar_do_env() {  # tirar_do_env REGEX — tira as linhas que casam
    TEMPORARIO="$(mktemp ./.env.XXXXXX)"
    grep -vE "$1" .env > "$TEMPORARIO" || true
    trocar_o_env
}

# O COMPOSE_PROFILES é uma lista separada por vírgula; "demo" é o perfil da demonstração.
tem_demo() { case ",$1," in *,demo,*) return 0 ;; *) return 1 ;; esac; }
com_demo() { if tem_demo "$1"; then printf '%s' "$1"; else printf '%s' "${1:+$1,}demo"; fi; }
sem_demo() {
    printf '%s' "$1" | awk -F, '{ s = ""; for (i = 1; i <= NF; i++)
        if ($i != "demo" && $i != "") s = s (s == "" ? "" : ",") $i; print s }'
}

#: A conta do revisor. `.example` é reservado (RFC 2606): o e-mail nunca é de ninguém.
EMAIL_DA_DEMO="dono@demo.example"

# As duas linhas que abrem o bloco da demonstração no .env (o ./demo.sh --apagar as tira).
COMENTARIO_DA_DEMO=(
    "# Demonstração em /demo (ADR-46): outra API, outro banco e outra conta, só com dados fictícios."
    "# Demonstração: endereço e senha com ./demo.sh --mostrar; desligar com ./demo.sh --desligar."
)
COMENTARIO_DA_DEMO_DESLIGADA="# Demonstração em /demo (ADR-46) desligada. Para ligar: ./demo.sh --ligar."

# Completa o .env com o que a demonstração precisa e ainda não está lá, e liga o perfil. O
# que já existe NÃO muda: a senha da conta é a que está na Apple, e trocá-la sem ninguém ver
# deixaria o revisor de fora. SENHA_DEMO_NOVA=1 diz que a senha nasceu agora — a única vez em
# que o resumo a mostra.
SENHA_DEMO_NOVA=0
completar_env_da_demo() {
    local banco jwt jwt_da_loja email senha bloco
    SENHA_DEMO_NOVA=0
    banco="$(valor_no_env DEMO_SENHA_BANCO)"
    jwt="$(valor_no_env DEMO_JWT_SECRET)"
    jwt_da_loja="$(valor_no_env JWT_SECRET)"
    email="$(valor_no_env DEMO_ADMIN_EMAIL)"
    senha="$(valor_no_env DEMO_ADMIN_SENHA)"
    [ -n "$banco" ] || banco="$(sortear 32)"
    # NUNCA o segredo da loja: o token só leva o id do usuário, e com o mesmo segredo o token
    # da conta de demonstração (senha nas notas da Apple) valeria na loja como o mesmo id.
    while [ -z "$jwt" ] || [ "$jwt" = "$jwt_da_loja" ]; do jwt="$(sortear 64)"; done
    [ -n "$email" ] || email="$EMAIL_DA_DEMO"
    if [ -z "$senha" ]; then senha="$(sortear 20)"; SENHA_DEMO_NOVA=1; fi
    if [ -z "$banco" ] || [ -z "$senha" ]; then morrer "não consegui sortear as senhas da demonstração."; fi

    # O recado de "desligada" (de um --sem-demo) deixa de valer.
    if grep -qF "$COMENTARIO_DA_DEMO_DESLIGADA" .env; then tirar_do_env "^# Demonstração em /demo \(ADR-46\) desligada"; fi
    if ! grep -qE '^DEMO_[A-Z_]+=' .env; then
        # .env de antes da demonstração: o bloco inteiro, com o recado de onde mexer.
        bloco=("" "${COMENTARIO_DA_DEMO[@]}")
        tem_no_env COMPOSE_PROFILES || bloco+=("COMPOSE_PROFILES=demo")
        bloco+=("DEMO_SENHA_BANCO=$banco" "DEMO_JWT_SECRET=$jwt"
                "DEMO_ADMIN_EMAIL=$email" "DEMO_ADMIN_SENHA=$senha")
        acrescentar_no_env "${bloco[@]}"
    else
        gravar_no_env DEMO_SENHA_BANCO "$banco"
        gravar_no_env DEMO_JWT_SECRET "$jwt"
        gravar_no_env DEMO_ADMIN_EMAIL "$email"
        gravar_no_env DEMO_ADMIN_SENHA "$senha"
    fi
    gravar_no_env COMPOSE_PROFILES "$(com_demo "$(valor_no_env COMPOSE_PROFILES)")"
}

# ------------------------------------------------------------------ o DNS do domínio
#
# Com domínio, o certificado HTTPS só sai se o nome apontar para ESTA máquina, e o Let's
# Encrypt limita as tentativas que falham: subir antes de o DNS estar certo gasta essas
# tentativas e deixa a loja sem HTTPS por uma hora. Por isso a conferida vem antes do `up` e
# diz o registro exato que falta, do jeito que o painel do domínio pede.

# O IP público desta máquina, perguntado a quem a vê de fora — a placa de rede de uma VPS
# atrás de NAT não sabe. Três serviços: um deles fora do ar não decide nada.
ip_desta_maquina() {  # ip_desta_maquina <4|6>
    local servicos servico ip
    command -v curl >/dev/null 2>&1 || return 1
    servicos="https://api.ipify.org https://ifconfig.me/ip https://icanhazip.com"
    [ "$1" = 6 ] && servicos="https://api64.ipify.org https://ifconfig.me/ip https://icanhazip.com"
    for servico in $servicos; do
        ip="$(curl "-$1" -fsS --max-time 5 "$servico" 2>/dev/null | tr -d '[:space:]' | tr 'A-F' 'a-f')" \
            || continue
        if [ "$1" = 6 ]; then
            case "$ip" in *:*) printf '%s' "$ip" | grep -Eq '^[0-9a-f:]+$' && { printf '%s' "$ip"; return 0; } ;; esac
        elif eh_ip "$ip"; then
            printf '%s' "$ip"; return 0
        fi
    done
    return 1
}

# Para onde o nome aponta, perguntado ao DNS (o que o Let's Encrypt vai ver) e não ao que a
# máquina acha: `-s dns` deixa o /etc/hosts de fora (um nome posto lá no IP público passaria
# sem registro nenhum), e `-A` tira o AI_ADDRCONFIG, que numa máquina sem IPv6 esconde o AAAA
# — um AAAA velho, que leva a outra máquina, passaria por certo e o certificado não sairia. O
# getent antigo, sem o -A, recusa as opções (o "uso" do argp, saída 64): aí a pergunta vai
# como antes, e a função sai 3 para quem chama saber que um AAAA pode ter ficado escondido.
# Fora da conta: a própria máquina (o /etc/hosts de muita VPS põe o nome dela em 127.0.1.1) e
# o IPv4 vestido de IPv6 (::ffff:) que o getent devolve quando o nome não tem AAAA.
enderecos_do_dominio() {  # enderecos_do_dominio <4|6> <domínio>
    local saida rc=0 antigo=0
    saida="$(getent -A -s dns "ahostsv$1" "$2" 2>/dev/null)" || rc=$?
    # 0 (achou) e 2 (não achou) são resposta; o resto é o getent que não aceitou as opções.
    if [ "$rc" -ne 0 ] && [ "$rc" -ne 2 ]; then
        antigo=1
        saida="$(getent "ahostsv$1" "$2" 2>/dev/null)" || true
    fi
    printf '%s\n' "$saida" | awk 'NF {print tolower($1)}' \
        | grep -vE '^(127\.|::1$|::ffff:)' | sort -u || true
    [ "$antigo" -eq 0 ] || return 3
}

# O "Nome" que o painel do domínio pede: a parte antes do domínio registrado ("loja" em
# loja.seudominio.com.br), ou "@" para ele mesmo. Registrado são os dois últimos pedaços — ou
# três, quando o penúltimo é uma categoria do país. No .br, qualquer um: lá não se registra
# direto sob o .br, só sob uma categoria (com.br, tec.br, app.br, adv.br, log.br...), e uma
# lista delas sempre ficava para trás — o tec.br que faltava mandava criar "minhaloja" na zona
# minhaloja.tec.br, o nome em dobro. Nos outros países, os genéricos (co.uk, me.uk, com.au...).
nome_no_painel() {
    local -a p
    local n raiz=2
    IFS=. read -r -a p <<< "$1"
    n=${#p[@]}
    if [ "$n" -ge 3 ]; then
        case "${p[n-2]}.${p[n-1]}" in
            *.br|me.uk|ltd.uk|plc.uk) raiz=3 ;;
            com.??|net.??|org.??|gov.??|edu.??|mil.??|co.??|ac.??) raiz=3 ;;
            art.??|blog.??|eco.??|emp.??|ind.??|inf.??|nom.??|tur.??) raiz=3 ;;
        esac
    fi
    if [ "$n" -le "$raiz" ]; then printf '@'; return 0; fi
    local IFS=.
    printf '%s' "${p[*]:0:n-raiz}"
}

juntar() { paste -sd, - | sed 's/,/, /g'; }   # uma por linha → "a, b"

# Preenche PENDENCIAS_DNS com o que falta acertar no painel do domínio; sai 0 se nada falta.
# DNS_NOTA e DNS_NOTA_AAAA: o que não deu para conferir (o ✓ diria mais do que se viu).
PENDENCIAS_DNS=(); DNS_IPS=""; DNS_NOTA=""; DNS_NOTA_AAAA=""
#: De quanto em quanto tempo a conferida se repete enquanto alguém acerta o painel (os testes
#: encurtam, como encurtam o DIR_SYSTEMD).
INTERVALO_DNS="${INTERVALO_DNS:-15}"
# O IP desta máquina não muda enquanto alguém mexe no painel: perguntado uma vez só (cada
# pergunta pode levar segundos com um serviço de eco fora do ar).
MEU_IPV4=""; MEU_IPV6=""; PERGUNTOU_IPV4=0; PERGUNTOU_IPV6=0
avaliar_dns() {
    local v4 v6 nome outros a aaaa_visto=1
    PENDENCIAS_DNS=(); DNS_NOTA=""; DNS_NOTA_AAAA=""
    # Ao lado do "Nome", o nome inteiro, para conferir com o painel — nunca ele NO campo: muito
    # painel acrescenta a zona sozinho, e o registro nasceria com o nome em dobro.
    nome="$(nome_no_painel "$DOMINIO") — o registro completo é $DOMINIO"
    if [ "$PERGUNTOU_IPV4" -eq 0 ]; then MEU_IPV4="$(ip_desta_maquina 4 || true)"; PERGUNTOU_IPV4=1; fi
    v4="$(enderecos_do_dominio 4 "$DOMINIO")" || true
    v6="$(enderecos_do_dominio 6 "$DOMINIO")" || aaaa_visto=0
    # Pelo getent antigo, "sem AAAA" pode ser o AAAA escondido: não conferido, e não certo.
    if [ "$aaaa_visto" -eq 0 ] && [ -z "$v6" ]; then
        DNS_NOTA_AAAA="o AAAA (IPv6) de $DOMINIO não foi conferido: o getent desta máquina é antigo (sem o -A), e numa máquina sem IPv6 ele o esconde. Veja no painel que nenhum AAAA leva a outra máquina — o Let's Encrypt tenta o IPv6 primeiro."
    fi
    DNS_IPS="$(printf '%s\n' "$v4" | juntar)"
    if [ -z "$v4" ]; then
        PENDENCIAS_DNS+=("Crie no painel do domínio:   Tipo A  ·  Nome $nome  ·  Valor ${MEU_IPV4:-<o IP público deste servidor>}")
    elif [ -z "$MEU_IPV4" ]; then
        DNS_NOTA="não consegui descobrir o IP público desta máquina: confira que $DNS_IPS é ela."
    elif ! printf '%s\n' "$v4" | grep -qxF "$MEU_IPV4"; then
        PENDENCIAS_DNS+=("$DOMINIO aponta para $DNS_IPS, não para este servidor. Corrija:   Tipo A  ·  Nome $nome  ·  Valor $MEU_IPV4")
    else
        outros="$(printf '%s\n' "$v4" | grep -vxF "$MEU_IPV4" | juntar || true)"
        [ -z "$outros" ] || PENDENCIAS_DNS+=("Apague os outros registros A de $DOMINIO ($outros): parte das visitas cairia em outra máquina.")
    fi
    if [ -n "$v6" ]; then
        if [ "$PERGUNTOU_IPV6" -eq 0 ]; then MEU_IPV6="$(ip_desta_maquina 6 || true)"; PERGUNTOU_IPV6=1; fi
        while read -r a; do
            if [ -z "$a" ] || [ "$a" = "$MEU_IPV6" ]; then continue; fi
            PENDENCIAS_DNS+=("Apague o registro AAAA de $DOMINIO ($a): ele leva a outra máquina, e o Let's Encrypt tenta o IPv6 primeiro.")
        done <<< "$v6"
    fi
    [ "${#PENDENCIAS_DNS[@]}" -eq 0 ]
}

mostrar_pendencias_dns() {
    local p
    [ "${#PENDENCIAS_DNS[@]}" -gt 0 ] || return 0
    for p in "${PENDENCIAS_DNS[@]}"; do alerta "$p"; done
}

# Nada pendente: o ✓ só quando tudo foi conferido; senão, o que se viu e o que ficou sem ver.
dns_passou() {  # dns_passou <a frase do ✓>
    if [ -z "$DNS_NOTA$DNS_NOTA_AAAA" ]; then certo "$1"; return 0; fi
    if [ -n "$DNS_NOTA" ]; then alerta "$DNS_NOTA"; else alerta "$1, pelo registro A"; fi
    if [ -n "$DNS_NOTA_AAAA" ]; then alerta "$DNS_NOTA_AAAA"; fi
}

conferir_dns() {
    local resposta rc
    [ "$AMBIENTE" = "producao" ] || return 0
    titulo "Conferindo o DNS de $DOMINIO"
    if ! command -v getent >/dev/null 2>&1; then
        alerta "sem o getent nesta máquina não dá para conferir: veja que $DOMINIO aponta para ela."
        return 0
    fi
    if avaliar_dns; then
        dns_passou "$DOMINIO aponta para este servidor ($DNS_IPS)"
        return 0
    fi
    mostrar_pendencias_dns
    # Sem gente na frente (--sim), não espera: a pendência volta no resumo, no fim.
    [ "$INTERATIVO" -eq 1 ] || return 0
    echo "  O certificado HTTPS só sai com o DNS certo. Conferindo de novo a cada ${INTERVALO_DNS} s —"
    echo "  tecle Enter para seguir sem esperar (o que faltar volta no fim)."
    while :; do
        rc=0; read -r -t "$INTERVALO_DNS" resposta || rc=$?
        # Enter (0) segue; fim da entrada (1) também — não há quem tecle, esperar seria para sempre.
        [ "$rc" -gt 128 ] || break
        if avaliar_dns; then dns_passou "agora sim: $DOMINIO aponta para este servidor"; return 0; fi
    done
}

# ------------------------------------------------------- instalação do Docker

# Todo comando de Docker passa por aqui.
#
# O motivo é o grupo `docker`: numa instalação recém-feita, o usuário é adicionado ao grupo,
# mas essa participação SÓ VALE na próxima sessão. Se o instalador insistisse em `docker`
# puro, ele instalaria o Docker com sucesso e morreria na linha seguinte com "permission
# denied" — obrigando a pessoa a sair, entrar e recomeçar. Com o prefixo, a mesma execução
# vai até o fim.
PREFIXO_DOCKER=""
dk() {
    if [ -n "$PREFIXO_DOCKER" ]; then sudo docker "$@"; else docker "$@"; fi
}

como_root() {
    if [ "$(id -u)" -eq 0 ]; then "$@"; else sudo "$@"; fi
}

tem_root() { [ "$(id -u)" -eq 0 ] || command -v sudo >/dev/null 2>&1; }

# Descobre se o Docker responde e se é preciso sudo. Devolve 1 se não responder de jeito
# nenhum.
definir_prefixo_docker() {
    if docker info >/dev/null 2>&1; then PREFIXO_DOCKER=""; return 0; fi
    if [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null \
       && sudo docker info >/dev/null 2>&1; then
        PREFIXO_DOCKER="sudo"; return 0
    fi
    if [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1 && sudo docker info >/dev/null 2>&1; then
        PREFIXO_DOCKER="sudo"; return 0
    fi
    return 1
}

esperar_docker() {  # esperar_docker <segundos>
    local limite="${1:-60}" i=0
    while [ "$i" -lt "$limite" ]; do
        definir_prefixo_docker && return 0
        i=$((i + 2)); sleep 2
    done
    return 1
}

instalar_docker_linux() {
    tem_root || return 3

    local baixador=""
    if command -v curl >/dev/null 2>&1; then baixador="curl"
    elif command -v wget >/dev/null 2>&1; then baixador="wget"
    else
        passo "instalando o curl primeiro…"
        if command -v apt-get >/dev/null 2>&1; then
            como_root apt-get update -qq >/dev/null 2>&1 || true
            como_root apt-get install -y -qq curl >/dev/null 2>&1 || true
        elif command -v dnf >/dev/null 2>&1; then
            como_root dnf install -y -q curl >/dev/null 2>&1 || true
        fi
        command -v curl >/dev/null 2>&1 && baixador="curl" || return 2
    fi

    passo "baixando o instalador oficial do Docker (get.docker.com)…"
    local script; script="$(mktemp)"
    if [ "$baixador" = "curl" ]; then
        curl -fsSL https://get.docker.com -o "$script" || { rm -f "$script"; return 1; }
    else
        wget -qO "$script" https://get.docker.com || { rm -f "$script"; return 1; }
    fi

    passo "instalando — isto demora alguns minutos e não pede nada…"
    # O script oficial cobre Ubuntu, Debian, Fedora, CentOS e derivados, e já traz o plugin
    # `docker compose` v2 junto. É a rota que a própria Docker recomenda para servidor.
    if ! como_root sh "$script" >/dev/null 2>&1; then
        rm -f "$script"; return 1
    fi
    rm -f "$script"

    passo "ligando o serviço…"
    if command -v systemctl >/dev/null 2>&1; then
        como_root systemctl enable --now docker >/dev/null 2>&1 || true
    else
        # Sem systemd (WSL antigo, alguns containers): tenta o init tradicional.
        como_root service docker start >/dev/null 2>&1 || true
    fi

    if [ "$(id -u)" -ne 0 ]; then
        # Vale a partir do próximo login. Nesta execução, quem resolve é o PREFIXO_DOCKER.
        como_root usermod -aG docker "$(id -un)" >/dev/null 2>&1 || true
    fi
    return 0
}

instalar_docker_mac() {
    command -v brew >/dev/null 2>&1 || return 2
    passo "instalando o Docker Desktop pelo Homebrew…"
    brew install --cask docker >/dev/null 2>&1 || return 1
    passo "abrindo o Docker Desktop…"
    open -a Docker >/dev/null 2>&1 || true
    return 0
}

garantir_docker() {
    if command -v docker >/dev/null 2>&1 && definir_prefixo_docker; then
        certo "Docker pronto ($(dk --version 2>/dev/null | cut -d, -f1))"
        return 0
    fi

    # Instalado mas parado: tentar ligar antes de sair instalando de novo.
    if command -v docker >/dev/null 2>&1; then
        passo "o Docker está instalado mas não respondeu; tentando ligar…"
        if command -v systemctl >/dev/null 2>&1 && tem_root; then
            como_root systemctl start docker >/dev/null 2>&1 || true
        elif [ "$(uname -s)" = "Darwin" ]; then
            open -a Docker >/dev/null 2>&1 || true
        fi
        if esperar_docker 60; then
            certo "Docker respondendo"
            return 0
        fi
        morrer \
"O Docker está instalado mas não responde.
  Linux:  sudo systemctl start docker
  Mac:    abra o Docker Desktop e espere o ícone ficar verde.
  Se acabou de instalar, pode ser preciso sair e entrar na sessão de novo."
    fi

    # Não está instalado.
    alerta "O Docker não está instalado — é o único programa de que este sistema precisa."

    if [ "$INSTALAR_DOCKER" -eq 0 ]; then
        morrer \
"Instalação automática desligada por --sem-docker.
  Instale à mão e rode de novo:
      Linux:  curl -fsSL https://get.docker.com | sudo sh
      Mac:    brew install --cask docker"
    fi

    if [ "$INTERATIVO" -eq 1 ]; then
        echo "  Ele é gratuito e é o que faz o banco, a API e o site rodarem isolados."
        local resposta=""
        ler resposta -p "  Instalar o Docker agora? [S/n]: "
        case "${resposta:-s}" in
            [Nn]*) morrer "instalação cancelada. Nada foi mexido no sistema." ;;
        esac
    fi

    titulo "Instalando o Docker"
    local resultado=0
    case "$(uname -s)" in
        Linux)  instalar_docker_linux || resultado=$? ;;
        Darwin) instalar_docker_mac   || resultado=$? ;;
        *)      resultado=9 ;;
    esac

    case "$resultado" in
        0) ;;
        2) morrer \
"Não encontrei como baixar o Docker nesta máquina.
  Instale à mão e rode ./instalar.sh de novo:
      Linux:  curl -fsSL https://get.docker.com | sudo sh
      Mac:    instale o Homebrew (https://brew.sh) ou baixe o Docker Desktop." ;;
        3) morrer \
"Instalar o Docker precisa de permissão de administrador, e este usuário não tem sudo.
  Peça a quem administra o servidor para rodar:
      curl -fsSL https://get.docker.com | sudo sh
      sudo usermod -aG docker $(id -un)
  Depois entre de novo na sessão e rode ./instalar.sh." ;;
        9) morrer \
"Não sei instalar o Docker automaticamente em $(uname -s).
  Baixe em https://www.docker.com/products/docker-desktop e rode ./instalar.sh de novo." ;;
        *) morrer \
"A instalação do Docker falhou.
  Tente à mão para ver a mensagem completa:
      curl -fsSL https://get.docker.com | sudo sh" ;;
    esac

    passo "esperando o Docker subir…"
    if ! esperar_docker 120; then
        morrer \
"O Docker foi instalado, mas não respondeu a tempo.
  No Mac, abra o Docker Desktop e espere o ícone ficar verde.
  No Linux, tente: sudo systemctl start docker
  Depois rode ./instalar.sh de novo — ele continua de onde parou."
    fi

    certo "Docker instalado e no ar ($(dk --version 2>/dev/null | cut -d, -f1))"
    [ -n "$PREFIXO_DOCKER" ] && \
        alerta "usando 'sudo docker' nesta execução; saia e entre na sessão para dispensar o sudo"
    return 0
}

# ------------------------------------------------------------------ verificações

titulo "Sistema de Gestão da Loja — instalação"

garantir_docker

dk compose version >/dev/null 2>&1 || morrer \
"O Docker está instalado, mas sem o plugin 'compose'.
  Ubuntu: sudo apt install docker-compose-plugin
  Ou reinstale pelo caminho oficial: curl -fsSL https://get.docker.com | sudo sh"

CMD_DOCKER="docker"
[ -n "$PREFIXO_DOCKER" ] && CMD_DOCKER="sudo docker"

# ------------------------------------------------------------------ a demonstração (ADR-46)
#
# Vem ligada. Fica de fora com --sem-demo — ou quando o .env de antes já decidiu: a linha
# COMPOSE_PROFILES existe e não tem "demo" (é o que o ./demo.sh --desligar deixa), e quem
# desligou a demonstração não a vê voltar por ter rodado o instalador de novo. Um .env de
# antes da demonstração não tem a linha: a loja que roda o instalador de novo ganha a demo.
# Lido aqui, antes de qualquer regravação: o --forcar ainda vê o .env de antes.
DEMO_ANTES=0
if tem_demo "$(valor_no_env COMPOSE_PROFILES)"; then DEMO_ANTES=1; fi
if [ "$SEM_DEMO" -eq 1 ]; then
    DEMO_LIGADA=0
elif tem_no_env COMPOSE_PROFILES; then
    DEMO_LIGADA="$DEMO_ANTES"
else
    DEMO_LIGADA=1
fi
# O que a demonstração já tinha. O --forcar regrava o .env inteiro e MANTÉM estes: a senha da
# conta é a que está na Apple, e uma sorteada de novo deixaria o revisor de fora.
PERFIS_ANTES="$(valor_no_env COMPOSE_PROFILES)"
DEMO_BANCO="$(valor_no_env DEMO_SENHA_BANCO)"
DEMO_JWT="$(valor_no_env DEMO_JWT_SECRET)"
DEMO_EMAIL="$(valor_no_env DEMO_ADMIN_EMAIL)"
DEMO_SENHA="$(valor_no_env DEMO_ADMIN_SENHA)"

# E o resto do .env de antes, também lido aqui. O --forcar regrava pelo modelo e leva adiante o
# que o modelo não escreve — a NFC-e (FISCAL_*, FOCUSNFE_*: só o .env a liga, ADR-41), o
# DEMO_MEMORIA, qualquer linha que alguém pôs à mão — e a cópia de fora e os avisos, quando
# esta rodada não trouxer outros. Sumiam calados: a NFC-e voltava a "desligado", as vendas
# seguiam sem nota, a cópia de fora parava e a demonstração voltava a 512m. O valor vai como
# estava escrito (aspas e tudo), sem passar pelo valor_no_env.
ENV_ANTES=""
if [ "$FORCAR" -eq 1 ] && [ -f .env ]; then ENV_ANTES="$(cat .env 2>/dev/null || true)"; fi
cru_de_antes() { printf '%s\n' "$ENV_ANTES" | grep -E "^$1=" | tail -1 | cut -d= -f2- || true; }
BACKUP_ANTES="$(cru_de_antes BACKUP_REMOTO)"
NOTIFICAR_ANTES="$(cru_de_antes NOTIFICAR_URL)"
NOTIFICAR_MANTIDO=0

# As linhas CHAVE= do .env de antes cuja chave o .env recém-gravado não tem, na ordem em que
# estavam e com o valor exato. As da demonstração ficam de fora: sobre elas o modelo decide.
linhas_que_o_modelo_nao_escreve() {
    [ -n "$ENV_ANTES" ] || return 0
    printf '%s\n' "$ENV_ANTES" | awk -F= '
        NR == FNR { if ($0 ~ /^[A-Za-z_][A-Za-z0-9_]*=/) novo[$1] = 1; next }
        /^[A-Za-z_][A-Za-z0-9_]*=/ && !($1 in novo) &&
            $1 !~ /^(DEMO_SENHA_BANCO|DEMO_JWT_SECRET|DEMO_ADMIN_EMAIL|DEMO_ADMIN_SENHA)$/' .env -
}

# ------------------------------------------------------------------ perguntas

if [ -f .env ] && [ "$FORCAR" -eq 0 ]; then
    alerta "Já existe um .env — a instalação vai reaproveitar as configurações dele."
    alerta "Para refazer a configuração, rode com --forcar (isto NÃO apaga os dados do banco)."
    # shellcheck disable=SC1091
    set -a; . ./.env; set +a
    # O que é da demonstração o docker compose lê do .env, e não do ambiente: exportada daqui,
    # uma cópia antiga venceria o arquivo que o instalador acabou de completar.
    unset COMPOSE_PROFILES DEMO_SENHA_BANCO DEMO_JWT_SECRET DEMO_ADMIN_EMAIL DEMO_ADMIN_SENHA
    REAPROVEITADO=1
    definir_endereco
    # Um .env de antes das minúsculas: o domínio vai em minúsculas também no arquivo. Exportado
    # daqui, ele já vence o .env no compose desta rodada — e o das próximas (o ./atualizar.sh lê
    # só o .env) subiria a loja com o endereço de antes.
    for chave in DOMINIO ENDERECO_PROXY CORS_ORIGINS; do
        antes="$(valor_no_env "$chave")"
        depois="$(printf '%s' "$antes" | tr '[:upper:]' '[:lower:]')"
        if [ "$antes" != "$depois" ]; then gravar_no_env "$chave" "$depois"; fi
    done
else
    REAPROVEITADO=0

    titulo "1. A loja"
    echo "  O nome aparece na tela de entrada, no topo do sistema e no recibo do cliente."
    while :; do
        perguntar "Nome da loja" "Minha Loja" LOJA
        [ -n "$LOJA" ] && break
    done
    echo
    echo "  E o que a loja vende? Isso troca as palavras das telas — não muda regra nenhuma,"
    echo "  e você pode mudar depois em Sistema > Configuração."
    perguntar_segmento SEGMENTO

    titulo "2. Endereço do sistema"
    echo "  Se a loja tem um domínio apontado para este servidor, informe-o: o certificado"
    echo "  HTTPS é pedido e renovado sozinho. Deixe 'localhost' para usar só nesta máquina;"
    echo "  o IP da rede da loja (ex.: 192.168.0.10) também serve, sem HTTPS."
    while :; do
        perguntar "Domínio (DNS)" "localhost" DOMINIO
        ip_publico "$DOMINIO" || break
        [ "$INTERATIVO" -eq 1 ] || break   # sem teclado, quem recusa é o definir_endereco
        alerta "$(explicar_ip_publico "$DOMINIO")"
        DOMINIO=""
    done

    definir_endereco

    titulo "3. Dono da loja"
    echo "  É a conta de administrador: vê custo, lucro, despesas e relatórios."
    while :; do
        perguntar "Nome" "Dona da Loja" NOME
        [ -n "$NOME" ] && break
    done
    # O e-mail errado sai antes da volta: o perguntar não pergunta o que já tem valor, e o laço
    # repetia "e-mail inválido." para sempre sem perguntar de novo — num erro de digitação, ou
    # com --sim, onde quem recusa é a validação logo abaixo ("faltou --email").
    while :; do
        perguntar "E-mail (é com ele que você entra)" "" EMAIL
        email_valido "$EMAIL" && break
        [ "$INTERATIVO" -eq 1 ] || break
        alerta "e-mail inválido."
        EMAIL=""
    done
    perguntar_senha "Senha do dono (mínimo 8 caracteres)" SENHA

    titulo "4. Banco de dados"
    echo "  Esta senha fica só entre os containers; ninguém digita no dia a dia."
    if [ "$INTERATIVO" -eq 1 ] && [ -z "$SENHA_BANCO" ]; then
        ler gerar -p "  Gerar uma senha forte automaticamente? [S/n]: "
        case "${gerar:-s}" in
            [Nn]*)
                while :; do
                    perguntar_senha "Senha do banco" SENHA_BANCO
                    senha_banco_valida "$SENHA_BANCO" && break
                    alerta "use só letras, números, hífen e sublinhado (mínimo 8)."
                    alerta "pontuação quebra a URL de conexão do banco."
                    SENHA_BANCO=""
                done
                ;;
            *)     SENHA_BANCO="$(sortear 32)"; certo "senha do banco gerada" ;;
        esac
    fi

    titulo "5. Fuso horário"
    echo "  Define o que é 'hoje' no caixa e nos relatórios."
    perguntar "Fuso" "America/Sao_Paulo" FUSO

    titulo "6. Avisos no celular (opcional)"
    echo "  Loja fora do ar, disco enchendo, backup parado, atualização que falhou: o sistema"
    echo "  avisa pelo ntfy, um app gratuito (Android e iPhone). Instale-o, toque em '+' e"
    echo "  assine um tópico com nome difícil de adivinhar — quem souber o nome lê os avisos."
    echo "  Sugestão de tópico: loja-$(sortear 12 | tr '[:upper:]' '[:lower:]')"
    if [ -n "$NOTIFICAR_ANTES" ]; then
        perguntar "Tópico do ntfy (vazio = fica o tópico de antes)" "" NOTIFICAR_URL
    else
        perguntar "Tópico do ntfy (vazio = os avisos ficam só no registro do servidor)" "" NOTIFICAR_URL
    fi
fi

# Só o nome do tópico também vale: vira o endereço no ntfy.sh, que é o que o notificar.sh usa.
case "$NOTIFICAR_URL" in
    ''|http://*|https://*) ;;
    *) NOTIFICAR_URL="https://ntfy.sh/$NOTIFICAR_URL" ;;
esac

# --------------------------------------------------- validação do modo não-interativo

if [ "$REAPROVEITADO" -eq 0 ]; then
    [ -n "$NOME" ]  || morrer "faltou --nome"
    [ -n "$EMAIL" ] || morrer "faltou --email"
    email_valido "$EMAIL" || morrer "e-mail inválido: $EMAIL"
    [ -n "$SENHA" ] || morrer "faltou --senha"
    [ "${#SENHA}" -ge 8 ] || morrer "a senha do dono precisa de ao menos 8 caracteres"
    [ -n "$SENHA_BANCO" ] || SENHA_BANCO="$(sortear 32)"
    senha_banco_valida "$SENHA_BANCO" || morrer \
"a senha do banco só aceita letras, números, hífen e sublinhado (mínimo 8).
  Pontuação quebra a URL de conexão — e um '\$' seria comido pelo docker compose.
  Deixe em branco para o instalador gerar uma forte."

    definir_endereco

    # --forcar redesenha a CONFIGURAÇÃO (domínio, portas, fuso), mas a senha do banco tem uma
    # peculiaridade: o Postgres só a grava quando cria os dados pela primeira vez. Se o volume
    # já existe e o instalador sorteasse uma senha nova, a API ficaria trancada fora do próprio
    # banco — "esperando o banco responder" para sempre, com o banco saudável ao lado.
    if [ -f .env ] && dk volume inspect loja_dados-do-banco >/dev/null 2>&1; then
        senha_existente="$(grep -E '^SENHA_BANCO=' .env | cut -d= -f2- || true)"
        if [ -n "$senha_existente" ] && [ "$senha_existente" != "$SENHA_BANCO" ]; then
            SENHA_BANCO="$senha_existente"
            alerta "o banco já existe: mantendo a senha atual dele"
            alerta "(para trocá-la de verdade é preciso apagar os dados com ./desinstalar.sh)"
        fi
    fi

    # O segredo do login da loja é sorteado a cada regravação, como sempre foi — e nunca igual
    # ao da demonstração: o token só leva o id do usuário, e com o mesmo segredo um token da
    # demonstração valeria na loja.
    JWT_NOVO="$(sortear 64)"
    while [ "$JWT_NOVO" = "$DEMO_JWT" ]; do JWT_NOVO="$(sortear 64)"; done
    PERFIS="$(sem_demo "$PERFIS_ANTES")"
    if [ "$DEMO_LIGADA" -eq 1 ]; then
        PERFIS="$(com_demo "$PERFIS_ANTES")"
        [ -n "$DEMO_BANCO" ] || DEMO_BANCO="$(sortear 32)"
        while [ -z "$DEMO_JWT" ] || [ "$DEMO_JWT" = "$JWT_NOVO" ]; do DEMO_JWT="$(sortear 64)"; done
        [ -n "$DEMO_EMAIL" ] || DEMO_EMAIL="$EMAIL_DA_DEMO"
        if [ -z "$DEMO_SENHA" ]; then DEMO_SENHA="$(sortear 20)"; SENHA_DEMO_NOVA=1; fi
        if [ -z "$DEMO_BANCO" ] || [ -z "$DEMO_SENHA" ]; then morrer "não consegui sortear as senhas da demonstração."; fi
    fi
    # Os avisos de antes ficam quando esta rodada não trouxe outro tópico (é o --forcar).
    if [ -z "$NOTIFICAR_URL" ] && [ -n "$NOTIFICAR_ANTES" ]; then
        NOTIFICAR_URL="$NOTIFICAR_ANTES"; NOTIFICAR_MANTIDO=1
    fi

    # O DNS ANTES de gravar o .env: a espera por ele não tem teto e convida a sair (Ctrl+C para
    # ir acertar o painel, o SSH que cai). Interrompida com o .env já gravado, a próxima rodada o
    # reaproveitava sem perguntar nada e terminava "com sucesso" sem a conta do dono, nem o nome
    # e o ramo da loja. Assim, quem volta recomeça do jeito que começou.
    conferir_dns

    titulo "Gravando a configuração"
    umask 077                      # o .env carrega senhas: só o dono do arquivo lê.
    cat > .env <<FIM
# Gerado por ./instalar.sh — contém senhas. NÃO versione, não compartilhe.
DOMINIO=$DOMINIO
ENDERECO_PROXY=$ENDERECO_PROXY
PORTA_HTTP=$PORTA_HTTP
PORTA_HTTPS=$PORTA_HTTPS

SENHA_BANCO=$SENHA_BANCO
JWT_SECRET=$JWT_NOVO

AMBIENTE=$AMBIENTE
CORS_ORIGINS=$CORS_ORIGINS
TIMEZONE_LOJA=$FUSO

# Para onde o ./backup.sh manda a cópia de fora do servidor. Qualquer destino do rclone
# (rclone.org): gdrive:loja-backups, s3:meu-bucket/loja, b2:loja... Vazio = a cópia fica
# só neste servidor, e morre junto com ele. Ela sai CIFRADA: ./backup.sh --mostrar-chave.
BACKUP_REMOTO=$BACKUP_ANTES

# Para onde vão os avisos (loja fora do ar, disco, backup, atualização que falhou): o
# endereço de um tópico do ntfy. Vazio = os avisos ficam só no journal deste servidor.
NOTIFICAR_URL=$NOTIFICAR_URL
FIM
    # A demonstração: ligada, ou desligada guardando o que ela já tinha (o ./demo.sh --ligar
    # volta com a mesma senha). Desligada e sem nada, só a decisão — o --sem-demo não grava
    # nada dela, mas a linha vazia diz ao próximo instalador que ela ficou de fora de propósito.
    {
        printf '\n'
        if [ "$DEMO_LIGADA" -eq 1 ] || [ -n "$DEMO_BANCO$DEMO_JWT$DEMO_SENHA" ]; then
            printf '%s\n' "${COMENTARIO_DA_DEMO[@]}"
            printf 'COMPOSE_PROFILES=%s\n' "$PERFIS"
            if [ -n "$DEMO_BANCO" ]; then printf 'DEMO_SENHA_BANCO=%s\n' "$DEMO_BANCO"; fi
            if [ -n "$DEMO_JWT" ]; then printf 'DEMO_JWT_SECRET=%s\n' "$DEMO_JWT"; fi
            if [ -n "$DEMO_EMAIL" ]; then printf 'DEMO_ADMIN_EMAIL=%s\n' "$DEMO_EMAIL"; fi
            if [ -n "$DEMO_SENHA" ]; then printf 'DEMO_ADMIN_SENHA=%s\n' "$DEMO_SENHA"; fi
        else
            printf '%s\n' "$COMENTARIO_DA_DEMO_DESLIGADA"
            printf 'COMPOSE_PROFILES=%s\n' "$PERFIS"
        fi
    } >> .env
    # O que o modelo não escreve vem do .env de antes, no fim.
    LEVADAS="$(linhas_que_o_modelo_nao_escreve)"
    if [ -n "$LEVADAS" ]; then
        printf '\n%s\n%s\n' "# Do .env de antes: o modelo acima não as escreve, e o ./instalar.sh --forcar as manteve." \
            "$LEVADAS" >> .env
    fi
    chmod 600 .env
    certo ".env gravado (só você consegue ler)"
    # Quais ficaram, pelo nome: o valor pode ser segredo (o FOCUSNFE_TOKEN é).
    MANTIDAS=()
    if [ -n "$BACKUP_ANTES" ]; then MANTIDAS+=(BACKUP_REMOTO); fi
    if [ "$NOTIFICAR_MANTIDO" -eq 1 ]; then MANTIDAS+=(NOTIFICAR_URL); fi
    while IFS= read -r chave; do MANTIDAS+=("$chave"); done \
        < <(printf '%s\n' "$LEVADAS" | cut -d= -f1 | awk 'NF && !visto[$0]++')
    if [ "${#MANTIDAS[@]}" -gt 0 ]; then
        certo "do .env de antes, mantidas: $(printf '%s\n' "${MANTIDAS[@]}" | juntar)"
    fi
fi

# Quem já tinha a loja e roda o instalador de novo: o .env fica como está, e só ganha o que
# a demonstração precisa (ou, com --sem-demo, a decisão de deixá-la de fora).
if [ "$REAPROVEITADO" -eq 1 ]; then
    if [ "$DEMO_LIGADA" -eq 1 ]; then
        completar_env_da_demo
        certo "demonstração ligada no .env (o que já havia nele ficou como estava)"
    elif ! tem_no_env COMPOSE_PROFILES; then
        acrescentar_no_env "" "$COMENTARIO_DA_DEMO_DESLIGADA" "COMPOSE_PROFILES="
    fi
    # Aqui o .env já existia; a instalação nova conferiu antes de gravá-lo.
    conferir_dns
fi

# ------------------------------------------------------------------ subir

sincronizar_senha_banco() {
    # O Postgres grava POSTGRES_PASSWORD só quando CRIA os dados. Num banco que já existia —
    # depois de um --forcar, de um .env refeito, ou de restaurar um backup noutra máquina — a
    # senha do arquivo e a do banco divergem, e a API fica batendo numa porta que não abre,
    # repetindo "esperando o banco responder" com o banco saudável ao lado.
    #
    # A imagem oficial do Postgres confia em conexões pelo socket local dentro do container,
    # então dá para alinhar as duas sem saber a senha antiga: o .env passa a ser a verdade.
    #
    # A senha entra no SQL sem escape, e isso é seguro porque `senha_banco_valida` já a
    # restringiu a letras, números, hífen e sublinhado.
    local i=0
    while [ "$i" -lt 30 ]; do
        dk compose exec -T db pg_isready -U loja -d loja >/dev/null 2>&1 && break
        i=$((i + 1)); sleep 2
    done
    dk compose exec -T db psql -q -v ON_ERROR_STOP=1 -U loja -d loja \
        -c "ALTER USER loja PASSWORD '$SENHA_BANCO';" >/dev/null 2>&1 || true
}

titulo "Construindo e subindo os containers"
passo "isto demora alguns minutos na primeira vez"

# A saída é mostrada E guardada: o build é longo e a pessoa precisa ver o progresso, mas se
# falhar queremos ler o motivo para traduzir a mensagem do Docker em algo acionável.
registro_up="$(mktemp)"
set +e
# O que a tela do sistema mostra em "versão". Instalação nova é, por definição, a mais
# nova que existe — e sem este arquivo a tela abriria dizendo "sem conferir com o GitHub"
# num sistema recém-instalado, que é a pior hora para desconfiar.
if git rev-parse --git-dir >/dev/null 2>&1; then
    mkdir -p docker/estado
    cat > docker/estado/versao.json <<FIM
{
  "commit": "$(git rev-parse --short HEAD 2>/dev/null)",
  "data": "$(git log -1 --format=%cI 2>/dev/null)",
  "conferido_em": "$(date -u +%Y-%m-%dT%H:%M:%S+00:00)",
  "atualizada": true
}
FIM
fi

# Só os serviços DA LOJA, pelo nome: a demonstração sobe depois, à parte, e o que acontece
# com ela nunca decide se a instalação da loja deu certo.
dk compose up -d --build db api proxy 2>&1 | tee "$registro_up"
codigo_up=${PIPESTATUS[0]}
set -e

if [ "$codigo_up" -ne 0 ]; then
    if grep -qiE "ports are not available|address already in use|bind: permission denied|forbidden by its access permissions" "$registro_up"; then
        rm -f "$registro_up"
        morrer \
"A porta $PORTA_HTTP já está sendo usada por outro programa.
  Descubra quem está nela:
      Linux/Mac:  sudo lsof -i :$PORTA_HTTP
      Windows:    netstat -ano | findstr :$PORTA_HTTP
  Ou instale numa porta livre:
      ./instalar.sh --forcar --porta-http 8080"
    fi
    rm -f "$registro_up"
    morrer "não foi possível subir os containers. O motivo está logo acima."
fi
rm -f "$registro_up"

titulo "Esperando o sistema responder"

sincronizar_senha_banco

pronto=0
for _ in $(seq 1 90); do
    # `ps -q` + `inspect` em vez de `ps --format`: o template Go não é aceito por versões
    # antigas do Compose, e ali o instalador acusaria a API de doente sem ela estar.
    id_api="$(dk compose ps -q api 2>/dev/null | head -1)"
    if [ -n "$id_api" ]; then
        estado="$(dk inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id_api" 2>/dev/null)"
        [ "$estado" = "healthy" ] && { pronto=1; break; }
    fi
    sleep 2
done
[ "$pronto" -eq 1 ] || {
    printf '\n%s' "$VERMELHO"
    echo "A API não ficou saudável. Os últimos registros:"; printf '%s\n' "$NORMAL"
    dk compose logs --tail 40 api
    morrer "instalação interrompida. Corrija o erro acima e rode ./instalar.sh de novo."
}
certo "API no ar, banco migrado"

# O commit que SUBIU, o mesmo registro que o ./atualizar.sh grava e usa como "a versão no
# ar" (é para ela que ele volta se a próxima atualização falhar). Sem gravar aqui, um
# `desinstalar --manter-dados` + `git pull` + `instalar` deixava valendo o registro da
# instalação ANTERIOR, e a volta atrás iria para um código que não conhece as migrations
# que este acabou de aplicar.
if git rev-parse --git-dir >/dev/null 2>&1; then
    mkdir -p docker/estado
    git rev-parse HEAD > docker/estado/implantado.novo && mv -f docker/estado/implantado.novo docker/estado/implantado
fi

# O proxy só lê o Caddyfile ao subir, e o `up` só o recria quando muda a configuração DELE
# no compose: rodando o instalador de novo, o Caddyfile do disco (o /demo, a CSP) pode ser
# mais novo que o que está no ar. Conferido antes de recarregar — um que não passa nunca
# troca o que está no ar. Num proxy recém-criado, recarregar o mesmo arquivo não muda nada.
if dk compose exec -T proxy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1; then
    dk compose exec -T proxy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 \
        || alerta "o proxy não recarregou o Caddyfile; se algo não abrir: ${CMD_DOCKER} compose restart proxy"
else
    alerta "o Caddyfile não passou na conferência do proxy: veja ${CMD_DOCKER} compose logs proxy"
fi

# A API estar saudável não garante que o proxy esteja publicando a porta. Antes de anunciar
# o endereço, abre ele de verdade.
WEB_OK=0
if command -v curl >/dev/null 2>&1; then
    if curl -skf -o /dev/null --max-time 15 "$URL_FINAL/app/"; then
        WEB_OK=1
        certo "sistema web respondendo em $URL_FINAL/app/"
    elif [ "$AMBIENTE" = "producao" ]; then
        alerta "o endereço ainda não responde — o certificado pode estar sendo emitido."
        alerta "acompanhe com: docker compose logs -f proxy"
    else
        alerta "a API subiu, mas $URL_FINAL/app/ não respondeu."
        alerta "veja o proxy com: docker compose logs proxy"
    fi
fi

# ------------------------------------------------------------------ identidade da loja

# Depois da API no ar (é ela que fala com o banco) e ANTES da conta do dono, para que a
# primeira tela que ele vir já esteja com o nome certo.
if [ -n "$LOJA" ]; then
    titulo "Gravando o nome e o ramo da loja"
    if dk compose exec -T api python -m app.cli configurar-loja \
            --nome "$LOJA" --segmento "${SEGMENTO:-OUTRO}"; then
        certo "identidade gravada"
    else
        alerta "não foi possível gravar (o sistema segue no ar, com o nome padrão)."
        alerta "dá para ajustar depois em Sistema > Configuração, ou por aqui:"
        echo "    ${PREFIXO_DOCKER:+sudo }docker compose exec api python -m app.cli configurar-loja --nome ... --segmento ..."
    fi
fi

# ------------------------------------------------------------------ dono da loja

if [ -n "$EMAIL" ] && [ -n "$SENHA" ]; then
    # `create-admin` não duplica: se a conta já existe e está ativa, ele avisa e sai bem.
    titulo "Criando a conta do dono"
    if dk compose exec -T api python -m app.cli create-admin \
            --nome "$NOME" --email "$EMAIL" --senha "$SENHA"; then
        certo "conta pronta"
    else
        alerta "não foi possível criar a conta (veja a mensagem acima)."
        alerta "o sistema está no ar; crie a conta depois com:"
        echo "    ${PREFIXO_DOCKER:+sudo }docker compose exec api python -m app.cli create-admin --nome ... --email ... --senha ..."
    fi
elif [ "$REAPROVEITADO" -eq 1 ]; then
    alerta "Configuração reaproveitada — a conta do dono não foi mexida."
    alerta "Para criar uma conta nova de administrador:"
    echo "    ${PREFIXO_DOCKER:+sudo }docker compose exec api python -m app.cli create-admin --nome ... --email ... --senha ..."
fi

# ------------------------------------------------------------------ a demonstração (ADR-46)

# A loja já está no ar e conferida; a demonstração vem depois, e nunca a derruba: sobe, espera
# com teto, e o que não deu vira recado — a instalação da loja termina do mesmo jeito. A conta
# dela nasce DENTRO do contêiner, pelo ambiente que o compose passa (a senha nunca aparece numa
# linha de comando, nem no `ps` da máquina).
ESPERA_DEMO=90
DEMO_PRONTA=0
subir_demonstracao() {
    local id estado
    titulo "Subindo a demonstração (${URL_FINAL}/demo)"
    passo "outra API e outro banco, só com dados fictícios: a loja não depende dela"
    if ! dk compose up -d demo-banco api-demo; then
        alerta "a demonstração não subiu (a loja está no ar e não depende dela)."
        alerta "veja: ${CMD_DOCKER} compose logs --tail 50 api-demo   e tente de novo: ./demo.sh --ligar"
        return 0
    fi
    # A primeira subida migra e carrega os dados fictícios antes de responder.
    for _ in $(seq 1 "$ESPERA_DEMO"); do
        id="$(dk compose ps -q api-demo 2>/dev/null | head -1 || true)"
        if [ -n "$id" ]; then
            estado="$(dk inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id" 2>/dev/null || true)"
            if [ "$estado" = "healthy" ]; then
                DEMO_PRONTA=1
                certo "demonstração no ar"
                break
            fi
        fi
        sleep 2
    done
    if [ "$DEMO_PRONTA" -eq 0 ]; then
        alerta "a demonstração ainda não respondeu — a primeira carga dos dados fictícios leva alguns minutos."
        alerta "confira depois com: ./demo.sh --mostrar"
        return 0
    fi
    # Respondeu por dentro; e pelo endereço? Só vale perguntar se a loja abriu por ele.
    if [ "$WEB_OK" -eq 1 ] && ! curl -skf -o /dev/null --max-time 15 "$URL_FINAL/demo/health"; then
        alerta "a demonstração está no ar, mas $URL_FINAL/demo não abriu: ${CMD_DOCKER} compose restart proxy"
    fi
}

if [ "$DEMO_LIGADA" -eq 1 ]; then
    subir_demonstracao
elif [ "$DEMO_ANTES" -eq 1 ]; then
    # --sem-demo numa loja que tinha a demonstração: desliga de verdade (os contêineres dela não
    # saem sozinhos do ar) e guarda o banco e a senha, como o ./demo.sh --desligar.
    titulo "Desligando a demonstração (--sem-demo)"
    ./demo.sh --desligar --sim || alerta "não consegui desligar a demonstração; tente: ./demo.sh --desligar"
fi

# ------------------------------------------------------------------ cópia diária e vigia

# A instalação oficial terminava sem cópia NENHUMA do banco: o `./backup.sh --automatico`
# existia, mas só ligava por SSH, e o ADR-28 conta o servidor que ficou meses assim. Agora
# ela nasce ligada (systemd no Linux, launchd no Mac), e no Linux o vigia junto: de 5 em 5
# minutos ele confere o /health, o disco e o backup da nuvem, e avisa pelo NOTIFICAR_URL.
# Falhar aqui não desfaz a instalação: a loja já está no ar, e o recado diz o que rodar.
# O `./desinstalar.sh --manter-dados` anota as rotinas que estavam ligadas (o backup do
# Drive e a atualização sozinha, com o intervalo) para elas voltarem iguais: sem isto, a loja
# religada ficava com o backup do Drive "ligado" na tela e nenhum timer para fazê-lo.
religar_rotinas_anotadas() {
    local anotadas="docker/estado/rotinas" nome minutos
    [ -s "$anotadas" ] || return 0
    while read -r nome minutos; do
        case "$nome" in
            loja-backup-nuvem)
                ./backup.sh --nuvem-automatico \
                    || alerta "o backup do Drive não religou; ligue com ./backup.sh --nuvem-automatico" ;;
            loja-atualizar)
                ./atualizar.sh --automatico "${minutos:-10}" \
                    || alerta "a atualização sozinha não religou; ligue com ./atualizar.sh --automatico" ;;
        esac
    done < "$anotadas"
    rm -f "$anotadas"
}

ligar_rotinas() {
    titulo "Cópia diária do banco e vigia da loja"
    case "$(uname -s)" in
        Darwin)
            ./backup.sh --automatico \
                || alerta "a cópia diária não ligou (veja acima); ligue depois com ./backup.sh --automatico"
            ;;
        Linux)
            # `/run/systemd/system` só existe com o systemd no comando (não em contêiner, WSL1…).
            if ! command -v systemctl >/dev/null 2>&1 || [ ! -d "${DIR_SYSTEMD_RODANDO:-/run/systemd/system}" ]; then
                alerta "Este servidor não usa systemd: a cópia diária NÃO foi ligada."
                alerta "Agende no cron do root: 15 3 * * * cd $(pwd) && ./backup.sh --sim"
                return 0
            fi
            ./backup.sh --automatico \
                || alerta "a cópia diária não ligou (veja acima); ligue depois com ./backup.sh --automatico"
            ./vigia.sh --automatico \
                || alerta "o vigia não ligou (veja acima); ligue depois com ./vigia.sh --automatico"
            # A demonstração volta ao começo toda madrugada: o revisor sempre encontra os dados
            # de exemplo inteiros, com as datas de hoje.
            if [ "$DEMO_LIGADA" -eq 1 ]; then
                ./demo.sh --automatico \
                    || alerta "a renovação da demonstração não ligou; ligue depois com ./demo.sh --automatico"
            fi
            religar_rotinas_anotadas
            ;;
        *)
            alerta "Não sei agendar a cópia diária em $(uname -s); rode ./backup.sh todo dia."
            ;;
    esac
    # O aviso de teste só quando o tópico acabou de ser informado: religar a loja (rodar o
    # instalador de novo com o .env de antes), ou o --forcar que manteve o tópico de antes, não
    # precisa apitar o celular toda vez.
    if [ -n "${NOTIFICAR_URL:-}" ] && [ "$REAPROVEITADO" -eq 0 ] && [ "$NOTIFICAR_MANTIDO" -eq 0 ]; then
        if ./notificar.sh --testar >/dev/null 2>&1; then
            certo "aviso de teste enviado para $NOTIFICAR_URL — confira o celular"
        else
            alerta "o aviso de teste não saiu para $NOTIFICAR_URL (o endereço está certo?)"
        fi
    fi
}
ligar_rotinas

# ------------------------------------------------------------------ fim

titulo "Pronto — o sistema está rodando"
cat <<FIM

  Endereço:  ${FORTE}${URL_FINAL}/app/${NORMAL}
  Modo:      ${MODO}
  Entrar:    ${EMAIL:-<a conta já existente>}
FIM
if [ "$DEMO_LIGADA" -eq 1 ]; then
    printf '\n  %sDemonstração%s (dados fictícios; a conta dela não entra na loja):\n' "$FORTE" "$NORMAL"
    printf '    Endereço:  %s%s/demo%s' "$FORTE" "$URL_FINAL" "$NORMAL"
    [ "$DEMO_PRONTA" -eq 1 ] || printf '   (ainda subindo: ./demo.sh --mostrar)'
    printf '\n    Entrar:    %s\n' "$(valor_no_env DEMO_ADMIN_EMAIL)"
    # A senha aparece uma vez: quando acabou de nascer. Rodar o instalador de novo não a
    # repete no terminal (nem no log de quem o rodou por automação).
    if [ "$SENHA_DEMO_NOVA" -eq 1 ]; then
        printf '    Senha:     %s%s%s   (anote: é a que vai para a revisão da Apple)\n' \
            "$FORTE" "$(valor_no_env DEMO_ADMIN_SENHA)" "$NORMAL"
    else
        printf '    Senha:     veja com ./demo.sh --mostrar\n'
    fi
else
    printf '\n  Demonstração: desligada — para ligar: ./demo.sh --ligar\n'
fi
cat <<FIM

  Comandos do dia a dia:
    ${CMD_DOCKER} compose ps               ver se está no ar
    ${CMD_DOCKER} compose logs -f api      acompanhar o que acontece
    ${CMD_DOCKER} compose restart          reiniciar
    ${CMD_DOCKER} compose down             desligar (os dados ficam guardados)
    ./instalar.sh                   religar depois de um down
    ./backup.sh --listar            as cópias do banco (uma por dia, às 03:15)
    ./backup.sh --mostrar-chave     a chave das cópias de fora: guarde FORA daqui
    ./vigia.sh                      conferir agora se está tudo de pé
    ./demo.sh --mostrar             a demonstração: endereço, senha e o que levar à Apple

FIM
if [ "$AMBIENTE" = "producao" ]; then
    # O que a conferida do DNS achou e ficou para trás (com --sim ninguém esperou por ele).
    if [ "${#PENDENCIAS_DNS[@]}" -gt 0 ]; then
        alerta "Falta acertar o DNS de $DOMINIO — sem isso o certificado HTTPS não sai:"
        mostrar_pendencias_dns
        echo
    fi
    alerta "As portas 80 e 443 deste servidor precisam estar liberadas — é o que o Let's"
    alerta "Encrypt usa para emitir o certificado. Acompanhe em: ${CMD_DOCKER} compose logs -f proxy"
    echo
fi
