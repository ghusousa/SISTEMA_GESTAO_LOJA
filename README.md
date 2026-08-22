# Sistema de Gestão de Loja de Roupas

Estoque, PDV, despesas e resultado do mês — bipando o código de barras da peça, no celular ou no
computador do balcão.

- **`api/`** — FastAPI + PostgreSQL. É onde ficam as regras e a verdade dos dados.
- **`web/`** — sistema web completo, servido pela própria API. JavaScript puro, sem build.
- **`mobile/`** — app React Native (Expo) para Android e iOS.
- **`docs/`** — [SPEC.md](docs/SPEC.md) (o que o sistema faz) e [ARQUITETURA.md](docs/ARQUITETURA.md)
  (modelo de dados, contratos e as decisões, com o porquê de cada uma).

**As duas telas fazem o mesmo.** O app existe para andar pela loja com a câmera; o sistema web
existe para o balcão, com leitor USB e teclado — que é onde se digita preço, se lança despesa e se
fecha o caixa. Mesma API, mesmas regras, mesmos papéis.

## O que dá para fazer

| | |
|---|---|
| **Vender** | Bipar a etiqueta, montar o carrinho, dar desconto, receber em dinheiro/PIX/débito/crédito (podendo dividir entre formas) e confirmar. O estoque baixa na mesma transação. Venda comum sai em quatro toques. |
| **Cadastrar peças** | Produto com grade de tamanhos e cores. Cada peça tem seu código de barras: o EAN da etiqueta do fornecedor ou um código interno que o sistema gera — porque muita peça chega sem etiqueta. |
| **Controlar estoque** | Entrada por bipagem contínua, ajuste com motivo, inventário por contagem física e um extrato que explica cada saldo: quem mexeu, quando e por quê. |
| **Controlar despesas** | Aluguel, energia, fornecedores. Contas fixas se repetem para o mês seguinte sem duplicar. |
| **Saber o resultado** | Faturamento, custo das peças vendidas, lucro bruto, despesas e o que sobrou. Mais vendidos, curva de vendas por dia e o que precisa repor. |
| **Fechar o caixa** | Conferir o esperado por forma de pagamento contra o contado. A diferença aparece — não é escondida. |
| **Trabalhar sem celular** | O sistema web faz tudo pelo computador: o leitor USB de balcão digita o código como se fosse teclado, e o PDV entende. `F2` cobra, `F4` desconta, `Esc` limpa. |

**Dois papéis.** O **administrador** vê tudo. O **vendedor** cadastra, consulta estoque e vende, mas
nunca recebe preço de custo, lucro ou despesas — a filtragem acontece no servidor, não escondendo
números na tela.

## Instalação

O sistema tem três partes, e só a primeira é obrigatória:

| Parte | Precisa de | Obrigatória? |
|---|---|---|
| **API + banco** | Python 3.11+ e PostgreSQL 16 | **Sim** — é onde ficam os dados e as regras |
| **Sistema web** | nada, a API já entrega | vem junto |
| **App do celular** | Node 20+ | só se for usar o celular |

Instalando a API, o sistema web já funciona — dá para operar a loja inteira sem instalar mais nada.

> **Para colocar num servidor de verdade** (domínio, HTTPS, backup automático, iniciar sozinho),
> o guia é o [docs/DEPLOY.md](docs/DEPLOY.md). O que está aqui é para instalar na máquina da loja
> ou na sua, para usar ou para desenvolver.

---

### Ubuntu

Escrito para o **24.04 LTS**, que já traz as versões certas. No 22.04 há dois ajustes, marcados
abaixo — ele vem com Python 3.10 e PostgreSQL 14, e o sistema precisa de 3.11+ e 16.

**1. Programas de base**

```bash
sudo apt update
sudo apt install -y python3 python3-venv python3-pip postgresql git
```

<details>
<summary><strong>No Ubuntu 22.04</strong>, use estes comandos no lugar do de cima</summary>

```bash
# Python 3.11 (o 22.04 traz 3.10, e o projeto exige 3.11+)
sudo add-apt-repository -y ppa:deadsnakes/ppa
sudo apt update && sudo apt install -y python3.11 python3.11-venv git

# PostgreSQL 16 pelo repositório oficial (o 22.04 traz o 14).
# A chave vem primeiro, e a linha do repositório aponta para ela com signed-by —
# sem isso o apt recusa o repositório por não saber quem o assinou.
curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
    | sudo gpg --dearmor -o /usr/share/keyrings/pgdg.gpg
sudo sh -c 'echo "deb [signed-by=/usr/share/keyrings/pgdg.gpg] \
    https://apt.postgresql.org/pub/repos/apt jammy-pgdg main" \
    > /etc/apt/sources.list.d/pgdg.list'
sudo apt update && sudo apt install -y postgresql-16
```

Depois, troque `python3` por `python3.11` no passo 3.
</details>

**2. Banco de dados**

```bash
sudo systemctl enable --now postgresql

# Senha do usuário administrador do Postgres e os dois bancos.
sudo -u postgres psql -c "ALTER USER postgres PASSWORD 'postgres';"
sudo -u postgres createdb loja
sudo -u postgres createdb loja_test        # só para rodar os testes
```

Troque `'postgres'` por uma senha sua se a máquina for compartilhada — e use a mesma no passo 3.

**3. O sistema**

```bash
git clone https://github.com/ghusousa/SISTEMA_GESTAO_LOJA.git
cd SISTEMA_GESTAO_LOJA/api

python3 -m venv .venv                      # cria o ambiente isolado do Python
.venv/bin/pip install -e ".[dev]"

cp .env.example .env
```

Abra o `.env` e ajuste duas linhas:

```ini
DATABASE_URL=postgresql+asyncpg://postgres:SUA_SENHA@localhost:5432/loja
JWT_SECRET=cole-aqui-a-chave-gerada-abaixo
```

A chave sai deste comando (é ela que assina os logins — não use a de exemplo):

```bash
.venv/bin/python -c "import secrets; print(secrets.token_urlsafe(48))"
```

**4. Criar o schema e o primeiro administrador**

```bash
.venv/bin/alembic upgrade head

.venv/bin/python -m app.cli create-admin \
    --nome "Dona Maria" --email dona@loja.com --senha "uma-senha-boa"
```

**5. Ligar**

```bash
.venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000
```

Abra **<http://localhost:8000/app/>** e entre com o e-mail e a senha do passo 4.
Para parar, `Ctrl+C` na janela do terminal.

---

### Windows 10 / 11

**1. Programas de base**

Baixe e instale, nesta ordem:

1. **Python 3.12** — <https://www.python.org/downloads/windows/>
   Na primeira tela do instalador, **marque "Add python.exe to PATH"**. Sem isso, nada do resto
   funciona no terminal, e corrigir depois dá mais trabalho do que marcar agora.
2. **PostgreSQL 16** — <https://www.postgresql.org/download/windows/>
   O instalador pede uma senha para o usuário `postgres`. **Anote**: ela vai no `.env` daqui a
   pouco. Pode deixar a porta 5432 e desmarcar o Stack Builder no fim.
3. **Git** — <https://git-scm.com/download/win> (tudo padrão serve).

**2. Banco de dados**

Abra o **PowerShell** e crie os dois bancos (ele pede a senha do passo 1.2 em cada linha):

```powershell
& "$env:ProgramFiles\PostgreSQL\16\bin\createdb.exe" -U postgres loja
& "$env:ProgramFiles\PostgreSQL\16\bin\createdb.exe" -U postgres loja_test
```

> Se aparecer *"não foi possível conectar"*, o serviço não subiu: abra **Serviços**
> (`services.msc`), procure `postgresql-x64-16` e clique em Iniciar.

**3. O sistema**

```powershell
cd $HOME
git clone https://github.com/ghusousa/SISTEMA_GESTAO_LOJA.git
cd SISTEMA_GESTAO_LOJA\api

py -m venv .venv
.venv\Scripts\pip.exe install -e ".[dev]"

Copy-Item .env.example .env
notepad .env
```

No Bloco de Notas que abrir, ajuste duas linhas e salve:

```ini
DATABASE_URL=postgresql+asyncpg://postgres:SUA_SENHA@localhost:5432/loja
JWT_SECRET=cole-aqui-a-chave-gerada-abaixo
```

A chave sai deste comando:

```powershell
.venv\Scripts\python.exe -c "import secrets; print(secrets.token_urlsafe(48))"
```

> Os comandos chamam `.venv\Scripts\...` direto, sem `Activate`. É de propósito: ativar o
> ambiente no PowerShell esbarra na política de execução do Windows e trava o roteiro logo no
> começo. Chamando o executável direto, funciona sem mexer em política nenhuma.

**4. Criar o schema e o primeiro administrador**

```powershell
.venv\Scripts\alembic.exe upgrade head

.venv\Scripts\python.exe -m app.cli create-admin `
    --nome "Dona Maria" --email dona@loja.com --senha "uma-senha-boa"
```

**5. Ligar**

```powershell
.venv\Scripts\uvicorn.exe app.main:app --host 0.0.0.0 --port 8000
```

Abra **<http://localhost:8000/app/>** e entre. Para parar, `Ctrl+C` na janela do PowerShell.

**6. Ligar sozinho quando o computador do balcão iniciar** *(opcional)*

Para a equipe não depender de alguém abrir o PowerShell toda manhã, crie o arquivo
`api\iniciar-loja.bat`:

```bat
@echo off
cd /d "%USERPROFILE%\SISTEMA_GESTAO_LOJA\api"
.venv\Scripts\uvicorn.exe app.main:app --host 0.0.0.0 --port 8000
```

Depois, no **Agendador de Tarefas** → *Criar Tarefa Básica* → disparo **"Ao fazer logon"** →
ação *Iniciar um programa* → aponte para esse `.bat`. Deixe também um atalho do navegador para
`http://localhost:8000/app/` na área de trabalho.

---

### Depois de instalar (nos dois sistemas)

**Conferir se subiu.** `http://localhost:8000/health` tem que responder `{"status":"ok",...}`.
A documentação da API fica em `http://localhost:8000/docs`.

**Usar de outro computador ou do celular na mesma rede.** O `--host 0.0.0.0` já aceita conexão da
rede local; falta descobrir o IP da máquina (`ip a` no Ubuntu, `ipconfig` no Windows) e abrir
`http://SEU_IP:8000/app/` no outro aparelho.

No **Windows**, o Firewall bloqueia isso por padrão. Libere a porta uma vez, no PowerShell **como
administrador**:

```powershell
New-NetFirewallRule -DisplayName "Sistema da Loja" -Direction Inbound `
    -LocalPort 8000 -Protocol TCP -Action Allow -Profile Private
```

> `-Profile Private` de propósito: libera na rede da loja, não em Wi-Fi público.

**Atualizar para uma versão nova.**

```bash
git pull                                   # na pasta do projeto
cd api
.venv/bin/pip install -e ".[dev]"          # Windows: .venv\Scripts\pip.exe
.venv/bin/alembic upgrade head             # Windows: .venv\Scripts\alembic.exe
```

Faça um backup antes (o comando está na seção de desinstalação) sempre que a atualização trouxer
migration.

**Dados de demonstração**, para ver o sistema cheio antes de cadastrar o seu:

```bash
cd api && .venv/bin/python scripts/seed_demo.py
```

Cria produtos, vendas e despesas fictícias, e dois usuários de senha conhecida. **Não rode no banco
da loja de verdade** — é só para conhecer o sistema.

---

### App do celular *(opcional)*

```bash
cd mobile
npm install
npm start                                  # abra no Expo Go, ou npm run android
```

Em desenvolvimento o app descobre sozinho o IP da máquina que roda o Metro e fala com
`http://<ip>:8000`. Para apontar para outro servidor:

```bash
EXPO_PUBLIC_API_URL=https://api.sualoja.com.br npm start
```

O celular e o computador precisam estar na mesma rede — `localhost`, para o celular, é ele mesmo.
Gerar o aplicativo instalável (APK/loja) está em [docs/DEPLOY.md](docs/DEPLOY.md).

---

### Só quer desenvolver? Use Docker para o banco

Evita instalar PostgreSQL na máquina. Substitui o passo 2 dos dois roteiros:

```bash
cd api
docker compose up -d          # Postgres 16 em localhost:5432, com o banco de teste junto
```

O `.env.example` já vem apontado para ele (`postgres:postgres`). Siga do passo 3 em diante.

## Desinstalar

> **Antes de qualquer coisa, salve os dados.** Apagar o banco leva junto o histórico de vendas, o
> estoque e as despesas — não tem desfazer, e ninguém percebe que precisava do backup antes de
> precisar dele.
>
> **Ubuntu:**
> ```bash
> pg_dump -U postgres -Fc loja > ~/loja-backup-$(date +%F).dump
> ```
> **Windows (PowerShell):**
> ```powershell
> & "$env:ProgramFiles\PostgreSQL\16\bin\pg_dump.exe" -U postgres -Fc loja `
>     -f "$HOME\loja-backup-$(Get-Date -Format yyyy-MM-dd).dump"
> ```
> Guarde esse arquivo fora da máquina. Para voltar atrás um dia:
> `pg_restore -U postgres -d loja --clean arquivo.dump`.

### Ubuntu

```bash
# 1. Parar o sistema (Ctrl+C na janela do uvicorn; se virou serviço:)
sudo systemctl disable --now loja-api 2>/dev/null
sudo rm -f /etc/systemd/system/loja-api.service && sudo systemctl daemon-reload

# 2. Apagar os bancos
sudo -u postgres dropdb --if-exists loja
sudo -u postgres dropdb --if-exists loja_test

# 3. Apagar o sistema (o ambiente Python está dentro, sai junto)
rm -rf ~/SISTEMA_GESTAO_LOJA
```

Isso já tira o sistema do ar. Os dois passos abaixo são **opcionais** — só faça se o PostgreSQL e o
Node tiverem entrado na máquina por causa deste projeto:

```bash
# PostgreSQL. O purge apaga os arquivos de TODOS os bancos da máquina, não só os da loja.
sudo apt purge -y postgresql postgresql-* && sudo apt autoremove -y
sudo rm -rf /var/lib/postgresql /etc/postgresql

# Node, se instalou por causa do app
sudo apt purge -y nodejs && sudo apt autoremove -y
```

Se houve deploy de produção, o [docs/DEPLOY.md](docs/DEPLOY.md) lista o que mais existe fora dessa
pasta: bloco do Nginx em `/etc/nginx/sites-available/loja`, certificado do certbot, `/opt/loja` e a
linha do backup no `crontab`.

### Windows

```powershell
# 1. Parar o sistema (Ctrl+C na janela do uvicorn)
#    Se criou a tarefa de iniciar sozinho, remova também:
Unregister-ScheduledTask -TaskName "Sistema da Loja" -Confirm:$false

# 2. Apagar os bancos
& "$env:ProgramFiles\PostgreSQL\16\bin\dropdb.exe" -U postgres loja
& "$env:ProgramFiles\PostgreSQL\16\bin\dropdb.exe" -U postgres loja_test

# 3. Apagar o sistema
Remove-Item -Recurse -Force "$HOME\SISTEMA_GESTAO_LOJA"

# 4. Tirar a regra de firewall, se criou
Remove-NetFirewallRule -DisplayName "Sistema da Loja"
```

Para tirar também os programas de base (**opcional**, e só se entraram por causa deste projeto):
**Configurações → Aplicativos → Aplicativos instalados**, e desinstale *PostgreSQL 16*, *Python* e
*Node.js*. O desinstalador do PostgreSQL costuma **deixar a pasta de dados para trás** — confira
`C:\Program Files\PostgreSQL` e apague à mão se sobrou, depois de conferir que o backup está
guardado.

### Só o app do celular

Desinstale como qualquer aplicativo, pelo próprio aparelho. Se estava usando pelo Expo Go, basta
fechar — nada fica instalado. Os dados ficam todos no servidor, então tirar o app de um celular não
apaga venda nenhuma.

## Testes

```bash
cd api    && .venv/bin/pytest -q            # 106 testes contra Postgres real
cd mobile && npm run typecheck && npm test  # TypeScript + camada de dinheiro
```

Os testes da API rodam contra um Postgres de verdade (`loja_test`), não SQLite: é o que exercita
`CHECK`, índice único parcial, coluna gerada e as corridas de concorrência que só aparecem com o
banco real.

Com a API no ar, o cenário completo de um dia de loja — do cadastro ao fechamento do caixa,
passando por venda com pagamento misto, cancelamento e conferência do resultado — roda com:

```bash
cd api && .venv/bin/python scripts/e2e.py
```

## Deploy

O guia de produção (VPS Ubuntu com systemd, Nginx, SSL, backup e atualização) está em
[docs/DEPLOY.md](docs/DEPLOY.md). Publicação do app nas lojas via EAS Build está no mesmo arquivo.

## Notas que economizam tempo

- **Dinheiro** é `Decimal`/`NUMERIC(14,2)` no servidor, string decimal (`"149.90"`) no fio e
  inteiro de centavos no app. Nunca `float`: `0.1 + 0.2` no caixa é dinheiro errado.
- **O dia do comércio** é o do fuso da loja (`TIMEZONE_LOJA`, padrão `America/Sao_Paulo`), não o do
  servidor. Às 23h de São Paulo o UTC já virou; consultar o caixa pelo dia UTC devolveria vazio.
- **Saldo de estoque** só muda junto com uma movimentação, na mesma transação, e nunca fica
  negativo. Se um número parecer errado, o extrato tem a resposta.
- **Venda e entrada são idempotentes** por `client_uuid`: reenviar depois de um timeout não
  duplica nada. Vale para o app e para qualquer integração futura.
- **Leitor USB é teclado.** O leitor de balcão não tem driver nem API: ele digita os dígitos em
  rajada e aperta Enter. O PDV web ouve o teclado inteiro, então funciona mesmo com o foco perdido
  em um botão — e o mesmo campo aceita o código digitado à mão quando a etiqueta está rasgada.
- **Campo de dinheiro que já vem preenchido é sugestão.** O primeiro dígito depois de focar
  recomeça o número; do segundo em diante, empurra pela direita (estilo caixa registradora).
  Sem isso, digitar `200` sobre um campo mostrando `179,70` daria R$ 17.970,00.
- **No navegador o refresh token fica em cookie `httpOnly`**, nunca em `localStorage`: o access
  token vive só na memória da página e a sessão volta sozinha ao recarregar.
