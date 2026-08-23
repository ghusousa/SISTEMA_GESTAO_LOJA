# SISTEMA_GESTAO_LOJA

Gestão de loja de roupas: estoque por código de barras, PDV, despesas e relatórios.
Monorepo: `api/` (FastAPI + PostgreSQL), `web/` (SPA em JS puro servida pela API) e
`mobile/` (React Native + Expo). Web e mobile fazem o mesmo; muda o balcão e a mão.

**A verdade do projeto está em `docs/SPEC.md` (escopo) e `docs/ARQUITETURA.md` (modelo de dados,
contratos, ADRs). Mudou algo? Atualize o doc no mesmo commit.**

## Stack

- API: Python 3.11+ · FastAPI · SQLAlchemy 2.0 async + asyncpg · Alembic · Pydantic v2 · pytest + httpx · PostgreSQL 16
- Web: HTML + CSS + módulos ES, **zero build**. Roteador por hash próprio; servida em `/app` pelo FastAPI
- Mobile: **Expo SDK 54** (managed) · TypeScript · expo-router · TanStack Query · Zustand ·
  react-hook-form + zod · expo-camera. Node ≥ 20.19.4
- Senhas: `bcrypt` direto (NÃO passlib — incompatível com bcrypt 5.x)

## Comandos

```bash
# Atualizar o servidor com o que está no GitHub (raiz do repo)
./atualizar.sh                                            # backup, pull, build, migra e confere
./diagnostico.sh                                          # só lê: por que parou (memória, disco, contêineres, logs)
./atualizar.sh --automatico                               # passa a se atualizar sozinho (timer do systemd)

# API (dentro de api/)
.venv/bin/uvicorn app.main:app --reload --host 0.0.0.0    # servidor
.venv/bin/alembic upgrade head                            # migrations
.venv/bin/pytest -q                                       # testes (usa loja_test)
.venv/bin/python -m app.cli create-admin --nome "Dona" --email x@y.com --senha ...
.venv/bin/python scripts/e2e.py                           # cenário de um dia de loja (API no ar)

# Stack completa em Docker (raiz do repo)
./instalar.sh                                             # instala e sobe tudo
docker compose logs -f api                                # acompanhar
docker compose exec api python -m app.cli create-admin ...  # novo admin
./desinstalar.sh --manter-dados                           # desligar preservando o banco

# Web: nada a instalar. Com a API no ar, abra http://localhost:8000/app/ (ou / no Docker)

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
- Papéis: dono (`ADMIN`) > gerente > supervisora > vendedora (`VENDEDOR`). O código **nunca**
  compara cargo: pergunta capacidade (`pode(user.role, Pode.VER_DINHEIRO)`), e a tabela única
  é `app/core/permissoes.py` (ADR-15). Rotas exigem o crachá (`ExigeDinheiro`, `ExigeCaixa`…).
  Custo/lucro/despesa saem por schemas de resposta distintos no servidor, não por esconder na
  tela. `web/js/permissoes.js` e `mobile/src/lib/permissoes.ts` são espelhos — mudou um, mude os três.
- Saldo de estoque: só muda junto com uma linha em `stock_movements`, na mesma transação
  (`UPDATE stock_balances SET quantity = quantity + :delta ... RETURNING`). `CHECK quantity >= 0`
  é a rede de segurança. Escrita multi-variante sempre ordenada por `variant_id`.
- Tempo real: `WS /api/v1/tempo-real`. Quem avisa é o commit do SQLAlchemy
  (`core/eventos.py`), não os services — mudou tabela, sai aviso. O que trafega é o
  ASSUNTO ("estoque"), nunca o dado: a tela refaz a consulta pela rota REST, e o filtro
  por papel continua inteiro. Token vai no primeiro quadro, nunca na URL.
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
- **Um campo, duas entradas**: o mesmo `data-leitor` aceita bipe E nome. Letras abrem a lista
  (`js/busca-peca.js`, espelho de `mobile/src/components/BuscarPeca.tsx`); com ela aberta o
  leitor ignora o Enter (`ignorarQuando`), senão "camiseta" viraria uma bipada.

## Convenções do mobile

- Dinheiro no app = **centavos inteiros** (`lib/money.ts`); converte na borda da API. Proibido `parseFloat` em valor.
- Estado do servidor → TanStack Query. Rascunho/sessão (carrinho do PDV, entrada) → Zustand.
- Tokens só em `expo-secure-store`; interceptor 401 → refresh (mutex) → refaz → falhou: logout.
- Endereço do servidor é do APARELHO (`api/servidor.ts`), não do build: um `.apk` serve para todas
  as lojas e trocar de IP não exige reinstalar. `baseAtual()` resolve a base a cada requisição.

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
- **Carrinho, conferência e cache são globais**: logout limpa tudo (`limparTudoDaSessao`),
  senão o próximo usuário herda a venda e a sacola do anterior.
- **Peça nova não entra pela Entrada**: ela nasce no cadastro, que já tem estoque inicial. A
  Entrada é da segunda vez em diante — e aí a mercadoria chega SEM a nossa etiqueta, porque o
  código interno nasceu aqui. Por isso a busca por nome não é conveniência: sem ela a reposição
  não tem como ser registrada. `GET /variantes?q=` acha por nome, cor ou código, sem acento.
- **Mutação que muda relatório**: invalide as chaves `relatorio-*` também, ou a aba Financeiro
  mostra o resultado de antes.
- **`response_model` por papel**: rota cuja resposta muda com o papel usa `response_model=None`,
  senão o modelo da classe base apaga o campo extra do admin.
- **Relacionamento ORM**: filtre no loader (`selectinload(X.y.and_(...))`), nunca reatribuindo a
  coleção — o SQLAlchemy trataria os removidos como órfãos. Em releitura, `populate_existing=True`.
- **Saldo**: `UPDATE` antes do `INSERT`, não `INSERT ... ON CONFLICT` — o Postgres avalia o CHECK
  do valor inserido antes de detectar o conflito, e toda saída estouraria o CHECK.
- **pytest-asyncio**: fixtures e testes precisam do mesmo escopo de loop, senão o asyncpg trava.
- **SDK do mobile é 54 de propósito**: 54 é o último Expo Go publicado na App Store e na Play
  Store (ADR-14). Subir de SDK mata o teste por QR — só resta *development build*. Ao mexer em
  dependência do Expo, use `npx expo install --fix` e feche com `npx expo-doctor`.
- **`npm run bundle` no mobile**: o `tsc` não vê import quebrado de dependência nativa; o
  bundle vê. Rode-o sempre que mexer em dependência (foi assim que apareceu a falta do
  `react-native-worklets`, peer do reanimated 4).
- **`Alert.alert` não para a câmera**: o diálogo não bloqueia nada; a câmera segue lendo a
  mesma etiqueta por baixo e, passada a trava de 1,5 s, empilha outro alerta igual. Antes de
  abrir diálogo sobre o scanner, `pausar()`; ao fechar, `retomar()`. As regras de tempo
  moram em `mobile/src/lib/leitura.ts`, com teste.
- **Aviso de tempo real não carrega dado**: mandar o objeto pelo WebSocket furaria o
  filtro por papel — a vendedora receberia custo por um caminho que não passa pelos
  schemas de resposta. O aviso diz só o assunto; quem busca é a rota REST.
- **Campo de dinheiro preenchido**: valor sugerido (o que falta pagar, o esperado no caixa) é
  substituído pelo primeiro dígito depois de focar; do segundo em diante empurra pela direita.
  Sem isso, digitar `200` sobre `179,70` virava R$ 17.970,00 — e um troco de R$ 9.999.820,29.
- **Template aninhado no web**: `html` precisa devolver valor marcado como cru, senão
  `html\`<ul>${itens.map(...)}\`` escapa a lista inteira e a tela mostra as tags como texto.
- **Cliente de WebSocket que cai é rotina, não erro**: a task que lê do socket morre com
  `WebSocketDisconnect`, e `await` numa task morta RELANÇA a exceção dela. Escapando do endpoint,
  o uvicorn escreve ~2 KB de traceback a cada celular que fecha o app. Some com log do Docker sem
  teto (o padrão) e o disco enche sozinho — disco cheio para o Postgres, e a loja "para e não
  volta" sem nada de errado no log da aplicação. Por isso `docker-compose.yml` fixa
  `max-size: 10m, max-file: 3` em todo serviço.
- **Foco no PDV web**: ninguém clica antes de bipar. `manterFoco` devolve o cursor ao campo de
  leitura, mas sai de cena com modal aberto ou enquanto a pessoa digita em outro campo.
