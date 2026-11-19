# Deploy

Como colocar a API no ar num VPS Ubuntu e o app na mão da equipe.

---

> **O caminho curto é o instalador.** Num servidor com Docker, `./instalar.sh` sobe banco, API,
> sistema web e HTTPS automático em um comando — veja [Instalação](../README.md#instalação). Este
> capítulo é a instalação **manual**, sem Docker: útil quando o servidor já tem um PostgreSQL
> compartilhado, quando a hospedagem não permite Docker, ou para entender o que o instalador faz.
>
> O que o instalador já entrega e aqui é por sua conta: a **cópia diária ligada** (com a cópia de
> fora **cifrada**), o **vigia** que avisa no celular quando a loja cai, o disco enche ou o backup
> atrasa, a **atualização que só sobe commit de CI verde**, a recusa de instalar pelo **IP
> público** em HTTP puro, a **conferência do DNS** do domínio antes de pedir o certificado e a
> **demonstração em `/demo`** (veja [abaixo](#a-demonstração-em-demo-só-com-o-instalador)) — esta
> não tem caminho manual. Os scripts (`backup.sh`, `vigia.sh`, `notificar.sh`, `atualizar.sh`)
> supõem o Docker; o raciocínio de cada um está no [README](../README.md#backup-automático-todo-dia)
> e no [ARQUITETURA.md](ARQUITETURA.md) (ADR-18, ADR-22, ADR-28 e seguintes).

## Antes de tudo: domínio, não IP

Em servidor com IP **público**, use um domínio e HTTPS — HTTP puro só é aceitável dentro da rede
da loja (`10.…`, `172.16–31.…`, `192.168.…`). Na internet, senha, token e CPF passam em texto
claro, e com `AMBIENTE` diferente de `producao` a API ainda abre o `/docs` e o CORS para qualquer
origem. Sem domínio próprio, `SEU.IP.sslip.io` (gratuito) aponta para o IP e o certificado sai do
mesmo jeito. O `./instalar.sh` recusa o IP público pelo mesmo motivo.

## A demonstração em /demo (só com o instalador)

O `./instalar.sh` sobe, ao lado da loja, uma **segunda loja só com dados fictícios** em
`https://<domínio>/demo`, com a conta de dono pronta (`dono@demo.example`, senha sorteada): é a
que a revisão da App Store usa, e a que se mostra a quem quer conhecer o sistema. Ela não tem
caminho manual: depende do compose — o serviço `demo-banco` cria no MESMO Postgres um banco e um
usuário próprios (`loja_demo`, sem acesso nenhum ao banco da loja), a `api-demo` é a mesma imagem
com outro banco, outro segredo de login e outras fotos, e o proxy manda `/demo/*` para ela. O porquê
de cada separação está na ADR-46 de [ARQUITETURA.md](ARQUITETURA.md).

- **DNS: um registro só.** A demonstração mora no mesmo domínio da loja, então não pede registro
  nem certificado a mais. O instalador confere o DNS **antes** de subir — o Let's Encrypt limita as
  tentativas que falham — e, se faltar, mostra o registro exato para o painel do domínio:

  ```
  ! Crie no painel do domínio:   Tipo A  ·  Nome loja — o registro completo é loja.minhaloja.com.br  ·  Valor 203.0.113.10
  ```

  (no campo Nome, só o `loja`, ou `@`; o nome completo é para conferir — no `.br` o domínio
  registrado sempre leva a categoria, `minhaloja.com.br`, `minhaloja.tec.br`...) e manda apagar um
  **AAAA** que leve a outra máquina (o Let's Encrypt tenta o IPv6 primeiro). Pergunta ao DNS
  (`getent -A -s dns`), não ao `/etc/hosts` da máquina, e vê o AAAA mesmo sem IPv6 nela; com um
  `getent` antigo, sem o `-A`, diz que o AAAA não foi conferido. No
  terminal, ele espera conferindo a cada 15 s (Enter segue sem esperar); com `--sim`, não espera e
  repete a pendência no resumo do fim.
- **O endereço.** A loja fica em `https://<domínio>/app/` e a demonstração em
  `https://<domínio>/demo` — no navegador e no app (o endereço do servidor no app é o da loja com o
  `/demo` no fim). Numa instalação local, `http://localhost/demo`, só para testar na rede: a Apple
  só alcança https.
- **A senha.** O resumo da instalação mostra a senha da conta da demonstração uma vez, quando ela
  nasce; depois, `./demo.sh --mostrar` mostra endereço, conta, senha e o que levar ao GitHub para a
  revisão da Apple.
- **Memória.** A demonstração é uma segunda API no servidor, com teto de **512 MB**
  (`DEMO_MEMORIA` no `.env`): numa máquina apertada ela é a primeira a ceder, nunca a loja. Conte
  com essa memória a mais; numa VPS pequena demais para as duas, instale com `--sem-demo` (e ligue
  depois com `./demo.sh --ligar`, se a máquina crescer).
- **Todo dia, de novo.** Às 04:30 (no fuso da loja) os dados da demonstração voltam ao começo, com
  as datas de hoje (`./demo.sh --renovar` faz o mesmo na hora). Ela não entra no backup da loja e
  nunca derruba a loja: se não subir na instalação ou na atualização, só avisa.

## Parte 1 — API em VPS Ubuntu

Serve qualquer VPS pequeno (1 vCPU e 2 GB dão conta de uma loja; a demonstração do instalador
soma uma segunda API, de até 512 MB). O caminho abaixo assume Ubuntu 22.04 ou 24.04 e um domínio
já apontando para o IP do servidor.

### 1. Servidor e acesso

```bash
adduser loja && usermod -aG sudo loja
# na sua máquina: ssh-copy-id loja@SEU_IP
```

Depois, em `/etc/ssh/sshd_config`: `PasswordAuthentication no` e `PermitRootLogin no`,
seguido de `systemctl restart ssh`.

```bash
sudo apt update && sudo apt install -y ufw fail2ban nginx postgresql python3-venv git
sudo ufw allow OpenSSH && sudo ufw allow 'Nginx Full' && sudo ufw enable
sudo systemctl enable --now fail2ban
```

O firewall não abre a porta do Postgres: o banco só é acessado pela própria máquina.

### 2. Banco

```bash
sudo -u postgres psql
```
```sql
CREATE USER loja WITH PASSWORD 'gere-uma-senha-forte-aqui';
CREATE DATABASE loja OWNER loja;
\q
```

### 3. Aplicação

```bash
sudo mkdir -p /opt/loja && sudo chown loja:loja /opt/loja
git clone SEU_REPOSITORIO /opt/loja/app
cd /opt/loja/app/api
python3 -m venv .venv
# Versões EXATAS da trava (as que o CI testou), e só então o projeto, sem resolver nada de novo.
.venv/bin/pip install -r requirements.lock
.venv/bin/pip install -e . --no-deps
```

`/opt/loja/app/api/.env` (permissão `600`, nunca versionado):

```ini
AMBIENTE=producao
DEBUG=false
DATABASE_URL=postgresql+asyncpg://loja:SENHA_DO_BANCO@localhost:5432/loja
JWT_SECRET=COLE_AQUI_O_SEGREDO_GERADO
ACCESS_TOKEN_EXPIRE_MINUTES=30
REFRESH_TOKEN_EXPIRE_DAYS=30
CORS_ORIGINS=https://api.sualoja.com.br
TIMEZONE_LOJA=America/Sao_Paulo
MEDIA_DIR=/opt/loja/media
```

```bash
chmod 600 .env
python3 -c "import secrets; print(secrets.token_urlsafe(48))"   # o JWT_SECRET
```

Se o `JWT_SECRET` mudar, todo mundo é deslogado. Guarde-o junto com a senha do banco.

```bash
.venv/bin/alembic upgrade head
.venv/bin/python -m app.cli create-admin --nome "Dona Maria" --email dona@loja.com --senha "..."
```

### 4. systemd

`/etc/systemd/system/loja-api.service`:

```ini
[Unit]
Description=API de gestão da loja
After=network.target postgresql.service
Requires=postgresql.service

[Service]
Type=notify
User=loja
Group=www-data
WorkingDirectory=/opt/loja/app/api
EnvironmentFile=/opt/loja/app/api/.env
ExecStart=/opt/loja/app/api/.venv/bin/uvicorn app.main:app \
    --uds /run/loja/api.sock --proxy-headers --forwarded-allow-ips='*'
RuntimeDirectory=loja
Restart=always
RestartSec=3

# Endurecimento: o processo enxerga o mínimo do sistema
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/loja/media

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now loja-api
sudo systemctl status loja-api
```

O socket Unix evita expor uma porta TCP: só o Nginx alcança a aplicação.

### 5. Nginx e SSL

`/etc/nginx/sites-available/loja`:

```nginx
server {
    listen 80;
    server_name api.sualoja.com.br;

    client_max_body_size 6M;          # fotos de produto
    gzip on;
    gzip_types application/json application/javascript text/css text/html;

    location / {
        proxy_pass http://unix:/run/loja/api.sock;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Fotos servidas direto do disco, sem passar pela aplicação.
    location /media/ {
        alias /opt/loja/media/;
        expires 30d;
        access_log off;
    }

    # Sistema web direto do disco. A API já serve esta mesma pasta em /app — isto só tira
    # do Python o trabalho de entregar arquivo estático. Se remover este bloco, continua
    # funcionando pelo proxy.
    location /app/ {
        alias /opt/loja/web/;
        try_files $uri $uri/ /app/index.html;   # rota por hash: tudo cai no index
        expires 1h;
    }
}
```

Depois de subir, abra `https://api.sualoja.com.br/app/` — é o endereço que fica no atalho da área
de trabalho do computador do balcão.

```bash
sudo ln -s /etc/nginx/sites-available/loja /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx

sudo snap install --classic certbot && sudo ln -sf /snap/bin/certbot /usr/bin/certbot
sudo certbot --nginx -d api.sualoja.com.br      # renovação automática já vem junto
```

Confira: `curl https://api.sualoja.com.br/health` deve responder `{"status":"ok",...}`.

### 6. Backup

Perder o banco é perder o histórico de vendas e o controle de estoque. `/opt/loja/backup.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
DESTINO=/opt/loja/backups
mkdir -p "$DESTINO"
ARQUIVO="$DESTINO/loja-$(date +%F-%H%M).sql.gz"

sudo -u postgres pg_dump loja | gzip > "$ARQUIVO"
find "$DESTINO" -name 'loja-*.sql.gz' -mtime +14 -delete

# Cópia fora do servidor — backup que só existe na mesma máquina não é backup.
# rclone copy "$ARQUIVO" remoto:backups-loja/
```

```bash
chmod +x /opt/loja/backup.sh
sudo crontab -e
# 15 3 * * *  /opt/loja/backup.sh >> /var/log/loja-backup.log 2>&1
```

Teste a restauração pelo menos uma vez: `gunzip -c arquivo.sql.gz | psql -d loja_restore`.

Dois cuidados que o `./backup.sh` do instalador já toma e este script, não:

- **A cópia local é o banco inteiro** (CPF, telefones, hashes de senha): ponha `umask 077` no
  começo do script e `chmod 700` na pasta, para nenhum outro usuário da máquina lê-la.
- **A cópia de fora tem de sair cifrada.** Com o rclone, crie um remote `crypt` por cima do
  destino (`rclone config` → *crypt*, `filename_encryption = off`) e copie para ele; guarde a
  senha **fora do servidor** — sem ela a cópia não abre. Quem já mandava em claro: as cópias
  antigas continuam legíveis no destino até serem apagadas à mão.

### 7. Atualizar

`/opt/loja/deploy.sh` (idempotente — rodar duas vezes não quebra nada):

```bash
#!/usr/bin/env bash
set -euo pipefail
cd /opt/loja/app
git pull --ff-only
cd api
.venv/bin/pip install -q -r requirements.lock && .venv/bin/pip install -q -e . --no-deps
.venv/bin/alembic upgrade head

# Sistema web: são arquivos estáticos, o git pull acima já os atualizou. Este rsync só
# existe se o Nginx estiver servindo /app de uma pasta separada (bloco location /app/).
rsync -a --delete /opt/loja/app/web/ /opt/loja/web/

sudo systemctl restart loja-api
sleep 2
curl -fsS http://localhost/health > /dev/null && echo "no ar" || (echo "FALHOU"; exit 1)
```

Faça um backup antes de qualquer atualização que traga migration, e só implante commit com o
CI verde no GitHub — é o que o `./atualizar.sh` do instalador confere sozinho antes de mexer.

---

## Parte 1b — O computador do balcão

Não há instalação: o sistema web é uma página. O que precisa de cuidado é o resto do balcão.

1. **Atalho na área de trabalho** apontando para `https://api.sualoja.com.br/app/`. No Chrome,
   *Mais ferramentas → Criar atalho → Abrir como janela* deixa o PDV em tela cheia, sem barra de
   endereço para alguém digitar errado no meio do atendimento.
2. **Leitor de código de barras USB.** Compre um leitor "keyboard wedge" (é o padrão; os de balcão
   quase todos são). Ele não precisa de driver: liga na USB e digita. Duas conferências antes de
   entregar para a equipe:
   - **Sufixo Enter ligado.** É o que fecha a leitura. Quase todo leitor vem assim de fábrica; se
     não vier, o manual traz um código de barras de configuração para ativar.
   - **Layout do teclado.** Se o leitor estiver configurado como teclado americano e o Windows como
     ABNT2 (ou vice-versa), os dígitos ainda saem certos, mas conferir uma etiqueta com letras
     evita surpresa. Teste no Bloco de Notas antes de testar no sistema.
3. **Teste de aceitação, com a loja aberta ainda não.** Abra o PDV, **não clique em nada** e bipe
   uma etiqueta: a peça tem que entrar sozinha. Esse é o comportamento que a equipe vai usar o dia
   inteiro — se só funcionar clicando no campo antes, algo está errado.
4. **Impressora de recibo**, se houver: o botão "Imprimir recibo" abre uma janela e chama a
   impressão do navegador. Deixe a impressora como padrão do sistema. Não é documento fiscal.

## Parte 2 — App no celular dos vendedores

Cada vendedor tem o próprio login (papel VENDEDOR) e usa o celular como leitor: aponta a câmera
para a etiqueta, vê o preço e fecha a venda. Custo, lucro, despesas e relatórios continuam só com
o ADMIN — quem corta é o servidor.

### Um instalador serve para todos

O endereço do servidor **não** é fixado na hora de compilar: fica gravado no aparelho e se
edita pela engrenagem do login. Isso muda a operação inteira:

- o mesmo arquivo `.apk` vai para todos os celulares, sem gerar um por loja;
- se o servidor mudar de IP, ninguém reinstala nada — é só "Mais → Conectado em…", ou a
  engrenagem do login, e informar o novo endereço;
- o vendedor faz isso uma vez; depois é só e-mail e senha.

Se quiser adiantar o preenchimento, defina `EXPO_PUBLIC_API_URL` no build: o endereço aparece já
sugerido na tela, e a pessoa só confirma.

> **Servidor sem HTTPS.** O `app.json` libera tráfego `http://` no Android (plugin
> `expo-build-properties`, chave `usesCleartextTraffic`) e, no iOS, **só na rede local**
> (`NSAllowsLocalNetworking`): é o que faz o app conseguir falar com `http://192.168.0.10` ou um
> nome `.local`. Endereço na internet tem de ser `https://` — o iPhone recusa o resto, inclusive a
> demonstração em `/demo` (por isso, sem esquema, o app põe `https://` num nome de domínio e
> `http://` só em IP, `localhost` e nomes `.local`). Quando você apontar um domínio para o servidor, o instalador
> emite o certificado sozinho e passa a valer `https://` — aí vale tirar a permissão do Android e
> gerar um build novo, porque em HTTP a senha do vendedor trafega em texto claro na rede.

### Gerar o APK

O build acontece na nuvem da Expo: não é preciso instalar Android Studio nem SDK.

```bash
cd mobile
npm install
npm install -g eas-cli
eas login                      # conta gratuita em expo.dev
eas build --profile preview --platform android
```

Ao final, o EAS devolve um link para baixar o `.apk`. O `eas.json` do projeto já vem com o perfil
`preview` configurado para APK — que instala direto no celular, sem passar por loja, e é como a
maioria das lojas pequenas começa.

Antes do primeiro build, ajuste em `mobile/app.json` o que identifica o seu app:
`expo.name`, `expo.slug`, `android.package`, `ios.bundleIdentifier` e o `extra.eas.projectId`
(o `eas build` preenche o projectId sozinho na primeira vez).

### Instalar no celular do vendedor

1. Mande o `.apk` para o aparelho (WhatsApp, link, cabo — tanto faz).
2. Abra o arquivo. O Android vai avisar que é de "fonte desconhecida": autorize só desta vez.
3. O app abre no login. Se o endereço do servidor ainda não estiver gravado, o rodapé avisa:
   toque na **engrenagem** no canto superior direito e informe o mesmo endereço que aparece no
   navegador do computador do balcão — pode colar inteiro, o app aproveita só o que interessa
   (a barra do navegador da demonstração mostra `/demo/app/...`: o app guarda o `/demo`).
   Definindo `EXPO_PUBLIC_API_URL` no build, ele já vem preenchido e ninguém digita nada.
4. O vendedor entra com o e-mail e a senha que você criou em **Usuários**.
5. Na primeira leitura o Android pede permissão de câmera. Autorize.

### iPhone

Precisa de conta paga no Apple Developer Program (US$ 99/ano) e o fluxo é o mesmo trocando
`--platform ios`. Não existe atalho gratuito equivalente ao `.apk`: a Apple não deixa instalar
app fora da App Store ou do TestFlight, e o TestFlight também exige a mesma conta paga.

O **Expo Go** não substitui isso no dia a dia — ele só abre um projeto enquanto o servidor de
desenvolvimento estiver no ar, num computador ligado. Serve para testar, não para vender.

Como o sistema web funciona no navegador do celular, um iPhone sem app ainda consegue vender
abrindo o endereço da loja no Safari — e dá para "Adicionar à Tela de Início", que deixa um
ícone igual ao de um app. O que se perde é a leitura pela câmera: no Safari a venda começa
digitando o código da etiqueta.

### Equipe com Android e iPhone misturados

É o caso mais comum, e a divisão fica assim:

| Aparelho | Como o vendedor usa | Custo |
|---|---|---|
| **Android** | `.apk` gerado pelo `eas build --profile preview`, instalado direto | grátis |
| **iPhone**, com conta Apple | build `--platform ios` distribuído por TestFlight | US$ 99/ano |
| **iPhone**, sem conta Apple | sistema web no Safari, com ícone na tela de início | grátis |

Vale começar pelo Android — que costuma ser a maioria — e deixar os iPhones no Safari. O login,
os papéis e os dados são os mesmos nos três caminhos: quem separa o que cada um vê é o servidor,
não o aparelho. Se depois o volume justificar, a conta da Apple entra sem mexer no código.

### Antes de entregar para a equipe

- [ ] `https://api.sualoja.com.br/health` responde e o certificado está válido
- [ ] Login funciona com o admin criado pelo CLI
- [ ] Bipar uma etiqueta encontra a peça (teste com uma peça real, na luz da loja)
- [ ] Uma venda de teste baixa o estoque; cancelá-la devolve
- [ ] Criar o usuário de cada vendedor e conferir que ele **não** vê a aba Financeiro
- [ ] Backup rodou e o arquivo existe fora do servidor

### Manutenção

- Logs da API: `journalctl -u loja-api -f`
- Reiniciar: `sudo systemctl restart loja-api`
- Espaço em disco (fotos e backups crescem): `df -h /`
- Atualização de JS sem passar pela loja: `eas update` (configure `expo-updates` antes)
