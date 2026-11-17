# Publicação automática na App Store

Publica a ficha inteira sem clicar em nada: nome, subtítulo, descrição, texto promocional,
palavras-chave, novidades (em atualização), as capturas de iPhone 6,5" e 6,9", categoria,
classificação etária completa, direitos de conteúdo, disponibilidade (Brasil), preço grátis,
conta de demonstração, notas para o revisor, o build — e o envio para a revisão.

**O que nenhum programa faz** (a API 4.6 da Apple não tem rota para isso), uma vez só:

1. **Criar o registro do app** no site: appstoreconnect.apple.com → Apps → **+** → Novo app →
   iOS, nome "Gestão de Loja", bundle `com.gestaoloja.app`, SKU `gestao-loja`.
2. **Responder a "Privacidade do App"** na tela, com as respostas prontas de
   `docs/LOJAS-DE-APP.md` §5. Depois de respondida, vale para as próximas versões.

O resto o publicador faz, e o **resumo do fim** de cada rodada diz o que ficou feito, os avisos e
as pendências (no GitHub, o mesmo resumo aparece na página da execução).

## Pelo GitHub (sem Mac e sem terminal) — o caminho de todo dia

GitHub → **Actions** → **Publicar iOS na App Store** → **Run workflow**. É o mesmo botão do
Sistema Obras.

**Um clique: caixa "completo".** Compila na nuvem da Expo esperando o build terminar (o envio
automático do EAS sobe o binário à Apple), sobe a ficha, espera a Apple processar o build (até
60 min, uma consulta por minuto) e manda para a revisão. Vem desmarcada porque o runner fica
parado esperando a Expo e a Apple — até ~2 h de minutos do Actions por rodada (o job tem teto de
150 min), e a conta já parou uma vez por limite de gasto.

**Duas rodadas curtas (o padrão):**

1. **Compilar** (+ **ficha**) marcados. O build leva ~20 min na Expo e, se o app já existe no
   App Store Connect, a própria Expo o envia à Apple ao terminar. A Apple processa mais
   10–30 min e manda e-mail.
2. Quando o build aparecer processado: rode de novo só com **revisão** marcada (desmarque
   compilar). Ele prende o build à versão e **envia para a revisão**.

**Por etiqueta (funciona antes de o botão existir).** O botão "Run workflow" só aparece depois
que o `publicar-apple.yml` chega na branch padrão. Uma etiqueta roda o modo completo a partir de
qualquer commit:

```bash
git tag ios-v1.0.0 && git push origin ios-v1.0.0     # a versão tem de ser a do mobile/app.json
git tag ios-v1.0.0-2 && git push origin ios-v1.0.0-2 # tentar de novo a MESMA versão
```

Versão nova = subir `"version"` no `mobile/app.json` antes (o campo "versão" do botão e a
etiqueta só conferem). O número do build sobe sozinho.

**Rodada completa que estourou o tempo** (fila longa na Expo, Apple lenta): o build segue na
Expo e é enviado à Apple mesmo assim. Quando chegar o e-mail da Apple, rode só com **ficha** +
**revisão** — ou empurre uma etiqueta com sufixo novo (essa compila outro build).

### Uma vez só: segredos e variáveis do repositório

Settings → Secrets and variables → Actions. **Os valores são os mesmos do Sistema Obras**
(mesma conta da Expo, mesma chave da Apple): copie de lá.

| Onde | Nome | O quê |
|---|---|---|
| Secret | `EXPO_TOKEN` | expo.dev → Account settings → Access tokens |
| Secret | `ASC_KEY_ID`, `ASC_ISSUER_ID` | a chave da API da Apple (ver "Pelo seu computador") |
| Secret | `ASC_KEY_P8` | o conteúdo INTEIRO do `.p8`, com as linhas BEGIN/END |
| Secret | `APPLE_DEMO_PASSWORD` | senha da conta demo do revisor |
| Variable | `APPLE_TEAM_ID` | developer.apple.com → Membership → Team ID |
| Variable | `APPLE_TEAM_TYPE` | `INDIVIDUAL` (pessoa física) ou `COMPANY_OR_ORGANIZATION` |
| Variable | `APPLE_EMAIL_SUPORTE`, `APPLE_URL_SUPORTE`, `APPLE_NOME_CONTATO`, `APPLE_TELEFONE_CONTATO`, `APPLE_COPYRIGHT` | contato e ficha |
| Variable | `APPLE_EMAIL_DEMO`, `APPLE_CODIGO_DEMO` | conta demo e um código de barras que exista nela |
| Variable (opcional) | `APPLE_SERVIDOR_DEMO` | onde o revisor conecta; padrão `https://loja-tria.vercel.app` |
| Variable (opcional) | `APPLE_URL_PRIVACIDADE`, `APPLE_URL_ETIQUETAS_DEMO` | padrão: `<servidor demo>/privacidade` |

Faltou alguma? O passo que precisa dela diz **quais nomes** faltam; os outros seguem. No modo
completo, a falta aparece ANTES de compilar.

**A conta demo do revisor mora no servidor de demonstração DA LOJA** (`APPLE_SERVIDOR_DEMO`):
crie lá um usuário de perfil dono só para a Apple. Antes as notas mandavam o revisor para
`sistemaobras.com.br`, que hoje é o site do Sistema Obras — a revisão voltaria.

**Primeira vez da loja na Apple:** o registro do app (lá em cima) tem de existir — se o primeiro
build sair antes disso, ele fica na Expo: crie o app e rode com **enviar** marcado. Com
`APPLE_TEAM_ID`/`APPLE_TEAM_TYPE` preenchidos, a Expo cria certificado e perfil sozinha; sem
eles, faça o primeiro build à mão (`npx eas build -p ios --profile production`), que pergunta o
Apple ID uma vez e guarda tudo na Expo. O projeto da Expo nasce no primeiro disparo
(`eas init`); para fixá-lo, copie o projectId de expo.dev para `expo.extra.eas.projectId` no
`mobile/app.json`.

Quem faz o quê: `publicar/ci.mjs` monta chave e ficha dos Secrets/Variables numa pasta do
runner fora do repositório (permissão 600), acha o app pelo bundle e liga o envio pelo perfil
`ci` do `eas.json` (que lê a chave das variáveis do runner). Nenhum segredo vai para o log
nem para arquivo do repositório — e a senha da demo vira `•••` até em mensagem de erro da Apple.

## O que sobe, e de onde

| Na Apple | Vem de |
|---|---|
| Nome (30), subtítulo (30), palavras-chave (100) | `ficha/nome.txt`, `ficha/subtitulo.txt`, `ficha/palavras-chave.txt` |
| Texto promocional (170) | `ficha/texto-promocional.txt` — muda sem nova revisão |
| Descrição (4000) | `ficha/descricao.txt` |
| Novidades (4000) | `ficha/novidades.txt` — **só a partir da 2ª versão** (a Apple recusa na primeira). Reescreva a cada versão nova |
| Notas para o revisor (4000) | `ficha/notas-revisao.txt` |
| Capturas iPhone 6,5" (**obrigatórias**) | `media/app-store/iphone-6.5/NN-nome.png` — 1242×2688, PNG RGB sem alfa, até 10 |
| Capturas iPhone 6,9" (extra) | `media/app-store/iphone-6.9/NN-nome.png` — 1320×2868 (ou 1290×2796, 1260×2736) |
| Classificação etária | `classificacao.mjs`: as 24 perguntas da API 4.6, "Não/Nenhum" → 4+ |
| Direitos de conteúdo, disponibilidade, preço, categorias | fixos no `publicar.mjs`: não usa conteúdo de terceiros; só Brasil (se a conta ainda não tiver disponibilidade — se já tiver, fica como está); grátis; Negócios + Produtividade |

Os textos são conferidos antes de falar com a Apple: limite contado como a Apple conta
(caractere, não byte), marcador `{{...}}` sem valor e menção a outra plataforma (diretriz
2.3.10) param a rodada com o nome do arquivo.

**Capturas.** A ordem da vitrine é a ordem dos nomes (`01-...` primeiro; as 3 primeiras aparecem
na busca). O reenvio substitui as antigas de cada conjunto, confirma cada arquivo pelo MD5 e
espera a Apple processar. O 6,5" é o conjunto obrigatório (em ago/2026 o formulário só aceitou
ele): com problema, a rodada para. O 6,9" é extra: pasta ausente, tamanho errado ou falha no
envio viram aviso, o conjunto pela metade é tirado e a App Store mostra o de 6,5" nos iPhones
maiores. Quem gera as imagens é `publicar/capturas/` (`gerar.sh` fotografa o app rodando com os
dados de demonstração e monta a arte) — veja `publicar/capturas/README.md`.

**Classificação etária.** Se a Apple recusar uma pergunta (409 que a nomeia), sai só ela, a
declaração vai de novo e fica um aviso. Pergunta que a Apple criou depois da 4.6 (vieram duas
em 16/11/2026) volta em branco: vira pendência com o nome dela e, se a Apple exigir no envio, a
mensagem dela aparece inteira — responda na tela (App Information → Age Rating) e rode de novo;
a rodada seguinte retoma o mesmo envio.

## Publicar pelo seu computador (dentro de `mobile/`)

Uma vez: em [appstoreconnect.apple.com](https://appstoreconnect.apple.com) →
**Users and Access → Integrations → App Store Connect API → Team Keys → +**, papel
**App Manager**; baixe o `.p8` (só dá uma vez), renomeie para `chave-apple.p8` e ponha nesta
pasta; copie `config.exemplo.json` para `config.json` e preencha. `config.json` e `*.p8` estão
no `.gitignore` desta pasta: **nunca** entram no git.

```bash
npx eas build --platform ios --profile production   # compila na nuvem
npm run publicar:build                              # sobe o build à Apple
npm run publicar -- --enviar --aguardar-build 60    # ficha inteira, espera o build e envia
```

- `npm run publicar` (sem `--enviar`) prepara tudo e para na beira — bom para conferir no site.
- `--aguardar-build <minutos>` espera, antes de prender o build, até existir build VALID da
  versão do `app.json` (uma consulta a cada `PUBLICAR_INTERVALO_BUILD` segundos, padrão 60).
  Estourou o limite ou a Apple marcou o build como inválido: mensagem clara e saída com erro.
- `npm run publicar:simular` só confere textos e capturas, sem falar com a Apple.

## Teste

```bash
node publicar/teste/rodar.mjs           # todos os cenários, com capturas sintéticas geradas no teste
node publicar/teste/rodar.mjs --reais   # a primeira publicação com as capturas REAIS de media/app-store
node --test publicar/teste/ci.test.mjs  # o preparo do GitHub Actions
```

`rodar.mjs` sobe uma App Store Connect de mentira (`teste/mock-asc.mjs`) e roda o publicador de
verdade contra ela: primeira publicação, atualização (novidades, disponibilidade intocada,
capturas substituídas, `--aguardar-build` com o build ficando VALID na 3ª consulta), falha no
6,9", pergunta recusada, perguntas novas exigidas no envio (e a rodada seguinte retomando o
envio), limite de espera estourado, imagem com alfa, senha que a Apple ecoa num erro, app
inexistente. A Apple de mentira **cobra como a de verdade**: toda rota, parâmetro e corpo é
conferido contra o recorte da especificação oficial em `teste/esquema-asc.mjs` (versão 4.6),
e o envio só passa com a ficha completa. Saiu especificação nova? Baixe o JSON no site da Apple
e rode `node publicar/teste/gerar-esquema.mjs <arquivo.json>`: o diff mostra o que mudou, e
pergunta de idade nova quebra o teste até ganhar resposta em `classificacao.mjs`.

Os dois testes rodam no CI. Variáveis que encurtam as esperas (o teste usa):
`PUBLICAR_INTERVALO_BUILD`, `PUBLICAR_INTERVALO_CAPTURAS` (segundos) e `ASC_REPETIR_MS`;
`PUBLICAR_CAPTURAS` aponta para outra pasta de capturas.
