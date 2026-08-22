# SISTEMA_GESTAO_LOJA

Gestão de loja de roupas: estoque por código de barras, PDV, despesas e relatórios.
Monorepo: `api/` (FastAPI + PostgreSQL) e `mobile/` (React Native + Expo).

**A verdade do projeto está em `docs/SPEC.md` (escopo) e `docs/ARQUITETURA.md` (modelo de dados,
contratos, ADRs). Mudou algo? Atualize o doc no mesmo commit.**

## Stack

- API: Python 3.11+ · FastAPI · SQLAlchemy 2.0 async + asyncpg · Alembic · Pydantic v2 · pytest + httpx · PostgreSQL 16
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
