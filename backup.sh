#!/usr/bin/env bash
#
# Cópia de segurança do banco da loja.
#
#     ./backup.sh                    faz uma cópia agora
#     ./backup.sh --automatico       passa a copiar todo dia, sozinho
#     ./backup.sh --listar           mostra as cópias que existem
#     ./backup.sh --restaurar ARQ    volta o banco para o estado daquela cópia
#     ./backup.sh --mostrar-chave    mostra a chave que abre as cópias de fora e pede a
#                                    confirmação de que ela foi guardada
#
# Perder o banco é perder o histórico de vendas E o estoque inteiro — não existe como
# recontar seis meses de venda. E o backup que o `./atualizar.sh` faz não serve para isso:
# ele só acontece quando há versão nova, e fica na mesma máquina que pode queimar.
#
# **A cópia de fora do servidor é a que importa.** Backup que só existe no mesmo disco não
# é backup: é uma segunda chance contra engano humano, e nenhuma contra o disco morrer.
# Configure `BACKUP_REMOTO` no .env (ex.: `BACKUP_REMOTO=gdrive:loja-backups`) e instale o
# rclone; sem isso este script avisa toda vez, de propósito.
#
# **O que sai do servidor sai cifrado** (Drive e BACKUP_REMOTO), com uma chave que nasce e
# mora SÓ nesta máquina (backups/.chave-do-backup). Guarde-a fora dela: sem a chave, a
# cópia de fora não abre — e é justamente no dia em que este servidor morreu que se precisa
# dela. Por isso a cifra só liga depois que uma pessoa VÊ a chave e confirma que a guardou
# (`--mostrar-chave`); até lá a cópia de fora sai como sempre saiu, e o recado insiste.
#
# Opções:
#   --automatico [HH:MM]  liga a cópia diária (padrão 03:15, loja fechada); systemd no
#                         Linux, launchd no Mac
#   --sem-automatico      desliga
#   --listar              lista as cópias, da mais nova para a mais velha
#   --restaurar ARQUIVO   restaura (pede confirmação e guarda uma cópia de antes). Aceita a
#                         cópia cifrada baixada do Drive (`.dump.bin`): pede a chave
#   --mostrar-chave       mostra a chave das cópias de fora (e a cria, se ainda não existe)
#                         e pergunta se ela foi guardada: o "sim" liga a cifra
#   --confirmar-chave     o mesmo, sem a pergunta (quem roda declara que guardou)
#   --sim                 não pergunta nada (para o agendamento)

set -euo pipefail
cd "$(dirname "$0")"

# Tudo que este script cria (dumps, a chave, a configuração do rclone) é só do dono do
# arquivo: o dump é o banco inteiro, com CPF, telefones e hashes de senha. Quem grava as
# unidades do systemd volta para 022 lá embaixo, onde é preciso.
umask 077

VERDE=$'\033[32m'; AMARELO=$'\033[33m'; VERMELHO=$'\033[31m'; AZUL=$'\033[36m'
FORTE=$'\033[1m'; NORMAL=$'\033[0m'
[ -t 1 ] || { VERDE=""; AMARELO=""; VERMELHO=""; AZUL=""; FORTE=""; NORMAL=""; }

titulo() { printf '\n%s%s%s\n' "$FORTE$AZUL" "$1" "$NORMAL"; }
ok()     { printf '  %s✓%s %s\n' "$VERDE" "$NORMAL" "$1"; }
aviso()  { printf '  %s!%s %s\n' "$AMARELO" "$NORMAL" "$1"; }
erro()   { printf '\n%s✗ %s%s\n' "$VERMELHO" "$1" "$NORMAL" >&2; }

DESTINO=backups
#: Duas semanas cobrem o "só percebi na segunda que estragou na quarta passada" sem que o
#: disco de um servidor pequeno vire um cemitério de dumps.
DIAS_PARA_GUARDAR=14
HORA_PADRAO="03:15"

ACAO="copiar"
ARQUIVO_ALVO=""
HORA="$HORA_PADRAO"
INTERATIVO=1

while [ $# -gt 0 ]; do
    case "$1" in
        --automatico)
            ACAO="ligar"
            case "${2:-}" in [0-9]*:[0-9]*) HORA="$2"; shift ;; esac
            ;;
        --sem-automatico) ACAO="desligar" ;;
        --nuvem)          ACAO="nuvem" ;;
        --nuvem-timer)    ACAO="nuvem-timer" ;;
        --nuvem-automatico) ACAO="nuvem-ligar" ;;
        --listar)         ACAO="listar" ;;
        --restaurar)      ACAO="restaurar"; ARQUIVO_ALVO="${2:-}"; shift ;;
        --mostrar-chave)  ACAO="mostrar-chave" ;;
        --confirmar-chave) ACAO="confirmar-chave" ;;
        --sim)            INTERATIVO=0 ;;
        -h|--help)        sed -n '2,42p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *)                erro "Opção desconhecida: $1"; exit 1 ;;
    esac
    shift
done

# ------------------------------------------------------------------ ferramentas

PREFIXO_DOCKER=""
dk() { if [ -n "$PREFIXO_DOCKER" ]; then sudo docker "$@"; else docker "$@"; fi; }

sudo_se_preciso() { if [ "$(id -u)" -eq 0 ]; then "$@"; else sudo "$@"; fi; }

[ -f docker-compose.yml ] || { erro "Rode este script de dentro da pasta do sistema."; exit 1; }

if docker info >/dev/null 2>&1; then
    PREFIXO_DOCKER=""
elif command -v sudo >/dev/null 2>&1 && sudo -n docker info >/dev/null 2>&1; then
    PREFIXO_DOCKER="sudo"
else
    erro "Não consegui falar com o Docker. Ele está rodando?"
    exit 1
fi

REMOTO="$(grep -E '^BACKUP_REMOTO=' .env 2>/dev/null | cut -d= -f2- | tr -d '"' || true)"

# A pasta das cópias é só do dono (700): as de antes desta regra nasceram 644, e fechar a
# pasta fecha elas também.
preparar_destino() {
    mkdir -p "$DESTINO"
    chmod 700 "$DESTINO" 2>/dev/null || true
}

# ------------------------------------------------------------------ a chave das cópias de fora
#
# O que sai deste servidor (Drive e BACKUP_REMOTO) sai CIFRADO, por um remote `crypt` do
# rclone. Em claro, quem entrasse no Google do dono — ou numa pasta compartilhada sem querer
# — levava o banco inteiro: CPF e telefone das clientes, hashes de senha, o diário com IPs, e
# o próprio rclone_token, que mora numa coluna do banco e vai junto no dump.
#
# A senha nasce AQUI e mora só aqui: backups/.chave-do-backup, 600, numa pasta 700. Não vai
# para o banco (iria dentro do dump que ela protege), nem para o .env (o `instalar.sh
# --forcar` o reescreve), nem para docker/estado/ (montado no contêiner da API, que nunca vê
# credencial — ADR-28). Sem ela a cópia de fora não abre: por isso é mostrada uma vez, ao
# nascer, com a ordem de guardar FORA da máquina, e o `--mostrar-chave` a mostra de novo.
CHAVE="$DESTINO/.chave-do-backup"

# Quem digita a chave no papel erra maiúscula, espaço e hífen; nada disso conta.
normalizar_chave() { printf '%s' "$1" | tr -d ' \t\r\n-' | tr '[:upper:]' '[:lower:]'; }
ler_chave() { normalizar_chave "$(cat "$CHAVE" 2>/dev/null || true)"; }

# Uma pessoa VIU a chave e disse que a guardou fora da máquina. Só a partir daí as cópias de
# fora saem cifradas. Cifrar com uma chave que ninguém viu — nascida pelo timer, numa loja
# já instalada, sem terminal — trocava "backup legível no Drive" por "backup que não abre":
# o disco morre e leva a única chave junto, no dia exato em que a cópia de fora importa.
# Até a confirmação a cópia de fora sai como sempre saiu, e o recado insiste a cada cópia.
CHAVE_CONFIRMADA="$DESTINO/.chave-confirmada"
cifrar_copias_de_fora() { [ -s "$CHAVE" ] && [ -f "$CHAVE_CONFIRMADA" ]; }
confirmar_chave() {
    preparar_destino
    : > "$CHAVE_CONFIRMADA"
    chmod 600 "$CHAVE_CONFIRMADA"
    ok "chave confirmada: as próximas cópias de fora saem cifradas"
}

# A cópia de fora saiu legível porque a chave não foi confirmada: diz isso no terminal e,
# com NOTIFICAR_URL, no celular (o notificar.sh segura a repetição).
avisar_copia_em_claro() {
    aviso "A cópia de fora saiu SEM criptografia: a chave do backup ainda não foi confirmada."
    aviso "Para ligar: ./backup.sh --mostrar-chave, guarde a chave FORA do servidor e confirme."
    if [ -x ./notificar.sh ]; then
        ./notificar.sh --assunto chave-do-backup "Confirme a chave do backup" \
            "As cópias de fora ainda saem sem criptografia. No servidor, rode ./backup.sh --mostrar-chave, guarde a chave fora dele e confirme." \
            >/dev/null 2>&1 || true
    fi
}

# A senha no formato do arquivo de configuração do rclone (`obscure`), lida pelo stdin para
# não aparecer num `ps`.
senha_rclone() { printf '%s\n' "$1" | rclone obscure -; }

criar_chave() {
    local bruta nova
    preparar_destino
    # 24 letras e números sem os que se confundem no papel (0/o, 1/l/i): ~120 bits, em seis
    # grupos de quatro. `head -c` primeiro: `tr < /dev/urandom | head` morre de SIGPIPE.
    bruta="$(head -c 2000 /dev/urandom | LC_ALL=C tr -dc 'abcdefghjkmnpqrstuvwxyz23456789' || true)"
    nova="$(printf '%s' "${bruta:0:24}" | sed 's/..../&-/g; s/-$//')"
    [ "${#nova}" -eq 29 ] || { erro "Não consegui sortear a chave do backup."; exit 1; }
    printf '%s\n' "$nova" > "$CHAVE.nova" && mv -f "$CHAVE.nova" "$CHAVE"
    chmod 600 "$CHAVE"
}

mostrar_chave() {
    printf '\n  %sChave das cópias de fora deste servidor (Drive e BACKUP_REMOTO):%s\n\n' \
        "$FORTE" "$NORMAL"
    printf '      %s%s%s\n\n' "$FORTE$AMARELO" "$(cat "$CHAVE")" "$NORMAL"
    printf '  %sGuarde-a FORA deste servidor%s: anotada em papel, num cofre de senhas, com o\n' \
        "$VERMELHO$FORTE" "$NORMAL"
    printf '  contador. As cópias de fora saem cifradas: se este servidor morrer, elas SÓ\n'
    printf '  abrem com esta chave, e ninguém consegue recuperá-la depois.\n\n'
    printf '  Restaurar noutra máquina: %s./backup.sh --restaurar loja-AAAAMMDD-HHMMSS.dump.bin%s\n' \
        "$FORTE" "$NORMAL"
    printf '  (ele pede a chave). Ver de novo: %s./backup.sh --mostrar-chave%s\n\n' "$FORTE" "$NORMAL"
    cifrar_copias_de_fora && return 0
    # A cifra só liga com o "sim" de quem está vendo a chave. Sem terminal (timer, --sim),
    # ninguém viu: fica para a próxima vez que alguém pedir a chave.
    if [ "$INTERATIVO" -eq 1 ] && [ -t 0 ]; then
        local resposta=""
        printf '  Já guardou a chave FORA deste servidor? Digite %sSIM%s para ligar a cifra: ' \
            "$FORTE" "$NORMAL"
        read -r resposta || true
        if [ "$(printf '%s' "$resposta" | tr '[:lower:]' '[:upper:]')" = "SIM" ]; then
            confirmar_chave
        else
            aviso "Sem a confirmação, as cópias de fora continuam saindo SEM criptografia."
        fi
    fi
}

# A chave existe? Se não, nasce — e é mostrada UMA vez, se há alguém no terminal. Pelo timer
# (o journal) ela nunca é impressa: só o recado de ir buscá-la, também no celular.
garantir_chave() {
    [ -s "$CHAVE" ] && return 0
    criar_chave
    if [ -t 1 ]; then
        mostrar_chave
    else
        aviso "Chave nova das cópias de fora criada em $CHAVE."
        aviso "A cifra só liga depois que alguém a vir e confirmar: ./backup.sh --mostrar-chave"
    fi
}

# ------------------------------------------------------------------ listar

listar() {
    titulo "Cópias que existem"
    # A pasta é 700: se quem a criou foi o timer (root), outro usuário nem a enxerga — e
    # "nenhuma cópia" seria mentira.
    if [ -d "$DESTINO" ] && [ ! -r "$DESTINO" ]; then
        erro "A pasta $DESTINO é de outro usuário (o timer roda como root). Use: sudo ./backup.sh --listar"
        exit 1
    fi
    # Pergunta pelos dumps, não pela pasta vazia: a chave do backup mora nela.
    if ! compgen -G "$DESTINO/loja-*.dump" >/dev/null; then
        aviso "Nenhuma ainda. Rode ./backup.sh para fazer a primeira."
        printf '\n'
        return
    fi
    ls -1t "$DESTINO"/loja-*.dump 2>/dev/null | while read -r arq; do
        printf '  %s  %s  %s\n' \
            "$(date -r "$arq" '+%d/%m/%Y %H:%M')" \
            "$(du -h "$arq" | cut -f1 | xargs printf '%6s')" \
            "$arq"
    done
    printf '\n  Para voltar o banco para uma delas: %s./backup.sh --restaurar ARQUIVO%s\n\n' \
        "$FORTE" "$NORMAL"
}

# ------------------------------------------------------------------ copiar

copiar() {
    titulo "Copiando o banco"
    preparar_destino

    local arquivo
    arquivo="$DESTINO/loja-$(date +%Y%m%d-%H%M%S).dump"

    # `-Fc` (formato próprio do Postgres, comprimido): restaura com pg_restore, permite
    # restaurar tabela por tabela e não depende da versão do cliente na máquina.
    if ! dk compose exec -T db pg_dump -U loja -d loja -Fc -f /tmp/backup.dump 2>/dev/null; then
        erro "O pg_dump falhou. O banco está no ar? (docker compose ps)"
        exit 1
    fi
    dk compose cp db:/tmp/backup.dump "$arquivo" >/dev/null 2>&1
    # O `docker cp` traz a permissão de DENTRO do contêiner (644), sem olhar o umask.
    chmod 600 "$arquivo" 2>/dev/null || true
    dk compose exec -T db rm -f /tmp/backup.dump >/dev/null 2>&1 || true

    # Dump que não abre não é backup — e só se descobre isso na hora de restaurar, que é a
    # pior hora possível. Conferir agora custa um segundo.
    if ! command -v pg_restore >/dev/null 2>&1; then
        dk compose cp "$arquivo" db:/tmp/conferir.dump >/dev/null 2>&1
        if ! dk compose exec -T db pg_restore -l /tmp/conferir.dump >/dev/null 2>&1; then
            rm -f "$arquivo"
            erro "A cópia saiu ilegível e foi descartada. Não confie no backup até resolver."
            exit 1
        fi
        dk compose exec -T db rm -f /tmp/conferir.dump >/dev/null 2>&1 || true
    elif ! pg_restore -l "$arquivo" >/dev/null 2>&1; then
        rm -f "$arquivo"
        erro "A cópia saiu ilegível e foi descartada. Não confie no backup até resolver."
        exit 1
    fi

    ok "$arquivo ($(du -h "$arquivo" | cut -f1)) — e ela abre"

    # ------------------------------------------------------ fora do servidor
    if [ -n "$REMOTO" ]; then
        if command -v rclone >/dev/null 2>&1; then
            garantir_chave
            local senha
            if ! cifrar_copias_de_fora; then
                if rclone copy "$arquivo" "$REMOTO" 2>/dev/null; then
                    ok "cópia enviada para $REMOTO"
                    avisar_copia_em_claro
                else
                    erro "NÃO consegui enviar para $REMOTO. A cópia só existe neste servidor."
                    printf '  Teste com: %srclone lsd %s%s\n' "$FORTE" "${REMOTO%%:*}:" "$NORMAL"
                fi
            else
            senha="$(senha_rclone "$(ler_chave)")"
            # Um remote `crypt` por cima do BACKUP_REMOTO, definido só para este comando (por
            # variável de ambiente): a configuração do rclone de quem cuida do servidor não
            # muda, e o que chega lá é `loja-….dump.bin`, que sem a chave não abre.
            if RCLONE_CONFIG_LOJACIFRADO_TYPE=crypt \
                RCLONE_CONFIG_LOJACIFRADO_REMOTE="$REMOTO" \
                RCLONE_CONFIG_LOJACIFRADO_PASSWORD="$senha" \
                RCLONE_CONFIG_LOJACIFRADO_FILENAME_ENCRYPTION=off \
                RCLONE_CONFIG_LOJACIFRADO_DIRECTORY_NAME_ENCRYPTION=false \
                rclone copy "$arquivo" lojacifrado: 2>/dev/null; then
                ok "cópia enviada para $REMOTO, cifrada"
            else
                erro "NÃO consegui enviar para $REMOTO. A cópia só existe neste servidor."
                printf '  Teste com: %srclone lsd %s%s\n' "$FORTE" "${REMOTO%%:*}:" "$NORMAL"
            fi
            fi
        else
            aviso "BACKUP_REMOTO está no .env mas o rclone não está instalado."
            printf '    Instale com: %scurl https://rclone.org/install.sh | sudo bash%s\n' \
                "$FORTE" "$NORMAL"
        fi
    else
        aviso "A cópia só existe NESTE servidor."
        printf '    Se o disco morrer, ela morre junto. Para mandar para fora, ponha no .env:\n'
        printf '      %sBACKUP_REMOTO=gdrive:loja-backups%s   (e configure o rclone)\n' \
            "$FORTE" "$NORMAL"
    fi

    # ------------------------------------------------------ faxina
    local velhos
    velhos="$(find "$DESTINO" -name 'loja-*.dump' -mtime "+$DIAS_PARA_GUARDAR" 2>/dev/null || true)"
    if [ -n "$velhos" ]; then
        printf '%s\n' "$velhos" | xargs -r rm -f
        ok "cópias com mais de $DIAS_PARA_GUARDAR dias apagadas"
    fi
    printf '\n'
}


# ============================================================ backup na nuvem (Drive)
#
# O que muda deste bloco para o `copiar()` de cima: aqui a configuração NÃO vem do `.env`,
# vem do BANCO — da tabela `backup_config`, que o dono preenche na tela do sistema
# (Sistema > Backup). É o que permite ligar o backup sem abrir terminal no servidor.
#
# A credencial do Google fica no banco e é lida AQUI, na máquina. Ela nunca entra no
# contêiner da API, pela mesma razão do token do GitHub no `atualizar.sh`: quem serve a
# loja não precisa da chave que apaga a cópia dela.

# `${HOME:-/root}`: serviço de sistema sem `User=` não recebe $HOME do systemd, e com
# `set -u` esta linha matava o script antes do primeiro pg_dump — o backup das 03:15 e o da
# nuvem falhavam todo dia, com o erro só no journal. Quem roda pelo timer é o root.
CONF_RCLONE="${HOME:-/root}/.config/rclone/loja.conf"

# Lê um campo da configuração direto do Postgres. `-tA` = sem cabeçalho, sem alinhamento.
conf_backup() {
    dk compose exec -T db psql -U loja -d loja -tA \
        -c "SELECT COALESCE($1::text, '') FROM backup_config WHERE id = 1" 2>/dev/null \
        | tr -d '\r' | head -1
}

# Ligado na tela? A pergunta devolve 1/0, e não o boolean em texto: `true::text` no
# Postgres é 'true' — o 't' é só como o psql MOSTRA a coluna crua —, e comparar com "t"
# fazia o backup ligado nunca rodar, sem erro em lugar nenhum.
backup_ligado() {
    [ "$(conf_backup "CASE WHEN ativo THEN 1 ELSE 0 END")" = "1" ]
}

# Escreve de volta como foi. É isto que a tela mostra — sem este retorno, "ligado" e
# "ligado e quebrado" ficariam idênticos na tela, que é o pior jeito de ter backup.
anotar_backup() {  # anotar_backup <ok true|false> <bytes> <copias|NULL> <erro>
    local ok="$1" bytes="${2:-NULL}" copias="${3:-NULL}" erro="${4:-}"
    local erro_sql="NULL"
    [ -n "$erro" ] && erro_sql="'$(printf '%s' "$erro" | sed "s/'/''/g")'"
    dk compose exec -T db psql -U loja -d loja -q -c "
        UPDATE backup_config SET
            ultimo_em = now(), ultimo_ok = $ok,
            ultimo_bytes = $bytes, copias_na_nuvem = $copias,
            ultimo_erro = $erro_sql, updated_at = now()
        WHERE id = 1" >/dev/null 2>&1 || true
}

# Monta o .conf do rclone a partir do token guardado no banco.
#
# `rclone authorize \"drive\"` roda no COMPUTADOR do dono (que tem navegador) e imprime um
# JSON; ele cola esse JSON na tela. O servidor nunca precisa abrir navegador — que é o que
# torna possível configurar backup em VPS pelo sistema.
#
# `loja:` é um remote `crypt` por cima do Drive (`loja-drive:`): o que se grava em
# `loja:pasta/x.dump` chega ao Drive como `pasta/x.dump.bin`, cifrado com a chave desta
# máquina. `filename_encryption = off` deixa o NOME legível — o dono vê as datas no Drive, e
# a rotação por nome continua igual —, e o que importa, o conteúdo, vai cifrado. As cópias
# de antes desta regra (`.dump`, em claro) o crypt não enxerga: ficam lá, legíveis, até o
# dono apagá-las à mão (docs/DEPLOY.md).
preparar_rclone() {
    local token="$1" senha
    garantir_chave
    mkdir -p "$(dirname "$CONF_RCLONE")"
    # 600: é uma credencial que dá acesso de escrita ao Drive da loja, e a senha das cópias.
    # Sem a chave confirmada, `loja:` é só um apelido do Drive: a cópia sai como sempre saiu
    # (ver CHAVE_CONFIRMADA). Confirmada, `loja:` vira o crypt — o resto do script não muda.
    if ! cifrar_copias_de_fora; then
        ( umask 177
          cat > "$CONF_RCLONE" <<FIM
[loja-drive]
type = drive
scope = drive.file
token = $token

[loja]
type = alias
remote = loja-drive:
FIM
        )
        return 0
    fi
    senha="$(senha_rclone "$(ler_chave)")"
    ( umask 177
      cat > "$CONF_RCLONE" <<FIM
[loja-drive]
type = drive
scope = drive.file
token = $token

[loja]
type = crypt
remote = loja-drive:
password = $senha
filename_encryption = off
directory_name_encryption = false
FIM
    )
}

# Apaga as mais velhas até sobrarem `$1`. Devolve quantas ficaram.
#
# A ordenação é por NOME, e é de propósito: o nome carrega a data
# (`loja-AAAAMMDD-HHMMSS.dump`), que é estável. Ordenar por data de modificação do Drive
# entregaria a decisão a um relógio que não é o nosso.
#
# O stdout desta função É a resposta (quem chama faz `$(rotacionar_nuvem ...)`), então o
# recado de cada apagada vai para o stderr. No stdout ele virava parte do número, o UPDATE
# de `copias_na_nuvem` quebrava calado, `ultimo_em` congelava, e o timer passava a copiar
# a cada 5 minutos — com 10 cópias, o Drive guardava só os últimos 50 minutos.
rotacionar_nuvem() {
    local manter="$1" pasta="$2" nomes total sobrando
    nomes="$(rclone --config "$CONF_RCLONE" lsf "loja:$pasta" --include 'loja-*.dump' 2>/dev/null \
        | sort || true)"
    total="$(printf '%s\n' "$nomes" | grep -c . || true)"
    if [ "$total" -gt "$manter" ]; then
        printf '%s\n' "$nomes" | grep . | head -n "$((total - manter))" | while read -r velho; do
            rclone --config "$CONF_RCLONE" deletefile "loja:$pasta/$velho" >/dev/null 2>&1 \
                && printf '  apagada do Drive: %s\n' "$velho" >&2
        done
        sobrando="$manter"
    else
        sobrando="$total"
    fi
    printf '%s' "$sobrando"
}

# Já passou o intervalo configurado desde a última cópia?
#
# É isto que faz o INTERVALO morar na tela e não no systemd. O timer bate de 5 em 5
# minutos e pergunta aqui; quem responde é a tabela. Mudar de 30 para 60 minutos na tela
# passa a valer na hora seguinte, sem `systemctl`, sem SSH, sem reinstalar nada.
esta_na_hora() {
    local intervalo passou
    intervalo="$(conf_backup intervalo_min)"
    [ -n "$intervalo" ] || intervalo=30
    passou="$(dk compose exec -T db psql -U loja -d loja -tA -c "
        SELECT CASE
            WHEN ultimo_em IS NULL THEN 1
            WHEN now() - ultimo_em >= ($intervalo || ' minutes')::interval THEN 1
            ELSE 0 END
        FROM backup_config WHERE id = 1" 2>/dev/null | tr -d '\r' | head -1)"
    [ "$passou" = "1" ]
}

copiar_para_nuvem() {
    titulo "Backup para o Google Drive"

    if ! dk compose exec -T db psql -U loja -d loja -tAc \
            "SELECT 1 FROM backup_config WHERE id = 1" >/dev/null 2>&1; then
        erro "Ainda não há configuração de backup. Ligue em Sistema > Backup, na tela."
        exit 1
    fi

    local token pasta manter
    if ! backup_ligado; then
        aviso "O backup na nuvem está DESLIGADO na tela do sistema. Nada a fazer."
        exit 0
    fi

    token="$(conf_backup rclone_token)"
    pasta="$(conf_backup pasta)"
    manter="$(conf_backup manter)"
    [ -n "$pasta" ] || pasta="backups-loja"
    [ -n "$manter" ] || manter=10

    if [ -z "$token" ]; then
        anotar_backup false NULL NULL "Sem conta do Google conectada."
        erro "Sem token do Google. Conecte a conta em Sistema > Backup."
        exit 1
    fi
    if ! command -v rclone >/dev/null 2>&1; then
        anotar_backup false NULL NULL "O rclone não está instalado neste servidor."
        erro "O rclone não está instalado. Instale com:"
        printf '    %scurl https://rclone.org/install.sh | sudo bash%s\n' "$FORTE" "$NORMAL"
        exit 1
    fi

    preparar_rclone "$token"

    # ---------------------------------------------------------------- o dump
    preparar_destino
    # No disco, prefixo PRÓPRIO (`loja-nuvem-`): é o que deixa a faxina lá embaixo apagar só
    # o que este bloco gerou. Com o mesmo nome do `copiar()`, ela levava junto as cópias
    # diárias (que prometem 14 dias) e o dump de segurança do --restaurar, que nunca sobe
    # para o Drive. No Drive o nome continua `loja-AAAAMMDD-HHMMSS.dump`, o da rotação.
    local carimbo; carimbo="$(date +%Y%m%d-%H%M%S)"
    local arquivo="$DESTINO/loja-nuvem-$carimbo.dump"
    if ! dk compose exec -T db pg_dump -U loja -d loja -Fc -f /tmp/backup.dump 2>/dev/null; then
        anotar_backup false NULL NULL "O pg_dump falhou — o banco respondeu?"
        erro "O pg_dump falhou. O banco está no ar?"
        exit 1
    fi
    dk compose cp db:/tmp/backup.dump "$arquivo" >/dev/null 2>&1
    chmod 600 "$arquivo" 2>/dev/null || true
    dk compose exec -T db rm -f /tmp/backup.dump >/dev/null 2>&1 || true

    # Dump que não abre não é backup, e só se descobre na hora de restaurar — a pior hora.
    dk compose cp "$arquivo" db:/tmp/conferir.dump >/dev/null 2>&1
    if ! dk compose exec -T db pg_restore -l /tmp/conferir.dump >/dev/null 2>&1; then
        rm -f "$arquivo"
        anotar_backup false NULL NULL "A cópia saiu ilegível e foi descartada."
        erro "A cópia saiu ilegível e foi descartada."
        exit 1
    fi
    dk compose exec -T db rm -f /tmp/conferir.dump >/dev/null 2>&1 || true

    local bytes
    bytes="$(stat -c %s "$arquivo" 2>/dev/null || echo 0)"
    ok "cópia gerada ($(du -h "$arquivo" | cut -f1)) — e ela abre"

    # ---------------------------------------------------------------- para o Drive
    if ! rclone --config "$CONF_RCLONE" copyto "$arquivo" "loja:$pasta/loja-$carimbo.dump" \
            2>/tmp/rclone.err; then
        local motivo; motivo="$(tail -2 /tmp/rclone.err 2>/dev/null | tr '\n' ' ')"
        anotar_backup false "$bytes" NULL "Não subiu para o Drive: ${motivo:-erro do rclone}"
        erro "NÃO consegui enviar para o Drive. A cópia só existe neste servidor."
        printf '  %s\n' "$motivo"
        exit 1
    fi
    if cifrar_copias_de_fora; then
        ok "enviada para o Drive, cifrada, em $pasta/"
    else
        ok "enviada para o Drive em $pasta/"
        avisar_copia_em_claro
    fi

    local sobrando; sobrando="$(rotacionar_nuvem "$manter" "$pasta")"
    ok "$sobrando cópias no Drive (o teto é $manter)"

    # No disco local guardamos poucas: o Drive é a cópia que vale, e o disco de um VPS
    # pequeno não pode virar cemitério de dump a cada 30 minutos. Só as `loja-nuvem-*`.
    find "$DESTINO" -name 'loja-nuvem-*.dump' -mmin +720 -delete 2>/dev/null || true

    anotar_backup true "$bytes" "$sobrando" ""
    printf '\n'
}

# ------------------------------------------------------------------ restaurar

# A cópia de fora (`.dump.bin`, baixada do Drive ou do BACKUP_REMOTO) volta a ser um dump
# comum, numa pasta só deste processo. Abre com `abrir_com <chave> <pasta>`: um `crypt` do
# rclone por cima da pasta, com a cópia dentro, e a prova de que saiu um dump do Postgres.
abrir_com() {
    local chave="$1" pasta="$2" senha
    [ -n "$chave" ] || return 1
    senha="$(senha_rclone "$(normalizar_chave "$chave")" 2>/dev/null)" || return 1
    rm -f "$pasta/copia.dump"
    RCLONE_CONFIG_LOJALOCAL_TYPE=crypt \
        RCLONE_CONFIG_LOJALOCAL_REMOTE="$pasta/cifrada" \
        RCLONE_CONFIG_LOJALOCAL_PASSWORD="$senha" \
        RCLONE_CONFIG_LOJALOCAL_FILENAME_ENCRYPTION=off \
        RCLONE_CONFIG_LOJALOCAL_DIRECTORY_NAME_ENCRYPTION=false \
        rclone copyto lojalocal:copia.dump "$pasta/copia.dump" >/dev/null 2>&1 \
        && [ "$(head -c 5 "$pasta/copia.dump" 2>/dev/null)" = "PGDMP" ]
}

# Decifra $ARQUIVO_ALVO para $ARQUIVO_DUMP. A chave, nesta ordem: a CHAVE_DO_BACKUP do
# ambiente (restauração por script), a desta máquina, e — com alguém no terminal — a que o
# dono guardou fora. Numa máquina nova, sem chave, a que abriu passa a ser a dela: as cópias
# seguintes continuam com a chave que o dono já tem guardada.
decifrar() {
    local pasta chave abriu=""
    command -v rclone >/dev/null 2>&1 || {
        erro "Esta cópia é cifrada, e abri-la precisa do rclone. Instale com:"
        printf '    %scurl https://rclone.org/install.sh | sudo bash%s\n\n' "$FORTE" "$NORMAL"
        exit 1
    }
    pasta="$(mktemp -d "${TMPDIR:-/tmp}/loja-restaurar.XXXXXX")"
    PASTA_DECIFRADA="$pasta"
    trap 'rm -rf "$PASTA_DECIFRADA"' EXIT
    mkdir -p "$pasta/cifrada"
    cp "$ARQUIVO_ALVO" "$pasta/cifrada/copia.dump.bin"

    for chave in "${CHAVE_DO_BACKUP:-}" "$(ler_chave)"; do
        if abrir_com "$chave" "$pasta"; then abriu="$chave"; break; fi
    done
    while [ -z "$abriu" ] && [ "$INTERATIVO" -eq 1 ]; do
        printf '  Chave do backup (a que foi guardada fora do servidor; vazio cancela): '
        read -r -s chave </dev/tty || chave=""
        printf '\n'
        [ -n "$chave" ] || { printf '  Cancelado.\n\n'; exit 0; }
        if abrir_com "$chave" "$pasta"; then abriu="$chave"; else aviso "essa chave não abre a cópia."; fi
    done
    if [ -z "$abriu" ]; then
        erro "A cópia é cifrada e nenhuma chave conhecida a abre. Nada foi mexido no banco."
        printf '  Rode sem --sim para digitar a chave, ou passe-a em CHAVE_DO_BACKUP.\n\n'
        exit 1
    fi
    ok "cópia cifrada aberta com a chave"
    if [ ! -s "$CHAVE" ]; then
        preparar_destino
        printf '%s\n' "$(normalizar_chave "$abriu" | sed 's/..../&-/g; s/-$//')" > "$CHAVE"
        chmod 600 "$CHAVE"
        ok "esta máquina passa a usar a mesma chave nas cópias de fora ($CHAVE)"
    fi
    # Quem a digitou e abriu a cópia, a tem guardada fora: é a confirmação que a cifra pede.
    cifrar_copias_de_fora || confirmar_chave
    ARQUIVO_DUMP="$pasta/copia.dump"
}

restaurar() {
    titulo "Restaurar o banco"

    [ -n "$ARQUIVO_ALVO" ] || { erro "Diga qual cópia: ./backup.sh --restaurar ARQUIVO"; exit 1; }
    [ -f "$ARQUIVO_ALVO" ] || { erro "Não achei o arquivo: $ARQUIVO_ALVO"; exit 1; }
    # As cópias são 600, e as do timer são do root: sem isto, o `docker cp` falhava calado e a
    # mensagem seria "a restauração falhou", sem dizer por quê.
    [ -r "$ARQUIVO_ALVO" ] || {
        erro "Sem permissão para ler $ARQUIVO_ALVO (é do root). Use: sudo ./backup.sh --restaurar $ARQUIVO_ALVO"
        exit 1
    }

    printf '  Cópia: %s (%s, de %s)\n' \
        "$ARQUIVO_ALVO" "$(du -h "$ARQUIVO_ALVO" | cut -f1)" \
        "$(date -r "$ARQUIVO_ALVO" '+%d/%m/%Y %H:%M')"

    # Cópia de fora vem cifrada (o crypt do rclone começa com "RCLONE"): abre ANTES de
    # perguntar e de parar a API — chave errada não pode custar a loja fora do ar.
    ARQUIVO_DUMP="$ARQUIVO_ALVO"
    if [ "$(head -c 6 "$ARQUIVO_ALVO" 2>/dev/null)" = "RCLONE" ]; then
        decifrar
    fi
    printf '\n  %sIsto APAGA o banco de agora%s e põe no lugar o daquele momento.\n' \
        "$VERMELHO$FORTE" "$NORMAL"
    printf '  Tudo que foi vendido depois daquela hora se perde.\n'

    if [ "$INTERATIVO" -eq 1 ]; then
        printf '\n  Para confirmar, escreva %sRESTAURAR%s: ' "$FORTE" "$NORMAL"
        read -r resposta </dev/tty || resposta=""
        [ "$resposta" = "RESTAURAR" ] || { printf '  Cancelado.\n\n'; exit 0; }
    fi

    # Uma cópia do estado ATUAL antes de sobrescrever. Restaurar o arquivo errado é o erro
    # mais fácil de cometer aqui, e sem isto ele não teria volta.
    titulo "Guardando o banco de agora, antes de trocar"
    preparar_destino
    local antes
    antes="$DESTINO/loja-antes-de-restaurar-$(date +%Y%m%d-%H%M%S).dump"
    if dk compose exec -T db pg_dump -U loja -d loja -Fc -f /tmp/antes.dump 2>/dev/null \
        && dk compose cp db:/tmp/antes.dump "$antes" >/dev/null 2>&1 \
        && chmod 600 "$antes"; then
        ok "$antes"
    else
        aviso "não consegui guardar o estado atual (o banco está no ar?)"
        if [ "$INTERATIVO" -eq 1 ]; then
            printf '  Continuar mesmo assim, SEM volta? [s/N] '
            read -r r </dev/tty || r="n"
            case "${r:-n}" in [Ss]*) ;; *) printf '  Cancelado.\n\n'; exit 1 ;; esac
        fi
    fi

    # A API fica fora enquanto o banco troca de baixo dela: uma venda gravada no meio da
    # restauração vira registro órfão, e o pg_restore não consegue derrubar tabela em uso.
    titulo "Desligando a API durante a troca"
    dk compose stop api >/dev/null 2>&1 || true
    ok "API parada"

    titulo "Restaurando"
    dk compose cp "$ARQUIVO_DUMP" db:/tmp/restaurar.dump >/dev/null 2>&1
    # O schema inteiro é ZERADO e recriado pelo dump — tudo numa transação só. Era
    # `pg_restore --clean`, que só derruba o que está NO DUMP: uma cópia de antes de uma
    # migration deixava para trás a tabela que ela criou, o alembic_version voltava à
    # revisão velha, e o `alembic upgrade head` do contêiner tentava criá-la de novo
    # (DuplicateTable) — a API não subia mais. Primeiro o dump vira SQL (arquivo ilegível
    # para aqui, sem tocar no banco); depois o psql roda o DROP, o CREATE e o dump com
    # `--single-transaction`: se qualquer linha falhar, o banco continua o de antes.
    # `public` volta como o initdb cria (dono pg_database_owner, USAGE para todos), para
    # restaurar duas vezes dar o mesmo banco.
    local restaurou=0
    if dk compose exec -T db pg_restore --no-owner -f /tmp/restaurar.sql /tmp/restaurar.dump \
        && dk compose exec -T db psql -U loja -d loja -q -v ON_ERROR_STOP=1 --single-transaction \
            -c "SET client_min_messages = warning" \
            -c "DROP SCHEMA public CASCADE" \
            -c "CREATE SCHEMA public AUTHORIZATION pg_database_owner" \
            -c "GRANT USAGE ON SCHEMA public TO PUBLIC" \
            -f /tmp/restaurar.sql >/dev/null; then
        restaurou=1
        ok "banco trocado pelo da cópia"
    else
        erro "A restauração falhou e foi desfeita: o banco continua o de antes."
    fi
    dk compose exec -T db rm -f /tmp/restaurar.dump /tmp/restaurar.sql >/dev/null 2>&1 || true

    # Religa mesmo se falhou: o banco de antes está intacto, e a loja volta com ele.
    titulo "Religando"
    dk compose start api >/dev/null 2>&1 || dk compose up -d api >/dev/null 2>&1

    printf '  aguardando a loja voltar…\n'
    local _
    for _ in $(seq 1 30); do
        if dk compose exec -T api python -c \
            'import urllib.request; urllib.request.urlopen("http://127.0.0.1:8000/health", timeout=3)' \
            >/dev/null 2>&1; then
            if [ "$restaurou" -eq 0 ]; then
                ok "a loja voltou, com o banco de ANTES — nada foi restaurado"
                printf '  Veja o erro acima; o arquivo pode ser de outra versão ou estar ruim.\n\n'
                exit 1
            fi
            ok "a loja voltou, com os dados de $(date -r "$ARQUIVO_ALVO" '+%d/%m/%Y %H:%M')"
            printf '\n  O banco de antes ficou em: %s\n' "${antes:-—}"
            printf '  %sNo balcão:%s Ctrl+F5. %sNo celular:%s feche e abra o app.\n\n' \
                "$FORTE" "$NORMAL" "$FORTE" "$NORMAL"
            return 0
        fi
        sleep 2
    done
    erro "A API não voltou. Veja: docker compose logs --tail 50 api"
    exit 1
}

# ------------------------------------------------------------------ agendar

DIR_SYSTEMD="${DIR_SYSTEMD:-/etc/systemd/system}"
SERVICO="$DIR_SYSTEMD/loja-backup.service"
TIMER="$DIR_SYSTEMD/loja-backup.timer"
PASTA="$(pwd)"

SERVICO_NUVEM="$DIR_SYSTEMD/loja-backup-nuvem.service"
TIMER_NUVEM="$DIR_SYSTEMD/loja-backup-nuvem.timer"

# No Mac não há systemd: quem agenda é o launchd, do usuário (o Docker Desktop roda na
# sessão dele). Se o Mac estava dormindo na hora, o launchd roda quando ele acordar.
PLIST_MAC="${HOME:-/root}/Library/LaunchAgents/br.loja.backup.plist"

# Falhou? O systemd chama a unidade-modelo do notificar.sh (OnFailure=), que avisa o dono —
# antes, a cópia que falhava todo dia só aparecia no journal, e ninguém olha o journal.
gravar_aviso_de_falha() {
    if [ -x ./notificar.sh ]; then
        DIR_SYSTEMD="$DIR_SYSTEMD" ./notificar.sh --instalar \
            || aviso "não consegui gravar o aviso de falha (loja-aviso@)"
    fi
}

ligar_nuvem_automatico() {
    titulo "Ligando o backup automático para o Drive"
    command -v systemctl >/dev/null 2>&1 || { erro "Este servidor não usa systemd."; exit 1; }
    umask 022
    garantir_chave
    gravar_aviso_de_falha

    sudo_se_preciso tee "$SERVICO_NUVEM" >/dev/null <<UNIDADE
[Unit]
Description=Backup do banco da loja para o Google Drive
After=docker.service
OnFailure=loja-aviso@%N.service

[Service]
Type=oneshot
WorkingDirectory=$PASTA
# Sem User=, o systemd não define HOME — e é nele que mora a configuração do rclone.
Environment=HOME=/root
ExecStart=$PASTA/backup.sh --nuvem-timer --sim
TimeoutStartSec=1800
UNIDADE

    # De 5 em 5 minutos, e quem decide se COPIA é a tabela `backup_config` (ver
    # `esta_na_hora`). O timer é só o despertador; o horário mora na tela.
    sudo_se_preciso tee "$TIMER_NUVEM" >/dev/null <<UNIDADE
[Unit]
Description=Confere de 5 em 5 min se esta na hora do backup

[Timer]
OnBootSec=3min
OnUnitActiveSec=5min
# Servidor desligado na hora: copia assim que voltar, em vez de pular a janela.
Persistent=true

[Install]
WantedBy=timers.target
UNIDADE

    if ! sudo_se_preciso systemctl daemon-reload \
        || ! sudo_se_preciso systemctl enable --now loja-backup-nuvem.timer >/dev/null 2>&1; then
        erro "Não consegui ligar o agendamento."
        sudo_se_preciso rm -f "$TIMER_NUVEM" "$SERVICO_NUVEM"
        exit 1
    fi
    ok "ligado — o sistema confere sozinho e copia no intervalo que estiver na tela"
    printf '\n  Configure a conta do Drive em: %sSistema > Backup%s\n' "$FORTE" "$NORMAL"
    printf '  Ver o que aconteceu: %sjournalctl -u loja-backup-nuvem -n 30%s\n\n' "$FORTE" "$NORMAL"
}

ligar_automatico_mac() {
    command -v launchctl >/dev/null 2>&1 || { erro "Não achei o launchctl neste Mac."; exit 1; }
    local hora minuto
    hora=$((10#${HORA%%:*})); minuto=$((10#${HORA#*:}))
    mkdir -p "$(dirname "$PLIST_MAC")"
    preparar_destino
    # PATH explícito: o launchd começa com um PATH mínimo, sem o docker do Docker Desktop
    # (/usr/local/bin) nem o do Homebrew (/opt/homebrew/bin).
    cat > "$PLIST_MAC" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>br.loja.backup</string>
    <key>ProgramArguments</key>
    <array><string>/bin/bash</string><string>$PASTA/backup.sh</string><string>--sim</string></array>
    <key>WorkingDirectory</key><string>$PASTA</string>
    <key>EnvironmentVariables</key>
    <dict><key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
    <key>StartCalendarInterval</key>
    <dict><key>Hour</key><integer>$hora</integer><key>Minute</key><integer>$minuto</integer></dict>
    <key>StandardOutPath</key><string>$PASTA/$DESTINO/backup.log</string>
    <key>StandardErrorPath</key><string>$PASTA/$DESTINO/backup.log</string>
</dict>
</plist>
PLIST
    chmod 644 "$PLIST_MAC"
    launchctl unload "$PLIST_MAC" >/dev/null 2>&1 || true
    if ! launchctl load -w "$PLIST_MAC"; then
        erro "Não consegui ligar o agendamento no launchd."
        rm -f "$PLIST_MAC"
        exit 1
    fi
    ok "todo dia às $HORA, sem comando nenhum (com o Mac dormindo, assim que ele acordar)"
    printf '\n  Ver o que aconteceu: %stail -40 %s/backup.log%s\n' "$FORTE" "$DESTINO" "$NORMAL"
    printf '  Desligar: %s./backup.sh --sem-automatico%s\n\n' "$FORTE" "$NORMAL"
}

ligar_automatico() {
    titulo "Ligando a cópia diária"
    # A chave nasce aqui, com alguém no terminal (o instalador chama isto): é a hora de ela
    # ser mostrada e anotada, antes de a primeira cópia sair cifrada sem ninguém olhando.
    garantir_chave
    if [ "$(uname -s)" = "Darwin" ]; then ligar_automatico_mac; return; fi
    umask 022

    command -v systemctl >/dev/null 2>&1 || { erro "Este servidor não usa systemd."; exit 1; }
    if ! sudo_se_preciso systemctl daemon-reload >/dev/null 2>&1; then
        erro "O systemd não responde neste servidor; não dá para agendar por aqui."
        printf '  Alternativa, no cron do root (%scrontab -e%s):\n\n' "$FORTE" "$NORMAL"
        printf '    %s %s * * * cd %s && ./backup.sh --sim >> /var/log/loja-backup.log 2>&1\n\n' \
            "${HORA#*:}" "${HORA%%:*}" "$PASTA"
        exit 1
    fi
    gravar_aviso_de_falha

    sudo_se_preciso tee "$SERVICO" >/dev/null <<UNIDADE
[Unit]
Description=Copia de seguranca do banco da loja
After=docker.service
OnFailure=loja-aviso@%N.service

[Service]
Type=oneshot
WorkingDirectory=$PASTA
# Sem User=, o systemd não define HOME — e é nele que mora a configuração do rclone.
Environment=HOME=/root
ExecStart=$PASTA/backup.sh --sim
TimeoutStartSec=1800
UNIDADE

    sudo_se_preciso tee "$TIMER" >/dev/null <<UNIDADE
[Unit]
Description=Copia o banco da loja todo dia as $HORA

[Timer]
OnCalendar=*-*-* $HORA:00
# Servidor desligado na hora marcada: copia assim que voltar, em vez de pular o dia.
Persistent=true

[Install]
WantedBy=timers.target
UNIDADE

    if ! sudo_se_preciso systemctl daemon-reload \
        || ! sudo_se_preciso systemctl enable --now loja-backup.timer >/dev/null 2>&1; then
        erro "Não consegui ligar o agendamento."
        sudo_se_preciso rm -f "$TIMER" "$SERVICO"
        exit 1
    fi
    ok "todo dia às $HORA, sem comando nenhum"
    [ -z "$REMOTO" ] && aviso "sem BACKUP_REMOTO no .env, a cópia continua só neste servidor"
    printf '\n  Ver o que aconteceu: %sjournalctl -u loja-backup -n 30%s\n' "$FORTE" "$NORMAL"
    printf '  Desligar: %s./backup.sh --sem-automatico%s\n\n' "$FORTE" "$NORMAL"
}

desligar_automatico() {
    titulo "Desligando a cópia diária"
    if [ "$(uname -s)" = "Darwin" ]; then
        launchctl unload -w "$PLIST_MAC" >/dev/null 2>&1 || true
        rm -f "$PLIST_MAC"
        ok "desligada. O banco só é copiado quando você rodar ./backup.sh"
        printf '\n'
        return
    fi
    sudo_se_preciso systemctl disable --now loja-backup.timer >/dev/null 2>&1 || true
    sudo_se_preciso rm -f "$TIMER" "$SERVICO"
    sudo_se_preciso systemctl daemon-reload >/dev/null 2>&1 || true
    ok "desligada. O banco só é copiado quando você rodar ./backup.sh"
    printf '\n'
}

# ------------------------------------------------------------------ ação

case "$ACAO" in
    copiar)    copiar ;;
    nuvem)     copiar_para_nuvem ;;
    nuvem-timer)
        # Chamado pelo timer. Sai calado quando não é a hora: o journal da máquina não
        # pode virar um log de "ainda não" a cada 5 minutos.
        if ! backup_ligado 2>/dev/null; then exit 0; fi
        if ! esta_na_hora; then exit 0; fi
        copiar_para_nuvem
        ;;
    listar)    listar ;;
    restaurar) restaurar ;;
    mostrar-chave)
        [ -s "$CHAVE" ] || criar_chave
        mostrar_chave
        ;;
    confirmar-chave)
        [ -s "$CHAVE" ] || criar_chave
        INTERATIVO=0 mostrar_chave
        cifrar_copias_de_fora || confirmar_chave
        ;;
    ligar)     ligar_automatico ;;
    nuvem-ligar) ligar_nuvem_automatico ;;
    desligar)  desligar_automatico ;;
esac
