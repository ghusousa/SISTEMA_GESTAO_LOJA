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
./backup.sh                                               # dump validado + cópia fora (BACKUP_REMOTO)
./backup.sh --automatico                                  # passa a fazer sozinho, todo dia (timer)
./backup.sh --listar / --restaurar ARQUIVO                # restaurar tira um dump de segurança antes
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
npm run publicar     # ficha inteira na App Store via API (mobile/publicar/, -- --enviar submete)
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
  `VER_AUDITORIA` é a única capacidade **só do dono** (nem o gerente): a auditoria audita o
  gerente também. Como `DONO = frozenset(Pode)`, capacidade nova é dono-only por padrão.
  Custo/lucro/despesa saem por schemas de resposta distintos no servidor, não por esconder na
  tela. `web/js/permissoes.js` e `mobile/src/lib/permissoes.ts` são espelhos — mudou um, mude os três.
- Saldo de estoque: só muda junto com uma linha em `stock_movements`, na mesma transação
  (`UPDATE stock_balances SET quantity = quantity + :delta ... RETURNING`). `CHECK quantity >= 0`
  é a rede de segurança. Escrita multi-variante sempre ordenada por `variant_id`.
- **Auditoria (ADR-23)**: toda mutação bem-sucedida vira uma linha em `audit_log`, gravada
  na BORDA (`auditoria/middleware.py`), não em cada service — registrar em cada rota é a
  garantia de que um dia alguém esquece. O mapa `auditoria/classificar.py` traduz
  `(método, caminho)` na frase que o dono lê; rota nova de mutação → uma linha nova ali. Nome
  e papel de quem agiu são **congelados** na linha (renomear depois não reescreve o passado).
  Login (sucesso/falha) é gravado pelo `AuthService`, que conhece o e-mail mesmo sem conta.
- **Força bruta (ADR-24)**: o login conta as falhas recentes por e-mail e por IP
  (`login_attempts`, janela de 15 min) e responde 429 com `Retry-After` quando passa do teto.
  A resposta de e-mail real e falso é idêntica — a trava não vaza se a conta existe, nem pelo
  tempo: e-mail inexistente confere contra `HASH_DE_MENTIRA`. A contagem é serializada por
  e-mail (`pg_advisory_xact_lock`), senão uma rajada paralela fura o teto. bcrypt **nunca**
  direto numa rota async: `hash_senha_async`/`verificar_senha_async` (thread), ou o login
  congela a loja inteira.
- **Fora de dev o app se blinda**: `settings.producao` esconde `/docs` e `/openapi.json`, e
  todo request leva `X-Content-Type-Options`, `X-Frame-Options` e `Referrer-Policy`.
  `api/scripts/pentest.py` roda a bateria de ataques contra a API no ar (17 vetores).
- Tempo real: `WS /api/v1/tempo-real`. Quem avisa é o commit do SQLAlchemy
  (`core/eventos.py`), não os services — mudou tabela, sai aviso. O que trafega é o
  ASSUNTO ("estoque"), nunca o dado: a tela refaz a consulta pela rota REST, e o filtro
  por papel continua inteiro. Token vai no primeiro quadro, nunca na URL.
- **Identidade da loja (ADR-26)**: nome e ramo moram numa linha de `store_config` (`CHECK id = 1`),
  não no `.env` — o dono corrige na tela, entra no backup, e as duas pontas leem da mesma rota.
  `GET /configuracao` é **aberto, sem login** (a tela de entrada precisa do nome antes da sessão);
  `PATCH` exige `CONFIGURAR_LOJA`, que só o dono tem. O ramo troca **só as palavras**:
  `product_variants.size/color` são dois eixos genéricos, e `app/core/segmentos.py` diz como
  chamá-los (Tamanho/Cor em roupas, Aplicação/Posição em autopeças). Trocar de ramo não move
  um dado. `web/js/loja.js` e `mobile/src/lib/segmento.ts` são espelhos — mudou um, mude os três.
- **Backup na nuvem (ADR-28)**: configurado na TELA (`backup_config`, singleton), não no `.env`
  nem no instalador. Quem copia é o `backup.sh --nuvem` na máquina — `pg_dump` + `rclone` para o
  Drive, faxina mantendo `manter` cópias (a 11ª apaga a 1ª, ordenando por NOME, que carrega a
  data). **A API nunca vê a credencial**: `rclone_token` entra por `PUT /backup` e não sai por
  rota nenhuma, nem para o dono — mesma separação do token do GitHub no `atualizar.sh`.
  O timer do systemd bate de 5 em 5 min e o script pergunta ao banco se já passou
  `intervalo_min`; assim mudar o intervalo na tela vale sem `systemctl`.
- Versão: `GET /versao` diz o commit instalado E se é o mais novo. Quem sabe disso é o
  `atualizar.sh` (tem a credencial do GitHub), que grava `docker/estado/versao.json`; a API
  só lê o arquivo montado. **A API nunca fala com o GitHub** — token do código-fonte não
  entra no contêiner que serve a loja.
- Mutações idempotentes por `client_uuid`: `POST /vendas`, `POST /estoque/entradas`,
  `POST /vendas/{id}/devolucoes` e `POST /clientes/{id}/pagamentos` (replay → 200 com o existente).
  A mesma chave com OUTRO pedido é 409 `DUPLICADO`, nunca o registro antigo como sucesso; a
  Entrada devolve no `detail.itens` o que já gravou, e a tela tira isso da lista antes de
  trocar a chave (senão o reenvio soma de novo). Depois do `rollback` de uma corrida, recarregue
  o `usuario` (`session.refresh`) antes de ler `role`/`id`: atributo expirado é MissingGreenlet.
- **Devolução, vale e fiado (ADR-19 a ADR-21)**: não existe "modo troca" — troca é devolução que
  vira vale mais uma venda nova. O valor volta pró-rata **pelas formas em que entrou**, com teto
  no que cada uma recebeu; o que não couber vira vale (`vouchers`, consumido por `UPDATE`
  condicional, igual ao saldo de estoque). `FORMAS_DE_GAVETA` (dinheiro, PIX, débito, crédito) é o
  que o caixa confere — VALE e FIADO **nunca** entram numa conferência de gaveta. O saldo do
  cliente é sempre calculado, nunca coluna, e o abatimento para onde a dívida acaba.

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
- Tokens só em `expo-secure-store`; interceptor 401 → refresh (mutex) → refaz → servidor recusou
  (401/403): logout; rede/timeout/5xx: falha a requisição e MANTÉM a sessão e o carrinho (`lib/renovacao.ts`).
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
  o UTC já virou e a consulta devolve um caixa vazio. **Filtro de período usa `app/core/datas.py`
  (ADR-27)**: o parâmetro é `date`, o router traduz com `inicio_do_dia`/`fim_exclusivo_do_dia` e o
  repositório compara `>= inicio AND < fim`. `fim: datetime` era o bug — `fim=2026-08-23` virava
  meia-noite do COMEÇO do dia e escondia o dia inteiro. No navegador, hora sai por `dataHora` do
  `ui.js`, que formata no fuso vindo de `GET /configuracao` — nunca no do aparelho de quem olha.
- **Estado que muda de status**: cancelar venda troca o status com `UPDATE ... WHERE status =
  'CONCLUIDA'` antes de estornar. Checar em memória deixa dois cliques estornarem duas vezes.
  Venda de dia com caixa já FECHADO não se cancela (reescreveria a conferência) e venda no
  fiado que a cliente já pagou também não (saldo negativo): nos dois casos, Devolução.
- **Carrinho, conferência e cache são globais**: logout limpa tudo (`limparTudoDaSessao`),
  senão o próximo usuário herda a venda e a sacola do anterior.
- **Uma porta só para mercadoria entrar (ADR-29)**: o cadastro cria a peça com saldo ZERO e
  manda para a Entrada com a grade já carregada. Estoque entra por `POST /estoque/entradas`,
  sempre — assim a PRIMEIRA compra também guarda fornecedor e custo, e fica no extrato. É o
  modelo do Bling e do Tiny; ter estoque nas duas telas era a redundância que confundia.
- **Duas telas mexem no estoque, e uma delas SUBSTITUI**: Entrada (SOMA, guarda fornecedor e
  atualiza custo) e Inventário
  (**substitui** o saldo pelo contado). Usar o Inventário para receber mercadoria APAGA o que
  estava na arara — tinha 5, chegaram 20, digita 20, e o saldo vira 20 em vez de 25, com o
  extrato dizendo "acerto por contagem física". As duas pontas travam isso: contagem em que
  TODAS as divergências são para mais (≥2 peças, nenhuma para menos) é a assinatura do engano,
  e a tela pergunta antes de gravar, oferecendo ir para a Entrada.
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
- **Desligar o contêiner esperava WebSocket que nunca fecha**: o celular de cada vendedora
  deixa um WS aberto; no shutdown o uvicorn espera TODOS fecharem, e celular de tela apagada
  não fecha. Ficava em "Waiting for background tasks to complete", o Docker matava em 10 s
  (SIGKILL, saída **137**) e a atualização parava no meio — com o antigo já renomeado para
  `<hash>_loja-api-1` e o novo em `created`. A loja dava **502**: o Caddy de pé, sem achar
  `api` no DNS interno. Por isso `--timeout-graceful-shutdown 10` no Dockerfile,
  `stop_grace_period: 25s` no compose (tem de ser MAIOR), e `limpar_orfaos` no
  `atualizar.sh`, que roda antes de todo `up -d --remove-orphans`.
- **Cliente de WebSocket que cai é rotina, não erro**: a task que lê do socket morre com
  `WebSocketDisconnect`, e `await` numa task morta RELANÇA a exceção dela. Escapando do endpoint,
  o uvicorn escreve ~2 KB de traceback a cada celular que fecha o app. Some com log do Docker sem
  teto (o padrão) e o disco enche sozinho — disco cheio para o Postgres, e a loja "para e não
  volta" sem nada de errado no log da aplicação. Por isso `docker-compose.yml` fixa
  `max-size: 10m, max-file: 3` em todo serviço.
- **Devolver o que já foi pago**: cliente que levou no fiado, pagou e só depois devolveu não pode
  ter a dívida abatida de novo — o saldo iria a −R$ 100,00, ela sumiria da lista de quem deve, e
  a loja ficaria devendo escondido. O abatimento é limitado ao que ela deve HOJE; a diferença sai
  em vale, que é papel na mão dela (ADR-21).
- **`Alert.alert` é no-op no react-native-web**: o export web do app serve de bancada de teste, mas
  nenhum diálogo aparece nele. Verificação por navegador que dependa de confirmação precisa de um
  shim — o app no aparelho está certo, quem não implementa é a plataforma web.
- **Foco no PDV web**: ninguém clica antes de bipar. `manterFoco` devolve o cursor ao campo de
  leitura, mas sai de cena com modal aberto ou enquanto a pessoa digita em outro campo.
