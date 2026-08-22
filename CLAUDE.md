# SISTEMA_GESTAO_LOJA

Gestão de loja de roupas: estoque por código de barras, PDV, despesas e relatórios.
Monorepo: `api/` (FastAPI + PostgreSQL), `web/` (SPA em JS puro servida pela API) e
`mobile/` (React Native + Expo). Web e mobile fazem o mesmo; muda o balcão e a mão.

**A verdade do projeto está em `docs/SPEC.md` (escopo) e `docs/ARQUITETURA.md` (modelo de dados,
contratos, ADRs). Mudou algo? Atualize o doc no mesmo commit.**

## Stack

- API: Python 3.11+ · FastAPI · SQLAlchemy 2.0 async + asyncpg · Alembic · Pydantic v2 · pytest + httpx · PostgreSQL 16
- Web: HTML + CSS + módulos ES, **zero build**. Roteador por hash próprio; servida em `/app` pelo FastAPI
- Mobile: Expo (managed) · TypeScript · expo-router · TanStack Query · Zustand · react-hook-form + zod · expo-camera
- Senhas: `bcrypt` direto (NÃO passlib — incompatível com bcrypt 5.x)

## Comandos

```bash
# API (dentro de api/)
.venv/bin/uvicorn app.main:app --reload --host 0.0.0.0    # servidor
.venv/bin/alembic upgrade head                            # migrations
.venv/bin/pytest -q                                       # testes (usa loja_test)
.venv/bin/python -m app.cli create-admin --nome "Dona" --email x@y.com --senha ...
.venv/bin/python scripts/e2e.py                           # cenário de um dia de loja (API no ar)

# Web: nada a instalar. Com a API no ar, abra http://localhost:8000/app/

# Mobile (dentro de mobile/)
npm start            # Expo
npm run typecheck    # tsc --noEmit
npm test             # camada de dinheiro (node --test via tsx)
npm run bundle       # expo export: pega erro de import que o tsc não vê
```

## Convenções da API

- Monolito modular: `app/modules/<dominio>/{router,service,repository,models,schemas}.py`.
  Fluxo router → service → repository. Um módulo **nunca** importa o repository de outro
  (só o service público). `relatorios` e `caixa` são exceção documentada: leem via SQL próprio.
- `HTTPException` só no router. Domínio lança `AppError` (`app/core/exceptions.py`), traduzida
  pelo handler global em `{code, message, detail}`.
- Toda listagem é paginada: `?page=&size=` → `{items, total, page, size}`.
- Dinheiro: `Numeric(14,2)` / `Decimal`. **Nunca float.** No fio trafega como string ("149.90").
- Datas em UTC (`TIMESTAMPTZ`); agrupamento por dia usa `settings.tz_loja` (America/Sao_Paulo).
- Soft delete = `deleted_at` + UNIQUE parcial `WHERE deleted_at IS NULL`; a API expõe `ativo`.
- Papéis: `ADMIN` vê tudo; `VENDEDOR` **nunca** recebe custo/lucro/despesas — isso é garantido
  por schemas de resposta distintos no servidor, não por esconder no app.
- Saldo de estoque: só muda junto com uma linha em `stock_movements`, na mesma transação
  (`UPDATE stock_balances SET quantity = quantity + :delta ... RETURNING`). `CHECK quantity >= 0`
  é a rede de segurança. Escrita multi-variante sempre ordenada por `variant_id`.
- Mutações idempotentes por `client_uuid`: `POST /vendas` e `POST /estoque/entradas` (replay → 200
  com o registro existente).

## Convenções do web (`web/`)

- Uma tela por arquivo em `js/views/`, `export function render(raiz, params, consulta)`; **máx. ~300 linhas**.
  Devolva uma função de limpeza se a tela ligar timer ou listener global.
- Nada do servidor entra em `innerHTML` sem escape: use o template `html` de `ui.js`. HTML confiável
  só com `cru()`. `html` devolve valor já marcado, então template dentro de template funciona.
- Dinheiro em centavos (`js/dinheiro.js`, **espelho de `mobile/src/lib/money.ts` — mudou lá, mude aqui**).
- Toda listagem pagina no servidor; filtros vão para a query da URL (`trocarConsulta`), para o F5 não perder.
- Refresh token **só** em cookie httpOnly; access token só em memória. Nunca `localStorage`.
- Leitor USB é teclado (`js/leitor.js`): rajada de dígitos + Enter. Campo do PDV marcado `data-leitor`.

## Convenções do mobile

- Dinheiro no app = **centavos inteiros** (`lib/money.ts`); converte na borda da API. Proibido `parseFloat` em valor.
- Estado do servidor → TanStack Query. Rascunho/sessão (carrinho do PDV, entrada) → Zustand.
- Tokens só em `expo-secure-store`; interceptor 401 → refresh (mutex) → refaz → falhou: logout.

## Testes

`pytest` roda contra Postgres real (`loja_test`), migrations aplicadas. Cenários que não podem
quebrar: rotação/reuso de refresh token, vendedor sem custo, venda atômica, estorno devolvendo
estoque, concorrência do último item, idempotência por `client_uuid`.

## Armadilhas já pagas (não repita)

- **Dinheiro digitado**: `paraCentavos` precisa distinguir `"2.500,00"` (milhar) de `"149.90"`
  (decimal da API). O último separador manda. Já custou um aluguel virar R$ 2,50.
- **Fuso**: "hoje" é o dia no fuso da loja, nunca `date.today()` do servidor. Às 23h de São Paulo
  o UTC já virou e a consulta devolve um caixa vazio.
- **Estado que muda de status**: cancelar venda troca o status com `UPDATE ... WHERE status =
  'CONCLUIDA'` antes de estornar. Checar em memória deixa dois cliques estornarem duas vezes.
- **Carrinho e cache são globais**: logout limpa os dois, senão o próximo usuário herda a venda
  do anterior.
- **Mutação que muda relatório**: invalide as chaves `relatorio-*` também, ou a aba Financeiro
  mostra o resultado de antes.
- **`response_model` por papel**: rota cuja resposta muda com o papel usa `response_model=None`,
  senão o modelo da classe base apaga o campo extra do admin.
- **Relacionamento ORM**: filtre no loader (`selectinload(X.y.and_(...))`), nunca reatribuindo a
  coleção — o SQLAlchemy trataria os removidos como órfãos. Em releitura, `populate_existing=True`.
- **Saldo**: `UPDATE` antes do `INSERT`, não `INSERT ... ON CONFLICT` — o Postgres avalia o CHECK
  do valor inserido antes de detectar o conflito, e toda saída estouraria o CHECK.
- **pytest-asyncio**: fixtures e testes precisam do mesmo escopo de loop, senão o asyncpg trava.
- **`legacy-peer-deps` no mobile**: peers não se instalam sozinhos; `npm run bundle` é o que
  revela o que falta.
- **Campo de dinheiro preenchido**: valor sugerido (o que falta pagar, o esperado no caixa) é
  substituído pelo primeiro dígito depois de focar; do segundo em diante empurra pela direita.
  Sem isso, digitar `200` sobre `179,70` virava R$ 17.970,00 — e um troco de R$ 9.999.820,29.
- **Template aninhado no web**: `html` precisa devolver valor marcado como cru, senão
  `html\`<ul>${itens.map(...)}\`` escapa a lista inteira e a tela mostra as tags como texto.
- **Foco no PDV web**: ninguém clica antes de bipar. `manterFoco` devolve o cursor ao campo de
  leitura, mas sai de cena com modal aberto ou enquanto a pessoa digita em outro campo.
