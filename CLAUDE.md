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
./backup.sh --mostrar-chave                               # a chave das cópias de fora (cifradas)
./atualizar.sh --automatico                               # passa a se atualizar sozinho (timer do systemd)
./atualizar.sh --ignorar-ci                               # sobe sem CI verde (o --sim nunca sobe)
./vigia.sh / --automatico                                 # /health, disco e backup; avisa (5 em 5 min)
./notificar.sh --testar                                   # aviso de teste no ntfy (NOTIFICAR_URL)
./demo.sh --mostrar                                       # a demonstração em <domínio>/demo: endereço, conta, senha, o que levar à Apple
./demo.sh --ligar / --desligar [--apagar]                 # liga (completa o .env) / desliga (dados ficam; --apagar leva banco, fotos, senhas)
./demo.sh --renovar / --automatico                        # dados fictícios de volta ao começo agora / toda madrugada (04:30, timer)

# API (dentro de api/)
.venv/bin/uvicorn app.main:app --reload --host 0.0.0.0    # servidor
.venv/bin/alembic upgrade head                            # migrations
.venv/bin/pytest -q                                       # testes (usa loja_test)
.venv/bin/python -m app.cli create-admin --nome "Dona" --email x@y.com --senha ...
.venv/bin/python scripts/e2e.py                           # cenário de um dia de loja (API no ar)
.venv/bin/python -m app.cli testar-push --email x@y.com   # a notificação não chega? aviso de teste + recibo da Apple (ADR-47)
.venv/bin/python -m scripts.codigos_para_teste           # refaz <raiz>/codigos-para-teste: as etiquetas da demo e o QR para a câmera da revisão da Apple

# Stack completa em Docker (raiz do repo)
./instalar.sh                                             # instala e sobe tudo, com a demonstração em /demo (--sem-demo: sem ela)
docker compose logs -f api                                # acompanhar
docker compose exec api python -m app.cli create-admin ...  # novo admin
./desinstalar.sh --manter-dados                           # desligar preservando o banco

# Web: nada a instalar. Com a API no ar, abra http://localhost:8000/app/ (ou / no Docker)
node --test testes/web/*.test.mjs                        # canal de tempo real do web (fora de web/, que é público)

# Mobile (dentro de mobile/)
npm start            # Expo
npm run typecheck    # tsc --noEmit
npm test             # camada de dinheiro (node --test via tsx)
npm run bundle       # expo export: pega erro de import que o tsc não vê
node assets/icone/desenhar.mjs  # refaz o ícone (iOS em RGB, Android, abertura, favicon) do desenho; ícone de exemplo a Apple recusa (2.3.8)
npm run publicar     # ficha inteira na App Store via API (mobile/publicar/; -- --enviar submete ou REENVIA, --aguardar-build 60 espera o build,
                     #   --video-revisao arquivo|https anexa a gravação de tela, --conferir-envio só confere sem escrever,
                     #   --mesmo-build reenvia o build que a Apple devolveu — sem ela nem --build, o reenvio dele é recusado)
node --test publicar/teste/*.test.mjs  # testes do publicador (ci.mjs e o push no App ID, notas em inglês, guia PDF em dia, demo em <domínio>/demo, rótulos citados no código)
node publicar/teste/rodar.mjs  # o publicador contra a Apple de mentira (--reais: com as capturas de media/app-store)
node publicar/revisao/gerar-guia.mjs  # refaz o guia PDF do revisor (mudou texto, prints ou ficha/aparelhos-testados.txt)
publicar/capturas/gerar.sh     # refaz os 20 prints da App Store com as telas do app (export web: cabeçalho do navegador) e o guia PDF (Postgres local + seed; --sem-build)
# GitHub → Actions → "Publicar iOS na App Store": build na Expo + envio + ficha, sem Mac; caixa "completo"
#   (ou etiqueta ios-v<versão>) faz tudo numa rodada, até a revisão; "video_revisao_url" anexa a gravação
#   (baixada UMA vez, no começo); "revisao" com "compilar"/"enviar" só no completo; caixa "aparelhos"
#   (experimental) gera o .ipa ad hoc — 1ª vez, interativo num computador: "npx eas-cli build --platform ios
#   --profile teste-aparelhos" (credencial ad hoc e iPhone no cadastro da Expo; mobile/publicar/README.md)
```

## Convenções da API

- Monolito modular: `app/modules/<dominio>/{router,service,repository,models,schemas}.py`.
  Fluxo router → service → repository. Um módulo **nunca** importa o repository de outro
  (só o service público). `relatorios` e `caixa` são exceção documentada: leem via SQL próprio.
- `HTTPException` só no router. Domínio lança `AppError` (`app/core/exceptions.py`), traduzida
  pelo handler global em `{code, message, detail}`. O erro do banco não repete os parâmetros
  (`hide_parameters=True` no engine); quem grava segredo não deixa o erro do banco subir (o
  registro do aparelho vira 503, levantado FORA do `except`); número que não cabe no banco é 422
  em qualquer rota (handler de `DBAPIError`; guarda em `tests/test_erros_do_banco.py`).
- Toda listagem é paginada: `?page=&size=` → `{items, total, page, size}` — inclusive
  relatório (`/relatorios/estoque-baixo`); quem só quer o número pede `size=1` e lê `total`.
  A contagem conta só a tabela base quando os JOINs são 1:1 por FK obrigatória (ADR-31).
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
  Login (sucesso/falha) é gravado pelo `AuthService`, pela porta pública `AuditoriaService`.
  2xx que não mudou nada (desligar o que já terminou, reenvio idempotente) não é ato: a rota
  chama `fora_do_diario(request)` (`auditoria/middleware.py`) e a borda pula a linha.
  **LGPD x auditoria**: o nome congelado de quem AGIU nunca muda, mas e-mail não fica à toa —
  `LOGIN_FALHOU` grava `user_id`+nome se a conta existe e o e-mail MASCARADO se não existe;
  excluir usuário mascara o e-mail dele nas linhas antigas; `RETENCAO_AUDITORIA_DIAS` (730,
  0 = tudo) apaga o velho na faxina do login. São as duas únicas escritas depois do INSERT.
- **Excluir conta (ADR-45)**: `DELETE /usuarios/me` `{senha}` (errada: 422 `SENHA_INCORRETA`, nunca
  401; único dono: 409) e `DELETE /usuarios/{id}` têm UMA limpeza (`_apagar_conta`); com venda/caixa/
  estoque (FK RESTRICT) a linha fica só com o nome e `deleted_at` (sem e-mail, senha, comissão e
  meta), e as `login_attempts` do e-mail saem junto (`AuthService.esquecer_tentativas`). O domínio
  `excluida.example` da marca é recusado no cadastro. Autor que some no ato:
  `congelar_autor(request, user)`. `web/js/exclusao-de-conta.js` ↔ `mobile/src/lib/exclusaoDeConta.ts`.
  Numa demonstração (Vercel ou `/demo`: `settings.conta_demo_protegida`), a conta `DEMO_ADMIN_EMAIL`
  (a das notas da Apple) não se exclui, não perde o papel, não é desativada nem troca de senha — 409
  `CONTA_DE_DEMONSTRACAO`, ANTES da senha (o publicador confere com uma senha aleatória) —, e quem
  sobe a demo a recria (Redeploy; na instalação, cada subida da `api-demo` converge a conta). Sem
  resposta (status 0) a tela não diz "não foi excluída": a próxima tentativa lê o 401 pela
  renovação (`depoisDaIncerta`).
- **Força bruta (ADR-24)**: o login conta as falhas recentes por e-mail e por IP
  (`login_attempts`, janela de 15 min) e responde 429 com `Retry-After` quando passa do teto.
  A resposta de e-mail real e falso é idêntica — a trava não vaza se a conta existe, nem pelo
  tempo: e-mail inexistente confere contra `HASH_DE_MENTIRA`. A conta protegida da demonstração
  da instalação (`/demo`, `settings.demonstracao`) conta só o IP (o e-mail dela é público nas
  notas da Apple, e a senha é sorteada); na Vercel a senha é escolhida por gente e a trava por
  e-mail continua. A contagem é serializada por
  e-mail (`pg_advisory_xact_lock`), senão uma rajada paralela fura o teto. bcrypt **nunca**
  direto numa rota async: `hash_senha_async`/`verificar_senha_async` (thread), ou o login
  congela a loja inteira.
- **Fora de dev o app se blinda**: `settings.producao` esconde `/docs` e `/openapi.json`, e
  todo request leva `X-Content-Type-Options`, `X-Frame-Options` e `Referrer-Policy`.
  `api/scripts/pentest.py` roda a bateria de ataques contra a API no ar.
  **CSP, HSTS, Permissions-Policy e o teto do corpo POR ROTA (as rotas de JSON leem o corpo antes
  do login; a da foto confere o login antes, mas o arquivo de quem entrou vai inteiro a um
  temporário antes de a API medir; e N conexões seguram N vezes o teto: 6 MB no PUT da foto, 2 MB
  no resto; rota nova com arquivo ganha matcher próprio; o 413 é do Caddy 2.7+) moram no Caddy**
  (`docker/caddy/Caddyfile`):
  `script-src 'self'`
  sem inline — atributo `onclick=""` em template é bloqueado; use delegação (`data-*`). Origem
  de fora nova (CDN, imagem) tem de entrar na CSP. O pentest confere no proxy com
  `PENTEST_PROXY=http://...`, ou no Caddyfile sem ele.
- **Vercel (ADR-42)** é a forma de rodar sem Docker, só demonstração (Root Directory `api/`, Neon): tudo atrás
  de `settings.vercel` (`VERCEL=1`, a Vercel põe) — sem ela nada muda. Lá, sem `JWT_SECRET`, o segredo
  do login é o HMAC da senha do banco do Neon (`segredo_derivado_do_banco`; senha fraca ou sem banco: não sobe). A CSP/HSTS de lá mora no
  `api/vercel.json`: mudou o Caddyfile, mude ele (`test_vercel.py` compara). Build: `scripts/vercel_build.py`,
  que chama o preparo compartilhado com a demo da instalação (`app/demonstracao.py`).
  A carga da demo é RETOMÁVEL (marcos `DEMONSTRACAO_*` no `audit_log`): passo novo no
  `seed_demo.popular()` usa `chave("rotulo")` fixa ou busca antes de criar, senão a retomada duplica.
- **Demonstração em `/demo` (ADR-46)**: a `api-demo` é a mesma imagem com `LOJA_DEMONSTRACAO=1` e
  `PREFIXO=/demo` (o `app.main` a monta sob o prefixo), banco/role `loja_demo` sem CONNECT no `loja` e
  `DEMO_JWT_SECRET` próprio (o token só leva o id). Caminho absoluto gerado no servidor lê
  `request.scope["root_path"]` (redirect, `Path` do cookie, auditoria); no app e no publicador, a
  base junta por texto, nunca `new URL('/x', base)`. Semear ou zerar exige as DUAS chaves:
  `settings.demonstracao` e o marco `loja.demonstracao = 'sim'` do banco. No compose, serviço da demo
  só usa `${X:-}` (nunca `:?`), a `api-demo` tem `pull_policy: never` e nenhum serviço da loja
  depende da demo: ela nunca derruba a loja (Compose 2.3 a 5.8). As fotos dela moram no disco do
  banco da loja: teto `DEMO_FOTOS_MAX_BYTES` (200 MB; ajustável no `.env`, vale ao recriar a
  `api-demo`; 409 `DEMONSTRACAO_SEM_ESPACO`, `FotosDaDemonstracao`)
  e a renovação esvazia `MEDIA_DIR/produtos` — nunca o `MEDIA_DIR`, onde o volume está montado.
  A renovação trava antes as portas da API (`PORTAS_DA_API`, na ordem em que a API entra no
  banco); caminho novo que entra por outra tabela entra na lista, na ordem certa. O logout e as
  rotas que derrubam sessões vão na ordem contrária à da renovação da sessão, e nenhuma ordem
  serve às duas: não troque a ordem por eles (o impasse com eles está na ADR-46).
- Tempo real: `WS /api/v1/tempo-real`. Quem avisa é o commit do SQLAlchemy
  (`core/eventos.py`), não os services — mudou tabela, sai aviso. O que trafega é o
  ASSUNTO ("estoque"), nunca o dado: a tela refaz a consulta pela rota REST, e o filtro
  por papel continua inteiro. Token vai no primeiro quadro, nunca na URL. Avisos em
  rajada viram UMA rodada (1 s de silêncio, teto de 2 s: `mobile/src/lib/avisos.ts`, espelho
  em `web/js/tempo-real.js`); no app só refaz consulta com tela montada
  (`refetchType: 'active'`), e com app no fundo ou aba escondida a rodada espera a volta.
  **Entre instâncias** (Vercel, ou mais de um worker) o assunto também sai por `pg_notify`
  DENTRO da transação (`after_flush`; rollback não avisa) e cada instância com tela ligada
  faz LISTEN numa conexão dedicada (`core/escuta.py`: abre na primeira tela, fecha na
  última, religa sozinha e manda refazer tudo na volta). O que volta com a origem da
  própria instância é descartado — ela já entregou em memória. O endereço do LISTEN sai SÓ
  de `dsn_da_escuta()` (`DATABASE_URL_UNPOOLED`, nunca o pooler: atrás de PgBouncer o LISTEN
  não recebe nada, calado; e com o SSL do app, `DB_SSL`). "conectado" só sai com o LISTEN
  de pé, ou depois de 5 s — e aí a escuta manda refazer tudo quando subir —, e o cliente
  refaz a tela ao recebê-lo; religar com espera crescente é `mobile/src/lib/canal.ts`
  (espelho `web/js/canal.js`) — na Vercel o socket fecha no `maxDuration`, toda vez.
- **Identidade da loja (ADR-26)**: nome e ramo moram numa linha de `store_config` (`CHECK id = 1`),
  não no `.env` — o dono corrige na tela, entra no backup, e as duas pontas leem da mesma rota.
  `GET /configuracao` é **aberto, sem login** (a tela de entrada precisa do nome antes da sessão)
  e por isso só leva nome, ramo, fuso, vocabulário e as chaves `demonstracao` (ADR-46) e
  `notificacoes_push` (ADR-47); documento, telefone e endereço (o CPF e a
  casa do dono MEI) saem por `GET /configuracao/completa`, com qualquer sessão — o recibo
  imprime. `PATCH` exige `CONFIGURAR_LOJA`, que só o dono tem. O ramo troca **só as palavras**:
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
  **O que sai da máquina sai cifrado**: `loja:` é um `crypt` do rclone sobre `loja-drive:`
  (`.dump.bin` no Drive), com a chave só em `backups/.chave-do-backup` — nunca no banco, no
  `.env` ou em `docker/estado/` (montado na API). Mostrada uma vez, nunca no journal. **E só
  depois de uma pessoa confirmar que guardou a chave** (`.chave-confirmada`): até lá `loja:` é
  um `alias` e a cópia sai legível, com aviso — chave que ninguém viu é backup que não abre.
  Trocar token ou pasta de backup JÁ conectado exige `senha_atual` (422, nunca 401 — 401
  derrubaria a sessão). `atrasado` (ligado e sem cópia há mais de 2× `intervalo_min`) é
  decidido no servidor e pintado na tela e no selo do dono (web: lateral; app: aba Mais).
- **NFC-e (ADR-41)**: quem emite é um emissor terceirizado (`modules/fiscal/emissores.py`,
  adaptador Focus NFe), ligado **só** pelo `.env` (`FISCAL_EMISSOR`, `FOCUSNFE_TOKEN`,
  `FOCUSNFE_AMBIENTE`); desligado, as rotas dão 409 com `detail.faltando`. O token nunca vai ao
  banco nem sai por rota (`SecretStr`). Rede caída no adaptador vira PENDENTE, nunca exceção; a
  `referencia` é commitada ANTES do envio (também a nova, na ida para produção), e a tentativa
  também (PENDENTE, `tentativas + 1`): processo que cai no meio deixa "pode ter saído", nunca
  REJEITADA nem `tentativas = 0`. O commit solta o `FOR UPDATE`, então retrava e relê a venda
  antes do POST; dois "Emitir" esperam na fila por venda (`uma_emissao_por_vez`). "Tentar de
  novo" consulta antes de reenviar. Só resposta DEFINITIVA vira REJEITADA ou "não encontrada"
  (SEFAZ recusou, recusa documentada do pedido, 404 `nfce_nao_encontrada`): 429, 408, 5xx e 4xx
  desconhecido ficam PENDENTE, e com nota PENDENTE sem resposta a venda NÃO cancela. Emissão
  automática é fora da transação da venda (`after_commit`). Cancelar venda chama
  `FiscalService.cancelar_nota_da_venda` depois das recusas da venda e antes dos estornos: emissor
  recusou → a venda NÃO cancela. Teste de emissor só com `httpx.MockTransport` — nunca internet.
  `web/js/nfce.js` + `web/js/campos-fiscais.js` e `mobile/src/lib/fiscal.ts` são espelhos.
- **Fotos (ADR-42, "Fotos no Vercel Blob")**: `catalogo/fotos.py` escolhe pelo ambiente — disco (`/media`, caminho relativo, trocar NÃO apaga a antiga) ou, com `BLOB_READ_WRITE_TOKEN`, Blob público com URL absoluta em `produtos/<VERCEL_ENV>/`, sem `mkdir`/`/media`, e a antiga apagada só depois do commit e só se for do mesmo ambiente; na Vercel (`VERCEL`, nunca a falha do `mkdir`: o `/tmp` grava) sem token, 503 e nada de `/media`; lá o teto é 4 MB (a função corta em 4,5); quem mostra aceita as duas (`lib/enderecoDaFoto.ts`). A rota lê o multipart só DEPOIS do login (`request.form` dentro dela, sem `File()`: com ele o FastAPI lê e grava o corpo antes das dependências, e o 401 sai depois do envio inteiro).
- **Leitor pelo celular (ADR-43)**: o computador pareia um celular (`/leitor/pareamentos`, código de 6
  sem 0/O/1/I, 5 min; aceite vale 12 h fixas; status calculado, nunca coluna) e cada bipe da câmera
  entra em `leitor_bipes` (idempotente por `client_uuid`, conferido ANTES de tudo). O computador
  RETIRA a fila (`.../retirar`: `UPDATE ... FOR UPDATE SKIP LOCKED`, 50 por vez, uma vez só, bipe
  com mais de 120 s descartado) por **SQL Core** — retirar pelo ORM avisaria "leitor" e cada tela
  retiraria de novo, em eco. Aceite: a mesma 404 `LEITOR_CODIGO_INVALIDO` para todo código que não
  serve — menos o reenvio de quem já aceitou (200 com o mesmo pareamento, a resposta se perdeu). `web/js/leitor-remoto.js` e `mobile/src/lib/leitorRemoto.ts` (convite do QR) são espelhos.
  No web, o bipe retirado vai ao `criarLeitor` da tela por `entregarCodigoDeFora` (`leitor.js`),
  na hora do aviso (`ouvirNaHora`, fora da rodada); tela nova com leitor ganha isso de graça
  se chamar `ligar()`/`desligar()` — e, se ela grava (POST que copia a lista e depois a limpa) ou
  tem campo de digitar na lista que o bipe redesenha, passa `ocupadoQuando: () => enviando ||
  digitandoEm(areaItens)`: o código de fora espera em vez de sumir. Uma aba por leitor
  (`criarDonaDaAba`, "Duplicar aba" copia o `sessionStorage`): quem ainda espera a resposta sobre
  um leitor responde por ele a quem perguntou depois (hora + sorteio; a resposta leva a hora de
  quem responde), e vence a primeira a perguntar.
  **O chamado (ADR-47)**, sem QR: "Abrir no app o leitor de código", acima do campo de leitura das
  cinco telas que leem código (tela nova com leitor: o `<div data-leitor-chamado>` antes do
  `.pdv__campo`, `ligarBotaoDoCelular` no render e o `soltar` na limpeza), chama
  o celular do MESMO login — `POST /leitor/chamados`, idempotente por `client_uuid` gravado no
  `sessionStorage` ANTES do POST (o F5 retoma, sem órfão), um a cada 2 s (429 com `Retry-After`). É
  um pareamento com `chamado`/`sinal`: o código sorteado nunca sai nem abre aceite, só o mesmo login
  atende (`/atender`, a MESMA 404 `LEITOR_CHAMADO_INVALIDO` para tudo que não serve), e o SINAL de 3
  caracteres é o que separa dois caixas com o mesmo login (a fronteira é o login; vínculo estrito é o
  QR). `substitui_id` de um ATIVO é 409 `LEITOR_JA_LIGADO`, também no QR. A instalação do app (UUID
  no SecureStore) vai no aceite, no atender e no bipe: reenvio, bipe e TROCOU valem por instalação,
  e o id só vive com o leitor ligado (`_encerrar` o anula; o do que venceu sai no primeiro código
  ou chamado feito 5 min depois do fim, `esquecer_instalacoes`, por último e com `SKIP LOCKED`). A
  conta vem antes de qualquer pareamento (`travar_conta`, FOR KEY SHARE), na ordem da exclusão da
  conta: senão o "Chamar de novo" e o atender se abraçam com ela (40P01). No web, a chave do
  chamado só vale enquanto descreve a aba e só sai do `sessionStorage` com o id do chamado já
  guardado — o F5 durante a pergunta às outras abas não perde o chamado —, e o F5 trava a área até
  o leitor voltar. No app, vencer não avisa ninguém (status calculado): a lista de chamados se
  reconfirma de 30 em 30 s enquanto tem chamado e esconde o vencido pelo `vence_em`. O leitor
  ligado tem "Digitar código", pelo MESMO `aoLer` da câmera.
  "leitor" é só o bipe; o pareamento é "leitor_pareamento". No app aberto o chamado desce como FAIXA
  (`FaixaDoChamado.tsx`, nunca modal, não pausa câmera), e ligar é sempre um toque (faixa, cartão ou
  notificação; link e QR nunca ligam sozinhos). Rótulo novo que a ficha da Apple cita entra em
  `TELAS_CITADAS` (`mobile/publicar/ficha.mjs`), e o CI confere no arquivo.
- **Notificações (ADR-47)**: o push do chamado nasce **DESLIGADO** (`NOTIFICACOES_PUSH=desligado`;
  na demo da instalação, `DEMO_NOTIFICACOES_PUSH`) e só funciona depois do passo único de quem publica
  (a chave APNs na Expo: `mobile/publicar/README.md`, "Notificações no iPhone"); ligar é o `.env`, sem
  build novo, e nada disso trava o envio à Apple. `GET /configuracao` diz `notificacoes_push`, e o app
  SÓ pede a permissão e SÓ manda o token com ela `true` — desligado, registra o aparelho sem token
  (`PUT /notificacoes/aparelho` a cada sessão: é o que faz `SEM_CELULAR` dizer a verdade). A
  permissão só no caminho do leitor ("Abrir o leitor", Mais → Leitor do computador), nunca ao abrir o
  app, nunca empilhada com a da câmera. O push sai DEPOIS do commit do chamado, fora de transação,
  com teto TOTAL de 4 s (`asyncio.timeout`), e nunca derruba o chamado (vira `FALHOU`); leva só texto
  fixo e o sinal — nenhum id, endereço de servidor ou dado da loja. **O token é credencial ao
  portador**: nunca em rota, log ou `repr` (nem o `message` cru da Expo, que o repete) e nunca em
  backup — os sete `pg_dump` dos scripts (cinco `.sh`, dois `.ps1`) levam
  `--exclude-table-data=notificacao_aparelhos`, e
  `pg_dump` novo leva a mesma flag (o teste de texto cobra). Ele some em `_derrubar_sessoes` (trocar
  ou redefinir a senha, desativar, excluir), no `DELETE /notificacoes/aparelho` SEM sessão (o app ao
  sair; sem rede, uma limpeza pendente) e, passados 30 dias sem registro, na faxina do registro,
  do login e da renovação da sessão (`SKIP LOCKED`, por último). O registro roda de novo quando a configuração muda o modo do
  push, nunca a cada religação. Um POST por aparelho à Expo (ela recusa o lote misto inteiro), e o
  porquê da recusa vai ao log só como código; `SEM_CHAVE_DA_APPLE` é a chave APNs que falta na Expo
  (o passo único do README do publicador). Teste de push só com
  `httpx.MockTransport` (o conftest reprova a Expo de verdade). O `expo-notifications` só carrega por
  `lib/notificacoesNativas.ts`: o export web e o Expo Go nunca o importam. Espelhos: a validação do
  token (`notificacoes/schemas.py` ↔ `tokenValido`, `lib/notificacoes.ts`), o formato do sinal
  (servidor ↔ app) e as frases da exclusão de conta (o registro sai junto).
- Versão: `GET /versao` diz o commit instalado E se é o mais novo. Quem sabe disso é o
  `atualizar.sh` (tem a credencial do GitHub), que grava `docker/estado/versao.json`; a API
  só lê o arquivo montado. **A API nunca fala com o GitHub** — token do código-fonte não
  entra no contêiner que serve a loja. O `atualizar.sh` só sobe commit de **CI verde**
  (check-runs, com a credencial do `origin`) e anota em `docker/estado/falhou` o que caiu na
  volta atrás, para o `--sim` não derrubar a loja de novo com ele (ADR-18).
- **Operação (ADR-32 a 34)**: toda unidade do systemd da loja leva `OnFailure=loja-aviso@%N`
  (o `notificar.sh` grava o modelo); unidade nova de rotina → a mesma linha. Teste de script
  que grava unidade usa `DIR_SYSTEMD` de mentira, nunca `/etc`. Dependência Python nova ou
  versão nova → `api/requirements.lock` (imagem e CI instalam dele, `--no-deps`). IP público
  no instalador é recusado: HTTP puro só na rede da loja.
- Mutações idempotentes por `client_uuid`: `POST /vendas`, `POST /estoque/entradas`,
  `POST /vendas/{id}/devolucoes` e `POST /clientes/{id}/pagamentos` (replay → 200 com o existente).
  A mesma chave com OUTRO pedido é 409 `DUPLICADO`, nunca o registro antigo como sucesso; a
  Entrada devolve no `detail.itens` o que já gravou e no `detail.nota` a nota que já lançou
  (`null` se foi sem; só para quem vê dinheiro), e a tela tira da lista os itens e do formulário
  a nota — só se for a MESMA (mesmo número; sem número, mesmo valor) — antes de trocar a chave
  (senão o reenvio soma as peças de novo e a dívida do fornecedor dobra em Contas a pagar).
  Outra nota fica; e nota que fica sem peça para levá-la a tela manda lançar em Contas a pagar
  (`notaDepoisDoDuplicado`). Depois do `rollback` de uma corrida, recarregue
  o `usuario` (`session.refresh`) antes de ler `role`/`id`: atributo expirado é MissingGreenlet.
- **Condicional e contas a pagar (ADR-39, ADR-40)**: a condicional tira a peça do saldo
  (`CONDICIONAL_SAIDA`); o fechamento devolve TUDO (`CONDICIONAL_RETORNO`) e vende o que ficou
  pelo `VendaService.registrar(..., confirmar=False)` — a venda dentro da transação de quem chama,
  sem commit. Não há segundo caminho de venda; o que ficou sai da peça que RECEBEU o retorno
  (a que `aplicar_movimento` devolve — a recadastrada, se a original foi excluída). A chave da
  abertura vive com a tela: mexer na sacola não a troca, e o 409 leva à condicional que já
  abriu. O reenvio do fechamento compara a cobrança inteira com a régua do PDV
  (`VendaService._cobrada_assim`: forma, valor, parcelas, bandeira, vale, desconto), e a
  aberta mostra o preço da peça que vai ser VENDIDA (`catalogo.pecas_que_receberiam`).
  `payables` (contas a pagar do fornecedor) nascem na Entrada, na mesma transação, e **nunca**
  entram no Resultado: o CMV já conta a mercadoria.
  `web/js/parcelas.js`/`condicional.js` são espelhos de `mobile/src/lib/` — mudou um, mude o outro.
- **Devolução, vale e fiado (ADR-19 a ADR-21)**: não existe "modo troca" — troca é devolução que
  vira vale mais uma venda nova. O valor volta pró-rata **pelas formas em que entrou**, com teto
  no que cada uma recebeu; o que não couber vira vale (`vouchers`, consumido por `UPDATE`
  condicional, igual ao saldo de estoque). `FORMAS_DE_GAVETA` (dinheiro, PIX, débito, crédito) é o
  que o caixa confere — VALE e FIADO **nunca** entram numa conferência de gaveta. O saldo do
  cliente é sempre calculado, nunca coluna, e o abatimento para onde a dívida acaba.
  Excluir cliente (só quitada e sem condicional aberta) **anonimiza** (LGPD): telefone, documento e observação viram
  nulos e o nome vira "Cliente removido #id"; a linha fica para as vendas do passado.

## Convenções do web (`web/`)

- Uma tela por arquivo em `js/views/`, `export function render(raiz, params, consulta)`; **máx. ~300 linhas**.
  Devolva uma função de limpeza se a tela ligar timer ou listener global.
- Nada do servidor entra em `innerHTML` sem escape: use o template `html` de `ui.js`. HTML confiável
  só com `cru()`. `html` devolve valor já marcado, então template dentro de template funciona.
- Dinheiro em centavos (`js/dinheiro.js`, **espelho de `mobile/src/lib/money.ts` — mudou lá, mude aqui**).
- Toda listagem pagina no servidor; filtros vão para a query da URL (`trocarConsulta`), para o F5 não perder.
- Refresh token **só** em cookie httpOnly; access token só em memória. Nunca `localStorage`.
- **Raiz da página (ADR-46)**: a mesma pasta serve a loja (`/app/`) e a demo (`/demo/app/`). Caminho
  do servidor só por `naRaiz()`, foto por `enderecoDaFoto()`, chave de storage/canal por `nomeNaRaiz()`
  (`js/raiz.js`); `testes/web/sem-endereco-absoluto.test.mjs` reprova `/api/v1` absoluto (também
  o montado depois de um `${...}` que não seja a raiz nem rota `#/`), a chave do navegador que não
  venha de `nomeNaRaiz` em CADA chamada (`?.`, apelido e `['x']` contam) e o `foto_url` que chegue
  ao `src` (`.src =`, `setAttribute('src'`, `src=${}`) sem passar por `enderecoDaFoto()`.
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
- **Área segura (do SE ao Pro Max)**: nada de altura ou padding fixo no que encosta na borda da
  tela. Barra de abas: `medidasDaBarraDeAbas` (`lib/areaSegura.ts`, com teste — `height` fixa faz
  o React Navigation esquecer o indicador de início). Rodapé, botão flutuante e pé de Modal de
  tela cheia: `useRespiroDeBaixo()`; topo de Modal de tela cheia: `useRespiroDeCima()`
  (`components/ui.tsx`). `KeyboardAvoidingView` de tela debaixo das faixas do topo (a entrada):
  `keyboardVerticalOffset={deslocamentoDoTeclado(alturaDasFaixas)}`, com a altura medida por
  `useAlturaDasFaixas()` (a guarda em `lib/areaSegura.test.ts` lê a `login.tsx`); folha modal
  nativa (a do servidor) e `<Modal>` de tela cheia não descontam. O export web não tem recorte:
  a auditoria emula a área segura pelo DevTools (`Emulation.setSafeAreaInsetsOverride`).
- Frase nunca leva `textTransform: 'capitalize'` (vira "Novembro De 2026"): `primeiraMaiuscula`
  e `plural` de `lib/texto.ts`, no lugar do "peça(s)".
- **Barra de status**: a raiz é CLARA (texto branco sobre o cabeçalho azul). Tela clara sem
  cabeçalho (entrada, servidor, Vender) chama `useBarraDeStatusEscura()` — no FOCO, não na
  montagem: as abas seguem montadas, e um `<StatusBar>` na aba Vender escureceria a barra sobre
  o azul de Produtos. No export web o pedido vai para `<html data-barra-de-status>`, e o
  `compor.mjs` das capturas pinta essa cor e PARA se ela sumir sobre a foto (`lib/barraDeStatus.ts`).
- **Câmera**: o leitor pede a permissão ao SISTEMA ao montar (`lib/permissaoDaCamera.ts`); a
  tela do app só aparece depois de recusada — "Abrir Ajustes" quando o iOS não pergunta mais,
  "Continuar" quando ainda pergunta. Nunca uma tela do app com "Permitir" antes do alerta (5.1.1).
- Diálogo do app (`Confirmacao`, os de pagamento, a caixa do "Digitar código"): corpo num `ScrollView`
  com `maxHeight` 85% e os botões fora da rolagem — com o Texto Maior do iOS, sem isso os botões saem
  da tela.

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
  Só o DIA de um instante (`TIMESTAMPTZ`) sai por `diaNaLoja`; `data()` é para data pura e fatia
  o ISO — num instante daria o dia em UTC (a venda das 23h30 viraria o dia seguinte).
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
- **Índice só entra medido (ADR-31)**: `EXPLAIN` com volume de anos de loja, não numa tabela
  de teste de três linhas, e a consulta escreve a expressão do índice letra por letra. Busca
  por nome usa `achatar()` de `catalogo/busca.py`, que manda as tabelas de acento LITERAIS:
  com parâmetro no meio, o plano genérico do asyncpg não casa com o índice trigram e cada
  tecla volta a varrer o catálogo. Teste de índice olha o plano da consulta REAL
  (`tests/planos.py`). A API tem `statement_timeout` por conexão (30 s).
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
  `react-native-worklets`, peer do reanimated 4). Bundle que "passa" com ~700 módulos em vez
  de ~2600 saiu SEM as rotas (e o `web:build` mostra "No routes found"): é o cache do Metro em
  `/tmp/metro-cache`, que é da máquina e não da cópia — de outra cópia do repositório (outra
  worktree, `node_modules` por link) ele serve o bundle errado calado. Rode com `TMPDIR` próprio
  e confira o número de módulos.
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
- **"Voltar" morto no iPhone (iOS 26+)**: o react-native-screens 4.16, versão que o SDK 54 fixa,
  desliga o botão ao sair de uma tela e só o religa no `didPopItem`. A tela das abas não tem
  cabeçalho, então o religar não acha o botão, e o iOS reaproveita o botão desligado na próxima
  tela. A partir daí nenhuma tela volta pelo toque, só pelo gesto da borda
  (software-mansion/react-native-screens#3294, corrigido na 4.17). A correção é
  `mobile/patches/react-native-screens+4.16.0.patch`, aplicado pelo `postinstall` (patch-package)
  em todo `npm install`/`npm ci`, inclusive no build da Expo. Não subimos o pacote porque o JS
  da 4.17 sobre o nativo 4.16 do Expo Go quebraria o teste por QR (ADR-14). O guarda é
  `src/lib/voltarNoIos.test.ts`, que reprova se o patch se perder; quando o pacote subir, apague
  o patch. É código nativo: só chega ao celular num build novo, nunca por atualização OTA (o app
  não tem `expo-updates`: TODA mudança do app, também em JS, só chega num build novo). Do lado do
  JS, duas armadilhas de pilha, com guarda no mesmo teste: o grupo `(app)` exporta
  `unstable_settings = { initialRouteName: '(tabs)' }` — sem ele, o app aberto por link (o convite
  do QR, `gestaoloja://leitor`, com o app fechado) punha a tela sozinha na pilha, sem "Voltar" e
  sem abas —, e voltar ao Vender é `router.dismissTo('/')`, nunca `router.replace('/(app)/(tabs)')`,
  que empilha abas novas sobre as velhas e deixa a lista e a venda escondidas embaixo.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- When graphify-out/graph.json exists, run `graphify query "<question>"` before your first grep, search or source-file read for a codebase question, and put this rule in every subagent prompt that explores code. Read raw files only for lines the graph or an earlier read already located. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
- A committed graphify-out/graph.json is rewritten whole on every build, so a large diff to it in a pull request is expected. Do not flag it as churn or suggest skipping the graph rebuild or its hooks.

**Regra do dono do projeto: pergunta ou análise sobre o código começa no grafo, nunca lendo
arquivo inteiro.**
1. Sem `graphify-out/graph.json` (sessão nova)? Rode antes de tudo
   `CLAUDE_CODE_REMOTE=true bash .claude/hooks/session-start.sh`: instala o graphify (versão
   fixa) e gera o grafo só com AST local, sem token, em ~10 s.
2. Onde está / como funciona: `graphify query "<pergunta>"` ou `graphify explain "<símbolo>"`.
   O que quebra se mexer: `graphify affected "<símbolo>"`. Como A chega em B: `graphify path`.
3. Só então abra o código, e só as linhas que o grafo apontou (`sed -n 'L1,L2p'`, `Read` com
   `offset`/`limit`) — nunca o arquivo todo para "dar uma olhada".
4. Mudou código? `graphify update .` (só AST, sem custo) antes da próxima pergunta.
5. Subagente que explora código recebe esta regra no prompt.

O `graphify-out/` não vai para o git (está no `.gitignore`): é refeito a cada sessão.
