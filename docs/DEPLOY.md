# Deploy

Como colocar a API no ar num VPS Ubuntu e o app na mão da equipe.

---

> **O caminho curto é o instalador.** Num servidor com Docker, `./instalar.sh` sobe banco, API,
> sistema web e HTTPS automático em um comando — veja [Instalação](../README.md#instalação). Este
> capítulo é a instalação **manual**, sem Docker: útil quando o servidor já tem um PostgreSQL
> compartilhado, quando a hospedagem não permite Docker, ou para entender o que o instalador faz.

## Parte 1 — API em VPS Ubuntu

Serve qualquer VPS pequeno (1 vCPU e 2 GB dão conta de uma loja). O caminho abaixo assume Ubuntu
22.04 ou 24.04 e um domínio já apontando para o IP do servidor.

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
.venv/bin/pip install -e .
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

### 7. Atualizar

`/opt/loja/deploy.sh` (idempotente — rodar duas vezes não quebra nada):

```bash
#!/usr/bin/env bash
set -euo pipefail
cd /opt/loja/app
git pull --ff-only
cd api
.venv/bin/pip install -e . --quiet
.venv/bin/alembic upgrade head

# Sistema web: são arquivos estáticos, o git pull acima já os atualizou. Este rsync só
# existe se o Nginx estiver servindo /app de uma pasta separada (bloco location /app/).
rsync -a --delete /opt/loja/app/web/ /opt/loja/web/

sudo systemctl restart loja-api
sleep 2
curl -fsS http://localhost/health > /dev/null && echo "no ar" || (echo "FALHOU"; exit 1)
```

Faça um backup antes de qualquer atualização que traga migration.

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

## Parte 2 — App nas lojas

### Configuração

O app precisa saber o endereço da API. Em `mobile/.env` (lido pelo Expo no build):

```ini
EXPO_PUBLIC_API_URL=https://api.sualoja.com.br
```

Ajuste também `mobile/app.json`: `expo.name`, `expo.slug`, `ios.bundleIdentifier`,
`android.package` e o `projectId` do EAS.

### Build

```bash
cd mobile
npm install -g eas-cli
eas login
eas build:configure
```

`eas.json` com três perfis — o de `preview` gera um APK que instala direto no celular, sem loja,
que é como a maioria das lojas pequenas começa:

```json
{
  "build": {
    "development": { "developmentClient": true, "distribution": "internal" },
    "preview": {
      "distribution": "internal",
      "android": { "buildType": "apk" },
      "env": { "EXPO_PUBLIC_API_URL": "https://api.sualoja.com.br" }
    },
    "production": {
      "autoIncrement": true,
      "env": { "EXPO_PUBLIC_API_URL": "https://api.sualoja.com.br" }
    }
  }
}
```

```bash
eas build --profile preview  --platform android    # APK para instalar na mão
eas build --profile production --platform android  # AAB para a Play Store
eas submit --platform android
```

Para iOS é preciso conta no Apple Developer Program; o fluxo é o mesmo trocando
`--platform ios`.

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
