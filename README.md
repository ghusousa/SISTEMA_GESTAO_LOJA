# Sistema de Gestão de Loja de Roupas

Estoque, PDV, despesas e resultado do mês — pelo celular, bipando o código de barras da peça.

- **`api/`** — FastAPI + PostgreSQL. É onde ficam as regras e a verdade dos dados.
- **`mobile/`** — app React Native (Expo) para Android e iOS.
- **`docs/`** — [SPEC.md](docs/SPEC.md) (o que o sistema faz) e [ARQUITETURA.md](docs/ARQUITETURA.md)
  (modelo de dados, contratos e as decisões, com o porquê de cada uma).

## O que dá para fazer

| | |
|---|---|
| **Vender** | Bipar a etiqueta, montar o carrinho, dar desconto, receber em dinheiro/PIX/débito/crédito (podendo dividir entre formas) e confirmar. O estoque baixa na mesma transação. Venda comum sai em quatro toques. |
| **Cadastrar peças** | Produto com grade de tamanhos e cores. Cada peça tem seu código de barras: o EAN da etiqueta do fornecedor ou um código interno que o sistema gera — porque muita peça chega sem etiqueta. |
| **Controlar estoque** | Entrada por bipagem contínua, ajuste com motivo, inventário por contagem física e um extrato que explica cada saldo: quem mexeu, quando e por quê. |
| **Controlar despesas** | Aluguel, energia, fornecedores. Contas fixas se repetem para o mês seguinte sem duplicar. |
| **Saber o resultado** | Faturamento, custo das peças vendidas, lucro bruto, despesas e o que sobrou. Mais vendidos, curva de vendas por dia e o que precisa repor. |
| **Fechar o caixa** | Conferir o esperado por forma de pagamento contra o contado. A diferença aparece — não é escondida. |

**Dois papéis.** O **administrador** vê tudo. O **vendedor** cadastra, consulta estoque e vende, mas
nunca recebe preço de custo, lucro ou despesas — a filtragem acontece no servidor, não escondendo
números na tela.

## Rodando em desenvolvimento

### 1. Banco

```bash
cd api
docker compose up -d          # Postgres 16 em localhost:5432, com o banco de teste junto
```

Sem Docker, sirva um Postgres 16 e crie os bancos `loja` e `loja_test`.

### 2. API

```bash
cd api
python3 -m venv .venv
.venv/bin/pip install -e ".[dev]"
cp .env.example .env                       # ajuste DATABASE_URL e JWT_SECRET

.venv/bin/alembic upgrade head             # cria o schema
.venv/bin/python -m app.cli create-admin \
    --nome "Dona Maria" --email dona@loja.com --senha "uma-senha-boa"

.venv/bin/uvicorn app.main:app --reload --host 0.0.0.0
```

A documentação interativa fica em `http://localhost:8000/docs`.

> O primeiro administrador vem pelo CLI porque criar usuário exige um admin autenticado — sem
> isso, uma instalação nova não teria por onde entrar.

### 3. App

```bash
cd mobile
npm install
npm start                                  # abra no Expo Go, ou npm run android
```

Em desenvolvimento o app descobre sozinho o IP da máquina que roda o Metro e fala com
`http://<ip>:8000`. Para apontar para outro servidor, defina `EXPO_PUBLIC_API_URL`:

```bash
EXPO_PUBLIC_API_URL=https://api.sualoja.com.br npm start
```

O celular e o computador precisam estar na mesma rede — `localhost`, para o celular, é ele mesmo.

## Testes

```bash
cd api    && .venv/bin/pytest -q            # 96 testes contra Postgres real
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
