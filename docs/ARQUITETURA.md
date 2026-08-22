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
users(id, name, email UNIQUE, password_hash, role CHECK(role IN ('ADMIN','VENDEDOR')),
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
              method CHECK IN ('DINHEIRO','PIX','DEBITO','CREDITO'),
              amount NUMERIC(14,2) CHECK > 0)
  ix_sale_payments_sale_id
```

Congelar `unit_price`/`unit_cost` é o que torna o lucro histórico correto: reajustar o preço amanhã
não reescreve o resultado de ontem.

### 2.5 Despesas

```sql
expense_categories(id, name, deleted_at, created_at)
  uq_expense_categories_name_active UNIQUE (lower(name)) WHERE deleted_at IS NULL

expenses(id, category_id FK→expense_categories RESTRICT, description,
         amount NUMERIC(14,2) CHECK > 0, expense_date DATE,
         competencia DATE GENERATED ALWAYS AS (date_trunc('month', expense_date)::date) STORED,
         is_recurring BOOL DEFAULT FALSE, note,
         recurring_source_id FK→expenses NULL, deleted_at, created_at, updated_at)
  uq_expenses_recurring_source_competencia UNIQUE (recurring_source_id, competencia)
  ix_expenses_expense_date, ix_expenses_category_id
```

A UNIQUE `(recurring_source_id, competencia)` é o que torna "replicar recorrentes do mês" idempotente:
rodar duas vezes não duplica o aluguel.

### 2.6 Caixa

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
dia em que o sistema está fora do ar. Então o app pergunta o endereço na primeira abertura e o
guarda no `SecureStore` (`api/servidor.ts`), e o cliente HTTP resolve a base a cada requisição
(`baseAtual()`), e não na criação do axios — assim trocar de servidor com o app aberto funciona.
O endereço é testado contra `/health` antes de ser aceito, porque um dígito errado no IP
apareceria depois como "não foi possível entrar" e a pessoa culparia a senha; e é normalizado
antes de gravar, porque o que a pessoa tem à mão é a barra do navegador do balcão
(`http://ip/app/#/pdv`), não o endereço da API. `EXPO_PUBLIC_API_URL` sobrevive como sugestão
inicial. O custo é uma tela a mais no primeiro uso; o ganho é um instalador único para toda a
equipe.

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

## 4. Contratos de API

Prefixo `/api/v1`. Auth: `Authorization: Bearer <access_token>`.
Listagens são paginadas: `?page=1&size=20` (size ≤ 100) → `{items, total, page, size}`.
Erros: `{"code": "...", "message": "...", "detail": {...}}`.

| code | HTTP | quando |
|---|---|---|
| `CREDENCIAIS_INVALIDAS` | 401 | login errado |
| `TOKEN_INVALIDO` | 401 | access/refresh inválido, expirado ou revogado |
| `SEM_PERMISSAO` | 403 | papel insuficiente |
| `NAO_ENCONTRADO` | 404 | recurso inexistente |
| `DUPLICADO` | 409 | e-mail, código de barras, categoria repetidos |
| `ESTOQUE_INSUFICIENTE` | 409 | venda/ajuste deixaria o saldo negativo |
| `OPERACAO_INVALIDA` | 409 | ex.: cancelar venda já cancelada |
| `PAGAMENTO_DIVERGENTE` | 422 | soma dos pagamentos ≠ total |
| `VALIDACAO` | 422 | payload inválido |

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
| GET | `/produtos` | A/V | `?q=&categoria_id=`; resposta sem custo para VENDEDOR |
| POST | `/produtos` | A/V | produto + `variantes[]` (com `estoque_inicial?` → gera ENTRADA na mesma transação) |
| GET/PATCH/DELETE | `/produtos/{id}` | A/V · A · A | detalhe traz variantes com saldo |
| PUT | `/produtos/{id}/foto` | A/V | multipart, salva em `media/produtos/` |
| POST | `/produtos/{id}/variantes` | A/V | adiciona variante a produto existente |
| PATCH/DELETE | `/variantes/{id}` | A | |
| GET | `/variantes` | A/V | `?produto_id=&q=&somente_com_saldo=` |
| **GET** | **`/variantes/codigo-barras/{codigo}`** | A/V | lookup do PDV: produto + variante + preço + saldo. 404 → app oferece cadastro rápido |
| POST | `/variantes/gerar-codigo-interno` | A/V | `{codigo}` EAN-13 interno, ainda não usado |

### 4.4 `estoque`
| método | rota | papel | notas |
|---|---|---|---|
| POST | `/estoque/entradas` | A/V | `{client_uuid, fornecedor?, observacao?, itens:[{variante_id, quantidade, custo_unitario?}]}`; `custo_unitario` atualiza o custo da variante |
| POST | `/estoque/ajustes` | A | `{variante_id, quantidade(±), motivo}` — motivo obrigatório |
| POST | `/estoque/inventarios` | A | `{observacao?, contagens:[{variante_id, quantidade_contada}]}` → movimentações das diferenças + resumo |
| GET | `/estoque/saldos` | A/V | `?q=&categoria_id=&somente_baixo=` |
| GET | `/estoque/movimentacoes` | A/V | extrato `?variante_id=&tipo=&inicio=&fim=` |

### 4.5 `vendas`
| método | rota | papel | notas |
|---|---|---|---|
| POST | `/vendas` | A/V | `{client_uuid, desconto?, observacao?, itens:[{variante_id, quantidade}], pagamentos:[{forma, valor}]}` → venda completa. Atômico. Replay → 200 |
| GET | `/vendas` | A/V | `?inicio=&fim=&status=&vendedor_id=`; VENDEDOR só vê as próprias (forçado no service) |
| GET | `/vendas/{id}` | A/V | idem escopo |
| POST | `/vendas/{id}/cancelamento` | A/V | `{motivo}`; VENDEDOR só a própria venda do dia corrente |

Troco não trafega: é calculado no app a partir do valor recebido em dinheiro.

### 4.6 `despesas` (ADMIN)
`GET/POST /despesas/categorias`, `PATCH/DELETE /despesas/categorias/{id}`,
`GET/POST /despesas`, `GET/PATCH/DELETE /despesas/{id}`,
`POST /despesas/replicar-recorrentes?competencia=YYYY-MM` (idempotente; devolve `{criadas, ignoradas}`).

### 4.7 `caixa` (ADMIN)
`GET /caixa/dia?data=YYYY-MM-DD` → esperado por forma de pagamento (vendas concluídas do dia no fuso
da loja) + fechamento existente, se houver.
`POST /caixa/fechamentos` `{data, contagens:[{forma, valor_contado}], observacao?}` → upsert do dia.
`GET /caixa/fechamentos?inicio=&fim=`.

### 4.8 `relatorios` (ADMIN)
Todos com `?inicio=&fim=` (≤ 366 dias), exceto `estoque-baixo` (sem período — é fotografia do agora).

- `/relatorios/resumo` → faturamento, CMV, lucro bruto, despesas, resultado, nº de vendas, ticket médio
- `/relatorios/vendas-por-dia` → série diária (faturamento, nº de vendas)
- `/relatorios/mais-vendidos?limite=10` → ranking por quantidade (valor bruto, sem rateio de desconto)
- `/relatorios/despesas-por-categoria`
- `/relatorios/estoque-baixo` → variantes com `saldo <= min_stock`

---

## 5. App mobile

`src/app/` (expo-router): `(auth)/login` e `(app)/` com abas — **PDV** (inicial), **Produtos**,
**Estoque**, **Mais**; ADMIN ganha **Despesas**, **Relatórios**, **Caixa**, **Usuários** (guarda por
papel no `_layout`).

- `api/client.ts`: axios, `baseURL` de `EXPO_PUBLIC_API_URL`, interceptor 401 → refresh sob mutex →
  refaz a requisição → falhou: limpa SecureStore e volta ao login.
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
| `js/store.js` | Sessão e carrinho do PDV — um objeto e quem quiser ser avisado se inscreve |
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
