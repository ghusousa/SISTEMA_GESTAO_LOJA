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
`security.py` (bcrypt + JWT), `exceptions.py` (AppError + handler), `pagination.py`, `deps.py`.

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
      is_active BOOL DEFAULT TRUE, created_at, updated_at)

refresh_tokens(jti UUID PK, user_id FK→users, family_id UUID NOT NULL,
               expires_at, revoked BOOL DEFAULT FALSE, created_at)
  ix_refresh_tokens_user_id, ix_refresh_tokens_family_id, ix_refresh_tokens_expires_at
```

E-mail é UNIQUE total (nunca reutilizável); desativar usuário é `is_active = false`, não delete —
preserva a autoria das vendas.

### 2.2 Catálogo

```sql
categories(id, name, deleted_at, created_at)
  uq_categories_name_active UNIQUE (lower(name)) WHERE deleted_at IS NULL

products(id, category_id FK→categories RESTRICT, name, description, photo_url,
         deleted_at, created_at, updated_at)
  ix_products_category_id, ix_products_name_lower

product_variants(id, product_id FK→products RESTRICT, size, color,
                 barcode, barcode_type CHECK IN ('EAN','INTERNO'),
                 cost_price NUMERIC(14,2) CHECK >= 0,
                 sale_price NUMERIC(14,2) CHECK > 0,
                 min_stock INT CHECK >= 0, deleted_at, created_at, updated_at)
  uq_product_variants_barcode_active UNIQUE (barcode) WHERE deleted_at IS NULL
  uq_product_variants_combo_active  UNIQUE (product_id, size, color) WHERE deleted_at IS NULL
  ix_product_variants_product_id

SEQUENCE internal_barcode_seq   -- alimenta o código interno
```

**Código interno**: para peça sem etiqueta, o service gera um EAN-13 válido com prefixo `2`
(faixa reservada a uso interno/restrito): `'2' + seq.zfill(11)` → dígito verificador EAN-13 → 13
dígitos. Fica indistinguível de um EAN para o leitor, e `barcode_type='INTERNO'` registra a origem.

### 2.3 Estoque

```sql
stock_balances(variant_id PK FK→product_variants, quantity INT CHECK >= 0, updated_at)

stock_entries(id, user_id FK→users, supplier, note, client_uuid UUID UNIQUE, created_at)

stock_movements(id, variant_id FK→product_variants, movement_type CHECK IN
                  ('ENTRADA','AJUSTE','INVENTARIO','VENDA','ESTORNO'),
                quantity INT CHECK (quantity <> 0),   -- com sinal: +entrada, -venda
                balance_after INT NOT NULL,           -- saldo resultante (auditoria)
                entry_id FK→stock_entries NULL, sale_id FK→sales NULL,
                user_id FK→users, note, created_at)
  ix_stock_movements_variant_created (variant_id, created_at)
  ix_stock_movements_sale_id, ix_stock_movements_type_created
```

Append-only: movimentação nunca é editada nem apagada. `balance_after` guarda o saldo após o evento
(o extrato reconstrói a história sem recalcular tudo).

### 2.4 Vendas

```sql
sales(id, seller_id FK→users, status CHECK IN ('CONCLUIDA','CANCELADA') DEFAULT 'CONCLUIDA',
      subtotal, discount DEFAULT 0, total,
      sold_at, cancelled_at NULL, cancelled_by_id FK→users NULL, cancel_reason NULL,
      client_uuid UUID UNIQUE NOT NULL, note NULL, created_at)
  CHECK (subtotal >= 0 AND discount >= 0 AND total >= 0)
  CHECK (discount <= subtotal)
  CHECK (total = subtotal - discount)
  CHECK (status='CANCELADA' AND cancelled_at IS NOT NULL AND cancelled_by_id IS NOT NULL
         OR status='CONCLUIDA' AND cancelled_at IS NULL AND cancelled_by_id IS NULL)
  ix_sales_sold_at, ix_sales_seller_id, ix_sales_status_sold_at
  ix_sales_business_date ((sold_at AT TIME ZONE 'America/Sao_Paulo')::date)

sale_items(id, sale_id FK→sales CASCADE, variant_id FK→product_variants RESTRICT,
           quantity INT CHECK > 0,
           unit_price NUMERIC(14,2),   -- CONGELADO na venda
           unit_cost  NUMERIC(14,2),   -- CONGELADO na venda (CMV histórico)
           line_total GENERATED ALWAYS AS (unit_price * quantity) STORED)
  ix_sale_items_sale_id, ix_sale_items_variant_id

sale_payments(id, sale_id FK→sales CASCADE,
              method CHECK IN ('DINHEIRO','PIX','DEBITO','CREDITO','VALE','FIADO'),
              amount NUMERIC(14,2) CHECK > 0,
              voucher_id FK→vouchers NULL,      -- qual vale pagou
              customer_id FK→customers NULL)    -- de quem é a dívida
  CHECK ((method = 'FIADO') = (customer_id IS NOT NULL))   -- ck_fiado_tem_cliente
  FK (sale_id, customer_id) → sales(id, customer_id)       -- é a MESMA cliente da venda
  ix_sale_payments_sale_id
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
          deleted_at NULL, created_at, updated_at)
  uq_customers_phone_active UNIQUE (phone) WHERE deleted_at IS NULL
  uq_customers_document_active UNIQUE (document) WHERE deleted_at IS NULL

customer_payments(id, customer_id FK→customers RESTRICT, user_id FK→users,
                  method CHECK IN ('DINHEIRO','PIX','DEBITO','CREDITO'),
                  amount CHECK > 0, paid_at, note NULL,
                  client_uuid UUID UNIQUE NOT NULL)
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
conferência: **não bloqueia** vendas nem cancelamentos.

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

`audit_log` é append-only e nunca é lido por vendedora — só por quem tem `VER_AUDITORIA`
(ADR-23). `user_id` fica nulo em falha de login (não há usuário) e vira nulo se a conta for
apagada; o nome/papel congelados preservam o histórico. `login_attempts` alimenta a trava de
força bruta (ADR-24): a contagem é por janela de 15 min, e uma limpeza periódica descarta o
que saiu da janela.

### 2.9 Identidade da loja

```sql
store_config(id, nome, segmento, documento, telefone, endereco, created_at, updated_at)
  ck_store_config_singleton CHECK (id = 1)   -- uma linha só, garantida pelo banco
```

`segmento` é texto validado na borda (`core/segmentos.py`), nunca um enum do banco: ramo novo é
uma linha numa tabela Python, não uma migration. Ramo desconhecido cai no vocabulário neutro em
vez de estourar — uma linha estranha (restauração antiga, edição na mão) não pode derrubar a tela
de login.

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
desenvolvimento — o JavaScript da página nunca o enxerga. O access token vive só em memória, e
recarregar a página reergue a sessão chamando `/auth/refresh` sem corpo nenhum: o cookie viaja
sozinho. `/auth/refresh` e `/auth/logout` aceitam o token **no corpo ou no cookie**, então o app do
celular continua funcionando sem alteração. Um 401 dispara uma renovação compartilhada por todas as
requisições em voo (mutex): duas rotações simultâneas com o mesmo refresh seriam lidas como token
roubado e derrubariam a família inteira.

**ADR-13 — O endereço do servidor mora no aparelho, não no instalador.**
O caminho óbvio seria assar `EXPO_PUBLIC_API_URL` no build, e ele quebra na primeira mudança de
IP: seria preciso gerar um instalador novo e reinstalar em cada celular da equipe — justamente no
dia em que o sistema está fora do ar. Então o endereço fica no aparelho, no `SecureStore`
(`api/servidor.ts`), e o cliente HTTP resolve a base a cada requisição (`baseAtual()`), e não
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
Quem publica é o **commit do SQLAlchemy** (`after_flush` anota as tabelas, `after_commit`
publica), e não os services: seriam mais de vinte pontos de commit, e o esquecido não
quebra teste nenhum — só deixa uma tela velha, o que ninguém liga a um commit específico.
O saldo de estoque é escrito por SQL direto e não passa pelo ORM, mas toda mudança de
saldo vem com uma linha em `stock_movements` na mesma transação, então ouvir o ORM basta.
Autenticação pelo **primeiro quadro**, não por query string: o navegador não manda
cabeçalho no handshake, e `?token=` acabaria no log de acesso do servidor, no do proxy e
no histórico de todo intermediário. Entrega é melhor esforço — ouvinte lento perde aviso
(fila de 32) e se acerta ao reconectar, quando o cliente invalida tudo. A central é em
memória e por processo: a loja roda um servidor, e empilhar Redis seria mais uma peça
para quebrar num sábado cheio.
**Queda de cliente não é erro.** A task que lê do socket (`_escutar_ate_cair`) existe para
PERCEBER a queda, e morre com `WebSocketDisconnect` quando ela acontece. `await` numa task
morta relança a exceção dela: sem suprimir, ela sobe até o uvicorn, que escreve um traceback
inteiro (~2 KB) por aparelho que fecha o app. É o tipo de defeito que não quebra nada e
custa o servidor: o log do Docker não tem teto por padrão, o arquivo cresce sem parar e
disco cheio faz o Postgres parar de aceitar escrita — a loja "para e não volta" sem nada de
errado aparecer no log da aplicação. Daí as duas metades da correção: o endpoint engole a
queda (`test_cliente_que_cai_nao_vira_erro_no_log` guarda isso) e o `docker-compose.yml`
fixa `max-size: 10m` × `max-file: 3` em todo serviço.


**ADR-17 — Achar a peça pelo nome é do fluxo, não conveniência.**
A busca de peças só olhava código de barras, o que bastava para o bipe e falhava no resto. O
furo aparece na reposição: quando o código é INTERNO, a etiqueta nasce aqui dentro, e a
mercadoria que chega do fornecedor vem sem nada colado. Exigir bipada obrigava a imprimir e
colar antes de conferir — peça por peça, para registrar o que já se sabia que chegou. Ou seja,
o caminho existia só para o caso que a loja quase não tem. Agora `GET /variantes?q=` procura
por nome do produto, cor ou código, com o exato à frente, e devolve saldo e nome do produto na
mesma resposta — o que a tela precisa para decidir sem uma segunda ida ao servidor.
Acento sai dos dois lados por `translate()` no Postgres, e não pela extensão `unaccent`:
extensão pede `CREATE EXTENSION`, mais uma migration e mais um privilégio para faltar num
servidor novo, enquanto para o alfabeto do português a tabela resolve igual. Quem procura
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

**ADR-23 — Auditoria na borda, com nome e papel congelados na linha.**
Quem cuida da loja precisa saber o que cada pessoa fez com o login dela — não para
desconfiar, para responder "quem cancelou essa venda?" sem adivinhar. A captura mora numa
**middleware** (`modules/auditoria/middleware.py`), não espalhada pelos services: toda
mutação que entra (`POST/PUT/PATCH/DELETE` sob `/api/v1`) e **termina bem** (status < 400)
vira uma linha em `audit_log`. Um classificador (`classificar.py`) traduz método+rota numa
frase de gente ("Cancelou uma venda", "Deu entrada de mercadoria"); rota que ninguém mapeou
ainda entra como `OUTRO`, então o diário nunca tem buraco. A linha **congela** o nome e o
papel de quem agiu (`user_nome`, `user_papel`): renomear ou rebaixar alguém amanhã não pode
reescrever o que o histórico diz que aconteceu. Ler o diário é a capacidade `VER_AUDITORIA`,
que só o dono tem (ADR-15) — nem o gerente entra. Por que na borda e não no service: um
lugar só, impossível de esquecer ao criar rota nova, e o texto sai do próprio contrato REST.
A gravação é embrulhada em `try/except` largo: auditoria **nunca** derruba a requisição que
ela observa — registro que falha vira log, não erro para o cliente. A middleware decodifica o
token ela mesma (o `contextvar` do usuário, setado lá adentro, não volta visível depois do
`call_next` no Starlette).

**ADR-24 — Trava de força bruta por e-mail e por IP, sem revelar quem existe.**
Senha é a única porta, então a porta conta tentativa. Cada login (certo ou errado) grava uma
linha em `login_attempts`; antes de conferir a senha, o service soma as falhas recentes numa
janela deslizante de 15 min e trava em `429 MUITAS_TENTATIVAS` com `Retry-After` quando passa
de **10 falhas para o mesmo e-mail** ou **30 para o mesmo IP**. Dois limites porque um cobre o
ataque focado numa conta e o outro a varredura de muitas contas do mesmo lugar. A trava é a
mesma quer o e-mail exista ou não — errar a senha de `admin@loja.com` e bater num e-mail
inventado dão a mesma resposta e o mesmo tempo, então a tela de login não vira um oráculo de
"esse cliente é cadastrado?". O IP vem do `X-Forwarded-For` (a API serve atrás do Caddy);
falha de login também entra no diário de auditoria (ADR-23) como `LOGIN_FALHOU`, com
`user_id` nulo. As mesmas contas de tentativa são a matéria-prima do pentest (`scripts/pentest.py`).

**ADR-25 — Em produção, a API não conta de si o que ajuda quem ataca.**
`settings.producao` é verdadeiro em qualquer ambiente que não seja `dev`/`test`/`local`. Nele,
`/docs`, `/redoc` e `/openapi.json` somem (o mapa da API não precisa ficar pendurado na porta
da loja), e toda resposta sai com `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY` e
`Referrer-Policy: strict-origin-when-cross-origin`. Não é segurança de verdade — é não entregar
de graça o que o atacante teria de descobrir sozinho. A checagem é uma propriedade só
(`config.py`), para "estamos em produção?" ter uma resposta e não várias.

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
nome antes de existir sessão, e o que sai por ali já está na fachada (nome, ramo, contato do
recibo); nenhum número, nenhum cliente. `PATCH` é `CONFIGURAR_LOJA`, só do dono: o nome vai
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

## 4. Contratos de API

Prefixo `/api/v1`. Auth: `Authorization: Bearer <access_token>`.
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
| `MUITAS_TENTATIVAS` | 429 | logins errados demais na janela; `detail.retry_after` em segundos, header `Retry-After` |

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

### 4.3 `catalogo`
| método | rota | papel | notas |
|---|---|---|---|
| GET/POST | `/categorias` | A/V · A | |
| PATCH/DELETE | `/categorias/{id}` | A | delete é soft; bloqueado se houver produto ativo |
| GET | `/produtos` | todos | `?q=&categoria_id=`; custo só para quem tem VER_DINHEIRO |
| POST | `/produtos` | A/V | produto + `variantes[]` (com `estoque_inicial?` → gera ENTRADA na mesma transação) |
| GET/PATCH/DELETE | `/produtos/{id}` | A/V · A · A | detalhe traz variantes com saldo |
| PUT | `/produtos/{id}/foto` | A/V | multipart, salva em `media/produtos/` |
| POST | `/produtos/{id}/variantes` | A/V | adiciona variante a produto existente |
| PATCH/DELETE | `/variantes/{id}` | A | |
| GET | `/versao` | A/V | commit instalado, quando foi conferido e se há versão nova; lê `docker/estado/versao.json` |
| GET | `/variantes` | A/V | `?produto_id=&q=` · `q` acha por **nome do produto, cor ou código** (sem acento, código exato primeiro); a resposta traz `produto` e `saldo` |
| **GET** | **`/variantes/codigo-barras/{codigo}`** | A/V | lookup do PDV: produto + variante + preço + saldo. 404 → app oferece cadastro rápido |
| POST | `/variantes/gerar-codigo-interno` | A/V | `{codigo}` EAN-13 interno, ainda não usado |

### 4.4 `estoque`
| método | rota | papel | notas |
|---|---|---|---|
| POST | `/estoque/entradas` | A/V | `{client_uuid, fornecedor?, observacao?, itens:[{variante_id, quantidade, custo_unitario?}]}`; `custo_unitario` atualiza o custo da variante — só de quem tem VER_DINHEIRO; dos outros é ignorado, a mesma tranca do catálogo |
| POST | `/estoque/ajustes` | A | `{variante_id, quantidade(±), motivo}` — motivo obrigatório |
| POST | `/estoque/inventarios` | A | `{observacao?, contagens:[{variante_id, quantidade_contada}]}` → movimentações das diferenças + resumo |
| GET | `/estoque/saldos` | A/V | `?q=&categoria_id=&somente_baixo=` |
| GET | `/estoque/movimentacoes` | A/V | extrato `?variante_id=&tipo=&inicio=YYYY-MM-DD&fim=YYYY-MM-DD` (dias no fuso da loja, ADR-27) |

### 4.5 `vendas`
| método | rota | papel | notas |
|---|---|---|---|
| POST | `/vendas` | A/V | `{client_uuid, desconto?, observacao?, cliente_id?, itens:[{variante_id, quantidade}], pagamentos:[{forma, valor, codigo_vale?}]}` → venda completa. Atômico. Replay → 200 |
| GET | `/vendas` | todos | `?inicio=YYYY-MM-DD&fim=YYYY-MM-DD` (dias no fuso da loja, ADR-27) `&status=&vendedor_id=&variante_id=&cliente_id=`; sem VER_VENDAS_DE_TODOS, o service força as próprias |
| GET | `/vendas/{id}` | A/V | idem escopo |
| POST | `/vendas/{id}/cancelamento` | CANCELAR_VENDA | `{motivo}`; dono e gerente — quem vende não desfaz |
| POST | `/vendas/{id}/devolucoes` | DEVOLVER_VENDA | `{client_uuid, motivo?, itens:[{item_id, quantidade, voltar_ao_estoque?}]}` → devolução com os valores decididos pelo servidor. Replay → 200 |
| GET | `/vendas/{id}/devolucoes` | DEVOLVER_VENDA | o que já voltou desta venda |
| GET | `/vendas/vales/{codigo}` | A/V | consulta o vale: `{codigo, valor, usado, saldo}` |

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
retry. O replay responde pelo uuid sem olhar a venda, e o leitor segue ligado sob o
comprovante: com um uuid por tela, a peça da próxima cliente bipada ali recebia o comprovante da
anterior, e a devolução dela não era gravada.

Venda cancelada não pode ter devolução, e venda com devolução não pode ser cancelada: são
dois caminhos para desfazer a mesma coisa, e deixar os dois abertos devolveria a peça duas
vezes (ADR-9 diz como isso vale até com as duas chegando juntas). Venda no fiado cujo
cancelamento deixaria o saldo da cliente negativo (porque ela já pagou) também não se cancela —
devolve-se (ADR-21).

### 4.6 `clientes` (GERIR_CREDIARIO: dono e gerente)
| método | rota | notas |
|---|---|---|
| GET | `/clientes` | `?q=&somente_devendo=`; `deve` e `acima_do_limite` vêm calculados |
| POST | `/clientes` | `{nome, telefone?, documento?, limite?}` |
| GET/PATCH | `/clientes/{id}` | |
| DELETE | `/clientes/{id}` | soft delete; recusa quem ainda deve |
| GET | `/clientes/{id}/extrato` | compras no fiado, pagamentos, e os três totais que fecham a conta |
| POST | `/clientes/{id}/pagamentos` | `{forma, valor, client_uuid, observacao?}`; só formas de gaveta, e não aceita mais do que a dívida |

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

### 4.9 `relatorios` (VER_DINHEIRO: dono e gerente)
Todos com `?inicio=&fim=` (≤ 366 dias), exceto `estoque-baixo` (sem período — é fotografia do agora).

- `/relatorios/resumo` → faturamento, CMV, lucro bruto, despesas, resultado, nº de vendas, ticket médio.
  `lucro_bruto = faturamento_liquido − (CMV − CMV devolvido)` e `margem_bruta_pct = lucro_bruto /
  faturamento_liquido` — as duas pontas líquidas de devolução; sobre o bruto, a margem encolheria
  na proporção do que voltou
- `/relatorios/vendas-por-dia` → série diária (faturamento, nº de vendas)
- `/relatorios/mais-vendidos?limite=10` → ranking por quantidade (valor bruto, sem rateio de desconto)
- `/relatorios/despesas-por-categoria`
- `/relatorios/estoque-baixo` → variantes com `saldo <= min_stock`

### 4.10 `auditoria` (VER_AUDITORIA: só o dono)
`GET /auditoria?usuario_id=&acao=&inicio=YYYY-MM-DD&fim=YYYY-MM-DD&page=&size=` → paginado, mais
recente primeiro. Cada linha: `{usuario_id, usuario, papel, acao, descricao, metodo, caminho,
entidade, entidade_id, ip, status_http, quando}` — `usuario`/`papel` são os que ficaram
congelados (ADR-23). `inicio`/`fim` recortam pelo dia no fuso da loja. Nem o gerente entra:
`403 SEM_PERMISSAO`.

### 4.11 `configuracao`
| método | rota | papel | notas |
|---|---|---|---|
| GET | `/configuracao` | **aberto** | nome, ramo, contato do recibo e o `vocabulario` já resolvido |
| GET | `/configuracao/segmentos` | **aberto** | os ramos que o sistema conhece, para a tela montar o seletor |
| PATCH | `/configuracao` | CONFIGURAR_LOJA | só o dono; campos opcionais (mudar o telefone não reenvia o nome) |

`timezone` é o fuso da loja, que as telas usam para formatar hora (ADR-27).
`vocabulario` traz `item`/`itens`/`artigo`, `eixo1`/`eixo2` (os rótulos das duas variações),
`eixo1_rapidos` (atalhos do cadastro em grade, vazio quando o ramo não tem valores previsíveis),
`icone` e `exemplo_produto`. Vem pronto do servidor para web e app não divergirem.

### 4.12 `backup` (GERIR_BACKUP: só o dono)
| método | rota | notas |
|---|---|---|
| GET | `/backup` | situação + configuração. **Nunca** devolve o token; devolve `configurado: bool` |
| PUT | `/backup` | `{ativo?, rclone_token?, pasta?, manter?, intervalo_min?}`; token ausente NÃO apaga o gravado |

Ligar com `ativo: true` sem token gravado é `409 OPERACAO_INVALIDA` — tela dizendo "ativo" sem
backup acontecendo é pior do que não ter tela.

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

Fluxo do PDV: bipar → item no carrinho → (qtd/desconto) → cobrar → formas de pagamento (misto,
com ajuste do centavo na última parcela) → confirma → `POST /vendas` com `client_uuid` → limpa
carrinho e invalida `['saldos']`, `['vendas']`, `['caixa']`.

---

## 6. Sistema web

`web/`, servido em `/app` pela própria API (ADR-11). Sem build: `index.html`, `css/estilo.css` e
módulos ES em `js/`.

| Arquivo | Papel |
|---|---|
| `js/api.js` | `fetch` com access token em memória, renovação sob mutex no 401, erros já traduzidos em `{code, message}` |
| `js/router.js` | Roteador por hash (`#/produtos/12`), views carregadas sob demanda com `import()`, guarda por papel |
| `js/store.js` | Sessão e carrinho do PDV — um objeto e quem quiser ser avisado se inscreve. Carrinho e conferência saem com a sessão (`limparTudoDaSessao`), no botão Sair **e** quando ela cai |
| `js/ui.js` | Template `html` com escape automático, modal, avisos, paginação, formatação pt-BR, campo de dinheiro |
| `js/dinheiro.js` | Espelho de `mobile/src/lib/money.ts`. Centavos inteiros; **se mudar lá, mude aqui** |
| `js/leitor.js` | Captura do leitor USB (teclado) e foco permanente no campo de leitura |
| `js/grafico.js` | Barras e proporções em SVG escrito à mão — sem biblioteca, sem CDN |
| `js/views/*.js` | Uma tela por arquivo, `export function render(raiz, params, consulta)` |

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
Cenários obrigatórios: rotação de refresh e detecção de reuso · vendedor não recebe `preco_custo` e
leva 403 em despesas/relatórios · venda atômica (falha em um item não grava nada) · estorno devolve
estoque · duas vendas concorrentes do último item → uma falha `ESTOQUE_INSUFICIENTE` · replay de
`client_uuid` não duplica · soma de pagamentos ≠ total → `PAGAMENTO_DIVERGENTE` · replicar recorrentes
duas vezes não duplica · resumo financeiro fecha a conta (receita − CMV − despesas).
