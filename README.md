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

**Um comando.** O instalador pergunta o endereço, os dados do dono e a senha do banco, sobe tudo
em Docker e termina com o sistema **já rodando**.

### O único pré-requisito: Docker

| | |
|---|---|
| **Ubuntu / Linux** | `curl -fsSL https://get.docker.com \| sudo sh`<br>depois `sudo usermod -aG docker $USER` e saia/entre na sessão |
| **Windows / Mac** | [Docker Desktop](https://www.docker.com/products/docker-desktop) — instale e espere o ícone ficar verde |

Python, PostgreSQL e Node **não** precisam ser instalados: tudo roda dentro dos containers.

### Instalar

**Ubuntu / Linux / Mac**

```bash
git clone https://github.com/ghusousa/SISTEMA_GESTAO_LOJA.git
cd SISTEMA_GESTAO_LOJA
./instalar.sh
```

**Windows** (PowerShell)

```powershell
git clone https://github.com/ghusousa/SISTEMA_GESTAO_LOJA.git
cd SISTEMA_GESTAO_LOJA
.\instalar.ps1
```

### O que ele pergunta

```
1. Endereço do sistema
  Domínio (DNS) [localhost]: loja.minhaloja.com.br

2. Dono da loja
  Nome [Dona da Loja]: Dona Maria
  E-mail (é com ele que você entra): dona@minhaloja.com.br
  Senha do dono (mínimo 8 caracteres): ********
  repita a senha: ********

3. Banco de dados
  Gerar uma senha forte automaticamente? [S/n]: S

4. Fuso horário
  Fuso [America/Sao_Paulo]:
```

| Pergunta | Para que serve |
|---|---|
| **Domínio (DNS)** | O endereço da loja. Com um domínio de verdade o **HTTPS é emitido e renovado sozinho**. `localhost` usa só nesta máquina, sem HTTPS. |
| **Nome / E-mail / Senha do dono** | A conta de administrador — a que vê custo, lucro, despesas e relatórios. É com esse e-mail que você entra. |
| **Senha do banco** | Fica só entre os containers; ninguém digita no dia a dia. Deixe gerar. |
| **Fuso horário** | Define o que é "hoje" no caixa e nos relatórios. |

No fim ele imprime o endereço para abrir. **O sistema já está no ar** — não falta nenhum passo.

```
Pronto — o sistema está rodando

  Endereço:  https://loja.minhaloja.com.br/app/
  Modo:      domínio loja.minhaloja.com.br, com HTTPS automático
  Entrar:    dona@minhaloja.com.br
```

### Com domínio: HTTPS sem trabalho

Informando um domínio, o Caddy pede o certificado ao Let's Encrypt e o renova sozinho. Para isso
funcionar, duas coisas precisam estar prontas **antes** de rodar o instalador:

1. O **DNS do domínio aponta para o IP deste servidor** (registro `A`).
2. As **portas 80 e 443 estão abertas** — é por elas que o Let's Encrypt confere que o domínio é
   mesmo seu.

Acompanhe a emissão com `docker compose logs -f proxy`. Sem domínio, o instalador usa HTTP puro e
ajusta o resto sozinho — inclusive o cookie de sessão, que em HTTP não pode ser marcado `Secure`
(seria descartado pelo navegador e ninguém conseguiria continuar logado).

### Sem perguntas (automação)

```bash
./instalar.sh --dominio loja.minhaloja.com.br --nome "Dona Maria" \
    --email dona@minhaloja.com.br --senha "uma-senha-boa" --sim
```

```powershell
.\instalar.ps1 -Dominio loja.minhaloja.com.br -Nome "Dona Maria" `
    -Email dona@minhaloja.com.br -Senha "uma-senha-boa" -Sim
```

Outras opções: `--senha-banco`, `--fuso`, `--porta-http`, `--porta-https`, `--forcar`
(refaz o `.env` do zero). Rodar o instalador de novo é seguro: sem `--forcar`, ele reaproveita a
configuração e só religa o que estiver parado.

### O dia a dia

```bash
docker compose ps            # está no ar?
docker compose logs -f api   # o que está acontecendo
docker compose restart       # reiniciar
docker compose down          # desligar (os dados ficam guardados)
./instalar.sh                # religar
```

O sistema sobe sozinho quando a máquina liga: os containers têm `restart: unless-stopped`. No
Windows, isso depende do Docker Desktop estar marcado para iniciar com o sistema.

### Atualizar

```bash
git pull
./instalar.sh                # reconstrói a imagem; as migrations rodam sozinhas ao subir
```

Faça um backup antes (comando na seção de desinstalação) quando a atualização trouxer migration.

### Dados de demonstração

Para ver o sistema cheio antes de cadastrar o seu, informando a conta de administrador que você
criou na instalação:

```bash
docker compose exec -e SEED_ADMIN_EMAIL=dona@minhaloja.com.br -e SEED_ADMIN_SENHA='sua-senha' \
    api python scripts/seed_demo.py
```

Cria 10 produtos com grade, ~100 vendas espalhadas por 25 dias, despesas e uma vendedora de teste
(`ana@loja.com` / `senha12345`). **Não rode no banco da loja de verdade** — é só para conhecer o
sistema, e a vendedora de teste tem senha pública.

### Usar de outro computador ou do celular

Todos na mesma rede: descubra o IP da máquina (`ip a` no Linux, `ipconfig` no Windows) e abra
`http://SEU_IP/app/`. No Windows, libere a porta uma vez, no PowerShell **como administrador**:

```powershell
New-NetFirewallRule -DisplayName "Sistema da Loja" -Direction Inbound `
    -LocalPort 80 -Protocol TCP -Action Allow -Profile Private
```

> `-Profile Private` de propósito: libera na rede da loja, não em Wi-Fi público.

Para o **app do celular**, aponte o `EXPO_PUBLIC_API_URL` para esse mesmo endereço — instruções em
[docs/DEPLOY.md](docs/DEPLOY.md).

### Rede que inspeciona HTTPS

Em algumas empresas o build quebra com `certificate verify failed`. Não é erro do projeto: o `pip`
dentro do container não conhece o certificado que a rede usa. Coloque-o em
`docker/certificados/` e rode `./instalar.sh --forcar`. Detalhes em
[docker/certificados/LEIA-ME.md](docker/certificados/LEIA-ME.md).

### Desenvolvimento sem Docker

Para mexer no código com recarga automática, dá para rodar a API direto na máquina — precisa de
Python 3.11+ e um PostgreSQL 16. O `api/docker-compose.yml` sobe só o banco de desenvolvimento,
já com o usuário e a senha que o `api/.env.example` espera:

```bash
cd api
docker compose up -d                       # só o Postgres, na porta 5432
python3 -m venv .venv && .venv/bin/pip install -e ".[dev]"
cp .env.example .env                       # ajuste DATABASE_URL e JWT_SECRET
.venv/bin/alembic upgrade head
.venv/bin/python -m app.cli create-admin --nome "Dona" --email d@l.com --senha "senha1234"
.venv/bin/uvicorn app.main:app --reload
```

O sistema web fica em <http://localhost:8000/app/> e a documentação da API em `/docs`.
O app do celular: `cd mobile && npm install && npm start`.

## Desinstalar

```bash
./desinstalar.sh          # Linux/Mac
```
```powershell
.\desinstalar.ps1         # Windows
```

**Ele faz backup do banco antes de apagar qualquer coisa** e só continua depois que você digitar
`APAGAR`. O arquivo `.dump` fica na pasta do projeto — guarde fora da máquina.

| Opção | O que muda |
|---|---|
| *(nenhuma)* | Backup, confirmação, e apaga tudo: containers, banco, fotos e `.env` |
| `--manter-dados` | Só desliga e remove os containers. Os dados ficam; `./instalar.sh` traz tudo de volta |
| `--sem-backup` | Pula o backup (use com consciência) |
| `--apagar-imagens` | Remove também a imagem construída |
| `--sim` | Não pergunta nada (automação) |

No Windows são as mesmas, com traço único: `-ManterDados`, `-SemBackup`, `-ApagarImagens`, `-Sim`.

### Restaurar um backup

Instale de novo e mande o arquivo para dentro do banco:

```bash
./instalar.sh
docker compose exec -T db pg_restore -U loja -d loja --clean < loja-backup-2026-08-22-1438.dump
docker compose restart api
```

```powershell
.\instalar.ps1
cmd /c "docker compose exec -T db pg_restore -U loja -d loja --clean < loja-backup-2026-08-22-1438.dump"
docker compose restart api
```

### Tirar o Docker também

Só se ele entrou na máquina por causa deste projeto:

```bash
sudo apt purge -y docker-ce docker-ce-cli containerd.io && sudo apt autoremove -y
```

No Windows: **Configurações → Aplicativos → Aplicativos instalados → Docker Desktop**.

### Só o app do celular

Desinstale pelo próprio aparelho. Os dados ficam todos no servidor, então tirar o app de um
celular não apaga venda nenhuma.

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
