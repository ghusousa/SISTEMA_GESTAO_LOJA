# ARQUITETURA — Sistema de Gestão de Loja de Roupas (v1)

Documento de referência: modelo de dados, contratos de API e decisões. **É a verdade do projeto** —
se o código divergir, um dos dois está errado e o doc é atualizado no mesmo commit.

---

## 1. Visão geral

```
mobile/ (Expo, React Native)  ──HTTPS──▶  api/ (FastAPI)  ──asyncpg──▶  PostgreSQL 16
```

Monolito modular. Cada módulo em `api/app/modules/<dominio>/`:

| arquivo | responsabilidade |
|---|---|
| `router.py` | HTTP: rotas, status codes, dependências de papel. Só aqui existe `HTTPException`. |
| `service.py` | Casos de uso e regras de negócio. Lança exceções de domínio (`AppError`). |
| `repository.py` | Persistência: SQL/ORM. Sem regra de negócio. |
| `models.py` | Entidades SQLAlchemy. |
| `schemas.py` | DTOs Pydantic de entrada e saída. |

**Regra de dependência**: `router → service → repository`. Um módulo nunca importa o `repository` de
outro; usa o `service` público. Exceção documentada: `relatorios` e `caixa` são leitura analítica
(CQRS-lite) e consultam as tabelas diretamente por SQL read-only próprio — nunca escrevem fora do seu
domínio.

Módulos e ordem de implementação (dependências primeiro):
`core` → `auth` → `usuarios` → `catalogo` → `estoque` → `vendas` → `despesas` → `caixa` → `relatorios`

`app/core/`: `config.py` (pydantic-settings), `db.py` (engine async + naming convention),
`url_do_banco.py` (a URL do Neon em formato asyncpg, ADR-42), `security.py` (bcrypt + JWT),
`exceptions.py` (AppError + handler), `pagination.py`, `deps.py`.

Três formas de rodar o mesmo código: a **loja** (Docker + Caddy na máquina dela, a de
verdade); a **demonstração que sobe com ela**, no mesmo domínio, em `<domínio>/demo` — outra
API, outro banco, outra conta, só dados fictícios, ligada por `COMPOSE_PROFILES=demo` no `.env`
(ADR-46); e a **Vercel** (demonstração, Neon como banco), ligada só por variáveis que a Vercel
põe — sem elas nada muda (ADR-42).

```
navegador / app ──HTTPS──▶ proxy (Caddy) ─┬─ /demo/*  ──▶ api-demo ──▶ banco loja_demo (role loja_demo)
                                          └─ o resto  ──▶ api      ──▶ banco loja      (o mesmo Postgres)
```

---

## 2. Modelo de dados

Convenções: PK `BIGINT GENERATED ALWAYS AS IDENTITY`; dinheiro `NUMERIC(14,2)`; datas/hora
`TIMESTAMPTZ` em UTC; enums como `VARCHAR + CHECK` (migração de valor é um `ALTER CHECK`, não um
`ALTER TYPE`); soft delete via `deleted_at` + índice UNIQUE parcial; naming convention no `MetaData`
(`pk_`, `fk_`, `uq_`, `ck_`, `ix_`) para migrations determinísticas.

### 2.1 Autenticação

```sql
users(id, name, email UNIQUE, password_hash,
      role CHECK(role IN ('ADMIN','GERENTE','SUPERVISORA','VENDEDOR')),
      is_active BOOL DEFAULT TRUE,
      comissao_percentual NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (0 <= x <= 100),
      meta_diaria NUMERIC(14,2) NULL CHECK (meta_diaria > 0),   -- ADR-37
      deleted_at TIMESTAMPTZ NULL,       -- conta excluída que segura histórico (ADR-45)
      created_at, updated_at)
  CHECK (deleted_at IS NULL OR NOT is_active)   -- excluída nunca volta a entrar

refresh_tokens(jti UUID PK, user_id FK→users, family_id UUID NOT NULL,
               expires_at, revoked BOOL DEFAULT FALSE, created_at)
  ix_refresh_tokens_user_id, ix_refresh_tokens_family_id, ix_refresh_tokens_expires_at
```

E-mail é UNIQUE total; desativar usuário é `is_active = false`, não delete — preserva a autoria
das vendas e se desfaz. **Excluir** (pelo dono ou pela própria pessoa, ADR-45) é outra coisa:
sem histórico, a linha sai inteira; com histórico (venda, caixa, estoque — FKs RESTRICT), fica só
com nome e papel, `deleted_at` preenchido, `is_active = false`, senha que nenhuma senha confere e
e-mail trocado por `conta-excluida-<id>@excluida.example` — o e-mail de verdade fica livre para
uma conta nova. Excluída não sai em `GET /usuarios` e é 404 para editar, redefinir senha ou
excluir de novo.

### 2.2 Catálogo

```sql
categories(id, name, deleted_at, created_at)
  uq_categories_name_active UNIQUE (lower(name)) WHERE deleted_at IS NULL

products(id, category_id FK→categories RESTRICT, name, description, photo_url,
         ncm CHECK ~ '^[0-9]{8}$', cest CHECK ~ '^[0-9]{7}$',            -- ADR-41, opcionais
         origem SMALLINT DEFAULT 0 CHECK 0..8, cfop DEFAULT '5102' CHECK ~ '^[0-9]{4}$',
         deleted_at, created_at, updated_at)
  ix_products_category_id, ix_products_name_lower
  ix_products_nome_achatado GIN (translate(lower(name), <acentos>) gin_trgm_ops)   -- ADR-31

product_variants(id, product_id FK→products RESTRICT, size, color,
                 barcode, barcode_type CHECK IN ('EAN','INTERNO'),
                 cost_price NUMERIC(14,2) CHECK >= 0,
                 sale_price NUMERIC(14,2) CHECK > 0,
                 min_stock INT CHECK >= 0, deleted_at, created_at, updated_at)
  uq_product_variants_barcode_active UNIQUE (barcode) WHERE deleted_at IS NULL
  uq_product_variants_combo_active  UNIQUE (product_id, size, color) WHERE deleted_at IS NULL
  ix_product_variants_product_id
  ix_product_variants_cor_achatada GIN (translate(lower(color), <acentos>) gin_trgm_ops)

SEQUENCE internal_barcode_seq   -- alimenta o código interno
```

**Código interno**: para peça sem etiqueta, o service gera um EAN-13 válido com prefixo `2`
(faixa reservada a uso interno/restrito): `'2' + seq.zfill(11)` → dígito verificador EAN-13 → 13
dígitos. Fica indistinguível de um EAN para o leitor, e `barcode_type='INTERNO'` registra a origem.

#### Fotos no Vercel Blob (ADR-42)

Onde a foto da peça mora é decisão do AMBIENTE, em `catalogo/fotos.py`; a tela, o banco e o
contrato de `PUT /produtos/{id}/foto` são os mesmos em todos os casos.

- **Disco** (padrão, a loja de sempre): `MEDIA_DIR/produtos/<id>-<uuid4>.<ext>`, servido pela
  API em `/media`; o banco guarda o caminho RELATIVO (montar a URL pelo header Host deixaria um
  atacante gravar o próprio domínio no banco). Trocar a foto **não** apaga a antiga: o backup do
  banco e o volume de fotos são cópias separadas, e o banco restaurado da semana passada aponta
  para a foto de antes.
- **Vercel Blob** (com `BLOB_READ_WRITE_TOKEN` no ambiente): o disco da função é só leitura,
  então não há `mkdir(MEDIA_DIR)` nem `mount("/media")` no import — era o que derrubava a
  função. A foto vai para um store **público** (foto de peça é vitrine, não dado pessoal) e o
  banco guarda a URL ABSOLUTA que a RESPOSTA do Blob trouxe; URL fora de
  `https://*.public.blob.vercel-storage.com` é recusada (store privado daria foto que não abre
  no navegador). A troca envia a nova fora de qualquer trava, trava o produto relido
  (`FOR NO KEY UPDATE OF products` — a categoria vem num LEFT JOIN, que o Postgres não trava),
  aponta, faz commit e só então apaga a antiga, e só se ela for do Blob (o `/media/...` de um
  banco que veio da loja local fica). Duas trocas ao mesmo tempo esperam na trava: cada uma
  apaga a que a anterior gravou, e o store guarda só a foto do banco. Produto excluído enquanto
  a foto subia: 404, e a que subiu é apagada. Blob fora do ar ou recusando: 503
  `FOTO_NAO_GUARDADA` e a foto de antes fica (o corpo do erro do Blob vai só para o log); falha
  ao apagar a antiga só vai para o log — foto órfã custa espaço, não a troca.
- **Uma pasta por ambiente no store**: `produtos/<VERCEL_ENV>/<id>-<uuid4>.<ext>` (`production`,
  `preview`, `development`; sem Vercel, `local`), e só se apaga foto da pasta do ambiente que
  está rodando. O store sai ligado à Production E à Preview (o painel pré-marca as duas), e com
  o *preview branching* do Neon o banco do preview é cópia do de produção: apontaria para as
  fotos da produção, e trocar a foto num preview apagaria a que a loja está mostrando. Fica de
  fora, aceito por ser demonstração: *restore* do Neon (ou *reset* de branch) volta o banco
  para antes de uma troca e aponta para a foto que a troca já apagou — a peça aparece sem foto
  até alguém enviar de novo.
- **Na Vercel sem token** (`VERCEL=1` e nada de `BLOB_READ_WRITE_TOKEN`) não há onde a foto
  dure: o `/tmp` da função grava (um `MEDIA_DIR=/tmp/media` passa em qualquer `mkdir`), mas é
  de cada instância e some no *cold start* — a foto responderia 200 e sumiria. Quem decide
  é a variável de sistema `VERCEL`, nunca a falha do `mkdir`: `/media` não monta, `MEDIA_DIR` é
  ignorado, e o envio responde 503 `FOTO_NAO_GUARDADA` (`motivo: sem_blob`) dizendo o que
  conectar. `VERCEL` só existe com "Enable access to System Environment Variables" ligado (o
  padrão); desligado, o `MEDIA_DIR` relativo cai no disco só leitura e o caminho é o da linha
  de baixo.
- **Na loja, pasta que não se cria ou não grava** (volume sem permissão, disco cheio) não
  derruba a API: `/media` não monta, e o envio responde 503 (`motivo: disco`) falando da pasta
  de fotos (`MEDIA_DIR`) — nada de Vercel na tela da lojista; o errno vai para o log.
- **Teto do envio**: na loja, `MAX_UPLOAD_BYTES` (5 MB) como sempre. Na Vercel (ou com o Blob
  ligado), no máximo 4 MB: a função recusa corpo acima de 4,5 MB com o 413
  `FUNCTION_PAYLOAD_TOO_LARGE` dela, sem o JSON da API (doc: *functions/limitations*, "Request
  body size"); os 0,5 MB que sobram são o envelope do multipart. O `limite_mb` do 422 diz o teto
  que vale. A web e o app já encolhem a foto para 100 a 300 KB antes de subir. Na demo da
  instalação, 409 `DEMONSTRACAO_SEM_ESPACO` acima do teto: o da pasta de fotos inteira
  (`DEMO_FOTOS_MAX_BYTES`, 200 MB por padrão, ajustável no `.env`), que a renovação esvazia
  (ADR-46).
- **Login antes do corpo**: a rota não declara o arquivo (`File()`). Com ele, o FastAPI lia o
  multipart inteiro — e o Starlette gravava o arquivo num temporário — ANTES de resolver as
  dependências: um envio sem login era gravado todo para só então dar 401. O crachá
  (`CurrentUser`) roda primeiro, a transação da conferência termina (o envio lento de um celular
  não segura conexão do pool nem a trava de leitura de `users`), e só então a rota lê o corpo
  (`request.form`). O contrato: campo `arquivo`, 422 `VALIDACAO` com `detail.campos` quando ele
  falta; um arquivo e até 4 campos de texto ao lado (o app e a web mandam só o arquivo) — mais
  que isso, 400, como o multipart quebrado. Esses 400 saem no formato e na frase do Starlette, em
  inglês (`{"detail": "Too many fields. Maximum number of fields is 4."}`), e não no `{code,
  message, detail}` da API — como saíam quando o FastAPI lia o corpo sozinho. O corpo continua na
  documentação (`openapi_extra`).
- **Cliente do Blob**: `httpx` direto, nas duas chamadas de que a loja precisa — `PUT
  {VERCEL_BLOB_API_URL}?pathname=produtos/<ambiente>/<nome>` (`x-vercel-blob-access: public`,
  `x-content-type` pela assinatura do arquivo, sem sufixo aleatório nem sobrescrita) e `POST
  .../delete` com `{"urls": [...]}`, ambos com `Authorization: Bearer` e `x-api-version: 12` —
  espelho do SDK Python oficial (`vercel-blob` 0.5.1, `_internal/api_client.py`), já que a doc
  pública da Vercel só documenta os SDKs. O SDK não entrou: o pacote `vercel` (o do
  `from vercel import blob` da doc) puxa sandbox, workflow, fila e websockets; o `vercel-blob`
  sozinho puxa mais quatro pacotes 0.x e roda sobre `httpx2`, onde o `httpx.MockTransport` dos
  testes não entra. A validação do envio (extensão, teto, assinatura) roda antes de qualquer
  byte sair, igual em todos os modos — só o teto muda na Vercel.
- **Quem mostra aceita as duas formas**: a web passa por `enderecoDaFoto()` (`web/js/raiz.js`),
  que põe a raiz da página no caminho relativo (`/demo/media/...` na demonstração, ADR-46) e
  deixa passar a URL absoluta do Blob; o app passa por `lib/enderecoDaFoto.ts` (relativo ganha
  o servidor do aparelho, `http(s)://` passa como está). CSP: o `docker/caddy/Caddyfile` não muda —
  na loja a foto é `'self'`; na Vercel quem libera `https://*.public.blob.vercel-storage.com` no
  `img-src` é o `vercel.json`.

### 2.3 Estoque

```sql
stock_balances(variant_id PK FK→product_variants, quantity INT CHECK >= 0, updated_at)

stock_entries(id, user_id FK→users, supplier, note, client_uuid UUID UNIQUE, created_at)

stock_movements(id, variant_id FK→product_variants, movement_type VARCHAR(20) CHECK IN
                  ('ENTRADA','AJUSTE','INVENTARIO','VENDA','ESTORNO','DEVOLUCAO',
                   'CONDICIONAL_SAIDA','CONDICIONAL_RETORNO'),   -- ADR-39
                quantity INT CHECK (quantity <> 0),   -- com sinal: +entrada, -venda
                balance_after INT NOT NULL,           -- saldo resultante (auditoria)
                entry_id FK→stock_entries NULL, sale_id FK→sales NULL,
                return_id FK→sale_returns NULL, consignment_id FK→consignments NULL,
                user_id FK→users, note, created_at)
  ix_stock_movements_variant_created (variant_id, created_at)
  ix_stock_movements_sale_id, ix_stock_movements_type_created, ix_stock_movements_consignment_id
  ix_stock_movements_created_at                 -- filtro de período do extrato (ADR-27)
```

Append-only: movimentação nunca é editada nem apagada. `balance_after` guarda o saldo após o evento
(o extrato reconstrói a história sem recalcular tudo).

### 2.4 Vendas

```sql
sales(id, seller_id FK→users, status CHECK IN ('CONCLUIDA','CANCELADA') DEFAULT 'CONCLUIDA',
      subtotal, discount DEFAULT 0, total,
      comissao_percentual NUMERIC(5,2) NOT NULL,   -- % de quem vendeu, CONGELADA na venda (ADR-37)
      sold_at, cancelled_at NULL, cancelled_by_id FK→users NULL, cancel_reason NULL,
      client_uuid UUID UNIQUE NOT NULL, note NULL, created_at)
  CHECK (subtotal >= 0 AND discount >= 0 AND total >= 0)
  CHECK (comissao_percentual >= 0 AND comissao_percentual <= 100)
  CHECK (discount <= subtotal)
  CHECK (total = subtotal - discount)
  CHECK (status='CANCELADA' AND cancelled_at IS NOT NULL AND cancelled_by_id IS NOT NULL
         OR status='CONCLUIDA' AND cancelled_at IS NULL AND cancelled_by_id IS NULL)
  ix_sales_sold_at, ix_sales_seller_id, ix_sales_status_sold_at
  ix_sales_customer_id (customer_id) WHERE customer_id IS NOT NULL   -- dívida por cliente
  ix_sales_business_date ((sold_at AT TIME ZONE 'America/Sao_Paulo')::date)

sale_items(id, sale_id FK→sales CASCADE, variant_id FK→product_variants RESTRICT,
           quantity INT CHECK > 0,
           unit_price NUMERIC(14,2),   -- CONGELADO na venda
           unit_cost  NUMERIC(14,2),   -- CONGELADO na venda (CMV histórico)
           line_total GENERATED ALWAYS AS (unit_price * quantity) STORED)
  ix_sale_items_sale_id (sale_id) INCLUDE (variant_id, quantity, unit_price, unit_cost)
  ix_sale_items_variant_id

sale_payments(id, sale_id FK→sales CASCADE,
              method CHECK IN ('DINHEIRO','PIX','DEBITO','CREDITO','VALE','FIADO'),
              amount NUMERIC(14,2) CHECK > 0,
              voucher_id FK→vouchers NULL,      -- qual vale pagou
              customer_id FK→customers NULL,    -- de quem é a dívida
              parcelas SMALLINT DEFAULT 1,      -- > 1 só no CREDITO (ck_parcelas)
              bandeira VARCHAR(20) NULL,        -- só no cartão (ck_bandeira_so_cartao)
              taxa_percentual NUMERIC(5,2) DEFAULT 0,  -- FOTOGRAFADA na venda (ADR-35)
              prazo_dias SMALLINT NULL)         -- obrigatório no cartão, nulo fora dele
  CHECK ((method = 'FIADO') = (customer_id IS NOT NULL))   -- ck_fiado_tem_cliente
  FK (sale_id, customer_id) → sales(id, customer_id)       -- é a MESMA cliente da venda
  ix_sale_payments_sale_id
  ix_sale_payments_fiado (sale_id) INCLUDE (amount) WHERE method = 'FIADO'

card_fees(id, forma CHECK IN ('DEBITO','CREDITO'), parcelas_de, parcelas_ate,
          percentual NUMERIC(5,2) CHECK 0 <= p < 100, prazo_dias CHECK 0..366,
          created_at, updated_at)
  -- débito é sempre 1x (ck_debito_a_vista); faixas da mesma forma não se sobrepõem — o
  -- service confere com a forma travada (pg_advisory_xact_lock). Apagar é DELETE de verdade:
  -- nenhuma venda aponta para cá, a taxa vai copiada no pagamento (ADR-35).
```

Congelar `unit_price`/`unit_cost` é o que torna o lucro histórico correto: reajustar o preço amanhã
não reescreve o resultado de ontem.

A FK composta `(sale_id, customer_id) → sales(id, customer_id)` não é enfeite: sem ela, um
pagamento no fiado poderia apontar para uma cliente diferente da cliente da venda, e a
dívida apareceria na conta de quem não levou a peça. O banco recusa; ninguém precisa
lembrar.

### 2.5 Devolução, vale e crediário

```sql
sale_items( ... , returned_quantity INT DEFAULT 0)
  CHECK (returned_quantity >= 0 AND returned_quantity <= quantity)
  UNIQUE (id, sale_id, variant_id)   -- alvo das FKs compostas abaixo

sale_returns(id, sale_id FK→sales RESTRICT, user_id FK→users, returned_at,
             reason NULL, total NUMERIC(14,2) CHECK >= 0,
             client_uuid UUID UNIQUE NOT NULL, created_at)
  ix_sale_returns_sale_id, ix_sale_returns_returned_at

sale_return_items(id, return_id FK→sale_returns CASCADE, sale_item_id, variant_id,
                  quantity INT CHECK > 0, refund_amount NUMERIC(14,2) CHECK >= 0,
                  restock BOOL DEFAULT TRUE)
  FK (sale_item_id, variant_id) → sale_items(id, variant_id)
  -- sem unit_price/unit_cost: vêm de sale_items por JOIN. Copiar seria deixar dois
  -- lugares dizerem o preço da mesma peça, e um dia eles discordam.

sale_return_payments(id, return_id FK→sale_returns CASCADE,
                     method CHECK IN (as 6 formas), amount CHECK > 0,
                     voucher_id FK→vouchers NULL)

vouchers(id, code UNIQUE, value NUMERIC(14,2) CHECK > 0,
         used_value NUMERIC(14,2) DEFAULT 0, return_id FK→sale_returns NULL,
         expires_at NULL, created_at)
  CHECK (used_value >= 0 AND used_value <= value)
  -- consumo por UPDATE condicional (WHERE used_value + :v <= value), igual ao saldo de
  -- estoque: conferir antes deixaria o mesmo vale pagar duas vendas simultâneas.

customers(id, name, phone NULL, document NULL, credit_limit NULL, note NULL,
          nascimento DATE NULL, preferencias VARCHAR(200) NULL,   -- ADR-36
          client_uuid UUID NULL UNIQUE,     -- chave do cadastro feito no balcão
          deleted_at NULL, created_at, updated_at)
  uq_customers_phone_active UNIQUE (phone) WHERE deleted_at IS NULL
  uq_customers_document_active UNIQUE (document) WHERE deleted_at IS NULL
  -- excluir (só quitada) ANONIMIZA: phone/document/note/nascimento/preferencias = NULL,
  -- name = 'Cliente removido #id'.
  -- Só marcar deleted_at deixava CPF e telefone para sempre no banco e em todo backup (LGPD);
  -- a linha fica para as vendas e pagamentos do passado seguirem fechando a conta.

customer_payments(id, customer_id FK→customers RESTRICT, user_id FK→users,
                  method CHECK IN ('DINHEIRO','PIX','DEBITO','CREDITO'),
                  amount CHECK > 0, paid_at, note NULL,
                  client_uuid UUID UNIQUE NOT NULL)
  ix_customer_payments_business_date ((paid_at AT TIME ZONE 'America/Sao_Paulo')::date)
```

`returned_quantity` sobe por `UPDATE ... WHERE returned_quantity + :q <= quantity`, a mesma
mecânica de `stock_balances`. Duas devoluções simultâneas da mesma peça (toque duplo, retry
de rede) passariam as duas por qualquer checagem em memória — e a peça voltaria duas vezes
para a arara, com o dinheiro saindo duas vezes da gaveta.

Quanto o cliente deve **não é coluna nenhuma**:

```
deve = Σ pagamentos FIADO de vendas CONCLUÍDAS
     − Σ customer_payments
     − Σ devoluções que abateram FIADO
```

### 2.6 Despesas

```sql
expense_categories(id, name, deleted_at, created_at)
  uq_expense_categories_name_active UNIQUE (lower(name)) WHERE deleted_at IS NULL

expenses(id, category_id FK→expense_categories RESTRICT, description,
         amount NUMERIC(14,2) CHECK > 0, expense_date DATE,
         competencia DATE GENERATED ALWAYS AS (date_trunc('month', expense_date)::date) STORED,
         is_recurring BOOL DEFAULT FALSE, note,
         recurring_source_id FK→expenses NULL, deleted_at, created_at, updated_at)
  uq_expenses_recurring_source_competencia UNIQUE (recurring_source_id, competencia)
    WHERE deleted_at IS NULL
  ix_expenses_expense_date, ix_expenses_category_id
```

A UNIQUE `(recurring_source_id, competencia)` é o que torna "replicar recorrentes do mês" idempotente:
rodar duas vezes não duplica o aluguel. É parcial como todo soft delete: a réplica excluída não ocupa
o mês, e "Lançar fixas" consegue trazê-la de volta.

A conta fixa é a **cadeia** — a despesa-raiz e as réplicas que apontam para ela (`recurring_source_id`
é sempre a raiz), mais a recorrente digitada à mão com a mesma categoria e descrição. Ao replicar:
- **A linha mais recente da cadeia é o modelo**, com ou sem a marca: o valor novo do aluguel vale para
  o mês seguinte, renomear a réplica não faz a raiz voltar como uma segunda conta, e **desmarcar
  "recorrente" na réplica para a conta ali** (sem desmarcar o histórico). Despesa digitada à mão
  sem a marca não conta como "parou" — desmarcada é o padrão da tela.
- **O dia do vencimento é o da raiz**: dia 31 vira 28/02 e volta a 31/03, em vez de ficar preso no 28.
  Mudar a data de uma réplica vale só para aquele mês.
- Já lançada no mês é a que tem a mesma origem **ou** a mesma (categoria, descrição) — esta pega o
  aluguel digitado à mão.
- Cada conta entra no seu SAVEPOINT: a colisão com uma replicação simultânea conta só ela em
  `ja_existentes`, e as outras do mês entram.

### 2.7 Caixa

```sql
cash_closings(id, closing_date DATE UNIQUE, user_id FK→users, note,
              total_expected, total_counted, difference, created_at, updated_at)

cash_closing_lines(id, closing_id FK→cash_closings CASCADE, method CHECK(...),
                   expected_amount, counted_amount,
                   difference GENERATED ALWAYS AS (counted_amount - expected_amount) STORED)
  uq_cash_closing_lines_closing_method UNIQUE (closing_id, method)
```

Refechar o mesmo dia é um UPDATE do registro (com novo snapshot do esperado). O fechamento é
conferência: **não bloqueia** vendas. Bloqueia uma coisa só: o **cancelamento** de venda do
dia fechado, que reescreveria o que foi contado — essa venda se desfaz por devolução (ADR-19).
O snapshot gravado é o MESMO esperado que validou as contagens: uma leitura só, porque com duas
uma venda no meio delas gravava como falta uma forma que ninguém precisou contar.

### 2.8 Auditoria e segurança do login

```sql
audit_log(id BIGINT, user_id FK→users ON DELETE SET NULL NULL,
          user_nome, user_papel,          -- congelados na linha (ADR-23)
          acao, descricao,                 -- descricao = frase de gente
          metodo, caminho, entidade, entidade_id,
          ip, status_http, created_at)
  ix_audit_log_created_at (created_at)
  ix_audit_log_user_created (user_id, created_at)
  ix_audit_log_acao (acao)

login_attempts(id BIGINT, email, ip, sucesso BOOL, created_at)
  ix_login_attempts_email_created (email, created_at)
  ix_login_attempts_ip_created (ip, created_at)
```

`audit_log` nunca é editado por tela nenhuma e nunca é lido por vendedora — só por quem tem
`VER_AUDITORIA` (ADR-23). `user_id` fica nulo em falha de login com e-mail sem conta (e aí
`user_nome` guarda o e-mail MASCARADO, `ma***@g***.com`) e vira nulo se a linha da conta for
apagada (a conta excluída que fica presa ao histórico, ADR-45, mantém o vínculo — a linha dela só
guarda o nome); o nome/papel congelados preservam o histórico. A faxina do login também apaga, em lotes de 5 mil,
o diário com mais de `RETENCAO_AUDITORIA_DIAS` (730 por padrão; 0 = guarda tudo). `login_attempts` alimenta a trava de
força bruta (ADR-24): a contagem é por janela de 15 min. A faxina é oportunista, no login
bem-sucedido (raro, e já escrevendo): apaga as tentativas com mais de um dia e os
`refresh_tokens` **vencidos** há mais de um dia. O revogado ainda dentro da validade fica — é a
linha dele que denuncia o reuso de uma cópia roubada (ADR-12); vencido, o próprio JWT já é
recusado pelo `exp` antes de qualquer consulta.

### 2.9 Identidade da loja

```sql
store_config(id, nome, segmento, documento, telefone, endereco,
             regime_tributario CHECK IN (1,2,3), inscricao_estadual CHECK ~ '^[0-9]{2,14}$',
             serie_nfce INT DEFAULT 1 CHECK 0..889,                       -- ADR-41
             created_at, updated_at)
  ck_store_config_singleton CHECK (id = 1)   -- uma linha só, garantida pelo banco
```

`segmento` é texto validado na borda (`core/segmentos.py`), nunca um enum do banco: ramo novo é
uma linha numa tabela Python, não uma migration. Ramo desconhecido cai no vocabulário neutro em
vez de estourar — uma linha estranha (restauração antiga, edição na mão) não pode derrubar a tela
de login.

### 2.10 Condicional e contas a pagar do fornecedor (ADR-39, ADR-40)

```sql
consignments(id, customer_id FK→customers NOT NULL, seller_id FK→users,
             due_date DATE,                         -- prazo: dia de calendário, sem fuso
             status CHECK IN ('ABERTA','FECHADA'),
             client_uuid UUID UNIQUE,               -- chave da abertura
             closing_uuid UUID UNIQUE NULL,         -- chave do fechamento = chave da venda dele
             sale_id FK→sales UNIQUE NULL,          -- a venda do que ficou com a cliente
             note, created_at, closed_at NULL, closed_by_id FK→users NULL)
  ck_consignments_close_consistency  -- ABERTA sem nada de fechamento; FECHADA com quem/quando/chave
  ix_consignments_open_due_date (due_date) WHERE status = 'ABERTA'
  ix_consignments_customer_id

consignment_items(id, consignment_id FK→consignments CASCADE, variant_id FK→product_variants,
                  quantity INT CHECK > 0,
                  returned_quantity INT NULL CHECK (NULL OR 0..quantity),  -- preenchido ao fechar
                  UNIQUE (consignment_id, variant_id))

payables(id, supplier, description, invoice_number NULL, amount NUMERIC(14,2) CHECK > 0,
         due_date DATE, paid_on DATE NULL,
         payment_method CHECK IN ('BOLETO','PIX','TRANSFERENCIA','DINHEIRO','CARTAO') NULL,
         installment_number, installment_count,     -- "parcela 2 de 3"
         entry_id FK→stock_entries NULL,            -- a Entrada que trouxe a mercadoria
         client_uuid UUID NULL,                     -- chave do lançamento avulso
         note, created_by_id FK→users, paid_by_id FK→users NULL, deleted_at, created_at, updated_at)
  ck_payables_paid_consistency       -- paga = dia + forma + quem, juntos; aberta = nenhum dos três
  ix_payables_open_due_date (due_date) WHERE paid_on IS NULL AND deleted_at IS NULL
  uq_payables_entry_id_installment_number    WHERE entry_id IS NOT NULL
  uq_payables_client_uuid_installment_number WHERE client_uuid IS NOT NULL
```

O que ficou com a cliente não é coluna: é `quantity - returned_quantity`, e a venda dele mora em
`sales` como qualquer outra. `payables` não é lida por relatório nenhum: fica fora do Resultado.

### 2.11 NFC-e (ADR-41)

```sql
notas_fiscais(id, sale_id FK→sales RESTRICT UNIQUE,              -- uma nota por venda
              status CHECK IN ('PENDENTE','AUTORIZADA','REJEITADA','CANCELADA'),
              ambiente CHECK IN ('homologacao','producao'), emissor,
              referencia UNIQUE,                                  -- o `ref` no emissor
              numero, serie, chave(44), protocolo, url_danfe, url_xml, mensagem,
              tentativas CHECK >= 0, autorizada_em, cancelada_em, created_at, updated_at)
  ck_notas_fiscais_autorizada_tem_chave CHECK (status NOT IN ('AUTORIZADA','CANCELADA') OR chave IS NOT NULL)
```

A credencial do emissor **não** está aqui nem em tabela nenhuma: é `FOCUSNFE_TOKEN` no `.env`.

### 2.12 Leitor pelo celular (ADR-43)

```sql
leitor_pareamentos(id, codigo VARCHAR(8),                 -- 6 de "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"
                   computador_user_id FK→users CASCADE,   -- quem gerou o código
                   aparelho_user_id FK→users CASCADE NULL,-- quem aceitou (o celular)
                   criado_em, codigo_expira_em,           -- criado + 5 min
                   aceito_em NULL, expira_em NULL,        -- aceito + 12 h, fixo
                   encerrado_em NULL,
                   motivo_encerramento CHECK IN ('COMPUTADOR','CELULAR','TROCOU','SUBSTITUIDO') NULL)
  ck_leitor_pareamentos_encerramento  -- encerrado_em e motivo andam juntos
  ck_leitor_pareamentos_aceite        -- aceito_em, aparelho_user_id e expira_em andam juntos
  uq_leitor_pareamentos_codigo_aguardando (codigo) WHERE aceito_em IS NULL AND encerrado_em IS NULL

leitor_bipes(id BIGINT, pareamento_id FK→leitor_pareamentos CASCADE,
             client_uuid UUID UNIQUE,                     -- o reenvio do celular não bipa duas vezes
             codigo VARCHAR(64), criado_em, consumido_em NULL)  -- retirado (entregue ou descartado)
  ix_leitor_bipes_pendentes (pareamento_id, id) WHERE consumido_em IS NULL
```

O status do pareamento não é coluna: sai das datas, no servidor — ENCERRADO se `encerrado_em`;
aceito, ATIVO até `expira_em` e EXPIRADO depois; sem aceite, AGUARDANDO até `codigo_expira_em` e
EXPIRADO depois. As duas tabelas são de vida curta e não são histórico da loja: a faxina (a cada
código gerado) apaga bipe com mais de 1 dia e pareamento terminado há mais de 30, e os FKs para
`users` são CASCADE — excluir a conta de alguém não trava num pareamento de ontem.

---

## 3. Decisões (ADRs)

**ADR-1 — Saldo materializado, atualizado pelo service.**
`stock_balances` guarda o saldo; toda mudança é `UPDATE stock_balances SET quantity = quantity + :delta
WHERE variant_id = :id RETURNING quantity`, na mesma transação da movimentação. Alternativas
descartadas: saldo derivado por `SUM(movements)` (o PDV precisa de leitura instantânea e o extrato
cresce sem limite) e trigger no banco (esconde a regra do teste unitário e complica a migration).
O `UPDATE ... RETURNING` é atômico por linha, então duas vendas concorrentes do último item serializam
naturalmente; o `CHECK quantity >= 0` é a rede de segurança que transforma a corrida perdida em erro,
nunca em estoque negativo. Escritas de várias variantes são ordenadas por `variant_id` para não haver
deadlock cruzado.

**ADR-2 — Idempotência por `client_uuid` em venda e entrada.**
O app gera um UUID v4 ao iniciar a venda/entrada e o envia no POST; a coluna é UNIQUE e o replay
devolve `200` com o registro já criado (em vez de `201`). Custo: uma coluna. Ganho hoje: toque duplo,
timeout e retry de rede nunca duplicam venda nem estoque. Ganho amanhã: é exatamente a chave que uma
fila offline (v2) exige — o app ganha SQLite e fila sem mudar o contrato.
Devolução e recebimento de fiado procuram o `client_uuid` **duas vezes**: na entrada e de novo
depois de travar a venda (devolução) ou a cliente (recebimento). O retry que chega enquanto a
primeira tentativa ainda não fez commit passa pela primeira busca sem ver nada e fica parado na
trava; sem a segunda, ele seguia com a dívida já abatida ("o valor é maior do que a dívida") ou
batia no UNIQUE (500) — erro na tela para uma operação que aconteceu.
**O replay confere o pedido.** O `client_uuid` é a chave de UM pedido; a mesma chave com outro
conteúdo não é retry. A venda confere peças e a cobrança (forma, valor, parcelas, bandeira,
código do vale e desconto — o mesmo valor em outro vale é outro papel na mão da cliente); a
devolução, a venda e as peças (item, quantidade, volta ao estoque); o recebimento, cliente, forma
e valor. Divergiu →
`409 DUPLICADO` com o id do que já existe (`detail.venda_id`, `devolucao_id`, `pagamento_id`).
Responder o antigo como sucesso mostrava o recibo de uma cobrança que não aconteceu: a peça
bipada depois da resposta perdida saía sem baixa, a gaveta esperava PIX onde entrou dinheiro, a
devolução de outra venda aparecia no comprovante. O reenvio idêntico continua `200`.
**A entrada de mercadoria confere peças, quantidades, fornecedor e custo** — o custo contra o
da peça, porque a entrada não o guarda por item: ela o grava na variante. Divergiu →
`409 DUPLICADO` com `detail.entrada_id`. Antes, a resposta perdida seguida de mais sete peças
bipadas devolvia `201` com a entrada antiga: as sete não entravam, e a tela ainda oferecia
etiqueta para elas. O 409 leva também o que a entrada gravada levou: `detail.itens` (peças e
quantidades) e, para quem vê dinheiro, `detail.nota` (`{numero, valor_total, parcelas}`, ou
`null` se foi sem nota). Web e celular tiram da conferência os itens gravados
(`tirarOQueJaEntrou`) e, se a gravada já levou ESTA nota, tiram a nota do formulário
(`notaDepoisDoDuplicado`, `js/entrada-gravada.js` ↔ `lib/entrada.ts`) — só então trocam a chave,
que é da entrada que já existe (com ela, todo reenvio cairia no mesmo 409). Trocar a chave e
reenviar o resto com a mesma nota lançava as parcelas de novo: a nota de R$ 900 virava R$ 1.800
em Contas a pagar, porque o servidor não tem como saber que duas notas iguais são a mesma (o
número é opcional e se repete entre fornecedores). Quem compara é a tela, que tem as duas: é a
mesma quando o número bate (sem pontuação nem caixa; mesmo número com outro valor é a nota
corrigida, e a correção é em Contas a pagar) ou, faltando número de um lado, quando o valor bate.
Outro número → é outra nota, que ainda não entrou: fica e vai com o resto (tirar qualquer nota
deixava o boleto dela vencer esquecido, o desfecho que o ADR-40 chama de pior). Sem número e
com outro valor não dá para saber: fica, e a mensagem pede para tirá-la se for a mesma. Gravada
sem nota → a do formulário fica e vai com o resto. E "vai com o resto" só vale se sobrou peça:
se a gravada já levou a lista inteira, o botão Registrar desliga e a nota não sairia — a
mensagem manda lançá-la em Contas a pagar (`POST /contas-pagar`). A mensagem diz à pessoa qual
dos casos aconteceu.

**ADR-3 — Desconto só no total da venda.**
Desconto por item multiplicaria os caminhos de arredondamento (rateio, soma que não fecha, margem por
item ambígua). No balcão, o que se negocia é "faço por R$ 90". Relatórios de margem rateiam o desconto
pró-rata sobre os itens; o ranking de mais vendidos é por valor bruto (documentado na resposta).

**ADR-4 — Preço quem decide é o servidor.**
`POST /vendas` recebe apenas `variante_id` e `quantidade`; o preço e o custo vêm do banco no momento
da venda. O cliente não pode inventar preço. Se o app estiver com preço velho em cache, a soma dos
pagamentos não bate com o total do servidor e a resposta é `422 PAGAMENTO_DIVERGENTE` **com o total
correto no `detail`** — o app mostra "o preço mudou, total agora é R$ X" e refaz.

**ADR-5 — Papéis garantidos por schema de resposta.**
`VarianteVendedorOut` simplesmente não tem o campo `preco_custo`; o service escolhe o schema pelo papel
do usuário autenticado. Vazamento por endpoint esquecido deixa de ser possível, e o app nunca precisa
"esconder um número que recebeu". Despesas, relatórios, caixa, ajustes, inventário e usuários exigem
ADMIN no service (não só na rota).

**ADR-6 — Dinheiro: `Decimal` no servidor, string no fio, centavos no app.**
`NUMERIC(14,2)` ↔ `Decimal` ↔ JSON string (`"149.90"`). O app converte para inteiro de centavos na
borda (`lib/money.ts`) e faz toda a aritmética em inteiro — JavaScript não tem decimal nativo e
`0.1 + 0.2` no caixa é dinheiro errado.

**ADR-7 — Cancelamento em vez de exclusão.**
Venda cancelada vira `status='CANCELADA'` + movimentações `ESTORNO` que devolvem o estoque. O
histórico permanece auditável; relatórios filtram por status.

**ADR-8 — Fuso da loja em um lugar só.**
`settings.tz_loja` (`America/Sao_Paulo`) é usado pelos relatórios e pelo índice funcional de data. O
banco guarda UTC; o "dia" do comércio é definido pelo fuso da loja. O cliente precisa perguntar pelo
mesmo dia: às 23h de São Paulo o UTC já virou, e consultar o caixa pela data UTC devolve vazio.

**ADR-9 — Cancelamento serializado pelo próprio status.**
`UPDATE sales SET status='CANCELADA' WHERE id=:id AND status='CONCLUIDA'` acontece **antes** dos
estornos, e o serviço só continua se a instrução afetou uma linha. Checar o status em memória
deixaria dois cliques (ou um retry) passarem juntos: o `UPDATE` de saldo é atômico, mas *soma* — a
peça voltaria duas vezes ao estoque sem nenhum erro aparecer.
O mesmo `UPDATE` leva `NOT EXISTS (sale_returns)`, e por isso vem depois de um
`SELECT ... FOR UPDATE` da venda, em instrução separada. Sozinho, o `UPDATE` tira a foto do banco
ao começar, para na trava de uma devolução em andamento e, quando ela faz commit, segue com a foto
velha — a devolução só travou a linha, não a alterou, e o Postgres não reavalia o WHERE. A venda
saía CANCELADA e com devolução, com a peça e o dinheiro voltando duas vezes. Travando antes, o
`UPDATE` começa depois do commit e enxerga a devolução.

**ADR-10 — Configuração insegura derruba o boot.**
Fora de `dev`/`test`, o app recusa subir com `JWT_SECRET` de exemplo ou curto, `CORS_ORIGINS='*'`
ou `DEBUG=true`. Um deploy sem `JWT_SECRET` aceitaria tokens forjados com o segredo que está no
repositório — administrador sem senha. Falhar no boot é a única forma de isso não passar batido.

---

**ADR-11 — Sistema web em JavaScript puro, servido pela própria API.**
A loja roda numa VPS pequena e quem mantém o sistema é uma pessoa. Um segundo processo Node no
servidor (Next.js, Vite em SSR) seria mais um serviço para subir, vigiar e atualizar em troca de
nada que este sistema precise: não há SEO a fazer, não há time de frontend, e a tela mais crítica
(o PDV) é a que menos muda. Então `web/` é HTML + CSS + módulos ES lidos do disco, montados pelo
FastAPI em `/app` com `StaticFiles(html=True)`. Deploy é copiar arquivos; desenvolvimento é
recarregar a página. O custo aceito é escrever à mão o que um framework daria pronto — roteador por
hash, escape de HTML, um store de 30 linhas — e está tudo em `web/js/`, com menos de 300 linhas por
tela. Em produção o Nginx pode servir a mesma pasta direto, e nada quebra se não servir.

**ADR-12 — No navegador, refresh em cookie `httpOnly`; no app, no cofre do sistema.**
O celular tem `expo-secure-store`; o navegador não tem equivalente, e refresh token em
`localStorage` é lido por qualquer script que entre na página. Então `POST /auth/login` grava o
refresh num cookie `httpOnly`, `SameSite=strict`, com `path=/api/v1/auth` e `Secure` fora de
desenvolvimento — o JavaScript da página nunca o enxerga. (Na demonstração em `/demo`, o mesmo
cookie vale em `/demo/api/v1/auth`: é o caminho que separa as duas sessões no mesmo domínio,
ADR-46.) O access token vive só em memória, e
recarregar a página reergue a sessão chamando `/auth/refresh` sem corpo nenhum: o cookie viaja
sozinho. `/auth/refresh` e `/auth/logout` aceitam o token **no corpo ou no cookie**, então o app do
celular continua funcionando sem alteração. Um 401 dispara uma renovação compartilhada por todas as
requisições em voo (mutex): duas rotações simultâneas com o mesmo refresh seriam lidas como token
roubado e derrubariam a família inteira. No servidor isso vale sob concorrência de verdade: o
`/auth/refresh` lê o token com `SELECT ... FOR UPDATE`, então a segunda renovação espera a
primeira confirmar e enxerga o token já revogado — é reuso. Sem a trava as duas liam
`revoked=false`, as duas rotacionavam, e uma cópia roubada que ganhasse a corrida do dono saía
com sessão própria sem disparar o alarme.

**ADR-13 — O endereço do servidor mora no aparelho, não no instalador.**
O caminho óbvio seria assar `EXPO_PUBLIC_API_URL` no build, e ele quebra na primeira mudança de
IP: seria preciso gerar um instalador novo e reinstalar em cada celular da equipe — justamente no
dia em que o sistema está fora do ar. Então o endereço fica no aparelho, no `SecureStore`
(`api/servidor.ts`) — a base inteira, com o caminho se houver (`https://loja.x.com.br/demo`, a
demonstração da ADR-46) —, e o cliente HTTP resolve a base a cada requisição (`baseAtual()`), e não
na criação do axios — assim trocar de servidor com o app aberto funciona. A tela que edita o
endereço abre pela **engrenagem do login**, e não como pedágio antes da senha: quem recebe o
`.apk` quase sempre já tem o endereço certo (do build ou de instalação anterior), e obrigar
todo mundo a passar por uma tela de IP para depois digitar e-mail e senha era uma parede na
primeira abertura. Sem endereço, o login diz isso no rodapé e o botão Entrar recusa com um
aviso que aponta a engrenagem, em vez de deixar a requisição morrer num erro de rede que a
pessoa leria como senha errada.
O endereço é testado contra `/health` antes de ser aceito, porque um dígito errado no IP
apareceria depois como "não foi possível entrar" e a pessoa culparia a senha; e é normalizado
antes de gravar, porque o que a pessoa tem à mão é a barra do navegador do balcão
(`http://ip/app/#/pdv`), não o endereço da API. `EXPO_PUBLIC_API_URL` sobrevive como sugestão
inicial. O ganho é um instalador único para toda a equipe.

**ADR-14 — O app fica no Expo SDK 54, e o teto é da Apple, não nosso.**
O SDK 57 é o estável atual e o app rodava nele. Mesmo assim ficamos no 54, porque **54 é a última
versão do Expo Go publicada na App Store e na Play Store**: o Expo Go para SDK 55 travou na
aprovação da Apple e a Expo parou de publicar novas versões. Num projeto acima do 54, o celular
responde *"Project is incompatible with this version of Expo Go"* e não há atualização que
resolva — o app da loja já está no topo. Como o teste por QR é o único caminho gratuito para
alguém abrir o app num iPhone (a Apple não permite instalar fora da loja sem conta paga), perder
o Expo Go custaria mais do que ficar um SDK atrás. O 54 continua recebendo correções.
Consequências: `expo`, `expo-*`, `react-native` e `react` seguem a tabela do SDK 54
(`npx expo install --fix` alinha); o `usesCleartextTraffic` do Android saiu do `app.json` — cujo
schema no 54 não o aceita — e passou para o plugin `expo-build-properties`; e o Node precisa ser
**≥ 20.19.4**, exigência do Metro e do React Native 0.81. Para subir de SDK no futuro, o preço a
pagar é trocar o Expo Go por um *development build*.

**ADR-15 — Capacidades numa tabela só, nunca `if papel == X` espalhado.**
Com dois papéis dava para escrever `if user.role != ADMIN` em cada rota. Com quatro isso
vira campo minado: um `!=` esquecido e a vendedora lê a margem da peça. Então o código
pergunta pela CAPACIDADE — `pode(user.role, Pode.VER_DINHEIRO)` — e a única tabela que
liga cargo a capacidade mora em `app/core/permissoes.py`. Mudar o que um cargo faz é uma
linha ali, e nenhuma rota precisa ser revisada. As rotas declaram o crachá que exigem na
porta (`ExigeDinheiro`, `ExigeCancelarVenda`), o que também documenta a API sozinho.
Consequências: `tests/test_permissoes.py` é a tabela virada em teste, papel por porta, e
inclui a trava contra escalada (um gerente com GERIR_USUARIOS conseguiria se promover a
dono com um PATCH no próprio id — `usuarios/service.py::_barrar_escalada` fecha isso, e o
CLI de instalação cria o primeiro dono passando um ator fundador em vez de afrouxar a
regra). `web/js/permissoes.js` e `mobile/src/lib/permissoes.ts` são espelhos: existem só
para a tela não oferecer o que daria 403, e uma divergência custa um botão a mais ou a
menos, nunca um dado vazado — o dado nem sai da API. Os valores gravados continuam
`ADMIN` e `VENDEDOR` por compatibilidade com quem já instalou; o nome que a loja vê sai
de `TITULO`.


**ADR-16 — Tempo real por aviso, não por dado.**
Cada tela vivia da própria cópia: cadastrava-se uma peça no balcão e o celular só a via
depois de fechar e abrir o app. O canal é um WebSocket (`/api/v1/tempo-real`) e o que
trafega nele é o ASSUNTO do que mudou (`estoque`, `catalogo`, `vendas`…), nunca o
registro. Mandar o objeto seria mais rápido e furaria o filtro por papel: os schemas de
resposta que escondem custo da vendedora vivem nas rotas REST, e um empurrão pelo socket
passaria por fora deles. Assim o aviso é minúsculo, não depende de tela nenhuma, e quem
busca continua sendo a rota de sempre.
Quem publica é o **commit do SQLAlchemy** (`after_flush` anota as tabelas e dá o
`pg_notify`, `after_commit` publica em memória), e não os services: seriam mais de vinte pontos de commit, e o esquecido não
quebra teste nenhum — só deixa uma tela velha, o que ninguém liga a um commit específico.
O saldo de estoque é escrito por SQL direto e não passa pelo ORM, mas toda mudança de
saldo vem com uma linha em `stock_movements` na mesma transação, então ouvir o ORM basta.
Autenticação pelo **primeiro quadro**, não por query string: o navegador não manda
cabeçalho no handshake, e `?token=` acabaria no log de acesso do servidor, no do proxy e
no histórico de todo intermediário. Entrega é melhor esforço — ouvinte lento perde aviso
(fila de 32) e se acerta ao reconectar, quando o cliente invalida tudo. A central é em
memória e por processo, e o repasse entre processos é o LISTEN/NOTIFY do próprio Postgres
(abaixo): empilhar Redis seria mais uma peça para quebrar num sábado cheio.
**Tempo real entre instâncias.** Na Vercel cada instância da função é isolada (e no Docker
com mais de um worker cada worker é um processo): a venda feita numa não avisava a tela
ligada em outra. O commit agora também manda o assunto por `pg_notify` no canal
`loja_avisos`, **dentro da transação** — o `after_flush` executa o NOTIFY na conexão dela,
um por assunto por transação (`_AVISADOS`). Assim o Postgres só entrega se o commit
acontecer (rollback não avisa), entrega junto com o commit (quem consulta já vê o dado) e
junta carga repetida. Savepoint desfeito descarta o NOTIFY feito dentro dele, então
`after_soft_rollback` esquece o que já foi avisado e o próximo flush avisa de novo; e só o
fim da transação de FORA esquece as tabelas tocadas — antes, o savepoint que falhava (a
despesa recorrente já lançada) apagava também o aviso do que a transação gravara antes
dele. A carga é `{"origem": <instância>, "assunto": ...}`, nunca o dado. Do outro lado,
`core/escuta.py`: uma conexão asyncpg DEDICADA por instância faz `LISTEN`, aberta pela
primeira tela que liga e fechada pela última que sai (instância sem tela não segura conexão
— no Neon é o que deixa o banco dormir), e repassa à central local, que segue com a rajada
e o filtro de sempre. **Sem aviso dobrado**: a instância que gravou já entregou em memória
no commit; o que volta pelo LISTEN com a origem dela é descartado. **Cai e volta**: aviso
de término do asyncpg mais um `SELECT 1` por minuto (a queda calada de NAT), religação com
espera crescente (1 s → 30 s) e, na volta, a central local publica TODOS os assuntos — o
que outra instância gravou no buraco não chegou, e não há como saber o quê. **"conectado" é
uma promessa**: o socket só o manda depois de o LISTEN estar de pé, e o cliente refaz as
consultas ao recebê-lo; daí em diante nada escapa. Se o LISTEN não sobe em 5 s (o Neon
acordando leva até 10 s para conectar), o "conectado" sai assim mesmo e a tela fica marcada
no turno da escuta (`atrasou`): quando ele subir, a central publica TODOS os assuntos, como
na volta de uma queda — senão o que outra instância gravasse entre o "conectado" e o LISTEN
não chegaria por consulta (já feita) nem por aviso (ninguém escutava). O laço do socket espera
o aviso OU a queda do cliente — esperando só o aviso, a tela que saiu ficava pendurada até o
próximo ping (25 s), segurando a escuta e, na Vercel, a instância. O endereço sai de
`dsn_da_escuta()`, ponto único: `DATABASE_URL_UNPOOLED` quando existe, senão
`DATABASE_URL` — sem o `+asyncpg`, com `ssl=` traduzido para `sslmode=`, sem
`channel_binding` (o asyncpg mandaria ao servidor como configuração, e o Postgres recusa) e,
sem URL direta, com o `-pooler` do host do Neon tirado: LISTEN atrás de PgBouncer em modo
transação não recebe nada, e sem erro. O `sslmode` é o do app (`DB_SSL`) quando ele existe,
sobre o que a URL disser: a URL do app pode chegar já sem ele (tirado para ir por
`connect_args`), e a conexão de LISTEN não pode ficar menos protegida que a do app. Queda
calada (NAT que esqueceu a conexão) é largada com `terminate()`, sem a despedida educada,
que esperaria `ESPERA_FECHAR` inteiro por resposta de quem não responde. O NOTIFY pode ir
pela conexão "pooled" (é uma função dentro da transação). Custo aceito: commit que dá
NOTIFY é serializado pelo Postgres entre si — irrelevante numa loja de meia dúzia de
aparelhos. Os clientes já religavam sozinhos e
refaziam a tela no "conectado"; a regra saiu para `mobile/src/lib/canal.ts` (teste em
`canal.test.ts`) e o espelho `web/js/canal.js` (teste em `testes/web/`, que também confere
`tempo-real.js` de verdade — fora de `web/`, porque tudo o que mora lá é servido em `/app`,
e `tests/test_web_servido.py` confere), porque na Vercel o socket FECHA no `maxDuration` da
função e religar deixou de ser exceção. Testes: `tests/test_tempo_real_instancias.py` —
outra central com outra escuta no mesmo processo, um segundo uvicorn de verdade com o
socket de verdade, e uma rede de mentira entre a escuta e o Postgres para o que o banco não
faz quando o teste pede (conexão nova que demora, como o Neon acordando; conexão que
emudece sem cair, como o NAT).
**Queda de cliente não é erro.** A task que lê do socket (`_escutar_ate_cair`) existe para
PERCEBER a queda, e morre com `WebSocketDisconnect` quando ela acontece. `await` numa task
morta relança a exceção dela: sem suprimir, ela sobe até o uvicorn, que escreve um traceback
inteiro (~2 KB) por aparelho que fecha o app. É o tipo de defeito que não quebra nada e
custa o servidor: o log do Docker não tem teto por padrão, o arquivo cresce sem parar e
disco cheio faz o Postgres parar de aceitar escrita — a loja "para e não volta" sem nada de
errado aparecer no log da aplicação. Daí as duas metades da correção: o endpoint engole a
queda (`test_cliente_que_cai_nao_vira_erro_no_log` guarda isso) e o `docker-compose.yml`
fixa `max-size: 10m` × `max-file: 3` em todo serviço.
**Rajada vira uma rodada; tela que ninguém olha não recarrega.** Uma venda publica dois
assuntos (`vendas`, `estoque`), uma devolução três, e num sábado cheio dois balcões vendem
no mesmo segundo. Tratado aviso por aviso, cada celular aberto refazia o estoque rolado
(todas as páginas), o resumo do mês e o estoque-baixo uma vez por aviso: 23 avisos de dez
vendas e uma devolução custavam 89 buscas no celular do dono. Agora o cliente junta os
avisos que chegam em sequência — fecha a rodada com 1 s de silêncio, nunca depois de 2 s do
primeiro (`JANELA_RAJADA`/`TETO_RAJADA`) — e aplica a união dos assuntos de uma vez: as
mesmas 23 viram 1 rodada e 8 buscas. A regra mora em `mobile/src/lib/avisos.ts` (com teste
de tempo simulado em `avisos.test.ts`) e é espelhada em `web/js/tempo-real.js`, onde a
rodada vira um redesenho por tela inscrita. No app, a rodada invalida com
`refetchType: 'active'`: só consulta com tela montada busca de novo; relatório fechado fica
marcado como velho e é buscado quando abrir. Limite conhecido: as abas do expo-router
continuam montadas, então a aba Financeiro conta como "tela montada" mesmo com a pessoa no
PDV; tirar isso pede `subscribed: useIsFocused()` em cada aba, o que é mudança de tela e
ainda não foi feita. Com o app no fundo (`AppState` →
`focusManager` do TanStack, em `app/_layout.tsx`) ou a aba do navegador escondida, a rodada
fica segurada; na volta o cliente já recarrega tudo de uma vez (é o mesmo buraco da
reconexão), e a rodada segurada é descartada no app ou somada ao redesenho no web.
O aviso continua sem dado: a rodada só diz QUAIS consultas refazer.


**ADR-17 — Achar a peça pelo nome é do fluxo, não conveniência.**
A busca de peças só olhava código de barras, o que bastava para o bipe e falhava no resto. O
furo aparece na reposição: quando o código é INTERNO, a etiqueta nasce aqui dentro, e a
mercadoria que chega do fornecedor vem sem nada colado. Exigir bipada obrigava a imprimir e
colar antes de conferir — peça por peça, para registrar o que já se sabia que chegou. Ou seja,
o caminho existia só para o caso que a loja quase não tem. Agora `GET /variantes?q=` procura
por nome do produto, cor ou código, com o exato à frente, e devolve saldo e nome do produto na
mesma resposta — o que a tela precisa para decidir sem uma segunda ida ao servidor.
Acento sai dos dois lados por `translate()` no Postgres, e não pela extensão `unaccent`:
`unaccent()` não é IMMUTABLE (não entra em índice) e depende de dicionário no servidor,
enquanto para o alfabeto do português a tabela resolve igual — e `translate(lower())` é
indexável (o índice trigram do ADR-31 é sobre esta expressão). Quem procura
escreve "calca jeans", e a peça não pode sumir por causa de uma cedilha — some ela, a pessoa
cadastra a mesma peça de novo, e aí são dois saldos para uma arara só.
Na tela é **um campo, não dois**: o leitor USB digita em rajada e fecha com Enter, o dedo
digita devagar e com letras, e dá para distinguir sem perguntar. Com a lista aberta o leitor
ignora o Enter (`ignorarQuando`), senão "camiseta" viraria uma bipada de código inexistente.
A conferência da entrada passou a morar no store, ao lado do carrinho, pelo mesmo motivo dele:
travar na peça não cadastrada no meio da sacola é rotina, e perder trinta bipadas para ir
cadastrar ensina a não cadastrar. Quem vai cadastrar volta com a peça nova já conferida.

**ADR-18 — A versão instalada vem do atualizador, não de uma consulta ao GitHub.**
"Estou na versão mais nova?" é pergunta de quem cuida da loja, e um hash na tela não
responde: `5c31d04` não é maior nem menor que o de ontem. Responder de verdade exige
comparar com o repositório — e a API poderia fazer isso, ao custo de ter um token do
código-fonte dentro do contêiner que serve o balcão. Não vale: quem só precisa vender roupa
não precisa de acesso ao fonte, e credencial guardada é credencial que vaza.
Então quem compara é o `atualizar.sh`, que já tem a credencial e já conversa com o GitHub a
cada conferida. Ele grava `docker/estado/versao.json` (commit, data, quando conferiu, se
havia coisa nova), montado **somente leitura** no contêiner. `GET /versao` lê o arquivo e
devolve a frase pronta — a mesma no web e no app, para as duas telas não divergirem sobre o
que "atualizada" quer dizer.
Duas datas, não uma: "atualizada" de três dias atrás não tranquiliza ninguém, porque o
timer pode ter morrido ontem. Passadas 24h sem conferir, a tela diz isso em vez de repetir
uma resposta velha com cara de nova.
**"Instalada" é o que subiu, não o que está no disco.** O `git reset` troca o código minutos
antes de o contêiner novo existir; uma morte nesse meio (o `TimeoutStartSec` matando um build
lento, queda de luz) deixava o HEAD igual ao GitHub com a imagem velha no ar, e toda conferida
seguinte dizia "nada a fazer" para sempre. O script grava em `docker/estado/implantado` o
commit que respondeu ao `/health` — o de antes, antes do reset; o novo, só depois do `/health`
— e compara o GitHub com ele. A execução seguinte a uma morte reconstrói, e a volta atrás
mira esse commit. Sem o arquivo (instalação nova), vale o HEAD, e o primeiro reset já o cria.
**Só sobe commit de CI verde, e não insiste no que caiu.** Implantar o que estivesse no `main`
fazia um commit quebrado derrubar a loja por 3 a 4 minutos a cada 10, o dia inteiro, porque a
volta atrás desfazia e a conferida seguinte tentava de novo. Antes de mexer em qualquer coisa, o
script pergunta `GET /repos/{dono}/{repo}/commits/{sha}/check-runs` com a MESMA credencial que o
git usa (a da URL crua do `origin`, ou o ajudante de credenciais; o token vai por `curl -K -`,
nunca na linha de comando). Verde = todas terminaram e nenhuma reprovou; zero verificações conta
como "ainda rodando". Sozinho (`--sim`), vermelho ou rodando não sobem (a tela passa a mostrar
versão nova esperando, e a próxima conferida pergunta de novo); **sem resposta** (token sem
"Checks: leitura", GitHub fora) também não sobe e sai com erro, para o `OnFailure=` avisar em vez
de a loja parar de atualizar calada. Interativo, pergunta; `--ignorar-ci` é a saída explícita.
A volta atrás grava o commit em `docker/estado/falhou` antes de tudo, e o `--sim` não tenta esse
commit de novo — só um commit NOVO no GitHub (a correção) o faz seguir; o arquivo some quando um
commit sobe bem. O JSON é lido com `grep -o` (a máquina não tem jq nem Python garantidos): as
chaves `status`/`conclusion` dentro de um texto viriam com as aspas escapadas e não casam.

**ADR-19 — Não existe "modo troca": troca é devolução que vira vale, mais uma venda nova.**
A troca parece uma operação só, e virou muitas telas em muitos sistemas: escolher o que
sai, o que entra, calcular a diferença nos dois sentidos, decidir o que fazer quando a peça
nova é mais barata. Cada um desses ramos é um lugar novo onde o dinheiro pode sumir.
Quebrando em duas operações que já existem, a troca não precisa de código nenhum: a peça
volta (devolução, com rastro em `sale_returns`), o valor sai por onde entrou, e a peça nova
é uma venda comum. Se o valor não pode voltar pela forma original, vira vale — um papel com
código, em `vouchers`, que a próxima venda consome.
**A devolução é reconhecida no dia em que acontece, não no dia da venda.** Refazer o
faturamento de terça porque a cliente voltou na sexta é reescrever um caixa que já foi
conferido e fechado. O relatório mostra bruto e líquido lado a lado.
**Pelo mesmo motivo, venda de dia com caixa fechado não se cancela — devolve-se.** O caixa e
o relatório leem a venda pelo dia em que ela aconteceu e só somam as concluídas: cancelar na
sexta a venda de R$ 100 em dinheiro de terça tirava os R$ 100 do esperado de terça (o dia que
fechou certinho passava a mostrar sobra) e não punha nada no de sexta (que fechava com a falta
dos R$ 100 que saíram da gaveta). `POST /vendas/{id}/cancelamento` responde
`409 OPERACAO_INVALIDA` quando existe fechamento para o dia da venda no fuso da loja, e a
mensagem manda para a Devolução, que entra no caixa de hoje. A régua é o fechamento, não a
data: dia que ninguém conferiu ainda pode ser acertado pelo cancelamento. (Cancelar no mesmo
instante em que alguém fecha aquele dia ainda passa: o fechamento não trava a venda. A janela é
de milissegundos, e o dia pode ser refechado.)
**O que volta por cada forma respeita o que entrou por ela.** Uma venda de R$ 200 paga
metade em dinheiro e metade no cartão devolve metade e metade — devolver tudo em espécie
tiraria da gaveta um dinheiro que nunca entrou nela. Cartão fica fora do esperado do caixa
de propósito: o estorno na adquirente cai dias depois e não muda o que está na gaveta hoje.
**Cada item decide se volta ao estoque.** Peça manchada ou rasgada volta para a loja, não
para a arara: o dinheiro sai igual, o saldo não sobe. Sem essa escolha, a vendedora
devolveria e teria de lembrar de um ajuste depois — e é disso que o estoque adoece.

**ADR-20 — Limite do crediário avisa, não bloqueia.**
Travar a venda quando a cliente passa do limite parece proteger a loja, e faz o contrário:
quem conhece a freguesa é a dona, e a vendedora que não consegue lançar aprende no mesmo
dia a registrar como dinheiro e anotar no papel. Aí a dívida sai da conta e volta para a
caderneta, que é exatamente o problema que o crediário veio resolver. O limite aparece como
aviso na hora de escolher a cliente e como etiqueta na lista; a decisão continua sendo de
quem está no balcão.
**O saldo devedor nunca é uma coluna.** É sempre calculado: fiado das vendas concluídas,
menos o que o cliente pagou, menos o que foi devolvido abatendo fiado. Saldo guardado é
saldo que sai do lugar no dia em que alguém esquece de atualizar — e aqui isso significaria
cobrar o que já foi pago.
**Fiado e vale nunca entram na conferência de gaveta.** O vale foi pago na venda que o
gerou; o fiado ainda nem foi pago. Somá-los faria o caixa fechar com falta todo santo dia
em que a loja vendesse fiado. Recebimento de fiado, ao contrário, entra: é dinheiro que
passou pela gaveta hoje — mas aparece separado do faturamento, porque a venda já foi
contada no dia dela.

**ADR-21 — Devolução só abate a dívida até onde ela existe; o resto vira vale.**
A cliente levou no fiado, pagou tudo e só então voltou com a peça. Abater o fiado outra vez
deixa o saldo em −R$ 100,00: a loja passa a dever a ela, ela some da lista de quem está
devendo, e nenhuma tela diz isso. O abatimento é limitado ao que ela ainda deve **hoje**, e
a diferença sai como vale — um papel na mão dela, que ela vê. Devolver em espécie seria
tirar da gaveta de hoje um dinheiro que entrou noutro dia, por outra venda; o sistema não
sabe qual pagamento quitou qual compra, e não vai fingir que sabe.
**O cancelamento obedece à mesma regra, recusando.** Cancelar tira o fiado da conta (venda
CANCELADA não cobra), mas o pagamento que ela já fez continua lá — e o saldo iria a negativo
pelo mesmo caminho. Por isso `POST /vendas/{id}/cancelamento` de venda com FIADO trava a
cliente (`quanto_deve(travar=True)`, na ordem venda → cliente, a mesma da devolução) e responde
`409 OPERACAO_INVALIDA` quando, sem o fiado desta venda, a dívida ficaria abaixo de zero. A
mensagem manda para a Devolução, que abate só o que ainda se deve e devolve o já pago em vale.
Recusar em vez de converter em vale no próprio cancelamento mantém um caminho só para o
dinheiro que já entrou; e se a dívida que sobra ainda cobre o fiado desta venda (duas compras,
um pagamento), o cancelamento passa normalmente.

**ADR-22 — Backup é do servidor, com cópia fora dele, e só vale se a restauração for testada.**
`pg_dump` que ninguém nunca restaurou é um arquivo, não um backup. `backup.sh` valida o
dump abrindo-o depois de gerar, guarda 14 dias, manda a cópia para fora por `rclone` quando
`BACKUP_REMOTO` está configurado, e a restauração tira um dump de segurança ANTES de
sobrescrever — porque restaurar o arquivo errado é o jeito mais rápido de perder o que
ainda estava certo. O `diagnostico.sh` conta a idade do último backup: backup velho é o
tipo de coisa que só se descobre no dia em que ele é preciso.
Restaurar **zera o schema** (`DROP SCHEMA public CASCADE` e recria) e roda o dump, tudo numa
transação só do `psql`. Era `pg_restore --clean`, que só derruba o que está NO dump: a cópia de
antes de uma migration deixava para trás a tabela que ela criou, o `alembic_version` voltava, e
o `upgrade head` do contêiner caía em DuplicateTable — a API não subia mais. Numa transação, dump
que não abre deixa o banco como estava, e a loja volta com ele.
A mesma restauração é a volta atrás do `atualizar.sh` quando a versão nova chegou a migrar o
banco e não subiu: o código anterior não acha a revisão nova ("Can't locate revision"), então
voltar só o código deixaria a loja fora. O script anota a revisão antes do `up`; se ela mudou e
a anterior não sobe, restaura a cópia tirada antes da atualização (o `--restaurar` guarda o banco
migrado antes, com o que se vendeu no meio tempo). Quem migra é só o `entrada.sh`, ao subir: o
`atualizar.sh` espera o `/health` em vez de rodar outro `alembic upgrade head`, que corria junto
com o do contêiner (o alembic não tem trava) e transformava atualização boa em volta atrás.
Essa cópia de antes passa pelo mesmo `pg_restore -l` do `backup.sh`, com o `pg_restore` do
contêiner (o da máquina pode ser de outra versão). Sem uma cópia que abra, o `--sim` (o timer)
**não atualiza**: segue na versão de antes, a tela passa a dizer que há uma nova esperando, e
só `--sem-backup` explícito pula a cópia. Interativo, o script pergunta.
**A cópia diária nasce ligada, e só o dono do arquivo a lê.** O instalador termina chamando o
`./backup.sh --automatico` (systemd no Linux, launchd no Mac; no Windows, uma Tarefa Agendada que
roda o `backup.ps1`, com "rodar assim que possível" para o computador do balcão que fica
desligado às 03:15). O `backup.sh` roda com `umask 077`, a pasta `backups/` é 700 e cada dump
600 — inclusive os do `atualizar.sh` e do `desinstalar.sh`, que recebem `chmod 600` depois do
`docker cp`, porque o `docker cp` traz a permissão de dentro do contêiner e ignora o umask.

**ADR-23 — Auditoria na borda, com nome e papel congelados na linha.**
Quem cuida da loja precisa saber o que cada pessoa fez com o login dela — não para
desconfiar, para responder "quem cancelou essa venda?" sem adivinhar. A captura mora numa
**middleware** (`modules/auditoria/middleware.py`), não espalhada pelos services: toda
mutação que entra (`POST/PUT/PATCH/DELETE` sob `/api/v1`) e **termina bem** (status < 400)
vira uma linha em `audit_log`. Um classificador (`classificar.py`) traduz método+rota numa
frase de gente ("Cancelou uma venda", "Deu entrada de mercadoria"); rota que ninguém mapeou
ainda entra como `OUTRO`, então o diário nunca tem buraco. A linha **congela** o nome e o
papel de quem agiu (`user_nome`, `user_papel`): renomear ou rebaixar alguém amanhã não pode
reescrever o que o histórico diz que aconteceu. O papel congelado é o do **banco** na hora do
ato, o mesmo que a autorização usou — não o claim do token, que pode ter até 30 min e ainda
dizer GERENTE de quem já foi rebaixada. Ler o diário é a capacidade `VER_AUDITORIA`,
que só o dono tem (ADR-15) — nem o gerente entra. Por que na borda e não no service: um
lugar só, impossível de esquecer ao criar rota nova, e o texto sai do próprio contrato REST.
A gravação é embrulhada em `try/except` largo: auditoria **nunca** derruba a requisição que
ela observa — registro que falha vira log, não erro para o cliente. A middleware decodifica o
token ela mesma (o `contextvar` do usuário, setado lá adentro, não volta visível depois do
`call_next` no Starlette). Quem excluiu a própria conta (ADR-45) não existe mais quando a borda
grava: a rota chama `congelar_autor(request, user)` antes, e a linha sai sem `user_id`, com o nome
e o papel de antes. **O 2xx que não mudou nada não é ato:** a rota idempotente que
responde sucesso sem efeito (desligar o leitor que já tinha terminado, o reenvio de um aceite —
ADR-43) chama `fora_do_diario(request)` e a borda pula a linha; senão o dono leria atos que não
aconteceram, no nome de quem só estava saindo do sistema. É opt-out de propósito: esquecer de
chamar deixa uma linha a mais, nunca esconde um ato.
**LGPD x auditoria — o equilíbrio.** O diário prova quem fez o quê, e para isso nome e papel de
quem AGIU continuam congelados, inclusive depois de a conta ser excluída: é a parte que tem
finalidade (prestação de contas, e inocentar quem foi acusado sem razão). O que não prova ato
nenhum deixou de ser guardado por extenso: (1) `LOGIN_FALHOU` de uma conta que existe grava o
`user_id` e o nome congelado dela, sem e-mail; de um e-mail sem conta, grava só a máscara
(`mascarar_email`) — pode ser o e-mail de qualquer pessoa, errado por uma letra, e não há conta
a que ele pertença para um dia ser apagado; (2) ao excluir um usuário, as linhas que ainda traziam
o e-mail dele (o formato antigo do `LOGIN_FALHOU`) passam a trazer a máscara — no nome e na frase,
e só ali; (3) nada fica para sempre: `RETENCAO_AUDITORIA_DIAS` (730 dias por padrão, 0 = guarda
tudo) e uma faxina oportunista no login certo, em lotes de 5 mil linhas, como a de
`login_attempts`. Livro fiscal é a venda, que não sai daqui; o diário é prestação de contas, e
dois anos cobrem qualquer conferência de caixa. Essas são as duas únicas escritas depois do
INSERT, e nenhuma toca em `user_nome`/`user_papel` de quem agiu. O login escreve pelo
`AuditoriaService` (porta pública), não pelo repository de outro módulo.

**ADR-24 — Trava de força bruta por e-mail e por IP, sem revelar quem existe.**
Senha é a única porta, então a porta conta tentativa. Cada login (certo ou errado) grava uma
linha em `login_attempts`; antes de conferir a senha, o service soma as falhas recentes numa
janela deslizante de 15 min e trava em `429 MUITAS_TENTATIVAS` com `Retry-After` quando passa
de **10 falhas para o mesmo e-mail** ou **30 para o mesmo IP**. Dois limites porque um cobre o
ataque focado numa conta e o outro a varredura de muitas contas do mesmo lugar. A trava é a
mesma quer o e-mail exista ou não — errar a senha de `admin@loja.com` e bater num e-mail
inventado dão a mesma resposta e o mesmo tempo, então a tela de login não vira um oráculo de
"esse cliente é cadastrado?". O mesmo tempo é de propósito: e-mail que não existe confere a
senha contra `HASH_DE_MENTIRA` (`core/security.py`, mesmo custo bcrypt dos de verdade) — sem
isso ele respondia em 10 ms e a senha errada em 300 ms. O teto vale sob concorrência:
`pg_advisory_xact_lock` por e-mail põe contar, conferir e gravar a tentativa num passo só até o
commit; sem a fila, 30 chutes simultâneos passavam todos pela contagem antes de a primeira falha
ser gravada. E o bcrypt roda numa thread (`verificar_senha_async`/`hash_senha_async`): no event
loop, cada conferência de ~0,3 s parava o servidor inteiro — PDV, bipagem, WebSocket — e uma
rajada de logins errados, mesmo dentro da trava, travava o balcão. O IP vem do
`X-Forwarded-For` (a API serve atrás do Caddy);
falha de login também entra no diário de auditoria (ADR-23) como `LOGIN_FALHOU`: com o
`user_id` e o nome da conta quando ela existe, com o e-mail mascarado quando não existe. A
consulta que descobre qual dos dois é feita nos dois casos, então o tempo da resposta não muda,
e a resposta HTTP continua idêntica — a diferença só existe no diário, que só o dono lê. As mesmas contas de tentativa são a matéria-prima do pentest (`scripts/pentest.py`).
*Emenda (ADR-46): a conta da demonstração da instalação não trava pelo e-mail.* Na demonstração
que sobe com a loja (`/demo`: `settings.demonstracao` e `settings.conta_demo_protegida`), o e-mail
da conta das notas da Apple conta **só as falhas por IP** (`segundos_de_bloqueio(...,
por_email=False)`). O e-mail dela está nas notas da revisão e o endereço da demo vai na ficha
pública da App Store: dez senhas erradas a cada 15 min — uma por liberação, guiadas pelo
`Retry-After` — trancavam o revisor do lado de fora para sempre, de um IP só, sem nunca chegar ao
teto de 30 por IP. A trava por IP continua segurando a força bruta de uma origem, e a senha dela
não é de gente (20 caracteres sorteados pelo instalador). **Na Vercel, não**: lá a
`DEMO_ADMIN_SENHA` é escolhida por gente, no painel, e sem a trava por e-mail um chute distribuído
(um IP por tentativa) contra um e-mail conhecido não teria teto nenhum — então lá vale a regra de
sempre, e a proteção da ADR-45 (outra coisa) continua. Não vaza quem existe: a exceção é UM e-mail
conhecido de antemão (está na config e nas notas, não na resposta), e qualquer outro e-mail, exista
a conta ou não, segue com a resposta idêntica. Na loja de verdade `conta_demo_protegida` é vazia, e
a regra é a de sempre.

**ADR-25 — Em produção, a API não conta de si o que ajuda quem ataca.**
`settings.producao` é verdadeiro em qualquer ambiente que não seja `dev`/`test`/`local`. Nele,
`/docs`, `/redoc` e `/openapi.json` somem (o mapa da API não precisa ficar pendurado na porta
da loja), e toda resposta sai com `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY` e
`Referrer-Policy: strict-origin-when-cross-origin`. Não é segurança de verdade — é não entregar
de graça o que o atacante teria de descobrir sozinho. A checagem é uma propriedade só
(`config.py`), para "estamos em produção?" ter uma resposta e não várias.
CSP, HSTS e `Permissions-Policy` moram no **proxy** (`docker/caddy/Caddyfile`), que é quem fala com o
navegador. A CSP é a segunda barreira contra XSS (o access token mora em memória): `script-src
'self'` sem `'unsafe-inline'` — o único atributo de evento que existia (`onclick` do
`erroBloco`) virou delegação em `ui.js` —, `style-src 'self' 'unsafe-inline'` (estilo inline
existe nas telas e no recibo impresso), `img-src 'self' data: blob:` (ícone e prévia da foto),
`connect-src 'self'` mais o WebSocket da mesma origem, `frame-ancestors 'none'`. `/docs` e
`/redoc` ficam fora dela: o Swagger vem de CDN e só existe fora de produção. HSTS vai sempre
(o navegador o ignora em HTTP), por um ano e sem `includeSubDomains`. O proxy também põe **teto
no corpo do pedido, por rota** (`request_body`, na loja e na demo, ADR-46): as rotas de JSON leem
o corpo inteiro, na memória, ANTES de conferir o login; a da foto confere o login antes de ler
(§2.2) — até essa mudança, o arquivo ia num temporário sem teto, e um `PUT .../foto` de 40 MB
sem login ocupava 39 MB de disco até sair o 401 —, mas, com login, o envio inteiro ainda vai ao
temporário antes de a API recusar a foto grande. E o teto vale por pedido:
N conexões abertas, segurando o último byte, seguram N vezes ele (com 10 MB em toda rota, 20 JSON
no login sem conta levaram a API da loja de 91 para 290 MiB). Por isso cada rota tem o menor que
lhe cabe: **6 MB** no `PUT .../produtos/{id}/foto`, o único arquivo — a API recusa a foto acima
de 5 MiB com a frase dela (422), e as duas pontas a encolhem para 100–300 KB antes —, e **2 MB**
em todo o resto, que é JSON: o maior legítimo, a contagem do Inventário ou a Entrada de uma nota,
leva de 50 a 70 bytes por peça (venda e condicional a API limita a 200 e 100 itens). Os dois
`request_body` têm matchers que se excluem (empilhados, o menor valeria para a foto); rota nova
que receba arquivo precisa do seu, ou fica com os 2 MB. Acima do teto, o Caddy responde 413 e a
API nunca recebe mais que ele — o 413 é do **Caddy 2.7** em diante: o 2.6 responde 502 ao mesmo
corpo com `Content-Length`, e o `handle_errors` da demo exclui esse erro pela mensagem (`request
body too large`) para não chamá-lo de "demonstração desligada". O WebSocket do tempo real não
sente o teto: depois do upgrade, o Caddy liga as duas pontas sem ler corpo (e ele não oferece
WebSocket por HTTP/2, onde o socket seria o corpo). Na Vercel o teto é o da plataforma (4,5 MB,
ADR-42). `scripts/pentest.py` confere tudo isso no Caddy quando `PENTEST_PROXY` aponta para ele,
e no `docker/caddy/Caddyfile` quando não aponta — lido como o Caddy lê: comentário não conta,
`request_body` aninhado num `handle` não cobre o site, e o tamanho vem nas unidades do
go-humanize (`1.5MB`, `10Mi`). Rota nova que precise de origem de fora tem de entrar na CSP, ou o
navegador a bloqueia calado.

**ADR-26 — Nome e ramo da loja no banco, e o ramo troca palavras, não dados.**
O sistema nasceu para uma loja de roupas e o vocabulário foi junto ("peça", "tamanho", "cor").
Para servir a uma autopeças, a saída **não** foi generalizar o modelo: `product_variants` já tem
dois eixos de variação (`size`, `color`) que são genéricos — "a primeira coisa que varia" e "a
segunda". O que muda por ramo é o NOME que a tela dá a eles, e isso é uma tabela
(`app/core/segmentos.py`), não uma migration. Trocar o ramo da loja amanhã não move um dado de
lugar, e é por isso que a tela pode oferecer a troca sem medo — está escrito nela.
A identidade mora em `store_config`, uma linha só garantida por `CHECK (id = 1)`: no `.env` ela
exigiria acesso ao servidor para corrigir um acento, não entraria no `pg_dump` e cada ponta
precisaria de uma cópia. `GET /configuracao` é **aberto, sem login** — a tela de entrada mostra o
nome antes de existir sessão —, e por isso devolve só a fachada: nome, ramo, fuso e as palavras
da tela. Documento, telefone e endereço saem por `GET /configuracao/completa`, que pede sessão de
qualquer papel (a vendedora imprime o recibo, que leva os três). Abertos, eles entregavam a quem
digitasse a URL o CPF e o endereço de casa do dono MEI. O web lê a completa quando a sessão nasce
e a esquece quando ela cai (`loja.js`, `garantirDadosDaLoja` antes de imprimir); o app usa
`useDadosDaLoja` só dentro do grupo logado. `PATCH` é `CONFIGURAR_LOJA`, só do dono: o nome vai
impresso no papel que o cliente leva. A migration semeia a linha para a loja que já existia — sem
ela, um `GET` aberto teria de ESCREVER no banco para a tela se desenhar. Espelhos obrigatórios:
`web/js/loja.js` e `mobile/src/lib/segmento.ts`.

**ADR-27 — Filtro por período é sempre por DIA no fuso da loja, em intervalo meio-aberto.**
Toda tela manda `inicio`/`fim` como DIA (`YYYY-MM-DD`), nunca como instante: quem conhece
`settings.tz_loja` é o servidor, e é o único que pode. O router traduz com `app/core/datas.py`
— `inicio_do_dia` (00:00 do dia, com fuso) e `fim_exclusivo_do_dia` (00:00 do dia SEGUINTE) — e
o repositório compara `>= inicio AND < fim` contra a coluna crua, que é o que mantém em uso
`ix_sales_sold_at` e `ix_stock_movements_created_at`. Para agregar POR dia (caixa, relatórios)
vale o outro lado: `dia_da_loja(coluna)` = `AT TIME ZONE`, casando com os índices funcionais
`ix_sales_business_date` / `ix_sale_returns_business_date`. Nenhum dos dois se aplica a coluna
`Date` (`expenses.expense_date`): dia de calendário digitado por gente não tem fuso, e
convertê-lo empurraria toda despesa um dia para trás.
O intervalo é meio-aberto de propósito. A alternativa (23:59:59.999999 com `<=`) funciona
enquanto a coluna guardar microssegundo; um valor arredondado ao segundo transforma esse
instante na meia-noite seguinte, e o filtro passa a incluir o começo do dia de amanhã.
O ADR nasceu de um chamado real: às 22h43 de 23/08, "De 16/08 Até 23/08" na tela de Vendas
mostrava ZERO vendas, porque o parâmetro era `datetime` (meia-noite do COMEÇO do dia) e
ingênuo (lido como UTC) — 25 horas de erro somadas. O mesmo bug estava no extrato de estoque.
E `GET /configuracao` passou a devolver `timezone`, porque a ponta também precisa dele: o web
formatava o dia em UTC e a hora no fuso do navegador, e imprimia no recibo "24/08 22:43" —
um instante que nunca existiu.

**ADR-28 — Backup se configura na tela, mas quem copia é a máquina.**
Backup que só liga por SSH é backup que a loja não liga: o `--automatico` existia e o servidor
estava havia meses sem uma cópia sequer. Então a configuração virou tela (`Sistema > Backup`,
capacidade `GERIR_BACKUP`, só do dono) e mora em `backup_config`, uma linha com `CHECK (id = 1)`.
Mas **a API não faz backup**: quem tem `pg_dump`, `rclone` e o disco é o `backup.sh`, que lê essa
linha pelo banco e escreve o resultado de volta nela. É a separação do ADR-18 — a credencial do
Google não entra no contêiner que serve a loja, do mesmo jeito que o token do GitHub não entra.
O `rclone_token` **não tem rota de leitura**, nem para o dono: uma rota que devolvesse a
credencial seria uma porta a mais para a mesma chave, sem nada em troca.
A autorização do Google acontece no COMPUTADOR do dono (`rclone authorize "drive"`), porque VPS
não tem navegador; ele cola o JSON na tela, uma vez.
A rotação mantém `manter` cópias ordenando por NOME (`loja-AAAAMMDD-HHMMSS.dump`) e não por data
do Drive: o nome é nosso, o relógio do Drive não. E o timer bate de 5 em 5 min só para PERGUNTAR
ao banco se já passou `intervalo_min` — assim o horário mora na tela, e trocar 30 por 60 minutos
não exige `systemctl` nem SSH. "Ligado?" é perguntado como `CASE WHEN ativo THEN 1 ELSE 0 END`:
`true::text` é 'true' (o 't' é só como o psql mostra a coluna crua), e comparar com "t" fez o
backup ligado nunca rodar, sem erro. No disco a cópia da nuvem se chama `loja-nuvem-…` (no Drive
continua `loja-AAAAMMDD-HHMMSS.dump`), e a faxina de 12 h só apaga essas: com o nome do backup
diário ela levava junto as diárias e o dump de segurança do `--restaurar`. As unidades do systemd
levam `Environment=HOME=/root` — serviço sem `User=` não recebe HOME, e o script usa `set -u`.
Os campos `ultimo_*` existem porque "ligado" e "ligado e quebrado" são a mesma tela sem eles: o
que dá confiança é "há 12 minutos, 4,2 MB, 10 cópias no Drive".
**O que sai da máquina sai cifrado, com uma chave que só a máquina tem.** O dump ia em claro para
o Drive e para o `BACKUP_REMOTO`: quem entrasse no Google do dono levava CPF e telefone das
clientes, hashes de senha, o diário com IPs — e o próprio `rclone_token`, que mora numa coluna
e vai dentro do dump. Agora `loja:` é um remote `crypt` do rclone por cima de `loja-drive:` (e o
`BACKUP_REMOTO` ganha um `crypt` definido por variável de ambiente, sem mexer no rclone de quem
cuida do servidor). `filename_encryption = off`: no Drive o arquivo é
`loja-AAAAMMDD-HHMMSS.dump.bin`, o nome mostra a data e a rotação por nome continua igual; o
conteúdo é que não abre. A chave nasce na máquina (`backups/.chave-do-backup`, 600, 24 letras
sem as que se confundem no papel) e **não** vai para o banco (iria dentro do dump que protege),
nem para o `.env` (que o docker compose, o instalador e os outros scripts leem, que se abre para
editar e que vai junto quando a configuração é copiada para outra pasta ou máquina — a chave mora
só naquele arquivo, que só o `backup.sh` lê), nem para `docker/estado/` (montado na
API, que nunca vê credencial). Sem ela a cópia não abre, então ela é mostrada UMA vez ao nascer
com alguém no terminal (o instalador), nunca no journal (pelo timer sai só o recado, também no
celular), e `--mostrar-chave` a mostra de novo. `--restaurar` reconhece a cópia cifrada pelo
cabeçalho `RCLONE` e a abre ANTES de perguntar e de parar a API — chave errada não custa a loja
fora do ar —, tentando a `CHAVE_DO_BACKUP` do ambiente, a da máquina e a digitada; numa máquina
nova, a chave que abriu passa a ser a dela. Limite conhecido: as cópias de antes, em claro, o
crypt não enxerga — continuam legíveis no Drive até o dono apagá-las à mão.

**A cifra só liga com a chave confirmada por uma pessoa** (`backups/.chave-confirmada`, gravado
pelo "SIM" do `--mostrar-chave` interativo, pelo `--confirmar-chave` ou por uma restauração que
abriu a cópia com a chave digitada). Nas lojas já instaladas a chave nasce pelo TIMER, sem
terminal, e ninguém a vê: cifrar com ela trocava "backup legível no Drive" por "backup que não
abre" — o disco morre e leva a única chave junto, no dia exato em que a cópia de fora importa.
Até a confirmação, `loja:` é um `alias` do Drive (e o `BACKUP_REMOTO` recebe o dump direto):
a cópia sai como sempre saiu, e cada cópia repete o aviso, no journal e pelo `notificar.sh`.
**Trocar o destino pede a senha de novo.** Com uma sessão do dono esquecida aberta no balcão,
colar o próprio token mandava o banco inteiro para o Drive de outra pessoa a cada 30 min — e
continuava depois de o dono trocar a senha. `PUT /backup` que troque o token ou a pasta de um
backup JÁ conectado exige `senha_atual` (conferida por `verificar_senha_async`); sem ela, ou
errada, é `422 VALIDACAO` com `detail.campo = "senha_atual"` — 422 e não 401, porque um 401
derrubaria a sessão de quem só errou a senha. Ligar, desligar, intervalo e quantas cópias
seguem sem senha: não levam o banco a lugar nenhum novo. A primeira conexão (sem token gravado)
ainda não pede; segundo fator para o dono também não existe — os dois são decisão do dono.
**"Atrasado" é do servidor.** O selo dizia "Funcionando" olhando SE a última cópia deu certo,
nunca QUANDO: um timer parado ou um rclone travado não gravam nada. `BackupOut.atrasado` é
verdadeiro quando o backup está ligado e a última cópia (ou, sem nenhuma, a última vez que a
configuração foi salva) passou de 2× `intervalo_min`. A tela (web e app) mostra "Atrasado" em
tom de alerta, e a barra lateral do web e a aba Mais do app ganham um selo para o dono, no
desenho do selo de versão, só quando há problema (atrasado ou falhou).

**ADR-29 — Mercadoria entra por uma porta só; o cadastro não põe estoque.**
O cadastro tinha `estoque_inicial` e existia a Entrada: duas portas para o mesmo efeito. O dono
perguntou, duas vezes, onde registrar a compra do fornecedor — e tinha razão em achar redundante.
Nos ERPs de referência (Bling, Tiny) o cadastro de produto é CATÁLOGO: diz o que a peça é, não
quanto tem. Estoque entra por nota/entrada, sempre.
Agora é assim: `POST /produtos` cria a peça com saldo zero, e `POST /estoque/entradas` é o único
caminho de entrada. O ganho não é só de clareza — antes, a PRIMEIRA compra de cada peça não
guardava fornecedor nem custo de compra e não aparecia no extrato como entrada; era um buraco no
histórico bem no momento em que a peça nasce.
Para não custar um passo, o cadastro leva a grade recém-criada para a Entrada, com quantidade
zero. Zero de propósito: quem diz quanto chegou é quem conferiu a caixa; sugerir 1 seria um número
inventado entrando no estoque. No celular as duas chamadas acontecem juntas, porque o cadastro de
lá costuma ser o cadastro rápido do PDV, com a cliente esperando no balcão — mas o estoque entra
pelo mesmo endpoint, com o mesmo rastro.
Sobram então DUAS telas que mexem em saldo, com verbos opostos e inconfundíveis: Entrada SOMA,
Inventário SUBSTITUI.

**ADR-30 — Quem decide pelo saldo trava a peça e o saldo; o que volta da cliente nunca cai
em peça excluída.**
Três defeitos com a mesma raiz: decidir com um número lido sem trava e escrever depois.
O inventário lia o saldo solto e aplicava a diferença por soma — duas contagens de 8 sobre 10
liam 10 as duas, aplicavam −2 cada uma, e o saldo ia a 6. A exclusão de peça/produto conferia
"saldo zero" solto, e uma Entrada do mesmo instante somava estoque numa peça que saía do
catálogo. E a terceira nem precisava de corrida: a peça esgota, a dona a exclui (saldo zero,
permitido), a venda é cancelada ou devolvida — e as peças voltavam para uma variante excluída,
fora da tela de Estoque, sem bipe (404) e recusada por Entrada, Ajuste e Inventário.
**A ordem das travas é uma só: a linha da PEÇA (`product_variants`), depois a do saldo**, as
duas por id. Inventário trava as peças contadas e os saldos (`movimentos.travar_saldos`, `FOR
UPDATE`) antes de calcular; a exclusão trava a grade inteira — inclusive as peças já excluídas,
que uma devolução pode estar reativando — e os saldos antes de conferir; e todo movimento
**positivo** passa por `catalogo.service.peca_que_recebe`, que trava a peça antes do saldo. A
trava da peça é `FOR NO KEY UPDATE`: não briga com o `FOR KEY SHARE` que a FK de cada venda tira
dela, então vender não espera ninguém. É ela que cobre a peça sem linha de saldo (onde `FOR
UPDATE` não teria o que travar). Quem chega depois enxerga o que o outro gravou: a exclusão vê o
saldo novo e recusa, ou a Entrada vê a peça excluída e responde 404.
**Peça que volta da cliente (ESTORNO, DEVOLUCAO) em peça excluída não é recusada** — está
fisicamente na loja. Se outra peça ativa tem a mesma etiqueta (a dona recadastrou), é ela que
recebe: mesma etiqueta é a mesma peça, e é ela que o bipe acha. Senão, a ativa do mesmo produto,
tamanho e cor (o UNIQUE da grade diz que é a mesma peça; reativar a antiga estouraria esse
UNIQUE). Senão, a peça volta ao catálogo, e o produto junto se saiu com ela. O extrato registra o
desvio ou a reativação na observação do movimento. Tudo dentro de estoque/catálogo:
`aplicar_movimento` pergunta ao catálogo (import tardia, porque o catálogo importa
`movimentos`), e vendas não muda.
Limites conhecidos: o desvio para a peça de mesma etiqueta pode travar fora da ordem de id —
duas devoluções cruzadas de várias peças podem, em tese, cair num deadlock, que o Postgres
desfaz abortando uma delas (que se refaz). A categoria excluída não volta junto com o produto:
o produto reaparece com o nome da categoria, só fora do filtro por categoria.

**ADR-31 — Índice só entra medido, e a consulta escreve a expressão do índice letra por letra.**
Num banco de três anos simulados (200 mil vendas, 400 mil itens, 15 mil peças, 20 mil
clientes) a tela Clientes ("quem está devendo", a que abre por padrão) levava 49 s: a dívida de
cada cliente somava as vendas dela por um índice onde `customer_id` era a 2ª coluna. A
migration `3f9c1a7e5b20` cria só o que o `EXPLAIN` mostrou valer: `sales(customer_id)` parcial
(49 s → 0,5 s), `sale_items(sale_id) INCLUDE (...)` (CMV de 30 dias 32 → 10 ms, sai do índice),
`sale_payments ... WHERE method = 'FIADO'` (vendido a prazo 13 → 5 ms), `customer_payments` pelo
dia da loja (caixa do dia 5 + 6 → 0,04 ms), `stock_movements(created_at)` (contar um mês do
extrato 23 → 1,5 ms; o ADR-27 já contava com ele) e o trigram do nome e da cor achatados.
Medidas no scratch da revisão; o que não mudou o plano ficou de fora.
**Busca por nome**: `pg_trgm` (extensão *trusted* desde o PG 13: o dono do banco instala sem
superusuário, e vem no `postgres:16-alpine`) com GIN sobre `translate(lower(...))` — a MESMA
expressão de `catalogo/busca.py`. As tabelas de acento vão no SQL como **literal**, nunca
como parâmetro: com `$2`/`$3` no meio, o plano genérico que o asyncpg reaproveita depois da
quinta execução não casa com índice de expressão nenhum. E o produto é filtrado antes de
encostar nas peças (`id IN (UNION de ids)`, cada ramo numa tabela só, cada um no seu índice):
o `OR` sobre o JOIN achatava o catálogo inteiro a cada tecla. "calca" 47 + 34 ms → 13 + 14 ms
(página + contagem); termo que não existe 34 + 38 → 1 + 1 ms. Mudar a tabela de acentos pede
migration que recrie os dois índices; `test_busca_por_nome_usa_o_indice_trigram` (plano
genérico da consulta REAL, `tests/planos.py`) quebra se esquecerem.
**Contagem da paginação conta só a tabela base** quando os JOINs são 1:1 por FK obrigatória
(vendas → vendedor; extrato → peça, produto, usuário; saldos → categoria): o total é o mesmo
e o extrato sem filtro caiu de 107 para 19 ms. JOIN que FILTRA (produto excluído, nome) fica.
**Vendas listam pelo instante** (`sold_at DESC, id DESC`): por id, "março do ano passado"
descia a chave desde a venda mais nova e descartava 170 mil linhas (43 ms) — agora desce
`ix_sales_sold_at` direto do período (0,1 ms).
**`statement_timeout` por conexão da API** (`DB_STATEMENT_TIMEOUT_MS`, 30 s): o app desiste em
15 s e o retry manda a mesma consulta; sem teto, a primeira seguia ocupando o banco. A
migration e o `pg_dump` usam conexão própria e não herdam o teto.
Limites conhecidos: termo de 1 ou 2 letras não tem trigrama e continua varrendo (~30 ms);
página funda (`page=5000`) ainda paga o OFFSET; o extrato ainda ordena por id com o filtro em
`created_at` (o mesmo desenho que as vendas tinham — não pesou no banco simulado, mas é o
próximo candidato); `dia_da_loja` manda o fuso como parâmetro, e os índices de dia casam no
plano com os valores, que é o que o Postgres mantém enquanto o genérico sair mais caro.

**ADR-32 — Aviso sai da máquina, sem virar barulho.**
Loja caída, disco enchendo, backup parado e atualização falhando só existiam no journal, e quem
descobria era a vendedora com fila no caixa. Três peças, todas na máquina (a API continua sem
saber de canal nenhum): o `notificar.sh` manda para o tópico do ntfy em `NOTIFICAR_URL` (no
`.env`, perguntado pelo instalador; sem ele, fica em `journalctl -t loja-aviso`), com o título em
RFC 2047 porque cabeçalho HTTP é ASCII; toda unidade da loja leva `OnFailure=loja-aviso@%N.service`,
uma unidade-modelo só, gravada pelo próprio `notificar.sh --instalar`; e o `vigia.sh`, de 5 em 5
minutos, confere o `/health` (de dentro do contêiner, como o atualizar), o disco (>90%, o maior
entre a pasta do sistema e a do Docker) e o backup da nuvem (ligado e sem cópia há mais de 2× o
intervalo, lido do banco; sem cópia nenhuma, conta desde o `updated_at`). Contra o barulho: o
mesmo assunto não se repete antes de uma hora (carimbo em `docker/estado/avisos/`, gravado só
quando o envio deu certo — ntfy fora do ar não silencia o próximo), o vigia lembra a cada 6 h
enquanto durar e avisa quando volta, e a API fora só avisa na **segunda** conferida seguida:
uma atualização normal fica fora um ou dois minutos e não pode virar alarme. O vigia não tem
`OnFailure=` (ele mesmo avisa), e o `desinstalar.sh` desliga as rotinas, senão o celular de quem
acabou de desligar a loja receberia "loja fora do ar" — e a atualização sozinha a ligaria de novo.

**ADR-33 — IP da rede da loja é instalação local; IP público exige domínio.**
O instalador tratava QUALQUER IP como "sem DNS", e sem DNS virava `AMBIENTE=local`: numa VPS
acessada pelo IP público, `/docs` aberto na internet, CORS refletindo qualquer origem com
credenciais, e senha, token e CPF em HTTP puro. Ser um IP não diz que o ambiente é de
desenvolvimento; dizer que a rede é da loja, sim. Local é vazio, `localhost` ou 10/8,
172.16/12, 192.168/16 e 127/8 — ali HTTP é o esperado, não há certificado público para o que a
internet não alcança. Qualquer outro IP é **recusado** (não "instalado com aviso": o aviso no
fim não fecha a porta que a instalação abriu), inclusive num `.env` reaproveitado, com o caminho
na mensagem: um domínio, ou `<ip>.sslip.io`, que aponta para o IP e deixa o Caddy emitir o
certificado. O `instalar.ps1` espelha a regra (`IpDeRedeLocal`) — mudou um, mude o outro.

**ADR-34 — O que vai para a loja é o que o CI testou, uma vez por commit.**
O `pyproject.toml` só tinha `>=`, e o Dockerfile instalava a versão do DIA: o que rodava na loja
dependia de quando o build aconteceu, e a volta atrás podia reconstruir o código velho com as
bibliotecas novas que o derrubaram (foi uma resolução nova do pytest-asyncio que quebrou 162
testes de uma vez). Agora `api/requirements.lock` tem as versões exatas do fecho de
`[project.dependencies]` (com os extras usados), gerado do venv em que a suíte passou e
conferido para o Python 3.12 da imagem; `requirements-dev.lock` tem só o que os testes somam. A
imagem instala com `--no-deps` e roda `pip check` (faltou alguém na trava, o build reprova, não a
API no import); o CI instala as duas travas e o projeto com `--no-deps`. O pyproject segue com
`>=` (é o que o código aceita); quem decide o que vai para a loja é a trava. Sem hashes por ora:
gerá-los pede baixar as distribuições. O CI roda uma vez por commit (push só no `main`, mais
pull request; PR cancela a rodada velha, o `main` não, porque o atualizar depende da resposta) e
cobre o que ficava de fora e já quebrou: `npm test` e o bundle do app, a imagem Docker, o
`shellcheck -S warning` dos scripts e um job com a API no ar rodando `e2e.py` e `pentest.py`
(qualquer achado reprova). É dessa resposta que o ADR-18 depende.

**ADR-35 — A taxa da maquininha é fotografada no pagamento, e o Resultado a desconta.**
Débito e crédito custam de 2 a 5% sobre a maior parte do faturamento; sem isso o "Resultado" saía
inflado todo mês. O dono cadastra o contrato numa tabela (`card_fees`: forma, faixa de parcelas,
percentual e dias para cair na conta) e a venda **copia** a taxa e o prazo que valiam naquele
instante para `sale_payments.taxa_percentual` e `prazo_dias` — o mesmo princípio do custo
congelado em `sale_items`: renegociar o contrato amanhã não reescreve o resultado de ontem, e
apagar uma linha da tabela não mexe em venda nenhuma (por isso é DELETE de verdade). Sem taxa
cadastrada para a forma e as parcelas, a venda segue com 0% e o prazo de mercado (débito D+1,
crédito D+30): a taxa é informação de gestão, nunca trava de balcão — e 0% é exatamente o que o
resultado já assumia antes. **Quem muda é o dono** (`CONFIGURAR_LOJA`): é o contrato que ele
assinou e mexe no resultado de toda venda dali em diante; **quem lê é quem vê dinheiro**
(`VER_DINHEIRO`): o gerente lê o Resultado que já desconta a taxa e precisa conferir de onde ela
veio. A vendedora escolhe parcelas (1 a 12, só no crédito — o banco recusa "débito em 3x") e
bandeira (texto livre, opcional), mas não vê taxa: ela sai só no schema de quem vê dinheiro.
`taxas_cartao` no resumo é Σ `round(valor × taxa / 100, 2)` por pagamento — o mesmo
arredondamento que a venda mostra, para os dois baterem centavo a centavo —, e a devolução
devolve a taxa da parte que voltou pelo cartão **no período da devolução** (ADR-19), na
proporção da taxa que aquela forma pagou naquela venda (a devolução diz por qual forma voltou,
não por qual pagamento). A conta é **acumulada** por venda e forma: `round(taxa paga × devolvido
até esta devolução / recebido pela forma) − round(taxa paga × devolvido antes dela / recebido)`,
com teto na taxa paga. Arredondar cada devolução sozinha devolvia mais do que a venda pagou —
R$ 10,00 a 2,5% pagam 0,25, e duas devoluções de R$ 5,00 devolviam 0,13 + 0,13, deixando
`taxas_cartao` negativo; acumulada, a soma telescopa e devolver tudo devolve a taxa paga,
cravada. O resumo e o estorno da agenda usam a mesma expressão (`relatorios/cartao.py`). A
agenda de recebíveis (`/relatorios/recebiveis`) quebra o crédito em parcelas — a 1ª em D+prazo,
as outras de 30 em 30 dias, o centavo da divisão na 1ª, como faz a credenciadora — e debita o
estorno no dia da devolução; é uma simplificação (há credenciadora que cancela as parcelas
futuras em vez de debitar), mas a soma fecha e o passado não muda. Ficou de fora:
taxa por bandeira, antecipação de recebíveis e taxa no recebimento de fiado em cartão.

**ADR-36 — Cliente em qualquer venda, por uma porta de balcão que não vê dinheiro.**
A cliente só existia para o fiado, e só o gerente cadastrava: a loja não formava base de
clientes ("chegou a coleção no seu tamanho", aniversariante do mês). A venda já aceitava
`customer_id` em qualquer forma; faltava o balcão poder buscar e cadastrar. A capacidade nova
`ATENDER_CLIENTE` é de todos os papéis (a vendedora deixa de ter tabela vazia) e abre só
`/clientes/balcao` e `/clientes/aniversariantes`, que respondem `ClienteBalcaoOut` — um schema
**próprio**, que não herda de `ClienteOut`: herdar traria `deve`, `limite` e `acima_do_limite`
para a tela da vendedora no primeiro campo novo que alguém pusesse lá. Também ficam de fora o
documento e a observação do crediário, que guarda combinados de cobrança. No balcão o documento
só casa **inteiro**, por igualdade: por trecho, "a Maria aparece?" virava oráculo, e um dígito
por vez a vendedora remontava o CPF que a resposta esconde. O tamanho não entra na regra —
o cadastro aceita RG e CPF sem o zero da frente, e casar só 11 ou 14 dígitos deixava esse
documento inteiro sem achar ninguém; a igualdade já fecha o oráculo. Só há um piso de 7
dígitos, abaixo do qual a igualdade vira chute de poucas tentativas. A busca por trecho do
documento fica no crediário (`GERIR_CREDIARIO`), que já o vê; o telefone segue por trecho nas duas portas, porque ele volta. O fiado continua sendo
`GERIR_CREDIARIO`: vender fiado é abrir uma dívida que alguém vai cobrar. O cadastro de balcão é idempotente por `client_uuid` (a rede caindo depois
de gravar não faz a cliente nascer duas vezes; a mesma chave com outra pessoa é 409), e
`nascimento` e `preferencias` entram na anonimização da exclusão (LGPD). No PDV, tirar o fiado
não tira mais a cliente da venda: ela continua sendo quem comprou. O histórico de compras é
`GET /vendas?cliente_id=`, com o escopo de sempre — a vendedora vê só as que ela fez. Editar
preferências pelo balcão ficou de fora (é do crediário, por enquanto).

**ADR-37 — Comissão sai do líquido de quem vendeu, e só o dono diz quanto.**
A loja paga comissão e o dono somava `/vendas` à mão, página por página, sem abater devolução.
`users` ganha `comissao_percentual NUMERIC(5,2) NOT NULL DEFAULT 0` (CHECK 0–100) e `meta_diaria
NUMERIC(14,2) NULL` (CHECK > 0; sem meta é `NULL`, não zero). A conta (`relatorios/vendedoras.py`):
**líquido = vendas concluídas no período − devoluções no período**, a devolução entrando no dia
em que aconteceu (ADR-19) e na conta de quem fez a venda ORIGINAL — quem só atendeu a troca não
perde nada. Assim um mês fechado nunca muda (a folha paga continua certa) e a blusa vendida em
outubro que voltou em novembro estorna a comissão em novembro; um período só de devolução tem
líquido e comissão **negativos**, de propósito: é o estorno, e escondê-lo daria a comissão de
graça. Cancelada não conta (cancelar desfaz a venda inteira). **A % é a da VENDA**, não a de
hoje: `sales.comissao_percentual` fotografa a % de quem vende no `registrar` — como o custo em
`sale_items` e a taxa da maquininha em `sale_payments` (ADR-35) —, e as vendas de antes da
coluna herdaram a % que a pessoa tinha na migration (a conta que o relatório já fazia). Sem
isso, o dono baixar a % de 5 para 3 reescrevia o mês já pago (R$ 50 viravam R$ 30) e a blusa
que voltasse depois estornava 3% do que tinha pago 5%. `comissao = (Σ total × % da venda −
Σ refund_amount × % da venda ORIGINAL) ÷ 100`, somado exato no banco e arredondado **uma vez
por pessoa**, meio centavo para cima (por venda, a soma derivaria meio centavo a cada uma). A
coluna `comissao_percentual` da resposta continua sendo a % de HOJE — a que o dono configurou
e mudaria; a % da venda não sai em resposta nenhuma de venda (a vendedora não a vê). Num
período em que a % mudou, `líquido × % de hoje` NÃO dá a comissão da linha, e a ajuda da tela
da equipe e do campo Comissão (%) diz isso (web e app): mudar a % vale daí em diante. Ticket
médio = vendido ÷ nº de vendas, a mesma conta do resumo. A soma da equipe fecha **centavo por
centavo** com o `faturamento_liquido` do resumo (teste). Cada fonte é somada por vendedora
antes de juntar (três `GROUP BY seller_id` num `UNION ALL`), e a equipe inteira vem numa
consulta: são dezenas de pessoas, então a página é recortada em Python e os totais
(`faturamento_liquido_total`, `comissao_total`) valem para o período todo — a folha paga a
equipe, não a página. No banco de três anos: mês 1,6 ms, ano 79 ms.
**Quem define**: capacidade nova `DEFINIR_COMISSAO`, só do dono. `GERIR_USUARIOS` não basta: o
gerente também recebe comissão, e um PATCH no próprio id dobraria o próprio salário — a mesma
lógica do `_barrar_escalada`. Mandar o campo sem a capacidade é **403**, mesmo com o valor de
hoje: um "ignorei" silencioso faria a tela dizer que salvou. Ausente = não mexe; `meta_diaria:
null` tira a meta; `comissao_percentual: null` é 422 (zero se diz com zero).
**O balcão vê o próprio dia** em `GET /relatorios/meu-dia`, aberto a qualquer login: o id sai
do token (nunca da URL), e a resposta tem só vendido, peças, meta e quanto falta — sem custo,
lucro nem a % (o dinheiro da loja continua nos schemas de quem vê dinheiro). É a MESMA conta do
relatório do dono para aquele dia. O PDV web e o app mostram "Hoje: R$ X de R$ meta" quando há
meta; a régua refaz com o aviso de `vendas` (venda de outro balcão) e de `usuarios` (o dono
mudou a meta), só ela — redesenhar o PDV apagaria o carrinho.

**ADR-38 — Giro do estoque: parada pela última venda, ABC pelo líquido, valor da loja inteira.**
Roupa é sazonal e o capital na arara é o maior ativo da loja; os dados já existiam
(`stock_movements` e saldo × preço), faltava a pergunta (`relatorios/giro.py`).
**Estoque parado** (`?dias=90`, 1–3650): peça com saldo > 0 cuja última `VENDA` tem MAIS de N
dias, ou que nunca vendeu e cuja última `ENTRADA` tem mais de N dias. "Parada desde" =
`coalesce(última venda, última entrada, cadastro da peça)` — o cadastro cobre o saldo que veio
de ajuste, inventário ou do cadastro antigo (antes do ADR-29), que senão sumiria do relatório.
Os dias contam no calendário da loja; exatamente N dias ainda não entra. Cada data é um `max()`
correlacionado que desce `ix_stock_movements_variant_id_created_at` de trás para frente — uma
leitura curta por peça com saldo, sem agrupar os anos de movimento; a de entrada só roda para
quem nunca vendeu (o `COALESCE` é preguiçoso). Banco de três anos, 8 mil peças com saldo:
60–110 ms por consulta (contagem+totais e página), boa parte dela o JIT que o custo estimado
dispara. Os parciais `(variant_id, created_at) WHERE movement_type = 'VENDA'` (e `'ENTRADA'`)
foram medidos: 30–60 ms, com Index Only Scan — e ficaram de fora, porque cobrariam uma escrita
de índice a mais em TODA venda para um relatório que o dono abre poucas vezes por dia. Os totais (`pecas_total`, `valor_em_custo_total`,
`valor_em_venda_total`) são de TODAS as peças paradas. Limite conhecido: a última VENDA de uma
venda depois cancelada continua contando como venda (o movimento existe).
**Curva ABC** (`?inicio&fim`): produto (não variante) por faturamento líquido no período — o
item com o desconto da venda rateado (`preço × qtd × total ÷ subtotal`, a mesma conta do
`refund_amount`) menos o devolvido no período. Somar o preço cheio contra a devolução rateada
inflaria quem vende com desconto. **A devolução vale pela MESMA régua do vendido**: `qtd
devolvida × preço × total ÷ subtotal` da venda ORIGINAL, sem arredondar — não o
`refund_amount`, que é arredondado no centavo a cada linha (e a última devolução da venda
absorve o resíduo). Com o `refund_amount`, a blusa de um rateio de 9,3333 voltava como 9,33 e
sobrava R$ 0,0033 por devolução; duas vendas, ou duas blusas do mesmo item devolvidas uma de
cada vez (a venda não zera, ninguém absorve), somavam R$ 0,0067 e a blusa sumida aparecia na
curva com 0 peças e R$ 0,01. Pela mesma régua, peça que volta inteira zera, quantas vendas e
devoluções forem (a devolução junta `sale_items` e `sales` pela PK). O custo: a soma da curva
pode diferir do faturamento líquido do Resultado pelos centavos do arredondamento do reembolso
— a curva ordena produtos; quem fecha com a gaveta é o Resultado. Só entra quem teve líquido > 0 no centavo
(`round(líquido, 2) > 0`; a divisão deixa ~1e-16 entre "2 peças" e "1 + 1 peça"). Produto só
com devolução puxaria o acumulado acima de 100% e de volta. A classe vai pelo acumulado ANTES do produto: A
enquanto ele é < 80%, B < 95%, C o resto — quem cruza a linha dos 80% ainda é A; pelo acumulado
"inclusive", um campeão que sozinho faz 90% seria B e a loja ficaria sem nenhum A. Janela
(`sum() OVER`) antes do `OFFSET`, então a página 2 continua o acumulado da 1. Ano: 127 ms.
**Valor do estoque**: peças, variantes com saldo, saldo × custo e saldo × preço de venda da loja
INTEIRA (peça excluída fica de fora, como em toda tela de estoque) — é o número que a tela
Saldos não podia dar, porque soma só a página. 9 ms.

**ADR-39 — Condicional tira a peça do saldo; o fechamento devolve TUDO e vende o que ficou.**
A peça que ia para a casa da cliente provar continuava "disponível": o balcão podia vendê-la de
novo, ou a vendedora simulava venda + devolução e sujava faturamento, taxa de devolução e caixa.
Agora abrir a condicional (`POST /condicionais`, cliente obrigatória, prazo, itens, `client_uuid`)
tira as peças do saldo por um movimento próprio, `CONDICIONAL_SAIDA`, pela porta de sempre
(`movimentos.aplicar_movimento`, ordenado por `variant_id`, com o CHECK do saldo como rede).
Fechar informa quantas VOLTARAM de cada peça — todas, conferidas uma a uma — e, se algo ficou,
os pagamentos. O fechamento devolve **tudo** ao estoque (`CONDICIONAL_RETORNO`) e registra o que
ficou pelo `VendaService.registrar` público, com a cliente da condicional: não existe um segundo
caminho de venda, e o que ficou entra no caixa, no faturamento, na comissão, tem recibo e pode
ser devolvido depois como qualquer venda (preço de hoje, ADR-4; fiado continua pedindo o
crediário). Retorno, venda e `consignments.sale_id` vão no MESMO commit — por isso o
`registrar` ganhou `confirmar=False` (grava sem commit; a transação é de quem chamou). A
transição é `UPDATE ... SET status='FECHADA' WHERE status='ABERTA'` (o mesmo padrão do
cancelamento de venda): dois aparelhos fechando ao mesmo tempo, um fecha, o outro recebe 409.
A abertura é idempotente pela chave dela, que as duas telas criam com a tela e só trocam
depois do sucesso (como o PDV e a Entrada): mexer na sacola, na cliente ou no prazo depois de
uma resposta perdida NÃO troca a chave — trocar abria uma segunda condicional e tirava as peças
do saldo de novo. Mesma chave com outra cliente, prazo ou peças → 409 `DUPLICADO` com
`detail.condicional_id`, e a tela diz "esta condicional já foi aberta (#id)" e leva a ela.
O fechamento é idempotente pela chave dele, que é também a chave da venda: reenvio igual → 200;
mesma chave com outro retorno ou outra cobrança → 409 `DUPLICADO`. "Outra cobrança" é a régua
do reenvio do PDV (`VendaService._cobrada_assim`, que o `_replay` de `POST /vendas` e o
`mesma_cobranca` do fechamento usam): forma, valor, parcelas, bandeira, código do vale e
desconto — crédito 1x reenviado como 3x, ou o mesmo valor em OUTRO vale, não é o mesmo pedido.
Outra chave numa condicional já fechada → 409 `OPERACAO_INVALIDA`. No crédito, as telas perguntam parcelas
(1 a 12) e bandeira como o PDV (ADR-35) — sem isso toda condicional parcelada virava 1x, com a
taxa e a agenda de recebíveis do à vista. A peça que volta entra no `_VOLTA_DA_CLIENTE` do
ADR-30: a última blusa vai para a sacola, o saldo zera, alguém exclui a peça achando que esgotou
— e a blusa volta ao catálogo em vez de ser recusada. Se a dona já a recadastrou (mesma
etiqueta ou mesma grade), o retorno vai para a peça ativa, e o que ficou com a cliente é
vendido DESSA peça (a que `aplicar_movimento` devolve como a que recebeu), nunca da excluída —
vender a excluída dava 404 e a condicional não fechava. E pelo preço DELA: enquanto a
condicional está aberta, o `preco_venda` de um item cuja peça foi excluída é o da peça que vai
recebê-lo (`catalogo.pecas_que_receberiam`, a regra do ADR-30 sem travar nem reativar), porque
é por ele que a tela cobra e é ele que a venda confere — recadastrada com outro preço, a tela
cobrava o da excluída e a venda pedia o da nova (422 sem saída). O extrato diz "Condicional
#12", nunca o nome da cliente: o extrato é append-only e a exclusão de cliente apaga o dado pessoal (LGPD). Capacidade
nova `FAZER_CONDICIONAL`, da vendedora em diante; todas veem todas (a cliente devolve a sacola a
quem estiver no balcão). A resposta não tem custo nem margem: só o preço de venda, que o balcão
já vê. "Vencida" é `prazo < hoje_na_loja()` — vence no dia SEGUINTE ao prazo.

**ADR-40 — Contas a pagar do fornecedor nascem na Entrada e ficam FORA do Resultado.**
A coleção comprada em 30/60/90 é a maior saída de dinheiro da loja, e não tinha onde morar: o
caminho natural, lançar o boleto em Despesas, contava o mesmo custo duas vezes — o Resultado já
desconta a mercadoria pelo CMV, no dia em que a peça é VENDIDA. `payables` é o calendário de
saída de dinheiro, não custo do mês: nenhum relatório a lê, e a tela diz isso. A nota entra pela
Entrada (`nota: {numero?, valor_total, parcelas:[{vencimento, valor}]}`), que cria uma conta por
parcela ligada a ela, na MESMA transação: se a mercadoria não entra, a dívida também não, e a
chave da Entrada protege as duas — o reenvio compara também a nota (outro valor ou outro
vencimento com a mesma chave → 409, com a nota gravada em `detail.nota` para a tela não
lançá-la de novo junto com o resto, ADR-2). As parcelas vêm prontas da tela (a sugestão 30/60/90 e o
centavo que sobra são de `lib/parcelas.ts` / `js/parcelas.js`); o servidor só confere que
somam a nota. Quem vê dinheiro vê, lança e paga (`VER_DINHEIRO`); a vendedora dá entrada SEM a
nota, e a nota vinda dela é recusada (403), não ignorada como o custo — ignorar deixaria a loja
achando que o boleto foi lançado. Pagar é `UPDATE ... WHERE paid_on IS NULL` com dia (não no
futuro) e forma; o reenvio igual é atendido, outro pagamento por cima é 409; conta paga não se
edita nem se exclui sem desfazer o pagamento antes. Pagar em dinheiro NÃO mexe na conferência
do caixa (sangria é decisão em aberto). `GET /contas-pagar/resumo` (vencidas, próximos 7 dias,
em aberto — três somas no índice das abertas) é o aviso de quem olha o dinheiro: no topo da tela
de contas, num selo da barra lateral do web e na aba Financeiro do app.

**ADR-41 — NFC-e por emissor terceirizado, ligado só pelo `.env`; a nota cai antes da venda.**
A loja não fala com a SEFAZ: quem assina e transmite é um emissor contratado pelo dono (Focus
NFe, NFE.io, PlugNotas...), que guarda o certificado A1 e o CSC. O módulo `fiscal` tem a
interface `Emissor` (emitir, consultar, cancelar) e um adaptador, o da **Focus NFe** (API v2 de
NFC-e, `focusnfe.py`). O padrão é **desligado**: as rotas respondem 409
`EMISSOR_NAO_CONFIGURADO` com `detail.faltando`. Liga-se por `FISCAL_EMISSOR=focusnfe`,
`FOCUSNFE_TOKEN` e `FOCUSNFE_AMBIENTE=homologacao|producao` — e **o token nunca vai ao banco nem
sai por rota**, nem para o dono (`SecretStr`; mesma régua do ADR-28): quem tem esse token emite
nota no CNPJ da loja. *Dados fiscais:* NCM, CEST, origem e CFOP no PRODUTO (a grade é a mesma
mercadoria); regime (CRT), IE e série na `store_config`, só o dono muda. Todos opcionais no
cadastro — a loja que não emite não é obrigada a nada — e é a **emissão** que recusa (409
`DADOS_FISCAIS_INCOMPLETOS`) com a lista em frase: "NCM do produto “Boné” (#12)", CNPJ (CPF não
emite), IE, regime. Só o regime 1 (Simples Nacional, CSOSN 102; 500 quando o CFOP é 5405) é
emitido: regime 2 e 3 tributam ICMS por alíquota, que o cadastro não tem, e são recusados com
essa frase em vez de sair uma nota errada. *Mapeamento:* a venda inteira, como foi feita; o
desconto da venda é rateado pelo valor de cada item, fechando ao centavo (`ratear_desconto`);
`data_emissao` é a hora da EMISSÃO (a SEFAZ recusa mais de 5 min de diferença); em homologação
o 1º item leva a descrição exigida pela SEFAZ. Formas → tPag: dinheiro 01, crédito 03, débito
04, PIX 17 (os três com `tipo_integracao` 2, maquininha não integrada), **FIADO 05 "Crédito
Loja"** (é o crediário próprio) e **VALE 99 "Outros" com descrição "Vale-troca"** (crédito de
uma devolução, não um vale-presente vendido; 99 sem descrição é a rejeição 441). As duas
últimas são para o contador confirmar — mudar é uma linha em `nfce.TPAG`. *Uma nota por venda:*
`sale_id` UNIQUE e a `referencia` (`venda-<id>-<aleatório>`, o sufixo protege de uma
reinstalação que recomeça os ids) é gravada e **commitada antes** do primeiro envio. **A
tentativa também**: antes de cada POST a linha vira PENDENTE com `tentativas + 1`, commitada —
`tentativas = 0` quer dizer "esta referência nunca saiu daqui", e um processo que cai com o
emissor já tendo autorizado deixa "pode ter saído" (que se consulta), nunca REJEITADA (que
libera cancelar a venda sem perguntar) nem "nunca enviada" (que a troca de ambiente larga).
Cada commit solta a trava da linha (`FOR UPDATE`), então a emissão retrava e relê a venda antes
do POST (cancelamento que entrou no vão não ganha nota), e dois "Emitir" da mesma venda (duplo
clique, automática + botão) esperam um pelo outro numa **fila por venda** que atravessa esses
commits: `pg_advisory_xact_lock` numa conexão à parte, aberta do começo ao fim da emissão
(`uma_emissao_por_vez`). Rede caída nunca vira
exceção: vira PENDENTE com a mensagem, e o "Tentar de novo" **consulta antes de reenviar** —
resposta perdida não vira duas notas; `already_processed` também vira consulta. **Só resposta
definitiva muda o veredito**: REJEITADA vem do `erro_autorizacao`/`denegado` da SEFAZ ou de
uma recusa do pedido que a Focus documenta (`_RECUSAS_DA_NOTA`), e "não encontrada" só do 404
`nfce_nao_encontrada`. 429 (limite de pedidos), 408, 409, 5xx, 404/4xx de proxy e qualquer 4xx
fora da tabela ficam PENDENTE — REJEITADA libera cancelar a venda sem falar com o emissor, e
dada por engano deixava uma NFC-e autorizada numa venda cancelada. *Cancelamento:*
`VendaService.cancelar` chama `FiscalService.cancelar_nota_da_venda` depois de todas as recusas
da venda (caixa fechado, fiado pago, corrida) e antes dos estornos (a chamada HTTP não segura a
trava dos saldos). Nota AUTORIZADA é cancelada no emissor (justificativa ≥ 15, até 255); se ele
recusar — o prazo de 30 minutos da SEFAZ é o caso comum —, a transação inteira volta e a venda
**não** é cancelada, com a mensagem dizendo isso e apontando a Devolução. Nota PENDENTE é
consultada antes (pode ter sido autorizada); consulta sem resposta definitiva recusa o
cancelamento (409, "não deu para confirmar com o emissor; tente de novo"), nunca o libera.
Nota de homologação, sem valor fiscal, só vai ao
emissor se a homologação ainda estiver ligada — senão, não segura a venda. *Emissão automática* (`FISCAL_EMITIR_AUTOMATICO=1`) nasce no `after_commit` da
venda, numa tarefa com sessão própria, em nome de quem vendeu: falha fiscal nunca impede vender.
Ir de homologação para produção reemite as notas de teste com referência nova — gravada e
commitada antes do envio pelo mesmo caminho da linha nova (`_travar_para_emitir`), senão um
processo que caísse entre a autorização e o commit sortearia outra; trocar de emissor ou
voltar a homologação com nota de produção autorizada ou pendente com tentativa é recusado
(409, "confira no painel"): poderia haver duas notas, e o cancelamento só fala com a nota no
ambiente em que ela nasceu. Telas: o cartão da NFC-e no
detalhe da venda (status, chave, DANFE, Emitir/Tentar de novo — `web/js/nfce.js` ↔
`mobile/src/lib/fiscal.ts`) e a chave no recibo. *Fica com o dono:* contratar o emissor,
cadastrar nele o A1 e o CSC, testar em homologação, e acertar regime/NCM/CFOP com o contador.
*Fora, por ora:* CPF na nota, NF-e de devolução, regimes 2 e 3, tributos aproximados (IBPT) e a
guarda dos XMLs na loja (ficam no emissor; aqui só os links).

**ADR-42 — Vercel como segunda forma de rodar: demonstração.**
A loja continua sendo a máquina dela (Docker, Caddy, `./atualizar.sh`, `./backup.sh`). A
Vercel é uma **segunda** forma de rodar o MESMO código, para mostrar o sistema a quem ainda não
o tem (plano Hobby, projeto `loja-tria`, banco Postgres no **Neon** que a própria Vercel cria
na aba Storage, região São Paulo). Ela é ligada por variáveis de ambiente e por três arquivos
que a loja não lê — `api/vercel.json`, `[tool.vercel]` no `pyproject.toml` e
`api/.python-version` —: **sem `VERCEL=1` (que a Vercel põe sozinha), nada muda**, e os testes
prendem isso (`test_url_do_banco.py`: URL, pool, ambiente e pasta web da loja saem iguais).
*Projeto:* Root Directory = `api/`, framework FastAPI (`entrypoint = "app.main:app"`), uma
função só, na região `gru1` (Hobby: uma região), `maxDuration` 60 s (as consultas já têm teto
de 30 s; o Hobby vai a 300). *Dependências:* com `pyproject.toml` presente a Vercel o lê no
lugar de qualquer requirements.txt e resolveria o `>=` no dia do build — o que o ADR-34 proíbe.
Por isso `installCommand = python scripts/vercel_instalar.py`, que instala o
`requirements.lock` com `--no-deps` (uv se houver, senão `ensurepip` + pip), e o build
**confere versão por versão** e reprova o deploy se a Vercel tiver instalado outra coisa.
Python 3.12, o da imagem e do CI. *Web:* o `web/` mora fora do Root Directory; o build
(`scripts/vercel_build.py`) o copia para `api/web_vercel/` (no `.gitignore`), e o `main.py`
serve a pasta de `settings.web_dir` — vazio, é o `web/` ao lado de `api/` de sempre; na Vercel,
a cópia. `[tool.vercel.fastapi.static] cdn = false`: nada vai para a CDN, `/app`, `/legal`,
`/privacidade` e o redirect de `/` saem do mesmo FastAPI, com os mesmos cabeçalhos. O que na
loja é do Caddy (CSP, HSTS, Permissions-Policy) está no `vercel.json`, igual — menos o
`{hostport}` do `connect-src`, que lá não existe (`'self'` já cobre ws/wss da mesma origem nos
navegadores atuais) — e com `https://*.public.blob.vercel-storage.com` no `img-src`, onde ficam
as fotos na Vercel; `test_vercel.py` compara as duas listas diretiva por diretiva.
X-Content-Type-Options/X-Frame-Options/Referrer-Policy NÃO vão no `vercel.json`: a API já os põe,
e em dobro ("DENY, DENY") alguns navegadores descartam. *Banco:* o Neon injeta `DATABASE_URL`
(PgBouncer em modo transação) e `DATABASE_URL_UNPOOLED` (direta), no formato
`postgres://...?sslmode=require&channel_binding=require`. A config prefere a **direta** (mantém
o cache de prepared statements e o `statement_timeout` na partida) e `core/url_do_banco.py`
traduz: `postgres://` vira `postgresql+asyncpg://`, `sslmode` sai da URL e vira o `ssl=` do
asyncpg, `channel_binding` sai (o asyncpg mandaria os dois ao servidor como configuração e não
conectaria). Só com a URL do pooler (`-pooler` no host), o cache de statements desliga, cada
statement ganha nome único e o teto de partida não vai. O pool é `DB_POOL_SIZE`/
`DB_MAX_OVERFLOW` (10/20 na loja; 2/3 por padrão na Vercel, onde cada instância tem o seu).
*Padrões na Vercel* (só o que o dono não escreveu): `AMBIENTE=producao` — esquecer a variável
não pode subir a demonstração com `/docs` aberto e aceitando o `JWT_SECRET` de exemplo, que
está no repositório; sem `JWT_SECRET` no painel, o segredo do login é o HMAC-SHA256 da senha do banco que o Neon injetou (rótulo `sistema-gestao-loja/jwt/v1`; só com banco informado e senha de 12+ caracteres — sem isso, não sobe): igual em toda instância, nunca impresso, e quem o calcularia já lê o banco inteiro; `CORS_ORIGINS` = os endereços que a Vercel dá ao deploy; `MEDIA_DIR=/tmp/media`
(o disco da função é só leitura; sem isso a API morria no import). *Build:* confere a trava,
copia o web e, **só com `VERCEL_ENV=production`** e com o banco conectado (sem `DATABASE_URL`
a config cairia no localhost da loja e o build num "Connect call failed" mudo; ele para antes,
dizendo para conectar o Neon sem prefixo — é o primeiro deploy de todo projeto novo), roda
`alembic upgrade head` e a carga da demonstração: o dono pela mesma porta do `app.cli
create-admin` e a loja cheia pelo `seed_demo.popular()` — as rotas de sempre, com a API dentro
do processo do build (`TestClient`), porque ali não há servidor de pé. A vendedora da
demonstração (`ana@loja.com`) tem senha de `DEMO_VENDEDORA_SENHA` ou sorteada: senha conhecida
numa URL pública é balcão aberto. **A carga é retomável e nunca duplica.** As duas contas
passam pela régua da API (`UsuarioCreate`) ANTES de qualquer escrita — antes, uma senha de
vendedora curta criava o dono, caía no 422 e o build seguinte via "já tem usuário" e nunca mais
semeava. O começo e o fim da carga são duas linhas no diário de auditoria
(`DEMONSTRACAO_INICIADA`/`DEMONSTRACAO_SEMEADA`, autor "Build da Vercel", pela porta pública
`AuditoriaService`): o dono vê ali que aquelas vendas são de exemplo, e o build lê ali o
estado — fim anotado, nada a fazer; só o começo, a carga caiu no meio (rede, Neon) e o
Redeploy a retoma; nenhum marco e já há produto ou venda, a loja é de alguém e não se semeia
por cima. Retomar sem duplicar é do próprio seed: toda gravação com `client_uuid` usa uma chave
FIXA por passo (`uuid5`), e a réplica devolve o registro de antes (a mesma régua do app no
celular); o resto (produto, cliente, despesa, ajuste) procura antes de criar; o sorteio é
consumido igual a cada execução, então a réplica manda o pedido idêntico; e a vendedora que já
existia com outra senha sorteada tem a senha redefinida pelo dono. Escolhemos o diário e não
uma tabela nova porque o marco É um fato a auditar e não pede migration numa loja de verdade;
a faxina (`RETENCAO_AUDITORIA_DIAS`) apaga o começo antes do fim, e sem nenhum dos dois a loja
tem produto — cai em "de alguém", nunca em semear de novo. Preview não toca no banco (o preview
de um branch não migra o banco da demonstração por baixo do deploy que está no ar); e o log
nunca leva senha nem URL do banco, nem a normalizada (erro de config sai só com a frase de cada
campo: o pydantic repete os valores lidos; o teste procura a senha de um papel do banco que só
existe nele). A migração roda ANTES de o deploy novo entrar no ar — o anterior
atende alguns segundos com o schema novo; numa demonstração, aceito. *Login:* a Vercel
sobrescreve o `X-Forwarded-For` com o IP de quem chamou, então o primeiro da lista — o que a
trava de força bruta (ADR-24) já lê — é o real; nada a configurar. *`/versao`:* não há
`atualizar.sh` nem `versao.json`; o commit vem de `VERCEL_GIT_COMMIT_SHA` e "a mais nova" é o
próprio deploy (cada envio ao GitHub publica sozinho). **O que NÃO roda lá:** `atualizar.sh`
(quem publica é a Vercel, a cada push), `backup.sh` e o backup no Drive do ADR-28 (o backup é
o do Neon: histórico e restauração para um instante, no painel dele), `vigia.sh`,
`notificar.sh`, `diagnostico.sh` e as unidades do systemd; e a **NFC-e automática pós-commit**
(`FISCAL_EMITIR_AUTOMATICO` é forçado a desligado: a instância da função pode congelar assim
que a resposta sai, e a nota ficaria pela metade — o botão "Emitir NFC-e" continua). O disco
da função não guarda nada entre instâncias (`/tmp` é de cada uma). *Incertezas que só um
deploy real confirma:* que o `installCommand` do `vercel.json` vale para o preset FastAPI (o
código do builder diz que sim; se não valer, o build reprova na conferência e o README diz o
que fazer); que "Include files outside the root directory" está ligado (sem ele o `web/` não
existe no build, e o build reprova dizendo isso); o HSTS, que a Vercel pode já mandar no
`*.vercel.app`; e se a integração Git da Vercel publica **check-run** no commit do branch
principal — o `atualizar.sh` exige TODAS verdes (ADR-34), e aí um deploy vermelho da
demonstração seguraria a atualização das lojas (a integração costuma publicar *commit status*,
que ele não lê; conferir no primeiro deploy em `GET /repos/.../commits/<sha>/check-runs`).
*Emenda (ADR-46):* o preparo da demonstração saiu do `scripts/vercel_build.py` para
`app/demonstracao.py`, que serve também à demonstração que sobe com a loja. Na Vercel nada muda:
autor "Build da Vercel" nos marcos, o nome da loja fica o que estiver, a senha do dono nunca é
trocada e a faixa "dados fictícios" não aparece (`settings.demonstracao` é falso lá; quem a
Vercel liga é `settings.vercel`). A Vercel deixa de ser a única demonstração; continua sendo a
única forma de rodar sem Docker.

**ADR-43 — O celular como leitor de código de barras do computador.**
*Contexto:* no balcão, o leitor USB é um teclado (`web/js/leitor.js`) — e nem toda loja tem um,
ou tem um só para dois caixas, ou precisa bipar a arara longe do computador (Entrada,
Inventário). O celular de cada vendedora já tem câmera, já lê etiqueta no app (`expo-camera`) e
já está logado. *Decisão:* o computador (PDV, Devolução, Entrada, Inventário, Condicional nova —
as telas que usam `criarLeitor`) **pareia** um celular, e cada bipe na câmera do celular chega
ao campo do leitor do computador como se fosse o leitor USB. O servidor é o carteiro: o celular
grava o bipe, o computador retira. Escolhas do dono: **qualquer pessoa da equipe logada pareia**
(sem capacidade nova: ler código de barras não mostra nada que a pessoa já não veja; o que
importa — vender, dar entrada — continua passando pela régua de sempre, na tela do computador,
com o login de lá); **um celular por computador**; o pareamento vale até alguém desligar ou sair,
e **no máximo 12 h depois do aceite**, fixas (usar não estica). *Modelo* (§2.12):
`leitor_pareamentos` e `leitor_bipes`, tabelas de vida curta. O status (AGUARDANDO, ATIVO,
EXPIRADO, ENCERRADO) é **calculado das datas** no servidor, com o relógio do BANCO (`SELECT now()`,
o mesmo instante da transação inteira) — coluna de status precisaria de alguém para virá-la na
hora, e duas instâncias com relógios diferentes discordariam do SQL. *O código:* 6 caracteres de
`23456789ABCDEFGHJKLMNPQRSTUVWXYZ` (sem 0/O/1/I, que se confundem lidos ou digitados), sorteado com
`secrets.choice`, válido 5 min, único só enquanto AGUARDANDO (UNIQUE parcial); colisão no
sorteio desfaz só a tentativa (savepoint) e sorteia outro. O aceite normaliza (maiúsculas, sem
espaços e hífens) e responde **a mesma coisa** — 404 `LEITOR_CODIGO_INVALIDO`, "Código não
encontrado ou vencido. Gere outro no computador." — para inexistente, vencido, já aceito por
OUTRO e encerrado: a tela não precisa saber qual foi, e quem chuta códigos não aprende nada com a
diferença. A exceção é o **reenvio de quem já aceitou**: a resposta do aceite se perdeu (Wi-Fi
fraco, partida a frio da Vercel) e o mesmo celular manda o mesmo código — recebe 200 com o
pareamento que ele mesmo ligou, sem mudar nada (nem linha no diário), enquanto ele estiver
ATIVO e dentro dos 5 min do código. Sem isso o computador mostrava "📱 Celular de Fulana" e o
celular, o erro — e o anterior dele já tinha virado TROCOU. Não vaza nada a quem chuta: a
resposta só muda para o próprio dono do aceite. *Força bruta:* o alfabeto tem 32 símbolos (8 algarismos e 24 letras), então são
32^6 ≈ 1,07 bilhão de códigos, cada um válido 5 min, e só para quem já
tem sessão (a rota exige login: quem chuta é alguém da equipe, ou uma sessão roubada, que já
teria coisa melhor a fazer). Com dez computadores esperando ao mesmo tempo, cada chute acerta
com chance de 10 em 1,07 bilhão: ter 50% de chance de acertar UM código dentro dos 5 min pede
~74 milhões de tentativas — ~250 mil por segundo, contra uma loja que responde dezenas. E quem
acertasse apareceria pelo nome no selo do computador ("📱 Celular de Fulana"), com o
aceite no diário. Sem trava nova. *Corrida no aceite:* `SELECT ... FOR UPDATE` da linha
(`aceito_em IS NULL AND encerrado_em IS NULL AND codigo_expira_em > now()`) e a mutação pelo
ORM: o segundo celular espera a trava e, quando o primeiro commita, o Postgres reavalia o WHERE
na versão nova e não acha nada — um 200, um 404. **Um celular, um computador:** aceitar encerra
(TROCOU) os outros ATIVOS do mesmo celular; dois aceites do mesmo celular ao mesmo tempo se
serializam numa `pg_advisory_xact_lock` por usuário (espaço 43), senão um não veria o outro. O
computador que gera código novo passa `substitui_id` (o antigo vira SUBSTITUIDO: código que
saiu da tela não pode continuar abrindo o leitor); mais de 10 vivos da mesma pessoa no computador
(o mesmo login em várias abas é normal; dezenas esquecidas, não), os mais velhos também. Desligar
vale de qualquer ponta (COMPUTADOR ou CELULAR; com o mesmo login nas duas, não há como saber o
lado e conta COMPUTADOR); desligar o que já terminou é 204 sem mudar nada — e sem linha no
diário. *Bipe:* idempotente
por `client_uuid`, **conferido antes de qualquer outra coisa** — o reenvio de um bipe que já
entrou responde 200 com o mesmo corpo mesmo que o leitor tenha sido desligado nesse meio-tempo
(o bipe entrou; o celular só não soube). A mesma chave com outro código ou outro pareamento é
409 `DUPLICADO`, e a de outro celular também (sem corpo: o atalho não é porta de leitura). Dois
POST iguais ao mesmo tempo: o perdedor cai no UNIQUE, faz rollback, recarrega o usuário
(`session.refresh`, o atributo expirado é MissingGreenlet) e devolve o do vencedor. Só o
celular do pareamento bipa por ele (404 para os outros — inclusive o computador); pareamento
fora de ATIVO é 409 `LEITOR_DESLIGADO` com `detail.status`; 100 pendentes é 409
`LEITOR_FILA_CHEIA` (o computador não está retirando — tela fechada, aba no fundo — e continuar
enfileirando só esconderia isso de quem bipa). *Retirada atômica e sem eco:* `UPDATE leitor_bipes
SET consumido_em = now() WHERE id IN (SELECT id ... WHERE pareamento_id = :p AND consumido_em IS
NULL ORDER BY id LIMIT 50 FOR UPDATE SKIP LOCKED) RETURNING ...`, em ordem de id: cada bipe sai
**uma vez**, e duas abas retirando juntas pegam lotes disjuntos (a segunda pula o que a primeira
travou, em vez de esperar e entregar de novo). Bipe com mais de **120 s** é consumido e não
entregue (`descartados`): código lido há dois minutos não pode cair no carrinho de surpresa quando
o computador volta. Pareamento fora de ATIVO entrega `[]`, descarta a fila e devolve o status,
para a tela saber que caiu. A retirada é **SQL Core, nunca objeto ORM sujo**: o aviso de tempo
real sai do commit do ORM, e se retirar avisasse, cada tela pareada retiraria de novo por causa
da própria retirada — eco sem fim. **Não é listagem paginada** (exceção à regra da §4): é uma
fila entregue uma vez, com teto de 50 por chamada; quem quer o resto chama de novo. *Tempo real:*
`Assunto.LEITOR` ("leitor"), com `leitor_pareamentos` e `leitor_bipes` no mapa do commit
(ADR-16): criar, aceitar, encerrar e bipar avisam; retirar não. Só o assunto trafega — **nunca o
código lido** —, e quem busca é a rota REST, que confere de quem é o pareamento. *Auditoria*
(ADR-23): aceitar é `LEITOR_PAREADO` ("Ligou o celular como leitor de código de barras de um
computador") e desligar um celular LIGADO é `LEITOR_DESLIGADO` ("Desligou o celular-leitor
#id"). O 204 sem efeito (o que já tinha terminado; o código que ninguém leu, cancelado por quem
abriu o QR e saiu) e o reenvio do aceite ficam fora (`fora_do_diario`, ADR-23). Gerar o código,
bipar e retirar ficam fora (`_IGNORAR`): o código na tela não é ato, cada bipe é uma tecla (o ato
é a venda depois) e a tela retira a cada aviso e, sem canal, de 2 em 2 s. *Faxina:* a cada código gerado, apaga bipe com mais
de 1 dia e pareamento terminado há mais de 30; FKs para `users` em CASCADE, como os do refresh
token (pareamento não é histórico; a exclusão de conta, LGPD, não pode travar nele). *Convite do
QR* (espelho `web/js/leitor-remoto.js` ↔ `mobile/src/lib/leitorRemoto.ts`, com teste nas duas
pontas): `gestaoloja://leitor?v=1&c=<CODIGO>&api=<base da API, encodeURIComponent>`; o leitor
do app aceita o convite ou o código digitado solto e recusa o resto (o código de barras de uma
peça lido por engano, uma URL de outro esquema); `mesmoServidor` compara host:porta (porta padrão
normalizada, sem diferenciar maiúsculas) e o caminho da base — a demonstração mora em `/demo` no
MESMO host da loja (ADR-46) — e confia no host quando o convite vem de loopback.
*As duas pontas:* **web** — o botão "📱 Celular como leitor" mora no rodapé da lateral, em
toda tela e para todo papel (`leitor-celular.js`). Ele gera o código e abre o modal
(`leitor-celular-janela.js`) com o QR — SVG montado pelo DOM (`vendor/qrcode.js` + `qr.js`),
nada de `data:` nem `innerHTML`, a CSP não muda —, o código escrito ("ABC 234"), o caminho no
app e a contagem dos 5 min; "Gerar outro" passa `substitui_id`. Fechar o modal sem aceite NÃO
desliga: o celular pode já ter lido o QR, e o código vence sozinho (e não deixa "desligou" no
diário por um código que ninguém usou). Enquanto AGUARDANDO, a aba consulta o pareamento de 2
em 2 s e a cada aviso "leitor"; quando vira ATIVO, o modal fecha e o selo "📱 Celular de
Fulana" toma o lugar do botão (clicar oferece Desligar). Com o leitor ATIVO, a aba retira a
fila **na hora** do aviso "leitor" — `ouvirNaHora` do `tempo-real.js`, fora da rodada de 1–2 s,
que continua só para redesenhar tela —, quando o canal volta, e como rede de segurança de 10 em
10 s (sem canal, de 2 em 2 s: o bipe leva até ~2 s). Uma retirada por vez (`umaPorVez`): aviso
que chega no meio vira UMA rodada a mais, e lote cheio (50) pede outra. `descartados > 0` vira
aviso no computador ("N leituras do celular chegaram depois de 2 min…"): o celular mostrou
"enviado" para elas, e sem o aviso ninguém saberia que não entraram. O que a retirada traz
passa pela **fila de entrega** (`criarEntrega`, `leitor-remoto.js`, com teste) — separada da
retirada, para código esperando a tela não segurar o `retirar` (a fila do servidor envelheceria
e seria descartada calada). Cada código vai, em ordem, ao `criarLeitor` montado por último
(`entregarCodigoDeFora` de `leitor.js`), que chama o `aoLer` da tela direto — sem a trava de
repetição do leitor USB, porque o celular já tem a dele e duas bipadas da mesma peça são duas
peças. O `aoLer` é esperado (a busca da peça) para o lote cair em ordem, mas não a PESSOA: se
ele abrir uma janela ("peça ainda não cadastrada"), o código conta como entregue e os próximos
encontram a janela aberta. Com uma janela aberta o código não entra e a tela avisa "bipe de
novo". **Tela ocupada** (`ocupadoQuando` do `criarLeitor`): gravando — a lista já foi copiada
para o POST e é limpa quando a resposta chega, e o código que entrasse no meio sumiria sem
aviso — ou com a pessoa digitando na lista que o bipe redesenharia (`digitandoEm`: a quantidade
digitada e ainda não confirmada voltaria a 1). Aí o código ESPERA e tenta de novo a cada 250 ms,
por até 60 s; passou, avisa "bipe de novo" (entrar minutos depois numa lista já gravada seria a
surpresa que o prazo do servidor evita). Entrada, Inventário, Condicional nova e Devolução dizem
quando estão ocupadas; o PDV fecha a venda num modal. A Entrada, ao gravar, tira da lista só o
que foi no envio (`oQueSobrou`): a leitura que já vinha a caminho quando a pessoa clicou fica
para a próxima, em vez de sumir na limpeza; a Condicional nova, que sai da tela, avisa que uma
peça lida no meio ficou de fora. Numa tela sem leitor o código espera 3 s (no F5 o leitor é
retomado antes de a tela terminar de carregar; numa troca de tela há um instante sem nenhuma) e
então o aviso manda abrir o PDV, a Devolução, a Entrada, o Inventário ou a Condicional. Limite
aceito: um F5 no instante exato de uma retirada em voo perde aquele lote (o servidor já o deu
por entregue e a página que pediu não existe mais) — "no máximo uma vez" escolhe perder a peça a
entregá-la duas; evitar pediria um segundo passo de confirmação em toda retirada, por uma janela
de uma ida e volta. O id do pareamento fica no `sessionStorage` da aba (o F5 não desliga; outra
aba não herda). "Duplicar
aba" copia o `sessionStorage`: antes de retomar, a aba pergunta por um `BroadcastChannel`
(`criarDonaDaAba`; não exige HTTPS, e a loja na rede local é HTTP) se outra aba já cuida daquele
leitor, e a cópia não retoma — senão as duas retirariam a mesma fila e os bipes se dividiriam
entre dois carrinhos, um numa aba escondida. O roteador tira o modal do QR da tela ao trocar de
rota sem fechá-lo: o `rota-trocada` (e o próximo clique) fecha de vez a janela que saiu do
documento, senão o botão ficava morto até um F5. O código gerado com a sessão saindo no meio
não é adotado nem mostrado (e é encerrado, se ainda houver token). Sair do sistema manda o DELETE (até 3 s) ANTES do logout — o
servidor não amarra o logout ao leitor, e o pareamento de uma tela que não pôde avisar (aba
fechada, energia, sessão perdida) vence sozinho nas 12 h. **App** — Mais → "Leitor do
computador", para todo papel: lê o QR (a câmera só com o tipo `qr`; o que não é convite mostra
um aviso e a câmera segue) ou aceita o código digitado ("abc-234" serve). O aceite vai SEMPRE ao
servidor em que o app já está — o app nunca troca de servidor por um QR —; o `api` do convite
serve só para, se o aceite falhar, acrescentar a dica "este código é de X; o app está em Y"
(`mesmoServidor`). O link `gestaoloja://leitor?…` só preenche o código: ligar pede o toque. Ligado,
a câmera lê sem parar (as travas de `lib/leitura.ts`), e cada leitura entra com `client_uuid`
próprio numa fila em memória (`stores/leitorStore.ts`, laço testado em `lib/filaDoLeitor.ts`): um
bipe por vez, em ordem; rede caída, timeout, 5xx, 408, 429 e `LEITOR_FILA_CHEIA` reenviam a MESMA
chave com espera de 1, 2, 4, 8 e 10 s, e o que **não saiu em 120 s** vira "não enviado"
(`PRAZO_DO_BIPE_MS`, o mesmo prazo do servidor) — ou **"confira no computador"**, quando a
última tentativa ficou sem resposta (rede, timeout, 5xx: o servidor pode ter gravado e o
computador recebido, e quem lê "não enviado" bipa de novo e a peça entra duas vezes). Resposta
do servidor tira a dúvida: a chave é conferida antes de tudo, então o bipe que já estava lá
voltaria 200, nunca 409 ou 404. A fila cheia (`LEITOR_FILA_CHEIA`) aparece na hora como alerta
("o computador não está recebendo as leituras…"), sem esperar o bipe vencer. 422 e `DUPLICADO`
descartam só aquele bipe; 404 ou 409 `LEITOR_DESLIGADO` param a fila e saem do modo leitor
dizendo por quê — o 409 só traz o status, então o app consulta o pareamento para dizer o
motivo (o computador desligou? o MESMO login ligou outro computador — "um celular, um
computador" vale por login, e a frase não afirma que foi este aparelho?). O que não saiu fica
listado com o aviso, na tela de ligar, até a pessoa dispensar: é o que ela tem de bipar de
novo. "Enviado" quer dizer "chegou ao servidor" (a tela diz); o que o computador não pegar a
tempo, ele avisa lá. O aceite que responde depois do logout não liga leitor nenhum (contador de
sessão na store); o diálogo "Desligar o leitor?" para a câmera pelo estado da TELA, não só pela
pausa de dentro do `Scanner` (bloquear o celular com o diálogo aberto desmonta a câmera, e a que
volta nasceria lendo); o QR que não é convite vibra como recusa e não vira o "Último:"; e o link
`gestaoloja://leitor?v=…` passa pela mesma `lerConvite` da câmera (versão desconhecida é
recusada nas duas). A tela consulta o
pareamento de 15 em 15 s só com ela em foco e o app na frente (fora disso, câmera e consulta
param). O pareamento não é guardado no aparelho: fechar o app esquece do lado do celular, e o
servidor o mantém até alguém desligar, um novo aceite deste celular (TROCOU) ou as 12 h. O logout
manda o DELETE (até 4 s) antes de revogar a sessão. O assunto "leitor" chega ao app e não refaz
consulta nenhuma (sai um por bipe). *Os dois prazos somam no pior caso:* o do app conta da
leitura, o do servidor do `criado_em` — um bipe preso ~2 min no celular sem rede ainda pode
esperar outros 2 min na fila de um computador que não está retirando. Na prática a aba retira
na hora; a soma só acontece com as duas pontas fora ao mesmo tempo, e o "não enviado"/descartado
continua valendo para cada lado.

**ADR-44 — Publicar o iOS por um botão do GitHub Actions, no molde do Sistema Obras.**
*Contexto:* publicar exigia o computador do dono (`eas build`, `npm run publicar:build`,
`npm run publicar -- --enviar`), com `config.json` e `.p8` numa pasta local. O Sistema Obras,
da mesma pessoa, já publica por um botão (`publicar-apple.yml`), e as notas do revisor desta
loja mandavam conectar em `sistemaobras.com.br` — que hoje serve o Obras: a revisão voltaria.
*Decisão:* `.github/workflows/publicar-apple.yml` (`workflow_dispatch`; a etiqueta `ios-v*` e a caixa "completo" vieram depois, ver abaixo) com quatro caixas:
compilar (EAS na nuvem, `--no-wait`, `--auto-submit-with-profile=ci`), enviar o último build,
ficha e revisão. Quem sobe a ficha é o MESMO `publicar.mjs` da máquina do dono, não o fastlane
do Obras: ele já faz ficha, capturas, conta demo e envio para revisão pela API da Apple, e tem
teste contra uma Apple de mentira. `publicar/ci.mjs` monta `config.json` + `.p8` a partir de
Secrets (chave, senha da demo) e Variables (contato, time) numa pasta do runner fora do
repositório, com permissão 600, e acha o `ascAppId` pelo bundle do `app.json` — sem ele o
eas não envia em modo não interativo, e o app NÃO pode ser criado pela API da Apple, então
app inexistente vira aviso com o passo do site e o build sai mesmo assim. O perfil de envio
`ci` do `eas.json` lê caminho e ids da chave das variáveis do runner (o eas interpola só esses
três campos); o `ascAppId` entra só na cópia do runner. Com o time da Apple (Team ID e tipo),
o build recebe `EXPO_ASC_*`/`EXPO_APPLE_*` e a Expo cria ou conserta certificado e perfil sem
perguntar. **O que não é segredo mora em `mobile/publicar/padroes.json`** (Issuer ID da chave,
time, contato, copyright, conta e código de barras da demo): o GitHub só precisa
de `EXPO_TOKEN`, `ASC_KEY_ID` e `ASC_KEY_P8` para subir a ficha, e Variable de mesmo nome vence o
padrão (`ASC_ISSUER_ID` e o telefone também como Secret: o passo "Preparar" lê os dois contextos). Pedir nove Variables a quem só quer publicar era o que travava a
primeira rodada; segredo de verdade (chave, senha da demo) nunca entra nesse arquivo, e o
`ci.test.mjs` recusa. Senha da demo e telefone de contato são **só da revisão**: sem eles a
ficha sobe (notas com "(pending)", campo vazio não vai à Apple e ela guarda o que tinha) e o
`--enviar` para dizendo o que falta — o telefone que a Apple já tem de um envio anterior basta.
A senha da demo também pode morar SÓ na Apple: o workflow `senha-demo.yml` a grava no campo "Senha" da
revisão (entrada lida do arquivo do evento e mascarada antes de qualquer `env:`), e o publicador, sem o
Secret, usa a que está lá — nas notas e na conferência da demo — e a esconde do log. Quem só tem a senha
e não pode criar Secret (um agente, por exemplo) publica assim. O issuer e o time chegam aos passos do eas por `secrets.X || steps.apple.outputs.x` (saída do
`ci.mjs`), nunca por saída que contenha Secret. O `app.json` guarda o `projectId` da Expo; sem
`owner`, porque do SDK 53 em diante o eas-cli não o exige nem com token de robô. O endereço que o revisor usa é
`url_servidor_demo` (padrão `https://loja-tria.vercel.app`, ADR-42) e a política de
privacidade sai de `<servidor>/privacidade`, que o próprio sistema serve; a URL de suporte, sem
`APPLE_URL_SUPORTE`, é a mesma da privacidade — sai também de `<servidor>/privacidade` e troca
junto com `APPLE_SERVIDOR_DEMO` (fixa no `padroes.json`, ficava no servidor antigo), ou segue a
`APPLE_URL_PRIVACIDADE` do dono. O endereço pode ter
CAMINHO — a demonstração que sobe com a loja mora em `https://<domínio>/demo` (ADR-46) —, então
toda junção (rotas da conferência, privacidade, notas) é por texto sobre a base inteira, nunca
`new URL('/x', base)`, que apagaria o `/demo` e conferiria a loja de verdade no lugar da demo;
`servidorDemo()` (`ficha.mjs`) recusa o que não é base (http, `?`, `#`, `@`, `//`, `/app`,
`/api`) antes de ele chegar às notas. Entrada do formulário
vai por `env`, nunca colada no script (`${{ }}` no `run:` viraria comando num runner com
token). *Consequências:* publicar é um clique por rodada (build; depois, revisão), sem Mac;
os segredos são os mesmos do Obras e moram no GitHub, nunca no repositório nem no log
(`ci.test.mjs` procura a senha e a chave na saída). O CI roda `ci.test.mjs` e `rodar.mjs`.
*Ficha completa (nov/2026):* o dono pediu não fazer nada no site da Apple, então o publicador
passou a responder tudo o que a API 4.6 alcança, conferido contra a especificação OFICIAL:
**classificação etária completa** — as 24 perguntas da `AgeRatingDeclaration` (frequência
NONE, sim/não false, inclusive as novas: conteúdo gerado por usuário, conversa, rede social,
anúncios, verificação de idade, controle parental, caixa de recompensa, saúde, armas), sem
tocar na faixa infantil nem nos ajustes manuais; atributo que a Apple recusar nomeando-o sai
sozinho e vira aviso; pergunta que a Apple criar depois da 4.6 (vieram duas em 16/11/2026)
volta em branco e vira pendência com o nome, e a recusa do envio aparece inteira
(`associatedErrors`) — a rodada seguinte retoma o envio que ficou aberto; **direitos de
conteúdo** = não usa conteúdo de terceiros; **disponibilidade** só no Brasil
(`POST /v2/appAvailabilities` com TODOS os territórios de `GET /v1/territories` em `included`,
cada um com id local `${...}` e `available` só no Brasil — a Apple recusa a criação que traz só
os que ficam à venda (409 "expects an included resource ... id 'ARG'", visto na 1ª rodada real),
e a Apple de mentira agora exige o mesmo; `availableInNewTerritories: false` — app em pt-BR, com
PIX e NFC-e) e só quando a conta ainda
não tem: a que existe fica como está; **capturas em dois conjuntos**: 6,5" (`APP_IPHONE_65`,
1242×2688) OBRIGATÓRIO — em ago/2026 o formulário só aceitou ele — e 6,9" (`APP_IPHONE_67`,
1320×2868) extra: pasta ausente, imagem fora do padrão ou falha viram aviso, e o conjunto pela
metade é tirado (a App Store usa o 6,5" nos iPhones maiores); PNG RGB sem alfa conferido antes
de subir, MD5 confirmado, espera o processamento da Apple, reenvio substitui; **textos**:
texto promocional e "Novidades" (só em atualização) vêm de `ficha/`, e limite, marcador sem
valor e menção a outra plataforma (2.3.10) param antes de falar com a Apple; a versão vem antes
do appInfo (numa atualização a Apple só abre o appInfo editável depois da versão nova) e o
build preso é o da versão do `app.json` (`filter[preReleaseVersion.version]`).
`--aguardar-build <min>` espera o build ficar VALID (consulta a cada
`PUBLICAR_INTERVALO_BUILD`, 60 s); estourou ou a Apple marcou o build inválido, erro claro. Um
resumo honesto fecha cada rodada (feito, avisos, pendências, o que a API não cobre), também na
página do Actions; a senha da demo vira `•••` até em erro da Apple. **Modo completo**: caixa
"completo" (desmarcada por padrão: o runner fica até ~2 h parado esperando a Expo e a Apple,
teto de 150 min) ou etiqueta `ios-v<versão>[-N]` (regex ancorada; tem de bater com o
`app.json`) — a etiqueta existe porque o botão `workflow_dispatch` só aparece depois que o
arquivo chega na branch padrão; compila com `--wait` (o envio automático do EAS sobe o
binário), e roda `publicar.mjs --enviar --aguardar-build 60`; sem ficha ou sem o app na Apple,
para ANTES de compilar. **O que a API 4.6 não cobre** — e nenhum programa faz: criar o
registro do app (não existe `POST /v1/apps`) e a ficha "Privacidade do App" (não há rota); o
resumo lembra das duas. A Apple de mentira (`teste/mock-asc.mjs`) confere toda rota, parâmetro
e corpo contra `teste/esquema-asc.mjs`, recorte gerado da especificação oficial por
`teste/gerar-esquema.mjs` — especificação nova, gera de novo e o diff mostra o que mudou.
*Resposta à Guideline 2.1 e revisão do publicador (nov/2026):* a 1ª submissão voltou com
"Information Needed" — gravação de tela num iPhone FÍSICO, modelos e iOS testados, propósito e
público, como acessar, serviços externos, regiões, setor regulado —, e o dono continua sem querer
usar o site da Apple. *Notas em inglês* (o revisor lê inglês; rótulos das telas entre aspas em português, como
aparecem), até 4000 contados como a Apple, com os sete itens; a lista de aparelhos
(`ficha/aparelhos-testados.txt`, uma linha por iPhone em que o teste rodou de verdade, a 1ª é a
da gravação) e o nome do vídeo entram por marcador e, sem eles, viram "(pending)": a ficha sobe,
mas o `--enviar` é RECUSADO antes de qualquer escrita na Apple — também com o guia PDF
desatualizado ou o servidor de demonstração fora do que as notas dizem. Nada é inventado: lista e
vídeo vêm de teste real. *Anexos pela API* (`/v1/appStoreReviewAttachments`, presos ao
appStoreReviewDetail; reserva → partes → MD5 → processamento): o guia `revisao/app-review-guide.pdf`
(os sete itens por extenso e os prints, impresso de `revisao/guia.mjs` pelo Playwright e
commitado; a impressão digital das entradas — texto, lista, prints — é conferida pelo CI e pelo
`--enviar`, e o `capturas/gerar.sh` o refaz) e o vídeo (`--video-revisao` arquivo ou https; no
Actions, `video_revisao_url`, baixado para `$RUNNER_TEMP`, MP4/MOV pelo cabeçalho, até 500 MB).
O reenvio substitui o anexo de mesmo nome sem duplicar: igual (MD5) fica, diferente sobe antes e
o antigo sai depois, falha apaga a reserva pela metade. *Reenvio:* a Apple aceita um envio ativo
por plataforma; o que voltou `UNRESOLVED_ISSUES` (recusa ou pedido de informação) é retomado — item
da versão garantido, o recusado marcado `resolved` (se a Apple recusar a marca, segue) e
`PATCH submitted: true` no MESMO envio; envio em andamento para a rodada. A Central de Resolução
não tem API e não é preciso: o reenvio leva notas e anexos (texto opcional em
`revisao/resposta-ao-app-review.txt`). *Build desta rodada:* o modo completo lê o
`appBuildVersion` do `eas build --wait --json` e passa `--build N`; só esse build é preso
(`filter[version]`) — antes, um VALID mais antigo da mesma versão ia para a revisão no lugar dele.
Fora do completo, "revisao" com "compilar"/"enviar" na mesma rodada é recusada no passo "Decidir"
(com `--no-wait`, o build novo não chegaria a tempo); e, num envio devolvido, o `--enviar` sem
`--build` recusa, antes de escrever, quando o build mais novo da versão é o MESMO que já estava
preso (`GET /v1/appStoreVersions/{id}/build`): o app desta rodada não chegou à Apple, e as notas
citariam telas que ele não tem. Reenviar o mesmo build é escolha explícita (`--mesmo-build`,
caixa "mesmo_build"), para a resposta que não pede app novo. *Regiões:* disponibilidade que já
existe fica como está, mas é lida (`territoryAvailabilities`): à venda fora do Brasil, o envio é
recusado, porque o item 6 das notas e o guia respondem "Brazil only". *Vídeo:* o link é baixado UMA
vez, no começo da rodada (`baixar-video.mjs`), e os passos seguintes recebem o arquivo — um link
pré-assinado venceria durante a compilação.
*Antes de compilar:* `ci.mjs preparar` expõe o estado da versão do app.json (inexistente,
editável ou travada; a mesma regra do publicador, `versoes.mjs`) e a travada para a compilação e o
envio do build; no completo, `publicar.mjs --conferir-envio` confere, só LENDO a Apple, tudo o que
a revisão cobrará. *Servidor de demonstração* conferido pela API pública do sistema: `/health`, o
login da conta demo com papel ADMIN, o código demo com ao menos 3 peças em estoque, a
privacidade e a URL de suporte (quando é outra página; sem `APPLE_URL_SUPORTE`, é a mesma), a
rota do leitor (404 `NAO_ENCONTRADO` × 404 genérico de deploy velho), a da exclusão
da própria conta (`DELETE /usuarios/me` com corpo vazio: 422 no campo senha, a validação recusa
antes da rota e nada é excluído) e a proteção da conta demo (uma senha aleatória recebe 409
`CONTA_DE_DEMONSTRACAO`, que vem antes de conferir a senha — ADR-45); a sessão aberta é encerrada
e a senha da demo não sai em mensagem. Privacidade e suporte são pedidos como página
(`Accept: text/html`, como o navegador do revisor). O suporte debaixo do servidor da demo é página
do sistema e segura o envio como a privacidade; o de fora dele (a página de contato do dono, de
terceiro) que não abre daqui vira só aviso — página de terceiro pode recusar robô, e o "não abre"
seria falso —, e o resumo não o dá por conferido: quem confere é o dono, no navegador. O servidor
de demonstração fica no ar depois da revisão: serve a política de privacidade da ficha.
*Ficha fiel ao build:*
`TELAS_CITADAS` (rótulo → arquivo do app que o mostra) para antes de falar com a Apple quando um
texto cita tela que o commit não tem (a exclusão de conta é o ADR-45). *Idioma:* registro criado
no site com outro idioma principal → pt-BR vira o principal e as localizações do outro idioma
(versão e appInfo) são apagadas, ou travariam o envio vazias. *6,9" fora da rodada:* o conjunto
velho da versão é apagado. *Preço:* só o ponto 0,00 da lista inteira (paginada); sem ele, nada é
gravado e fica pendência. *Serviços externos* escritos a partir do código: dado e login só do
servidor da loja; a demonstração é uma loja só de dados fictícios, isolada de qualquer loja de
verdade (as notas e o guia não amarram um provedor: ela pode ser a da instalação, ADR-46, ou a da
Vercel, ADR-42, e quem cita os provedores é a política de privacidade); NFC-e opcional (Focus NFe),
desligada na demonstração; e a biblioteca de rede do React Native (NetInfo), que no iPhone testa a
conexão com um pedido vazio ao `generate_204` do Google — dito nas notas, para não afirmar
"nenhum outro servidor". *Teste em iPhones reais* (experimental até a 1ª rodada real): perfil
`teste-aparelhos` no `eas.json` (distribuição interna: o `.ipa` ad hoc que o BrowserStack instala e
reassina; o da App Store não instala) e a caixa "aparelhos" no Actions — `ci.mjs aparelhos`
pergunta à Apple pelos iPhones registrados (`GET /v1/devices`; o perfil ad hoc exige um) e
registra o da entrada `udid_aparelho` (`POST /v1/devices`, UDID mascarado no log); sem nenhum,
para dizendo como resolver; o eas compila com `--wait --json` e o link do `.ipa` vai para o resumo
da execução. O perfil é ad hoc de propósito (`enterpriseProvisioning: "adhoc"`) e o build leva
`--refresh-ad-hoc-provisioning-profile` com a chave da Apple: sem eles, o eas-cli em modo não
interativo parava pedindo o modo interativo. Mas a 1ª credencial ad hoc (o certificado ligado ao
perfil) o eas-cli só monta no modo interativo, e a Expo monta o perfil com os iPhones do cadastro
DELA (não os da Apple): na 1ª vez, `npx eas-cli build --platform ios --profile teste-aparelhos`
num computador; daí em diante, a caixa refaz o perfil sozinha. O ci.mjs não diz mais que o
iPhone registrado na Apple basta.
*Consequências:* o reenvio depois de uma recusa é um clique, sem site; a revisão só sai com o que
a Apple pediu e com o servidor da demonstração conferido; mudar prints ou a lista de aparelhos
pede refazer o guia (o CI acusa). A Apple de mentira ganhou um envio ativo por
plataforma, o estado `UNRESOLVED_ISSUES`, anexos, aparelhos, localizações de outro idioma, pontos
de preço paginados e builds antigos da mesma versão; `teste/demo-falso.mjs` faz o servidor de
demonstração (com `prefixo: '/demo'`, a demo debaixo do caminho e a loja de verdade na raiz: o
cenário de `rodar.mjs` e o `servidor-demo.test.mjs` provam que nenhuma chamada perde o caminho).
*Capturas do app de verdade (nov/2026):* as 20 imagens saem de `mobile/publicar/capturas/gerar.sh`
— banco local de teste com a loja da seed (`seed_demo.py`, "Loja Tria", roupas), a API e o export
web do próprio app, fotografado cena a cena pelo Playwright numa tela de iPhone (áreas seguras
declaradas ao navegador), com a arte montada por cima (`compor.mjs`) nos dois tamanhos e com os
mesmos nomes; `png.mjs` grava RGB sem alfa. Nada é desenhado à mão: mudou uma tela, roda de novo.
A foto não retoca o app: a barra de abas e os rodapés respeitam a área segura sozinhos (se
deixarem de respeitar, o gerador para), e antes de cada foto `quadro.mjs` enquadra a lista —
nada cortado nas bordas, embaixo do indicador de início ou do botão flutuante, e o que a cena
pede em `mostrar` inteiro; sem posição assim, a cena para e muda (por isso o caixa sai com a
gaveta batendo e o estoque e os produtos pela busca). A hora da barra de status é a da foto, no
fuso da loja — a mesma do recibo e da condicional da cena — e a COR é a que o app pede para a
tela (`lib/barraDeStatus.ts`; escura nas telas claras sem cabeçalho: entrada, servidor, Vender),
anotada pelo `gerar.mjs`: se ela sumir sobre o fundo, o `compor.mjs` para em vez de pintar a
outra (antes, a cor vinha da foto e escondia a barra branca que o PDV tinha no iPhone). *O que a
foto não é:* o export web é o código das telas, mas a NAVEGAÇÃO é a do navegador: no iPhone o
cabeçalho é o nativo (título centralizado, "‹ Voltar", 44 pt) e o "Cobrar" abre como folha por
cima do PDV; nas fotos, o cabeçalho do export web (seta "←", título à esquerda, ~63 pt) e o
Cobrar em tela cheia. Para fotos com o cabeçalho do iPhone, só fotografando num aparelho ou
simulador (a sessão do BrowserStack da gravação serve); a gravação anexada à revisão mostra o
nativo.
O CI não roda o gerador (pede Postgres, Chromium e as fontes Inter), mas confere as commitadas nos
bytes contra as cenas (`compor.mjs --conferir`) e as sobe na Apple de mentira (`rodar.mjs --reais`).

**ADR-45 — Excluir a própria conta de dentro do app; o único dono passa o papel antes.**
*Contexto:* a Apple devolveu a primeira submissão (Guideline 2.1, "Information Needed") pedindo,
entre outras coisas, o vídeo do fluxo de exclusão de conta. A regra é a 5.1.1(v): app que cria
conta tem de deixar a pessoa **iniciar a exclusão da própria conta dentro do app** — desativar não
conta, e "peça ao administrador" também não. Aqui não há autocadastro, mas o app cria contas
(Mais › Usuários › novo), e o dono só podia desativar pelo app; excluir existia na API e a
própria conta era recusada. E havia um buraco pior: `DELETE /usuarios/{id}` de quem já tinha
vendido dava **500** — `sales.seller_id` (e caixa, estoque, devolução, condicional, contas a pagar)
é FK RESTRICT, e o "apagar a linha" só tinha olhado o `audit_log`. Na demo, a vendedora da carga
faz 60% das vendas: o revisor que tentasse excluí-la veria um erro.
*Decisão:* (1) `DELETE /usuarios/me` com `{senha}` para **qualquer** papel: a senha confirma que é a
pessoa e não um celular destravado na mão de outra; errada é 422 `SENHA_INCORRETA` — nunca 401,
que faria o cliente renovar e derrubar a sessão que a senha só confirmava (o mesmo cuidado do
`senha_atual` do backup, ADR-28). No app: Mais › Minha conta › Excluir minha conta; no web: Minha
conta. A tela diz o que some e o que fica (`lib/exclusaoDeConta.ts` e o espelho
`js/exclusao-de-conta.js`), pede a senha e confirma; deu certo, a sessão fecha só do lado do
cliente (o servidor já revogou tudo e apagou o cookie: um logout daria 401 e "sessão expirada") e
a entrada diz "Conta excluída". (2) **O único dono ativo não se exclui** (409 com o caminho:
"Passe o papel de dono a outra pessoa em Usuários antes"). É o padrão do Slack e do Google
Workspace: a loja não pode ficar sem quem administra equipe, backup e diário — e a conta do dono
é a chave do servidor da loja. Na demo da Vercel, o revisor testa a exclusão numa conta de
funcionário criada por ele (o dono da demo é o único dono). A contagem de donos trava as linhas de
dono (`FOR UPDATE`, em ordem de id): dois donos saindo juntos não deixam a loja sem nenhum — sem a
trava, cada um contava o outro. (3) O dono (e o gerente, para quem não é dono) segue excluindo
pela lista da equipe (`DELETE /usuarios/{id}`; agora com botão no app e no web); ninguém se exclui
por ali. (4) **Uma limpeza só** (`_apagar_conta`): trava a linha da conta (`travar_viva`, `FOR
UPDATE` só se ela ainda não foi excluída — duas exclusões da mesma conta ao mesmo tempo, de dois
aparelhos ou dela e do dono, viram uma, e a segunda leva 404 em vez de 500 no flush) e tenta
apagá-la num SAVEPOINT. Sem
histórico, ela sai inteira (sessões e leitor pelo CASCADE, o diário perde o vínculo pelo `SET
NULL`). Com histórico, o FK RESTRICT segura — e é para segurar: a venda é documento contábil da
loja, e o relatório de comissão ainda precisa saber de quem foi. A linha fica só com o nome e o
papel; o que é da CONTA vai embora do mesmo jeito: e-mail (trocado por
`conta-excluida-<id>@excluida.example` — `.example` é reservado, nunca será de ninguém, e continua
válido para o `EmailStr` de uma versão anterior —, e o de verdade fica livre para uma conta nova),
senha (um valor que não é hash: nenhuma senha confere), sessões, pareamentos do leitor (pelo ORM,
para avisar "leitor"), e `deleted_at` marca que ela não existe mais: fora de `GET /usuarios`, 404
para editar, redefinir senha ou excluir de novo, e um CHECK impede que volte a ser ativa. Nos dois
casos o e-mail sai do diário (máscara, ADR-23) e o nome congelado de quem agiu fica. (5) A linha do
diário "Excluiu a própria conta" (`USUARIO_EXCLUIU_PROPRIA_CONTA`) é gravada pela borda DEPOIS do
commit, quando a conta já saiu: a rota chama `congelar_autor(request, user)` antes do service, e a
borda grava sem `user_id` (o FK derrubaria a linha inteira no `try/except`) e com o nome e o papel
de antes. A borda também deixou de mandar o `user_id` de uma conta que não existe mais.
*Consequências:* a exclusão é a mesma pelo app, pelo web e pelo dono, e funciona para quem já
vendeu; as notas da revisão citam "Mais > Minha conta > Excluir minha conta" (qualquer pessoa) e
"Mais > Usuários > (pessoa) > Excluir conta" (dono). A conta excluída com histórico continua no
banco como o nome de quem vendeu — é o que a página pública de exclusão (`/exclusao-de-dados`) e a
política dizem que fica, e por quê. A confirmação no app é um `Modal` do próprio app
(`components/Confirmacao.tsx`), não `Alert.alert`, que não aparece no export web.
*Revisão (o que a primeira versão deixava para trás):* (6) **O caminho do dono único existe no
celular**: a recusa manda passar o papel de dono a outra pessoa em Usuários, e a lista da equipe do
app só tinha comissão, Desativar e Excluir — trocar papel era só no web. Agora `Mais › Usuários ›
(pessoa) › Mudar papel` (`mais/usuario-papel.tsx`, `PATCH /usuarios/{id}` `{papel}`), com a régua
do servidor espelhada em `possoMudarPapel`/`papeisQuePossoDar` (`lib/permissoes.ts` ↔
`js/permissoes.js`). (7) **O que a conta deixava**: a linha que fica perde também comissão e meta
(a remuneração da pessoa; a comissão de cada venda já está congelada nela, ADR-37), e as
`login_attempts` do e-mail saem na mesma transação (`AuthService.esquecer_tentativas`) — o login
grava o e-mail por extenso e a faxina só leva o de mais de um dia. O domínio da marca
(`excluida.example`) é recusado no cadastro: ocupado antes, ele fazia a exclusão daquela conta
estourar a UNIQUE (500) para sempre. (8) **Sem resposta não é "não excluída"**: o pedido que passa
do tempo (15 s no app) ou perde a conexão pode ter sido commitado; a tela diz que não dá para saber
e, na tentativa seguinte, lê o 401 sem o desvio de "sessão expirada" (`semRenovar`) e desempata pela
renovação (`depoisDaIncerta`): o servidor recusou o refresh → a conta saiu, e a entrada diz "Conta
excluída". No web, o modal da exclusão fica preso enquanto o pedido roda (`travar` do `modal`):
fechado no meio, a resposta não tinha mais a quem avisar. (9) **A conta da demonstração**: na
Vercel, a conta `DEMO_ADMIN_EMAIL` (a das notas da revisão) não se exclui, não perde o papel, não
é desativada e não troca de senha — 409 `CONTA_DE_DEMONSTRACAO`, antes de conferir a senha. Sem
isso, o revisor que criasse outro dono e voltasse em "Excluir minha conta" apagava a conta das
notas no meio da revisão. O publicador confere a trava com uma senha aleatória (que nunca confere
e não exclui nada) e recusa o envio sem ela; e o Redeploy recria o dono se uma demo de antes da
trava o perdeu (`_garantir_dono_da_demonstracao`, idempotente).
*Emenda (ADR-46): a proteção vale fora da Vercel.* Ela liga em qualquer demonstração — a Vercel ou
a que sobe com a loja em `/demo` — por `settings.conta_demo_protegida` (`(vercel or demonstracao)
and DEMO_ADMIN_EMAIL`, o e-mail minúsculo); na loja de verdade a mesma variável, se existir por
engano, não protege nada (o dono de uma loja real sai como qualquer um). A recusa continua antes
da senha, e, na demo da instalação, a conta das notas também não trava pelo e-mail no login
(emenda da ADR-24; na Vercel, trava como qualquer uma). Quem
recria a conta é quem sobe a demonstração: na Vercel, o Redeploy; na instalação, cada subida da
`api-demo` CONVERGE a conta (existe, é dona, está ativa e tem a senha de `DEMO_ADMIN_SENHA` — o
hash é refeito se não bater, e as sessões dela caem), e a renovação da madrugada a refaz do zero.

**ADR-46 — A demonstração sobe com a loja, em `<domínio>/demo`.**
*Contexto:* a revisão da Apple pede um servidor de demonstração no ar — conta de dono, dados de
mentira e a política de privacidade servida por ele (ADR-44, ADR-45) —, e ele só existia na Vercel
(ADR-42), montado à mão; numa loja instalada, o README ensinava a semear o PRÓPRIO banco com o
`seed_demo.py` ("não rode no banco da loja de verdade"). O dono pediu, com estas palavras: "a conta
demo já vai vir pronta" ao rodar o `./instalar.sh` numa VPS; "dados fictícios, nada de real; esse
usuário só pode fazer tudo no demo, e no real nada" — "praticamente dois sistemas rodando juntos";
o domínio configurado na própria instalação; a loja em `loja.seudominio.com.br` e a demonstração em
`loja.seudominio.com.br/demo`. A Vercel fica como está: nada muda no comportamento dela.
*Decisão:* uma segunda loja inteira ao lado da de verdade, na mesma máquina e no mesmo domínio,
separada camada por camada — porque o caminho, ao contrário de um subdomínio, não separa nada no
navegador: as duas dividem a mesma origem.
- **Topologia.** O `docker-compose.yml` ganha, no profile `demo`, o one-shot `demo-banco` e a
  `api-demo` (a MESMA imagem da `api`, `pull_policy: never`); banco e proxy são os de sempre. Quem
  liga é `COMPOSE_PROFILES=demo` no `.env`, que vale para todo `docker compose` da pasta. O proxy é
  um site só (`docker/caddy/Caddyfile`): `/demo` redireciona para `/demo/`, `/demo/*` vai à
  `api-demo` **sem tirar o prefixo** e o resto vai à `api`. Com a demo desligada ou ainda subindo,
  `/demo/api/*` recebe do próprio Caddy um 503 `DEMONSTRACAO_FORA_DO_AR` em JSON, e o resto de
  `/demo/*` uma página com a mesma frase — nunca a loja de verdade no lugar, e nunca um 502 vazio:
  com a frase, o app e a tela dizem que a demonstração está desligada ou começando, em vez de um
  erro que faria a pessoa redigitar um endereço certo. Só o erro de não alcançar a `api-demo` (502
  a 504) vira a frase: o 413 do teto do corpo (o mesmo da loja, por rota: 6 MB na foto e 2 MB no
  resto, ADR-25) também é erro do Caddy, e passa como é — "desligada" seria mentira para quem
  mandou um corpo grande demais. O 413 é do Caddy 2.7 em diante; no 2.6 o mesmo corpo sai 502
  (`request body too large`), e por isso os matchers da frase excluem esse erro pela mensagem: na
  demo ele sai 502 vazio, como na loja, e nunca "desligada ou começando".
- **Banco e role próprios, sem CONNECT no real.** No MESMO Postgres (um segundo servidor de banco
  seria memória a mais numa VPS pequena), o `demo-banco` cria e converge, a cada `up`, a role
  `loja_demo` — sem superusuário, sem criar banco nem role, `CONNECTION LIMIT 20` — dona só do banco
  `loja_demo`, e faz `REVOKE CONNECT ON DATABASE loja FROM PUBLIC` (e do `postgres`). Dentro do
  Postgres a demonstração só enxerga o que é dela: nem uma injeção de SQL na demo conectaria no banco
  real, e o superusuário `loja`, cuja senha a `api-demo` não recebe, é só da loja e do backup. O
  limite de conexões existe porque o `max_connections` é um só para os dois bancos: um robô
  martelando a demo não toma as conexões do balcão. E o pool da `api-demo` cabe nele
  (`DB_POOL_SIZE: "5"` e `DB_MAX_OVERFLOW: "8"` no compose): 13 no pico, mais 1 do LISTEN do tempo
  real e as 2 ou 3 do preparar/renovar (por `exec` no mesmo contêiner) ficam abaixo de 20. Com o
  padrão da loja (10 + 20), a 21ª conexão era recusada pelo Postgres e o pedido saía 500; dentro
  do pool, o excesso espera a vez — até 30 s (o `pool_timeout` do SQLAlchemy). Passado isso, sai
  500 também: uma rajada de logins na conta da demo, cada um segurando a conexão na fila da trava
  por e-mail, chega lá (130 de uma vez deram 11). E o banco da demo leva um marco, `ALTER DATABASE
  loja_demo SET loja.demonstracao = 'sim'`, que o real nunca tem: é a segunda chave de tudo que
  APAGA dados (abaixo).
- **Segredos próprios, escritos à mão.** O `.env` ganha `DEMO_SENHA_BANCO` (sorteada, 32
  caracteres), `DEMO_JWT_SECRET` (sorteado, 64), `DEMO_ADMIN_EMAIL=dono@demo.example` (fixo:
  `.example` é reservado pela RFC 2606, nunca será a caixa de alguém) e `DEMO_ADMIN_SENHA`
  (sorteada, 20). Só o `instalar.sh` e o `demo.sh` escrevem neles, com o `.env` em 600, e o
  `--forcar` MANTÉM os que já existem: a senha é a que está na Apple. **O segredo do login é outro
  porque o access token só leva o id do usuário** (`sub`, sem emissor nem instância) e a API busca o
  usuário por esse id no banco DELA: com o segredo da loja, o token do revisor (id 1 na demo) abriria
  a conta de id 1 da loja — a do dono. O instalador sorteia de novo até os dois serem diferentes. A
  lista de variáveis da `api-demo` é escrita à mão, nunca copiada da `api` nem por `env_file`:
  `FOCUSNFE_TOKEN`, `SENHA_BANCO` e o `JWT_SECRET` da loja não chegam lá. As fotos ficam num volume
  dela (`fotos-da-demo`), e a NFC-e é desligada pela própria config quando `settings.demonstracao`
  está ligada, venha o que vier do ambiente: a venda de quem testa nunca sai como nota no CNPJ da
  loja.
- **As fotos da demo têm teto.** O volume `fotos-da-demo` mora no MESMO disco do banco da loja, e a
  senha da demo vai para a Apple e para quem o dono mostra o sistema: sem teto, envios repetidos de
  5 MB (criar produto é livre, então apagar a foto trocada não limitaria nada) encheriam o disco e
  parariam o Postgres da loja. Com `settings.demonstracao` e a foto no disco, `fotos._fabricar` dá
  o `FotosDaDemonstracao`: antes de gravar ele soma o que `MEDIA_DIR/produtos` OCUPA — o bloco
  inteiro de cada arquivo, senão milhões de "fotos" de 9 bytes passariam pelo teto enchendo o disco
  e os inodes — e recusa com 409 `DEMONSTRACAO_SEM_ESPACO` a foto que passaria de
  `DEMO_FOTOS_MAX_BYTES` — 200 MB por padrão; o compose passa à `api-demo` o valor do `.env`
  (`${DEMO_FOTOS_MAX_BYTES:-209715200}`: vazio não vira número e a demo não subiria), e o valor
  novo vale depois de recriar a `api-demo` (`./demo.sh --ligar`). Medir e gravar são um passo só
  (`asyncio.Lock` do processo; a `api-demo` é um processo só — com N, o teto passaria de no máximo
  N-1 fotos). A renovação esvazia
  a pasta (abaixo), e o teto volta a zero toda madrugada. Na loja e no Blob, nada disso.
- **A API sob o prefixo.** `LOJA_DEMONSTRACAO=1` liga `settings.demonstracao`; `PREFIXO=/demo`
  (vazio, ou `/[a-z0-9-]+` sem barra no fim — o resto é recusado no boot, nunca "consertado": um
  prefixo que a API entendesse diferente do Caddy daria 404 em tudo, calado) faz o `app.main` expor
  em `app` um envoltório Starlette com `Mount(prefixo, app=<a FastAPI>)` que repassa o lifespan; o
  CMD `uvicorn app.main:app` não muda e, fora do prefixo, a resposta é 404. Tudo que gera caminho
  absoluto lê o `root_path` que o `Mount` põe: o `/` leva a `/demo/app/` (um `/app/` seco levaria
  quem testa para a loja), o cookie `loja_refresh` vale em `{root}/api/v1/auth` no set e no delete,
  e a auditoria classifica o caminho sem o prefixo — lido cru, toda mutação da demo saía do diário,
  calada. `GET /configuracao` e `/configuracao/completa` dizem `demonstracao`.
- **No navegador: cookie por caminho, web relativa, faixa.** O cookie tem o MESMO nome nas duas, e
  é o `Path` que as separa: o navegador não manda o refresh da loja para a demo nem o contrário, e
  entrar ou sair de uma não derruba a sessão da outra. A web é a mesma pasta, servida em
  `<raiz>/app/`, e descobre a raiz pelo próprio endereço (`web/js/raiz.js`: o que vem antes do
  `/app` do fim; "" na loja, "/demo" na demo), sem build nem config: API e renovação em
  `<raiz>/api/v1`, o WebSocket em `<raiz>/api/v1/tempo-real`, a foto relativa em `<raiz>/media/...`
  (a URL absoluta do Blob passa direto) e as páginas legais com a raiz. Com o `/api/v1` absoluto de
  antes, a página da demo entraria, venderia e abriria o tempo real NA LOJA. As chaves do
  `sessionStorage`/`localStorage` e o `BroadcastChannel` ganham `@<raiz>` só fora da raiz vazia: na
  loja os nomes ficam os de sempre e nada guardado se perde na atualização. E, porque as duas têm as
  mesmas telas no mesmo domínio, a demo mostra uma **faixa fixa** no topo de toda tela, já na
  entrada — "Loja de demonstração — os dados são fictícios." —: sem ela, quem tem as duas abas
  abertas lança a venda de verdade na demo, e ela some na renovação da madrugada. Quem decide é o
  servidor (`demonstracao`), não o caminho da página: a demo da Vercel mora na raiz do domínio dela,
  e lá nada muda. O app faz o mesmo com o endereço do aparelho: `normalizarEndereco` guarda a base
  COM o caminho (`https://loja.x.com.br/demo`; sem esquema, `https://` para nome de domínio e
  `http://` só para IP, `localhost` e `*.local`, a rede local que o ATS do iOS libera), junta as
  rotas por texto, compara a base INTEIRA no convite do leitor (ADR-43) e mostra a mesma faixa. O
  publicador aceita `url_servidor_demo` com caminho e também junta por texto (ADR-44).
- **A conta do revisor.** A proteção da ADR-45 vale por `settings.conta_demo_protegida`, que liga na
  Vercel ou na demonstração e nunca na loja. A exceção da trava da ADR-24 (só o IP conta) vale SÓ na
  demonstração da instalação (`settings.demonstracao`), cuja senha é sorteada; na Vercel a senha é
  escolhida por gente, e a trava por e-mail continua a de sempre (as emendas estão nas duas ADRs).
- **Carga, preparo e renovação: duas chaves.** O que era do build da Vercel virou
  `app/demonstracao.py`, com duas origens (ADR-42 para a Vercel). Na instalação, o
  `docker/entrada.sh` roda, depois do `alembic upgrade head`, `python -m app.cli
  preparar-demonstracao` a cada subida da `api-demo` — o ÚNICO gatilho da carga: dois correriam
  juntos e duplicariam o que não tem chave única —; se ele falhar, avisa e sobe o servidor assim
  mesmo, sem laço de reinícios, e o próximo boot retoma de onde parou (a carga é retomável). Ali o
  preparo assina os marcos como "Demonstração (instalação)", dá o nome "Loja de Demonstração" e o
  ramo ROUPAS (o catálogo do seed é de roupa) e converge a conta do revisor. `renovar-demonstracao`
  faz TRUNCATE de todas as tabelas do schema `public` menos `alembic_version` (`RESTART IDENTITY
  CASCADE`), apaga os arquivos de `MEDIA_DIR/produtos` (a pasta e o `MEDIA_DIR`, onde o volume está
  montado, ficam) e prepara de novo. O TRUNCATE disputa as travas das tabelas com a API que está
  atendendo, e trava uma a uma. Em ordem alfabética, chegava a `users` quase no fim: a requisição
  que já tinha passado pelo crachá (`get_current_user` lê `users` primeiro e segura a trava até o
  fim) pedia `products`, que ele já tinha, e o Postgres derrubava um dos dois — às vezes a
  requisição, com 500. Por isso ele trava antes as **portas da API**, na ordem em que ela as pega
  (`PORTAS_DA_API`: `login_attempts`, que o login conta antes de ler a conta; `refresh_tokens`, que
  a renovação da sessão trava antes de ler a conta; `users`), num `LOCK TABLE` — que trava na
  ordem dada; a do TRUNCATE não é documentada —, e só então o resto: quem já passou por uma porta
  termina sem esbarrar nele, e quem chega depois espera na porta sem segurar nada. Com três
  navegadores pedindo a lista de produtos sem parar, 8 renovações em 8 sem impasse, sem repetição
  e sem 5xx (antes, repetição em 4 das 8 e 23 respostas 500). A repetição fica como rede para
  quem entra sem passar por uma porta — a transação que a rota abre depois de um commit no meio da
  requisição: a da foto, depois do login, e a releitura de uma mutação enquanto a auditoria grava o
  diário por outra conexão (a borda espera `users` atrás do TRUNCATE, que espera a releitura: um
  ciclo que o Postgres não vê, desfeito pelo prazo da trava) —: cada trava espera no máximo 5 s
  (`lock_timeout`; só os testes a encurtam, com `DEMO_RENOVAR_ESPERA_DA_TRAVA_MS`, que na
  instalação não chega à `api-demo`) e, em impasse (40P01) ou espera vencida (55P03), a transação
  inteira volta — nada foi zerado — e se repete, até 5 tentativas, com pausa que dobra (1, 2, 4,
  8 s), avisando na saída. As fotos só saem depois de um TRUNCATE que deu certo. Os dois comandos
  exigem as DUAS chaves — o contêiner se diz
  demonstração (`settings.demonstracao`) E o banco também (o marco `loja.demonstracao`) —, porque o
  banco de uma loja recém-instalada está vazio, que é exatamente o "pode semear" da carga: uma
  variável copiada por engano para o contêiner da loja não basta para tocar no banco dela. Sem as
  duas, saem com código ≠ 0 e a frase de qual faltou, sem tocar em nada; nunca imprimem senha nem a
  URL do banco. As contas (`DEMO_ADMIN_*`, `DEMO_VENDEDORA_SENHA`) são conferidas ANTES do TRUNCATE
  e de qualquer escrita — a régua do cadastro (`UsuarioCreate`), mais a senha de até 72 BYTES (o
  bcrypt; o cadastro conta caracteres) e o dono com e-mail diferente do da vendedora (`ana@loja.com`,
  que a carga cria) —: inválidas, a renovação sai ≠ 0 sem tocar em nada e a demo de ontem segue no
  ar, com a conta do revisor (o preparo também para sem gravar). Na instalação, preparo e renovação
  esperam um pelo outro (`pg_advisory_lock` de sessão, numa conexão própria); na Vercel, não — uma
  trava presa no Neon seguraria o próximo deploy.
- **Renovação diária, porque o seed é relativo a hoje.** As vendas da carga se espalham pelos 25 dias
  ANTES do dia em que ela rodou: semanas depois, o "hoje", a semana e o mês da demo estariam vazios,
  e o que cada revisor vendeu, cancelou ou excluiu ficaria para o próximo — inclusive o saldo do
  código das notas, que a conferência do publicador exige (ao menos 3 peças). O timer
  `loja-demo-renovar` (04:30 no fuso da loja, com `OnFailure=loja-aviso@%N`, ADR-32) renova toda
  madrugada; `./demo.sh --renovar` faz o mesmo na hora.
- **A demo nunca derruba a loja.** Nenhum serviço da loja tem `depends_on` num da demo, e a
  `api-demo` tem teto de memória (`mem_limit`, 512 MB por padrão, `DEMO_MEMORIA` no `.env`): numa
  VPS pequena é ela que cede, nunca a loja. O instalador sobe a loja pelo nome, confere, e só depois
  a demo, esperando com teto e só avisando se ela não ficou pronta. O `atualizar.sh` sobe em DUAS
  fases: `up -d --build --remove-orphans db api proxy` decide sucesso ou volta atrás, como sempre; só
  então, com a demo ligada, `up -d demo-banco api-demo`, cuja falha avisa (pelo `notificar.sh`) e não
  desfaz nada. **A volta atrás não toca na demo:** toda volta atrás vem antes da segunda fase, e o
  `up` que só nomeia `db api proxy` não recria serviço que não foi nomeado — a demo segue no
  contêiner, na imagem e no banco de ANTES, sem nunca ter rodado a versão desfeita. Apagar o banco
  dela e semear de novo (era o que se fazia, "um schema mais novo que o código não a deixaria
  subir") não protegia nada: só a tirava do ar, com `/demo` em 503, e derrubava a sessão de quem
  estava nela — o revisor da Apple inclusive. A exceção é a demo que sumiu: se a versão desfeita
  tirou ou renomeou o serviço, o `--remove-orphans` da primeira fase levou o contêiner dela como
  órfão, e nada o traria de volta até o próximo `./demo.sh --ligar`. Com a demo ligada e o
  `compose ps -q api-demo` vazio, a volta atrás sobe `demo-banco api-demo` de novo — sem DROP, no
  banco de antes —, e a falha avisa pelo `notificar.sh`, como na segunda fase. Backup e vigia
  continuam só da loja.
- **A pasta do Caddyfile, montada inteira.** O `git reset --hard` da atualização troca o
  `docker/caddy/Caddyfile` por um arquivo novo (inode novo), e um arquivo montado sozinho continua
  mostrando o VELHO ao contêiner até ele ser recriado: o `caddy reload` "dava certo" sem mudar nada,
  e o `/demo` (ou uma CSP nova) só chegaria no próximo reboot, numa hora que ninguém escolheu. Com a
  pasta montada, o contêiner enxerga o arquivo novo na hora; quando o Caddyfile mudou e o proxy não
  foi recriado, o `atualizar.sh` roda `caddy validate` e `caddy reload` por `exec` (o que não passa
  desfaz a atualização) e confere a loja PELO PROXY antes de dizer "Atualizado" — a saúde de dentro
  da API não enxerga um Caddyfile quebrado. O `limpar_orfaos` pega o `<hash>_loja-<serviço>-N` de
  qualquer serviço, não só da `api`.
- **Do Compose 2.3 ao 5.8, por regra e não por versão.** O instalador aproveita o Docker que a
  máquina já tiver (do 2.3 do apt ao 5.8 do get.docker.com; o `name: loja` do compose já exige o
  2.3), e nessa faixa quatro comportamentos mudam. Então: (R1) só `${X:-}` nos serviços da demo,
  nunca `:?`, `?` nem `env_file` — `${X:?}` num serviço de profile desligado quebra a interpolação
  do ARQUIVO INTEIRO, e com ela todo `docker compose` de uma loja antiga, inclusive o `pg_dump` do
  backup e o `/health` do vigia; (R2) `pull_policy: never` na `api-demo` — até o 2.12, o pull de uma
  imagem que só existe local derrubava o `up`; (R3) desligar e desinstalar NOMEIAM a demo (`rm -sf
  api-demo demo-banco`, `down --profile demo`) — o `up --remove-orphans` nunca derruba serviço de
  profile desligado, e o `down` sem o profile a deixa rodando (ou falha, abaixo do 2.18); (R4)
  nenhum serviço sem profile depende de um da demo. Um `.env` antigo, sem as variáveis novas,
  continua dando só `db`, `api` e `proxy`.
- **Instalação e operação.** O `instalar.sh` liga a demo por padrão (`--sem-demo` a deixa de fora)
  e confere o DNS do domínio ANTES de gravar o `.env` — e, com isso, antes do `up`: o certificado só
  sai com o nome apontando para esta máquina, o Let's Encrypt limita as tentativas que falham, e uma
  espera interrompida (o Ctrl+C de quem foi acertar o painel, o SSH que cai) não deixa um `.env`
  que a rodada seguinte reaproveitaria sem criar o dono. A pergunta vai ao DNS, e não ao que a
  máquina acha: pelo `resolvectl query --synthesize=no --cache=no` quando o `resolv.conf` aponta
  para o stub do systemd-resolved (`127.0.0.53`, que responde pelo `/etc/hosts` mesmo a um
  `getent -s dns`), e pelo `getent -A -s dns` nos outros — sem o `/etc/hosts` (um nome posto lá,
  ou o 127.0.1.1 do hostname, decidiriam no lugar do registro) e sem o AI_ADDRCONFIG (numa máquina
  sem IPv6 ele esconde o AAAA); o getent antigo, sem o `-A`, pergunta com o `-s dns` e, numa
  máquina sem IPv6, diz que o AAAA não foi conferido. Mostra o registro exato a criar (Tipo A ·
  Nome · Valor, com o IP público perguntado a serviços de eco) e o AAAA de outra máquina a apagar;
  no interativo, espera conferindo a cada 15 s (Enter segue sem esperar), e com `--sim` não espera
  e repete a pendência no resumo. O `--forcar` refaz o `.env` pelo modelo (domínio, portas, fuso,
  o segredo do login de novo) e leva adiante o que o modelo não escreve, como estava — a NFC-e
  (`FISCAL_*`, `FOCUSNFE_*`: só o `.env` a liga, ADR-41), o `DEMO_MEMORIA`, uma linha à mão, também
  a `export CHAVE=valor` —, além das senhas da demo (a da conta é a que está na Apple) e do
  `BACKUP_REMOTO` e do `NOTIFICAR_URL` quando a rodada não traz outros; a saída diz, pelo nome, o
  que ficou. O `-Forcar` do Windows (`instalar.ps1`) ainda refaz só com o modelo, e o README diz o
  que copiar de volta. O resumo final traz a URL da
  demo, o e-mail e a senha — a senha só quando acabou de ser sorteada; depois, `./demo.sh
  --mostrar`. O `atualizar.sh` nunca escreve no `.env`: a loja que já existia ganha a demo pelo
  `./demo.sh --ligar` (ou rodando o `./instalar.sh` de novo, que respeita quem a desligou). O
  `demo.sh` mostra (`--mostrar`: endereço, conta e o que levar ao GitHub e à Apple — e, com
  domínio, as URLs de privacidade e de exclusão de dados que o Play Console tem de receber ANTES de
  o servidor antigo, a Vercel, ser desligado: o Google Play não passa pelo publicador), liga, renova,
  desliga (os dados ficam) e, com `--desligar --apagar`, apaga banco, role, fotos e as `DEMO_*` do
  `.env`; `--automatico` liga o timer. O `desinstalar.sh` derruba a demo junto (`--profile demo`) e
  desliga o timer; o `diagnostico.sh` a mostra (o `demo-banco` "exited (0)" é o normal de um
  one-shot).
- **Por que caminho e não subdomínio.** `demo.<domínio>` separaria a origem de graça — cookie,
  storage e o resto — sem mexer em cliente nenhum. Mas o dono pediu `<domínio>/demo`, e o caminho
  dispensa um segundo registro DNS e um segundo certificado: o domínio que a instalação já confere
  serve às duas, e "vem pronta" continua verdade. O preço foi ensinar a API, a web, o app e o
  publicador a morar debaixo de um caminho, cada um com teste.

*Consequências:* toda instalação com domínio nasce com uma demonstração pública em
`https://<domínio>/demo`; a local, em `http://localhost/demo`, serve para testar na rede — a Apple
só alcança https. Para a revisão usar a demo da loja: Variables `APPLE_SERVIDOR_DEMO` (o endereço
COM o `/demo`) e `APPLE_EMAIL_DEMO`, e a senha pelo workflow "Senha da conta demo na Apple" (o
`./demo.sh --mostrar` diz os três); o `padroes.json` continua apontando para a Vercel até a VPS
existir. O que se faz na demo dura até a madrugada, e o servidor carrega uma segunda API (até
512 MB). **Risco aceito: a mesma origem.** O navegador não separa `/demo` de `/`: um script que
rodasse na página da demo poderia chamar a API da loja, e o navegador mandaria junto o cookie da
loja — o `Path` decide o que vai sozinho, não o que um script pode pedir. O risco é do navegador
que tem as duas sessões, o do dono. As barreiras: a CSP `script-src 'self'` sem inline e o template
que escapa tudo (ADR-25; as telas são as mesmas nas duas), o access token só em memória, o token da
demo que não vale na loja (segredo próprio), a role da demo que nem conecta no banco real, e só dado
fictício do lado de lá. Os testes provam o isolamento em cada ponta (§7), e o job `imagem` do CI sobe
a pilha de verdade (`testes/pilha/pilha.sh`: compose com `.env` antigo e novo, o Caddyfile nos dois
modos, e contas, tokens, cookies e bancos da loja e da demo sem se cruzar; o pool da demo em três
rajadas de 60 pedidos; o teto do corpo por rota nas duas — 413 no login de 3 MB e na foto de 7 MB,
com a foto de verdade passando, até a de 3 MB —; e o WebSocket do tempo real pelo proxy, com mais
que o teto passando pelo socket).

## 4. Contratos de API

Prefixo `/api/v1`. Auth: `Authorization: Bearer <access_token>`.
Na demonstração que sobe com a loja, a API inteira mora sob `/demo` — `/demo/api/v1/...`,
`/demo/health`, `/demo/app/` (ADR-46) — e, fora do prefixo, a `api-demo` responde 404.
Listagens são paginadas: `?page=1&size=20` (size ≤ 100) → `{items, total, page, size}`.
Erros: `{"code": "...", "message": "...", "detail": {...}}`.

| code | HTTP | quando |
|---|---|---|
| `CREDENCIAIS_INVALIDAS` | 401 | login errado |
| `TOKEN_INVALIDO` | 401 | access/refresh inválido, expirado ou revogado |
| `SEM_PERMISSAO` | 403 | capacidade que o cargo não tem |
| `NAO_ENCONTRADO` | 404 | recurso inexistente |
| `DUPLICADO` | 409 | e-mail, código de barras, categoria repetidos |
| `ESTOQUE_INSUFICIENTE` | 409 | venda/ajuste deixaria o saldo negativo |
| `OPERACAO_INVALIDA` | 409 | ex.: cancelar venda já cancelada |
| `PAGAMENTO_DIVERGENTE` | 422 | soma dos pagamentos ≠ total |
| `VALIDACAO` | 422 | payload inválido |
| `EMISSOR_NAO_CONFIGURADO` | 409 | NFC-e sem emissor ligado no `.env`; `detail.faltando` (ADR-41) |
| `DADOS_FISCAIS_INCOMPLETOS` | 409 | NFC-e sem NCM, CNPJ, IE ou regime; `detail.faltando`, `detail.produtos_sem_ncm` |
| `MUITAS_TENTATIVAS` | 429 | logins errados demais na janela; `detail.retry_after` em segundos, header `Retry-After`. A conta da demonstração da instalação (`/demo`: `settings.demonstracao` e `conta_demo_protegida`) conta só o IP; na Vercel, a regra de sempre (ADR-24, ADR-46) |
| `LEITOR_CODIGO_INVALIDO` | 404 | código do leitor pelo celular inexistente, vencido, já aceito por outro ou encerrado — a MESMA resposta (ADR-43) |
| `LEITOR_DESLIGADO` | 409 | bipe num pareamento que não está ATIVO; `detail.status` diz qual (ADR-43) |
| `LEITOR_FILA_CHEIA` | 409 | 100 bipes esperando o computador retirar (ADR-43) |
| `DEMONSTRACAO_SEM_ESPACO` | 409 | só na demonstração da instalação (`settings.demonstracao`, foto no disco): a foto passaria do teto da pasta de fotos (`DEMO_FOTOS_MAX_BYTES`: 200 MB por padrão, ajustável no `.env`, vale depois de recriar a `api-demo`); `detail.limite_mb`. A foto de antes fica, e a renovação da madrugada esvazia a pasta (ADR-46) |
| `CONTA_DE_DEMONSTRACAO` | 409 | numa demonstração — a Vercel ou a que sobe com a loja em `/demo` (`conta_demo_protegida`) —, excluir, rebaixar, desativar ou trocar a senha da conta `DEMO_ADMIN_EMAIL` (ADR-45, ADR-46) — antes de conferir a senha. Na loja de verdade, nunca |
| `DEMONSTRACAO_FORA_DO_AR` | 503 | do PROXY, não da API: `/demo/api/*` com a demonstração desligada ou subindo. Corpo `{"code":"DEMONSTRACAO_FORA_DO_AR","message":"A demonstração está desligada ou começando. Tente de novo em um minuto.","detail":{}}`; o resto de `/demo/*` recebe a mesma frase numa página. Nunca a loja no lugar (ADR-46) |

### 4.1 `auth`
| método | rota | papel | descrição |
|---|---|---|---|
| POST | `/auth/login` | público | `{email, senha}` → `{access_token, refresh_token, expires_in, usuario}` |
| POST | `/auth/refresh` | público | `{refresh_token}` → novo par (rotação). Reuso de token já rotacionado revoga a família inteira |
| POST | `/auth/logout` | autenticado | `{refresh_token}` → 204, revoga a família |
| GET | `/auth/me` | autenticado | usuário corrente |

### 4.2 `usuarios`
`GET /usuarios` (A) · `POST /usuarios` (A) · `GET/PATCH /usuarios/{id}` (A) ·
`PATCH /usuarios/{id}/senha` (A, reset) · `PATCH /usuarios/me/senha` (qualquer, exige senha atual).
Desativar = `PATCH {ativo:false}`. Bootstrap do primeiro admin: `python -m app.cli create-admin`.
(A) = `GERIR_USUARIOS` (dono e gerente; conta de dono só o dono mexe — 403).

| método | rota | papel | notas |
|---|---|---|---|
| DELETE | `/usuarios/me` | qualquer logado | `{senha}` → 204 e apaga o cookie do refresh. Exclui a PRÓPRIA conta (ADR-45). Senha errada → **422 `SENHA_INCORRETA`** (nunca 401: derrubaria a sessão; nada muda). Sem senha → 422 `VALIDACAO`. Único dono ativo → **409 `OPERACAO_INVALIDA`** "Você é o único dono da loja. Passe o papel de dono a outra pessoa em Usuários antes de excluir a sua conta." Numa demonstração (a Vercel ou a de `/demo`), a conta `DEMO_ADMIN_EMAIL` → **409 `CONTA_DE_DEMONSTRACAO`**, antes da senha. Diário: `USUARIO_EXCLUIU_PROPRIA_CONTA`, "Excluiu a própria conta", sem `user_id` e com nome/papel de antes |
| DELETE | `/usuarios/{id}` | A | 204. Exclui a conta de OUTRA pessoa (a mesma limpeza). A própria → 409 (o caminho é `/usuarios/me`, com a senha); o último dono ativo → 409; gerente em dono → 403; conta já excluída → 404 |

As duas exclusões fazem a mesma limpeza (`UsuarioService._apagar_conta`): sessões derrubadas,
celular-leitor desligado, e-mail mascarado no diário; a linha sai inteira, ou fica só com o nome
de quem fez a venda (ADR-45). Venda e diário ficam, com o nome congelado.
`UsuarioOut` traz `comissao_percentual` ("2.50") e `meta_diaria` (string ou `null`). No `POST` e no
`PATCH` esses dois campos exigem `DEFINIR_COMISSAO` (só o dono): mandá-los sem ela é `403`, mesmo
com o valor atual. No `PATCH`, ausente = não mexe, `meta_diaria: null` tira a meta (ADR-37).

### 4.3 `catalogo`
| método | rota | papel | notas |
|---|---|---|---|
| GET/POST | `/categorias` | A/V · A | |
| PATCH/DELETE | `/categorias/{id}` | A | delete é soft; bloqueado se houver produto ativo |
| GET | `/produtos` | todos | `?q=&categoria_id=` · `q` acha por nome (sem acento, como `/variantes`) ou código da grade; custo só para quem tem VER_DINHEIRO |
| POST | `/produtos` | A/V | produto + `variantes[]` (com `estoque_inicial?` → gera ENTRADA na mesma transação) |
| GET/PATCH/DELETE | `/produtos/{id}` | A/V · A · A | detalhe traz variantes com saldo; DELETE só com saldo zero, conferido com grade e saldos travados (ADR-30) |
| PUT | `/produtos/{id}/foto` | A/V | multipart, campo `arquivo`: um arquivo e até 4 campos de texto ao lado; mais, 400 (`{"detail": ...}` com a frase do Starlette, em inglês, §2.2). Lido só DEPOIS do login (sem login, 401 sem ler o envio); no disco salva em `media/produtos/` (caminho relativo), com `BLOB_READ_WRITE_TOKEN` no Vercel Blob público (URL absoluta, a antiga é apagada se for do mesmo ambiente). Teto 5 MB (4 MB na Vercel); na demo da instalação, 409 `DEMONSTRACAO_SEM_ESPACO` acima do teto da pasta de fotos (`DEMO_FOTOS_MAX_BYTES`, ADR-46); 503 `FOTO_NAO_GUARDADA` se não guardou, inclusive na Vercel sem Blob (§2.2, ADR-42) |
| POST | `/produtos/{id}/variantes` | A/V | adiciona variante a produto existente |
| PATCH/DELETE | `/variantes/{id}` | A | DELETE só com saldo zero, conferido com peça e saldo travados (ADR-30) |
| GET | `/versao` | A/V | commit instalado, quando foi conferido e se há versão nova; lê `docker/estado/versao.json` |
| GET | `/variantes` | A/V | `?produto_id=&q=` · `q` acha por **nome do produto, cor ou código** (sem acento, código exato primeiro); a resposta traz `produto` e `saldo` |
| **GET** | **`/variantes/codigo-barras/{codigo}`** | A/V | lookup do PDV: produto + variante + preço + saldo. 404 → app oferece cadastro rápido |
| POST | `/variantes/gerar-codigo-interno` | A/V | `{codigo}` EAN-13 interno, ainda não usado |

### 4.4 `estoque`
| método | rota | papel | notas |
|---|---|---|---|
| POST | `/estoque/entradas` | A/V | `{client_uuid, fornecedor?, observacao?, itens:[{variante_id, quantidade, custo_unitario?}], nota?}`; `custo_unitario` atualiza o custo da variante — só de quem tem VER_DINHEIRO; dos outros é ignorado, a mesma tranca do catálogo. `nota: {numero?, valor_total, parcelas:[{vencimento, valor}]}` cria as contas a pagar na mesma transação — só VER_DINHEIRO (403 dos outros), exige fornecedor e parcelas que somem a nota (ADR-40). Resposta traz `contas_a_pagar` (quantas parcelas). Replay → 200; mesma chave com outras peças, quantidades, fornecedor, custo ou nota → 409 com `detail.entrada_id`, `detail.itens` (o que ela gravou) e, para VER_DINHEIRO, `detail.nota` (a nota gravada ou `null`) — a tela tira os dois antes de trocar a chave (ADR-2) |
| POST | `/estoque/ajustes` | A | `{variante_id, quantidade(±), motivo}` — motivo obrigatório |
| POST | `/estoque/inventarios` | A | `{observacao?, contagens:[{variante_id, quantidade_contada}]}` → movimentações das diferenças + resumo. A diferença é calculada com peças e saldos travados (ADR-30) |
| GET | `/estoque/saldos` | A/V | `?q=&categoria_id=&somente_baixo=` · `q` acha por nome do produto (sem acento, como `/variantes`) ou código |
| GET | `/estoque/movimentacoes` | A/V | extrato `?variante_id=&tipo=&inicio=YYYY-MM-DD&fim=YYYY-MM-DD` (dias no fuso da loja, ADR-27) |

### 4.5 `vendas`
| método | rota | papel | notas |
|---|---|---|---|
| POST | `/vendas` | A/V | `{client_uuid, desconto?, observacao?, cliente_id?, itens:[{variante_id, quantidade}], pagamentos:[{forma, valor, codigo_vale?}]}` → venda completa. Atômico. Replay → 200; mesma chave com outras peças ou outra cobrança (forma, valor, parcelas, bandeira, vale, desconto) → 409 (ADR-2) |
| GET | `/vendas` | todos | `?inicio=YYYY-MM-DD&fim=YYYY-MM-DD` (dias no fuso da loja, ADR-27) `&status=&vendedor_id=&variante_id=&cliente_id=`; sem VER_VENDAS_DE_TODOS, o service força as próprias |
| GET | `/vendas/{id}` | A/V | idem escopo |
| POST | `/vendas/{id}/cancelamento` | CANCELAR_VENDA | `{motivo}`; dono e gerente — quem vende não desfaz. Recusa (409) venda de dia com caixa fechado: devolve-se (ADR-19). Com NFC-e AUTORIZADA, cancela a nota no emissor ANTES (motivo ≥ 15 → senão 422); emissor recusou/sem rede/sem resposta definitiva (429, 5xx...)/desligado → 409 e a venda segue concluída (ADR-41) |
| POST | `/vendas/{id}/devolucoes` | DEVOLVER_VENDA | `{client_uuid, motivo?, itens:[{item_id, quantidade, voltar_ao_estoque?}]}` → devolução com os valores decididos pelo servidor. Replay → 200; mesma chave com outra venda ou outras peças → 409 (ADR-2) |
| GET | `/vendas/{id}/devolucoes` | DEVOLVER_VENDA | o que já voltou desta venda |
| GET | `/vendas/vales/{codigo}` | A/V | consulta o vale: `{codigo, valor, usado, saldo}` |
| GET | `/vendas/{id}/nfce` | quem vê a venda | `{venda_id, emissor:{nome, ambiente, configurado, faltando[], emitir_automatico}, nota: NotaOut \| null}` — 200 mesmo com emissor desligado (a tela decide se mostra) |
| POST | `/vendas/{id}/nfce` | quem vê a venda | emite (ADR-41). Idempotente: nota AUTORIZADA devolve a mesma, sem chamar o emissor. 409 `EMISSOR_NAO_CONFIGURADO` (`detail.faltando`), 409 `DADOS_FISCAIS_INCOMPLETOS` (`detail.faltando`, `detail.produtos_sem_ncm`), 409 venda cancelada. Rede caída/SEFAZ processando/429/4xx fora da tabela da Focus → 200 com nota PENDENTE |
| GET | `/fiscal/emissor` | qualquer logado | o mesmo bloco `emissor`; o token nunca, só se existe |

Troco não trafega: é calculado no app a partir do valor recebido em dinheiro. No web, o
"Dinheiro recebido" vem **sugerido** igual à parte em dinheiro e a acompanha nos dois sentidos
até alguém digitar nele; digitado, a parte mudar não o reescreve (se ficar menor que ela, a tela
avisa e trava o botão). Acompanhar só para cima deixava troco fantasma: R$ 200 em dinheiro
baixados para R$ 50 + R$ 150 no PIX mantinham "recebido 200" e mandavam devolver R$ 150 a quem
entregou R$ 50.

`?variante_id=` existe para a devolução: no balcão a cliente chega com a blusa e sem nota, e
o caminho começa na peça — "de quais vendas esta peça saiu?" — não no número da venda.
A tela gera o `client_uuid` com a devolução e o troca quando ela é **gravada** ou quando a
**venda muda** — reabrir a mesma venda depois de uma resposta perdida mantém o uuid, que é o
retry. O replay confere a venda e as peças do pedido (ADR-2) — a mesma chave noutra venda é
409, não o comprovante da anterior —, e o leitor segue ligado sob o comprovante: com um uuid por
tela, a peça da próxima cliente bipada ali recebia o comprovante da anterior, e a devolução dela
não era gravada.

Venda cancelada não pode ter devolução, e venda com devolução não pode ser cancelada: são
dois caminhos para desfazer a mesma coisa, e deixar os dois abertos devolveria a peça duas
vezes (ADR-9 diz como isso vale até com as duas chegando juntas). Venda no fiado cujo
cancelamento deixaria o saldo da cliente negativo (porque ela já pagou) também não se cancela —
devolve-se (ADR-21). E venda de um dia cujo caixa já foi fechado, idem: cancelar reescreveria a
conferência feita, e a devolução entra no caixa de hoje (ADR-19).

### 4.6 `clientes` (GERIR_CREDIARIO: dono e gerente; o balcão é ATENDER_CLIENTE: todos)
| método | rota | notas |
|---|---|---|
| GET | `/clientes` | `?q=&somente_devendo=`; `deve` e `acima_do_limite` vêm calculados |
| POST | `/clientes` | `{nome, telefone?, documento?, limite?, nascimento?, preferencias?}` |
| GET | `/clientes/balcao` | **ATENDER_CLIENTE**. `?q=` (nome sem acento, trecho do telefone ou documento INTEIRO — por igualdade, a partir de 7 dígitos, nunca por trecho), paginado. Responde `ClienteBalcaoOut` `{id, nome, telefone, nascimento, preferencias}` — sem `deve`, `limite`, `observacao` nem `documento` (ADR-36) |
| POST | `/clientes/balcao` | **ATENDER_CLIENTE**. `{client_uuid, nome, telefone?, nascimento?, preferencias?}` → 201 `ClienteBalcaoOut`. Replay → 200; mesma chave com outro nome ou telefone → 409. Telefone de cliente ativa → 422 |
| GET | `/clientes/aniversariantes` | **ATENDER_CLIENTE**. `?mes=1..12` (sem ele, o mês de hoje na loja), paginado, na ordem do dia; `ClienteBalcaoOut` |
| GET/PATCH | `/clientes/{id}` | o PATCH aceita `nascimento` e `preferencias` (`""` apaga a preferência) |
| DELETE | `/clientes/{id}` | recusa quem ainda deve e quem está com condicional aberta (409, `detail.condicionais_abertas`). Quitada, **anonimiza** (LGPD): `phone`, `document`, `note`, `nascimento` e `preferencias` viram nulos e `name` vira "Cliente removido #id"; a linha fica, e vendas, pagamentos e devoluções continuam apontando para ela. Sem volta |
| GET | `/clientes/{id}/extrato` | `?page=&size=` pagina as DUAS listas juntas: `vendas` (compras no fiado) e `pagamentos` vêm cada uma em `{items, total, page, size}`, mais recentes primeiro; os três totais que fecham a conta (e o `deve`) são da conta inteira, nunca da página |
| POST | `/clientes/{id}/pagamentos` | `{forma, valor, client_uuid, observacao?}`; só formas de gaveta, e não aceita mais do que a dívida. Replay → 200; mesma chave com outra cliente, forma ou valor → 409 (ADR-2) |

O histórico de compras da cliente (todas, não só o fiado) é `GET /vendas?cliente_id=`, com o
escopo de sempre: a vendedora vê só as que ela fez.

### 4.7 `despesas` (LANCAR_DESPESA: dono e gerente)
`GET/POST /despesas/categorias`, `PATCH/DELETE /despesas/categorias/{id}`,
`GET/POST /despesas`, `GET/PATCH/DELETE /despesas/{id}`,
`POST /despesas/replicar-recorrentes?competencia=YYYY-MM` (idempotente; devolve
`{competencia, criadas, ja_existentes, valor_total, despesas}` — regras da cadeia em §2.6).

### 4.8 `caixa` (FECHAR_CAIXA: dono, gerente e supervisora)
`GET /caixa/dia?data=YYYY-MM-DD` → esperado por forma de pagamento (vendas concluídas do dia no fuso
da loja) + fechamento existente, se houver.
`POST /caixa/fechamentos` `{data, contagens:[{forma, valor_contado}], observacao?}` → upsert do dia.
`GET /caixa/fechamentos?inicio=&fim=`.

### 4.9 `relatorios` (VER_DINHEIRO: dono e gerente; `meu-dia` é de qualquer login)
Com `?inicio=&fim=` (≤ 366 dias), exceto `estoque-baixo`, `estoque-parado`, `valor-do-estoque` e
`meu-dia` (sem período — são fotografia do agora).

- `/relatorios/resumo` → faturamento, `devolucoes`, `faturamento_liquido`, CMV, `cmv_devolvido`,
  lucro bruto, despesas, `taxas_cartao`, resultado, nº de vendas, ticket médio. As telas mostram
  CADA parcela (o Financeiro do app em `mobile/src/lib/resumoFinanceiro.ts`, com teste; o web com
  o cartão Devoluções em `relatorios-resumo.js`): quem soma a tela chega no lucro bruto.
  `lucro_bruto = faturamento_liquido − (CMV − CMV devolvido)` e `margem_bruta_pct = lucro_bruto /
  faturamento_liquido` — as duas pontas líquidas de devolução; sobre o bruto, a margem encolheria
  na proporção do que voltou. `resultado = lucro_bruto − despesas − taxas_cartao`, com
  `taxas_cartao` = Σ `round(valor × taxa_percentual / 100, 2)` dos pagamentos no cartão das vendas
  concluídas do período, menos a taxa da parte devolvida pelo cartão no período (ADR-35)
- `/relatorios/recebiveis?inicio=&fim=&page=&size=` → agenda do cartão, paginada por DATA PREVISTA
  de crédito (o período é o da data prevista, não o da venda): `{items: [{data, bruto, taxa,
  liquido}], total, page, size}`. Débito em D+`prazo_dias`; crédito em N parcelas, a 1ª em
  D+`prazo_dias` e as outras de 30 em 30 dias, com o centavo da divisão na 1ª. Estorno no
  cartão sai negativo no dia da devolução (ADR-35)
- `/relatorios/vendas-por-dia` → série diária (faturamento, nº de vendas)
- `/relatorios/mais-vendidos?limite=10` → ranking por quantidade (valor bruto, sem rateio de desconto)
- `/relatorios/despesas-por-categoria`
- `/relatorios/estoque-baixo` → variantes com `saldo <= min_stock`, **paginado** (`?page=&size=` →
  `{items, total, page, size}`), as mais urgentes primeiro (com mínimo definido e mais abaixo
  dele; `variante_id` desempata). Quem só mostra "N peças no mínimo" (aba Financeiro do app)
  pede `size=1` e lê `total` — a lista inteira passava de 7 mil linhas e 1,5 MB, baixados a
  cada venda.
- `/relatorios/vendedoras?inicio&fim&page&size` (ADR-37) → `{items, total, page, size,
  faturamento_liquido_total, comissao_total}`; cada item `{usuario_id, nome, comissao_percentual,
  quantidade_vendas, faturamento, devolucoes, faturamento_liquido, pecas, ticket_medio, comissao}`,
  quem mais trouxe primeiro. Os totais são da equipe inteira no período.
- `/relatorios/meu-dia` (**qualquer login**, sem período: é o hoje da loja) → `{data, vendido,
  quantidade_vendas, pecas, meta, falta}` de quem está logado; `meta`/`falta` nulos sem meta.
- `/relatorios/estoque-parado?dias=90&page&size` (ADR-38, sem período) → `{items, total, page,
  size, dias, pecas_total, valor_em_custo_total, valor_em_venda_total}`; cada item `{variante_id,
  produto_id, produto, tamanho, cor, codigo_barras, saldo, ultima_venda, ultima_entrada,
  dias_parada, preco_custo, preco_venda, valor_em_custo, valor_em_venda}`, a mais antiga primeiro.
- `/relatorios/curva-abc?inicio&fim&page&size` (ADR-38) → paginado; cada item `{produto_id,
  produto, pecas, faturamento_liquido, percentual, percentual_acumulado, classe: A|B|C}`.
- `/relatorios/valor-do-estoque` (sem período) → `{pecas, variantes, valor_em_custo,
  valor_em_venda}` da loja inteira.

### 4.9.1 `taxas-cartao` (ler: VER_DINHEIRO; mudar: CONFIGURAR_LOJA)
| método | rota | notas |
|---|---|---|
| GET | `/taxas-cartao` | paginado: `{id, forma, parcelas_de, parcelas_ate, percentual, prazo_dias}` |
| POST | `/taxas-cartao` | só o dono. `forma` DEBITO/CREDITO; débito é sempre 1x; faixa sobreposta à de outra linha da mesma forma → 422 |
| PATCH | `/taxas-cartao/{id}` | só o dono; a forma não muda. Vale para as vendas dali em diante |
| DELETE | `/taxas-cartao/{id}` | só o dono. As vendas de antes não mudam: a taxa delas está fotografada |

`POST /vendas` aceita em cada pagamento `parcelas` (1..12, > 1 só no CREDITO) e `bandeira`
(texto, só no cartão). A resposta traz `parcelas` e `bandeira` para todos; `taxa_percentual`,
`taxa` e o `taxas_cartao` da venda, só no schema de quem vê dinheiro. Parcelas e bandeira entram
na comparação do replay: "crédito 1x" reenviado como "3x" é 409.

### 4.10 `auditoria` (VER_AUDITORIA: só o dono)
`GET /auditoria?usuario_id=&acao=&inicio=YYYY-MM-DD&fim=YYYY-MM-DD&page=&size=` → paginado, mais
recente primeiro. Cada linha: `{usuario_id, usuario, papel, acao, descricao, metodo, caminho,
entidade, entidade_id, ip, status_http, quando}` — `usuario`/`papel` são os que ficaram
congelados (ADR-23). `inicio`/`fim` recortam pelo dia no fuso da loja. Nem o gerente entra:
`403 SEM_PERMISSAO`.

### 4.11 `configuracao`
| método | rota | papel | notas |
|---|---|---|---|
| GET | `/configuracao` | **aberto** | só a fachada: `nome`, `segmento`, `timezone`, o `vocabulario` já resolvido e `demonstracao` |
| GET | `/configuracao/completa` | qualquer logado | a fachada mais `documento`, `telefone` e `endereco` (o cabeçalho do recibo) e os fiscais `regime_tributario`, `inscricao_estadual`, `serie_nfce` (ADR-41) |
| GET | `/configuracao/segmentos` | **aberto** | os ramos que o sistema conhece, para a tela montar o seletor |
| PATCH | `/configuracao` | CONFIGURAR_LOJA | só o dono; campos opcionais (mudar o telefone não reenvia o nome) |

`timezone` é o fuso da loja, que as telas usam para formatar hora (ADR-27).
`demonstracao` (`bool`, também na `/completa`) diz se esta API é a demonstração que sobe com a
loja (`LOJA_DEMONSTRACAO=1`): a web e o app põem a faixa "Loja de demonstração — os dados são
fictícios." no topo de toda tela. Vem da config do contêiner, não do banco; na Vercel é `false`
(ADR-46). Servidor antigo não manda o campo: falta = `false`.
`vocabulario` traz `item`/`itens`/`artigo`, `eixo1`/`eixo2` (os rótulos das duas variações),
`eixo1_rapidos` (atalhos do cadastro em grade, vazio quando o ramo não tem valores previsíveis),
`icone` e `exemplo_produto`. Vem pronto do servidor para web e app não divergirem.

### 4.12 `backup` (GERIR_BACKUP: só o dono)
| método | rota | notas |
|---|---|---|
| GET | `/backup` | situação + configuração. **Nunca** devolve o token; devolve `configurado: bool` |
| PUT | `/backup` | `{ativo?, rclone_token?, pasta?, manter?, intervalo_min?, senha_atual?}`; token ausente NÃO apaga o gravado. Trocar token ou pasta de um backup já conectado exige `senha_atual` (422 sem ela) |

`GET /backup` traz também `atrasado: bool` (ligado e sem cópia nova há mais de 2× o intervalo).

Ligar com `ativo: true` sem token gravado é `409 OPERACAO_INVALIDA` — tela dizendo "ativo" sem
backup acontecendo é pior do que não ter tela.

### 4.13 `condicionais` (FAZER_CONDICIONAL: da vendedora em diante, ADR-39)
| método | rota | notas |
|---|---|---|
| POST | `/condicionais` | `{client_uuid, cliente_id, prazo: YYYY-MM-DD, observacao?, itens:[{variante_id, quantidade}]}` → 201 com a condicional; tira as peças do saldo (`CONDICIONAL_SAIDA`). Prazo que já passou → 422; peça sem estoque → 409 `ESTOQUE_INSUFICIENTE`. Replay → 200; mesma chave com outra cliente, prazo ou peças → 409 `detail.condicional_id` |
| GET | `/condicionais` | `?situacao=abertas` (padrão) `|vencidas|fechadas|todas` `&cliente_id=` · abertas e vencidas pela que vence primeiro |
| GET | `/condicionais/{id}` | `{id, status, cliente_id, cliente, cliente_telefone, vendedora, prazo, vencida, dias_para_vencer, itens:[{variante_id, produto, tamanho, cor, codigo_barras, preco_venda, quantidade, devolvida, ficou}], total_pecas, valor_pecas, venda_id, fechada_em, fechada_por}` — sem custo |
| POST | `/condicionais/{id}/fechamento` | `{client_uuid, itens:[{variante_id, devolvida}] (todas as peças), desconto?, pagamentos:[…como em /vendas, com parcelas e bandeira no crédito]}` → 201; tudo volta (`CONDICIONAL_RETORNO`) e o que ficou vira venda (`venda_id`), no mesmo commit — da peça que recebeu o retorno, se a original foi excluída e recadastrada, pelo preço dela (o `preco_venda` que o GET da aberta já mostra). Sem nada a cobrar, `pagamentos` vazio e desconto 0 (senão 422). Replay → 200; mesma chave com outro retorno ou outra cobrança (forma, valor, parcelas, bandeira, vale, desconto) → 409 `DUPLICADO`; já fechada com outra chave → 409 `OPERACAO_INVALIDA` |

A busca de cliente das telas de condicional é a de balcão (`GET /clientes/balcao`, `ATENDER_CLIENTE`).

### 4.14 `contas-pagar` (VER_DINHEIRO: dono e gerente, ADR-40)
| método | rota | notas |
|---|---|---|
| GET | `/contas-pagar/resumo` | `{hoje, vencidas, proximos_7_dias, em_aberto}`, cada faixa `{quantidade, valor}` — rota leve, para aviso |
| GET | `/contas-pagar` | `?situacao=abertas` (padrão) `|vencidas|proximos_7_dias|pagas|todas` `&fornecedor=&entrada_id=` → `{id, fornecedor, descricao, numero_nota, valor, vencimento, parcela, parcelas, situacao: ABERTA|VENCIDA|PAGA, dias_para_vencer, paga_em, forma_pagamento, entrada_id, observacao, ativo, criada_em}` |
| POST | `/contas-pagar` | lançamento sem Entrada: `{client_uuid, fornecedor, descricao, observacao?, nota}` → 201 `{contas, valor_total}`; replay → 200; mesma chave com outro fornecedor/valor/vencimento → 409 |
| GET/PATCH/DELETE | `/contas-pagar/{id}` | PATCH `{fornecedor?, descricao?, numero_nota?, valor?, vencimento?, observacao?}` e DELETE (soft) só com a conta aberta (409 se paga) |
| POST | `/contas-pagar/{id}/pagamento` | `{forma: BOLETO|PIX|TRANSFERENCIA|DINHEIRO|CARTAO, pago_em?}` (padrão: hoje na loja; futuro → 422). Reenvio igual → 200; outro pagamento sobre conta paga → 409 |
| DELETE | `/contas-pagar/{id}/pagamento` | desfaz o pagamento marcado por engano (idempotente) |

### 4.15 `leitor` (qualquer pessoa logada, ADR-43)
`PareamentoOut` = `{id, codigo, status: AGUARDANDO|ATIVO|EXPIRADO|ENCERRADO, computador_nome,
aparelho_nome|null, criado_em, codigo_expira_em, aceito_em|null, expira_em|null, encerrado_em|null,
motivo_encerramento: COMPUTADOR|CELULAR|TROCOU|SUBSTITUIDO|null}` (datas ISO em UTC).

| método | rota | notas |
|---|---|---|
| POST | `/leitor/pareamentos` | computador: corpo opcional `{substitui_id?}` → 201 `PareamentoOut` AGUARDANDO (código de 6, vale 5 min). `substitui_id` do próprio computador e não encerrado é encerrado (SUBSTITUIDO); de outra pessoa, ignorado. Mais de 10 vivos (AGUARDANDO/ATIVO) da mesma pessoa no computador: os mais velhos viram SUBSTITUIDO. Faz a faxina |
| POST | `/leitor/pareamentos/aceitar` | celular: `{codigo}` (maiúsculas, espaços e hífens tanto faz) → 200 `PareamentoOut` ATIVO por 12 h; encerra (TROCOU) os outros ATIVOS deste celular. Inexistente, vencido, já aceito por outro ou encerrado → 404 `LEITOR_CODIGO_INVALIDO`, a mesma resposta; dois celulares no mesmo código: um 200, o outro 404. O reenvio do MESMO celular (a resposta se perdeu), com o pareamento ainda ATIVO e dentro dos 5 min do código → 200 com o mesmo `PareamentoOut`, sem mudar nada e sem linha no diário |
| GET | `/leitor/pareamentos/{id}` | `PareamentoOut` para as duas pontas; para mais ninguém, 404 |
| DELETE | `/leitor/pareamentos/{id}` | 204 de qualquer ponta (COMPUTADOR ou CELULAR; o mesmo login nas duas conta como COMPUTADOR); já encerrado ou vencido → 204 sem mudar nada; de terceiro → 404. Só o que desligou um celular ATIVO entra no diário |
| POST | `/leitor/bipes` | celular: `{client_uuid, pareamento_id, codigo}` → 201 `{id, client_uuid, pareamento_id, codigo, criado_em}`. A chave é conferida antes de tudo: reenvio idêntico → 200 com o mesmo corpo; a mesma chave com outro código, outro pareamento ou de outro celular → 409 `DUPLICADO`. `codigo` sem espaços nas pontas, 1–64, sem caractere de controle (senão 422). Pareamento que não é deste celular → 404; não ATIVO → 409 `LEITOR_DESLIGADO` `detail.status`; 100 pendentes → 409 `LEITOR_FILA_CHEIA` |
| POST | `/leitor/pareamentos/{id}/retirar` | só o computador: → 200 `{items:[{id, codigo, criado_em}], descartados, pareamento: PareamentoOut}`. Até 50 por chamada, na ordem da leitura, entregues uma vez (consumidos na mesma instrução; duas abas pegam lotes disjuntos). Bipe com mais de 120 s é consumido e NÃO entregue (conta em `descartados`); pareamento que não está ATIVO entrega `[]`, descarta a fila e devolve o status. **Não é listagem paginada** (é uma fila com teto) e **não gera aviso de tempo real** |

---

## 5. App mobile

`src/app/` (expo-router): `(auth)/login` e `(app)/` com abas — **PDV** (inicial), **Produtos**,
**Estoque**, **Mais**; a aba **Financeiro** abre para quem fecha o caixa (dono, gerente e
supervisora) e mostra dentro só o que cada capacidade permite — a supervisora encontra o
caixa do dia, sem o resumo do mês. Guarda por capacidade no `_layout`.

- `api/client.ts`: axios, `baseURL` de `EXPO_PUBLIC_API_URL`, interceptor 401 → refresh sob mutex →
  refaz a requisição → o servidor **recusou** o refresh (401/403, `lib/renovacao.ts`): limpa
  SecureStore e carrinho e volta ao login. Rede caída, timeout ou 5xx no refresh não dizem nada
  sobre o token: a requisição falha como falha de rede (o BannerConexao mostra) e a sessão fica.
- `lib/money.ts`: `paraCentavos("149.90") → 14990`, `formatar(14990) → "R$ 149,90"`,
  `paraDecimalString(14990) → "149.90"`. Toda conta em inteiro.
- `stores/`: `authStore` (usuário/papel), `cartStore` (carrinho do PDV), `entradaStore`,
  `inventarioStore`. Estado do servidor fica no TanStack Query.
- `components/BarcodeScanner.tsx`: `CameraView` com `ean13/ean8/code128`; ignora o mesmo código por
  1,5 s e qualquer código por 0,4 s (a câmera dispara vários frames do mesmo bipe); haptics + som.
- `lib/caixa.ts`: na conferência de caixa, o contado nasce com o esperado e o **acompanha** nos
  campos que ninguém digitou; a tela refaz a consulta ao focar e logo antes de gravar. Preenchido
  uma vez só, quem confirmava direto gravava como falta as vendas feitas com a tela aberta.
- `lib/comissao.ts` (com teste): a % digitada ("2,5") vira "2.50" e só aceita 0–100 com até duas
  casas — "0,005" pela régua do dinheiro viraria 5%; meta zero é `null`; `progressoDaMeta` dá a
  barra do PDV (`components/MetaDoDia.tsx`). O dono edita comissão e meta em
  `(app)/mais/usuario-comissao` (ADR-37).
- `components/relatorios/`: as seções novas da tela de Relatórios (equipe, curva ABC, a receber
  do cartão, valor do estoque, estoque parado), uma por assunto. Chaves `relatorio-*` caem com
  venda e despesa; `estoque-parado` e `valor-do-estoque` caem com qualquer aviso de `estoque`.

- `lib/parcelas.ts` (espelho de `web/js/parcelas.js`): sugestão 30/60/90 da nota do fornecedor
  sem perder centavo e a conferência de que as parcelas somam a nota (ADR-40).
- `lib/condicional.ts` (espelho de `web/js/condicional.js`): o total do que ficou com a cliente,
  o corpo do fechamento e o prazo em palavras (ADR-39). Telas em `(app)/condicional/` (lista,
  nova, detalhe com fechamento) e `(app)/financeiro/contas-pagar`; a Entrada ganhou a nota
  (`components/NotaFornecedor.tsx`) para quem vê dinheiro.

- `lib/exclusaoDeConta.ts` (com teste; espelho de `web/js/exclusao-de-conta.js`): o que some e o
  que fica na exclusão de conta, em quem a equipe mostra "Excluir conta" e onde vai a recusa (a
  senha errada no campo, o dono único em destaque). Telas: `(app)/mais/conta.tsx` (Minha conta:
  trocar senha e excluir a própria) e o "Excluir conta" de `(app)/mais/usuarios.tsx`, ambos com
  `components/Confirmacao.tsx`; deu certo, `authStore.encerrarPorContaExcluida` fecha a sessão sem
  falar com o servidor e o login mostra "Conta excluída" (ADR-45).
- `lib/leitorRemoto.ts` (com teste; espelho de `web/js/leitor-remoto.js`): o convite do QR do
  leitor pelo celular — `normalizarCodigo`, `formatarCodigo`, `montarConvite`, `lerConvite`,
  `mesmoServidor` e `PRAZO_DO_BIPE_MS` (120 s, o mesmo do servidor); e, só do app, a espera
  entre tentativas e o destino de cada falha. O modo leitor (`(app)/mais/leitor.tsx`,
  `components/LeitorPareado.tsx`) transforma a câmera no leitor de um computador pareado; a fila
  de envio é `stores/leitorStore.ts`, com o laço em `lib/filaDoLeitor.ts` (com teste) (ADR-43).

- `lib/areaSegura.ts` (com teste): a área segura de cada iPhone (iOS 15.1+, do SE de 4,7" ao Pro
  Max de 6,9"). A barra de abas tira altura e respiro de baixo de `medidasDaBarraDeAbas(insets
  .bottom)` — com `height` fixa o React Navigation deixa de somar o indicador de início, e os
  rótulos encostavam nele. Rodapé de botões, botão flutuante e o fim de Modal de tela cheia usam
  `useRespiroDeBaixo()` (o MAIOR entre o respiro e a área, nunca a soma: no SE fica como era);
  Modal de tela cheia (a busca de peça, o "Receber pagamento") desce da barra de status com
  `useRespiroDeCima()`. Os dois ganchos moram em `components/ui.tsx`; o `Scanner` recebe
  `encosta` quando ocupa a tela até a borda. Rodapé que fica EM CIMA da barra de abas (o PDV)
  não soma nada: quem respeita o indicador é a barra.
- `lib/resumoFinanceiro.ts` (com teste): as linhas do cartão "Resultado do mês" — faturamento,
  devoluções, custo das peças vendidas, custo das que voltaram ao estoque, lucro bruto, despesas e
  taxas — e a fórmula impressa (`Lucro bruto − despesas − taxas de cartão`). Espelho da conta de
  `RelatorioService.resumo`; o teste soma as linhas com os números da demonstração. E o aviso de
  boleto (`avisoDeContasAPagar`): vencidas e os próximos 7 dias são faixas disjuntas no servidor,
  e cada uma sai com o SEU valor — o aviso contava só as vencidas com a soma das duas.
- `lib/barraDeStatus.ts` (com teste) e `hooks/useBarraDeStatusEscura.ts`: a barra de status é
  clara na raiz (cabeçalho azul) e escura no FOCO das telas claras sem cabeçalho (entrada,
  servidor, Vender), pela pilha do `StatusBar` (no web, `<html data-barra-de-status>`, que as
  capturas leem: o `compor.mjs` pinta essa cor e para se ela sumir sobre a foto).
- `lib/permissaoDaCamera.ts` (com teste): o leitor pede a câmera ao SISTEMA ao montar; a tela do
  app (botão primeiro, texto depois — cabe na faixa de 28% do SE) só aparece depois de recusada,
  com "Abrir Ajustes" ou "Continuar", nunca um "Permitir" antes do alerta (Apple 5.1.1).
- `lib/texto.ts` (com teste): `primeiraMaiuscula` e `plural` (espelho do `plural` de
  `web/js/ui.js`). `textTransform: 'capitalize'` não entra em frase: põe maiúscula em toda
  palavra ("Novembro De 2026").

Fluxo do PDV: bipar → item no carrinho → (qtd/desconto) → cobrar → formas de pagamento (misto,
com ajuste do centavo na última parcela) → confirma → `POST /vendas` com `client_uuid` → limpa
carrinho e invalida `['saldos']`, `['vendas']`, `['caixa']`.

---

## 6. Sistema web

`web/`, servido em `/app` pela própria API (ADR-11). Sem build: `index.html`, `css/estilo.css` e
módulos ES em `js/`.

| Arquivo | Papel |
|---|---|
| `js/api.js` | `fetch` com access token em memória, renovação sob mutex no 401, erros já traduzidos em `{code, message}`. Só 401/403 do refresh derruba a sessão (e o carrinho); rede caída ou 5xx falha como rede e a sessão fica — a regra de `mobile/src/lib/renovacao.ts` |
| `js/router.js` | Roteador por hash (`#/produtos/12`), views carregadas sob demanda com `import()`, guarda por papel |
| `js/store.js` | Sessão e carrinho do PDV — um objeto e quem quiser ser avisado se inscreve. Carrinho e conferência saem com a sessão (`limparTudoDaSessao`), no botão Sair **e** quando ela cai |
| `js/ui.js` | Template `html` com escape automático, modal, avisos, paginação, formatação pt-BR, campo de dinheiro |
| `js/dinheiro.js` | Espelho de `mobile/src/lib/money.ts`. Centavos inteiros; **se mudar lá, mude aqui** |
| `js/leitor.js` | Captura do leitor USB (teclado) e foco permanente no campo de leitura. O último `criarLeitor` ligado é o da tela; `entregarCodigoDeFora` entrega a ele o bipe do celular, respeitando o `ocupadoQuando` da tela (gravando, ou `digitandoEm` a lista) (ADR-43) |
| `js/leitor-remoto.js` | Espelho de `mobile/src/lib/leitorRemoto.ts` (teste em `testes/web/leitor-remoto.test.mjs`): o convite do QR do celular-leitor, o código normalizado e formatado, `mesmoServidor` e o prazo de 120 s do bipe; e, só do web, o ritmo da retirada, `umaPorVez`, a fila de entrega à tela (`criarEntrega`), o aviso dos descartados e a dona da aba (`criarDonaDaAba`) (ADR-43) |
| `js/leitor-celular.js`, `js/leitor-celular-janela.js` | O celular como leitor (ADR-43): botão e selo da lateral, retirada da fila na hora do aviso (`ouvirNaHora` do `tempo-real.js`) e o modal do QR. `js/qr.js` desenha o QR em SVG pelo DOM com `js/vendor/qrcode.js` (qrcode-generator 1.4.4, MIT, copiado inteiro) |
| `js/exclusao-de-conta.js` | Espelho de `mobile/src/lib/exclusaoDeConta.ts` (teste em `testes/web/exclusao-de-conta.test.mjs`): o que some e o que fica, em quem a lista mostra "Excluir conta" e onde vai a recusa. `views/conta.js` exclui a própria conta (modal com a senha; deu certo, `encerrarSessaoLocal` + `#/entrar?conta=excluida`), `views/usuarios-acoes.js` exclui a de outra pessoa (ADR-45) |
| `js/grafico.js` | Barras e proporções em SVG escrito à mão — sem biblioteca, sem CDN |
| `js/parcelas.js`, `js/condicional.js` | Espelhos de `mobile/src/lib/parcelas.ts` e `condicional.ts` (com teste lá): parcelas da nota do fornecedor e a conta do fechamento da condicional |
| `js/nota-fornecedor.js` | A nota do fornecedor (valor, número, parcelas) — na Entrada e no lançamento avulso de Contas a pagar |
| `js/views/*.js` | Uma tela por arquivo, `export function render(raiz, params, consulta)` |
| `js/views/relatorios-*.js` | Os cartões da tela de Relatórios com lista própria (repor, equipe, curva ABC, a receber, giro do estoque) e os cartões do resumo — cada um pagina no servidor e guarda a página na URL |
| `js/views/pdv-meta.js` | "Hoje: R$ X de R$ meta" no PDV de quem está logado (ADR-37); se atualiza sozinha sem redesenhar o PDV |

**Leitor USB.** O leitor de balcão é um teclado: digita os dígitos em rajada e manda Enter. Não há
API de navegador para isso. `leitor.js` ouve o `keydown` do documento inteiro em fase de captura,
acumula caracteres alfanuméricos, reinicia o buffer depois de 300 ms de silêncio (leitor não pausa;
dedo humano pausa) e dispara no Enter. Campos de texto comuns são ignorados — senão digitar o nome
de um produto viraria bipada —, com exceção do campo marcado `data-leitor`, que é onde o código
também pode ser digitado à mão. O PDV trava o mesmo código por 1,2 s (bipe duplo não vende duas
peças); entrada e inventário usam 250 ms, porque ali bipar dez vezes a mesma etiqueta são dez peças.

**Segurança da tela.** Nada vindo do servidor entra em `innerHTML` sem escape: o template `html`
escapa tudo que for interpolado, e HTML confiável só entra marcado com `cru()`. O template devolve
um valor já marcado, para que um template dentro do outro continue sendo HTML.

**Papéis.** O menu esconde o que o vendedor não usa e o roteador barra a rota por papel, mas isso é
conveniência: quem garante é a API (ADR-5). Abrir `#/relatorios` na mão mostra "Área restrita", e
mesmo que mostrasse a tela, a API responderia 403.

---

## 7. Testes

`pytest` contra Postgres real (`loja_test`), migrations aplicadas, transação por teste.
Cenários obrigatórios: rotação de refresh e detecção de reuso (também com duas renovações
simultâneas) · trava de força bruta sob rajada simultânea · vendedor não recebe `preco_custo` e
leva 403 em despesas/relatórios · venda atômica (falha em um item não grava nada) · estorno devolve
estoque · duas vendas concorrentes do último item → uma falha `ESTOQUE_INSUFICIENTE` · replay de
`client_uuid` não duplica · soma de pagamentos ≠ total → `PAGAMENTO_DIVERGENTE` · replicar recorrentes
duas vezes não duplica · resumo financeiro fecha a conta (receita − CMV − despesas) · condicional:
a peça na sacola não se vende no balcão, fechar duas vezes (simultâneo ou reenvio) não devolve
nem cobra duas vezes, erro na venda do fechamento desfaz o retorno · conta a pagar: a nota entra
com a Entrada ou nada entra, vendedora não lança nota, pagar uma vez só, Resultado não muda ·
tempo real entre instâncias: o commit de um processo chega ao socket de outro uvicorn, rollback
não avisa, a tela de quem gravou recebe o aviso uma vez só, a escuta que cai (ou emudece)
religa e manda refazer, o LISTEN que sobe depois do "conectado" manda refazer, e a última
tela que sai fecha o LISTEN · leitor pelo celular (ADR-43): o bipe chega ao computador uma vez
só, dois celulares no mesmo código (simultâneos) → um ganha, o mesmo bipe em duas requisições
simultâneas grava uma linha, duas retiradas simultâneas pegam lotes disjuntos, bipe com mais de
120 s é descartado, e a retirada não gera aviso de tempo real · exclusão de conta (ADR-45): a
própria conta sai com a senha certa e derruba as sessões; a errada é 422 e a sessão segue; o único
dono leva 409 e dois donos saindo juntos deixam um; quem já vendeu também sai (a venda fica com o
nome, o e-mail fica livre); o diário ganha a linha sem `user_id` e com o nome congelado ·
demonstração ao lado da loja (ADR-46): token assinado com o segredo da demo é 401 na loja (acesso
e renovação), a role `loja_demo` não conecta no banco `loja`, preparar e renovar sem as duas
chaves (variável e marco do banco) saem com erro sem tocar em nada, a carga da instalação semeia e
converge a conta do revisor, a renovação zera, apaga as fotos e semeia de novo (com a conta
inválida no `.env`, para antes de zerar; o TRUNCATE trava antes as portas da API, e a requisição
que já passou pelo crachá, o login e a renovação da sessão terminam sem impasse com ele; o que
ainda perde a vez se repete; e o preparo espera a renovação que está rodando), as
fotos da demo têm teto (envios juntos não o furam; a foto minúscula conta o bloco), a conta
protegida da instalação não trava pelo e-mail (a da Vercel e as outras, sim; e o IP trava
todas), o cookie da demo vive e morre em `/demo/api/v1/auth`, a auditoria classifica sob `/demo`, fora do
prefixo é 404, e a web, o app e o publicador nunca perdem o `/demo` (varredura de endereço
absoluto no web; `servidor-demo.test.mjs` e o cenário de `rodar.mjs` no publicador). No CI,
`testes/pilha/pilha.sh` sobe a pilha de verdade: `.env` antigo dá só a loja, e contas, tokens,
cookies e bancos das duas não se cruzam.
