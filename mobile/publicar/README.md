# Publicação automática na App Store

Publica a Fase 6 inteira sem clicar em nada: nome, subtítulo, descrição,
palavras-chave, as 10 capturas, categoria, classificação etária, preço grátis,
conta de demonstração, notas para o revisor, o build — e o envio para a revisão.

## Uma vez só (10 minutos)

1. Em [appstoreconnect.apple.com](https://appstoreconnect.apple.com):
   **Users and Access → Integrations → App Store Connect API → Team Keys → +**.
   Papel **App Manager**. Baixe o `.p8` (a Apple só deixa baixar uma vez).
2. Renomeie o arquivo para `chave-apple.p8` e ponha nesta pasta.
3. Copie `config.exemplo.json` para `config.json` e preencha (Key ID, Issuer ID,
   seus contatos e a conta de demonstração para o revisor).

`config.json` e `*.p8` estão no `.gitignore` desta pasta: **nunca** entram no git.

## Pelo GitHub (sem Mac e sem terminal) — o caminho de todo dia

GitHub → **Actions** → **Publicar iOS na App Store** → **Run workflow**. É o mesmo botão
do Sistema Obras: compila na nuvem da Expo, envia à Apple e sobe a ficha. Duas rodadas por
versão:

1. **Compilar** (+ **ficha**) marcados. O build leva ~20 min na Expo e, se o app já existe no
   App Store Connect, a própria Expo o envia à Apple ao terminar. A Apple processa mais
   10–30 min e manda e-mail.
2. Quando o build aparecer processado: rode de novo só com **revisão** marcada
   (desmarque compilar). Ele prende o build à versão e **envia para a revisão**.

Versão nova = subir `"version"` no `mobile/app.json` antes (o campo "versão" do botão só
confere). O número do build sobe sozinho.

### Uma vez só: segredos e variáveis do repositório

Settings → Secrets and variables → Actions. **Os valores são os mesmos do Sistema Obras**
(mesma conta da Expo, mesma chave da Apple): copie de lá.

| Onde | Nome | O quê |
|---|---|---|
| Secret | `EXPO_TOKEN` | expo.dev → Account settings → Access tokens |
| Secret | `ASC_KEY_ID`, `ASC_ISSUER_ID` | a chave da API da Apple (passo 1 acima) |
| Secret | `ASC_KEY_P8` | o conteúdo INTEIRO do `.p8`, com as linhas BEGIN/END |
| Secret | `APPLE_DEMO_PASSWORD` | senha da conta demo do revisor |
| Variable | `APPLE_TEAM_ID` | developer.apple.com → Membership → Team ID |
| Variable | `APPLE_TEAM_TYPE` | `INDIVIDUAL` (pessoa física) ou `COMPANY_OR_ORGANIZATION` |
| Variable | `APPLE_EMAIL_SUPORTE`, `APPLE_URL_SUPORTE`, `APPLE_NOME_CONTATO`, `APPLE_TELEFONE_CONTATO`, `APPLE_COPYRIGHT` | contato e ficha |
| Variable | `APPLE_EMAIL_DEMO`, `APPLE_CODIGO_DEMO` | conta demo e um código de barras que exista nela |
| Variable (opcional) | `APPLE_SERVIDOR_DEMO` | onde o revisor conecta; padrão `https://loja-tria.vercel.app` |
| Variable (opcional) | `APPLE_URL_PRIVACIDADE`, `APPLE_URL_ETIQUETAS_DEMO` | padrão: `<servidor demo>/privacidade` |

Faltou alguma? O passo que precisa dela diz **quais nomes** faltam; os outros seguem.

**A conta demo do revisor mora no servidor de demonstração DA LOJA** (`APPLE_SERVIDOR_DEMO`):
crie lá um usuário de perfil dono só para a Apple. Antes as notas mandavam o revisor para
`sistemaobras.com.br`, que hoje é o site do Sistema Obras — a revisão voltaria.

**Primeira vez da loja na Apple** (o resto o botão faz sozinho):
- o app tem de existir no App Store Connect — a Apple só deixa criar pelo site: Apps → **+** →
  Novo app → iOS, nome "Gestão de Loja", bundle `com.gestaoloja.app`, SKU `gestao-loja`. Se
  o primeiro build sair antes disso, ele fica na Expo: crie o app e rode com **enviar** marcado;
- com `APPLE_TEAM_ID`/`APPLE_TEAM_TYPE` preenchidos, a Expo cria certificado e perfil sozinha.
  Sem eles, faça o primeiro build à mão (`npx eas build -p ios --profile production`), que
  pergunta o Apple ID uma vez e guarda tudo na Expo;
- o projeto da Expo nasce no primeiro disparo (`eas init`). Para fixá-lo, copie o projectId
  de expo.dev para `expo.extra.eas.projectId` no `mobile/app.json`.

Quem faz o quê: `publicar/ci.mjs` monta chave e ficha dos Secrets/Variables numa pasta do
runner fora do repositório (permissão 600), acha o app pelo bundle e liga o envio pelo perfil
`ci` do `eas.json` (que lê a chave das variáveis do runner). Nenhum segredo vai para o log
nem para arquivo do repositório. Teste: `node --test publicar/teste/ci.test.mjs`.

## Publicar pelo seu computador (dentro de `mobile/`)

```bash
npx eas build --platform ios --profile production   # compila na nuvem
npm run publicar:build                              # sobe o build (cria o app na 1ª vez)
npm run publicar -- --enviar                        # ficha inteira + envia para revisão
```

Sem `--enviar`, o `npm run publicar` prepara tudo e para na beira — bom para
conferir no site antes. `npm run publicar:simular` só valida arquivos e textos,
sem falar com a Apple.

Os textos vêm de `ficha/` e as capturas de `media/app-store/iphone-6.5/` —
mudou lá, o próximo `npm run publicar` republica.

## O que continua manual (limite da Apple, sem API)

- A ficha **Privacidade do App** — uma vez, seguindo `docs/LOJAS-DE-APP.md` item 5.
- Criar a conta e aceitar os contratos.

## Teste

`node publicar/teste/rodar.mjs` sobe uma App Store Connect de mentira e roda a
publicação inteira contra ela, conferindo tudo o que chegou — inclusive os bytes
de cada captura.
`node --test publicar/teste/ci.test.mjs` confere o preparo do GitHub Actions contra a
mesma Apple de mentira. Os dois rodam no CI.
