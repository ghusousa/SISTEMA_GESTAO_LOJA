# Publicação automática na App Store

Publica a ficha inteira sem clicar em nada: nome, subtítulo, descrição, texto promocional,
palavras-chave, novidades (em atualização), as capturas de iPhone 6,5" e 6,9", categoria,
classificação etária completa, direitos de conteúdo, disponibilidade (Brasil), preço grátis,
conta de demonstração, notas para o revisor (em inglês), o anexo da revisão (UM só — a Apple
recusa o segundo: a gravação de tela ou, sem ela, o guia PDF), o build — e o envio para a
revisão, **inclusive o reenvio** depois de uma recusa ou de um pedido de informação da Apple.

**O que nenhum programa faz** (a API 4.6.1 da Apple não tem rota para isso), uma vez só:

1. **Criar o registro do app** no site: appstoreconnect.apple.com → Apps → **+** → Novo app →
   iOS, nome "Gestão de Loja", **Idioma principal "Português (Brasil)"**, bundle
   `com.gestaoloja.app`, SKU `gestao-loja`. (Escolheu outro idioma sem querer? O publicador põe
   o pt-BR como principal e apaga as localizações vazias do outro, que travariam o envio.)
2. **Responder a "Privacidade do App"** na tela, com as respostas prontas de
   `docs/LOJAS-DE-APP.md` §5. Depois de respondida, vale para as próximas versões.

E uma coisa que **não precisa**: escrever na Central de Resolução (a mensagem do App Review).
A API também não escreve lá — mas o reenvio leva as notas e o anexo novos, e é isso que a
Apple lê. Se quiser responder também, o texto pronto, em inglês, está em
`revisao/resposta-ao-app-review.txt` (cole depois do reenvio).

O resto o publicador faz, e o **resumo do fim** de cada rodada diz o que ficou feito, os avisos e
as pendências (no GitHub, o mesmo resumo aparece na página da execução).

## A resposta à Apple (Guideline 2.1 — "Information Needed")

A Apple devolveu a 1ª submissão pedindo sete coisas. Tudo sai deste repositório, e **o
publicador reenvia sozinho**: o envio que voltou em `UNRESOLVED_ISSUES` é retomado (o MESMO
envio, com a versão dentro e, se houver, o build novo — a Apple recusa abrir outro), as notas e
o anexo sobem de novo e ele marca o item recusado como resolvido antes de reenviar. Não há
nada a clicar no site.

| A Apple pediu | Onde mora | Quem faz |
|---|---|---|
| 1. Gravação de tela num iPhone **físico**, iOS mais novo, desde a abertura do app | anexo da revisão (`--video-revisao` / entrada `video_revisao_url`) | a sessão no iPhone real (BrowserStack), seguindo o roteiro abaixo |
| 2. Modelos e versões de iOS testados | `ficha/aparelhos-testados.txt` (uma linha por aparelho, `iPhone 17 — iOS 26.1`; a 1ª é a da gravação) | quem testou — **nada inventado** |
| 3 a 7. Para que serve e para quem, como acessar (conta demo), serviços externos, regiões, setor regulado | `ficha/notas-revisao.txt` (inglês, até 4000); por extenso, com os prints, no guia `revisao/app-review-guide.pdf` — que só vai anexado enquanto não há vídeo (a Apple aceita um anexo) | já escritos |

As notas citam a lista e o vídeo por marcadores (`{{APARELHOS_TESTADOS}}`, `{{APARELHO_DO_VIDEO}}`,
`{{VIDEO}}`): sem eles, viram "(pending)" — **a ficha sobe, a revisão não**. E citam só o anexo
que vai estar lá: a linha que começa com `{{SE_GUIA_ANEXADO}}` ("The attached `{{GUIA}}` has them
in full...") só fica com o guia anexado; com o vídeo, ela sai e o item 1 cita o vídeo. O `--enviar`
(caixa "revisao" no GitHub) é RECUSADO, antes de mexer em qualquer coisa na Apple, quando:

- `ficha/aparelhos-testados.txt` está vazio (só comentários) ou tem linha fora do formato;
- não há vídeo: nem `--video-revisao`, nem um já anexado (e processado) à revisão desta versão;
- o guia PDF commitado não é o das entradas de agora (texto, lista de aparelhos, prints);
- o servidor de demonstração não está como as notas dizem: `GET /health` no ar; a conta demo
  entra e é de **dono**; o código de barras demo existe e tem ao menos 3 peças em estoque (as
  notas mandam vender, e o PDV recusa peça sem estoque: reponha pela Entrada na demo); a
  política de privacidade abre (e a URL de suporte, quando é outra página; as duas pedidas como
  página, `Accept: text/html`. A de suporte FORA do servidor da demo que não abre daqui vira
  aviso no resumo, sem segurar o envio: página de terceiro pode recusar robô — e o "Pronto para
  a revisão" diz "privacidade (suporte: ver o aviso)", não "privacidade e suporte"); há rota
  para o leitor pelo celular, para o chamado dele (ADR-47: "Abrir no app o leitor de código";
  só a lista dos abertos, que não chama celular nenhum) e para a exclusão da própria conta (deploy
  na mesma versão); e a conta
  demo é **protegida** lá (ADR-45: não se exclui, não perde o papel nem troca de senha — senão
  o revisor que cria outro dono apaga a conta das notas no meio da revisão). Tudo pela API
  pública do sistema, a mesma do app; a sessão aberta para conferir é encerrada. A conferência
  da exclusão manda corpo vazio (a validação recusa antes de a rota rodar) e, para a proteção,
  uma senha aleatória: a recusa da conta da demonstração vem
  antes de a senha ser conferida, e uma senha que nunca confere não exclui nada. Nenhuma
  mensagem leva a senha da demo. Login recusado (401): confira `APPLE_EMAIL_DEMO` e
  `APPLE_DEMO_PASSWORD` contra o servidor — na demonstração que sobe com a loja (ADR-46),
  `./demo.sh --mostrar` na máquina dela diz os dois, e cada subida da demo (ou
  `./demo.sh --renovar`) refaz a conta com eles; na Vercel (ADR-42), um Redeploy da demo a
  recria com `DEMO_ADMIN_EMAIL`/`DEMO_ADMIN_SENHA` de lá (que tem de ser o mesmo e-mail).
  O servidor pode ter caminho (`https://loja.seudominio.com.br/demo`): toda rota é juntada por
  texto à base inteira — nunca `new URL('/x', base)`, que apagaria o `/demo` e conferiria a
  loja de verdade no lugar da demonstração.

O que as notas e o guia dizem da **exclusão de conta** (5.1.1(v)) é o que o app faz: qualquer
pessoa em `Mais > Minha conta > Excluir minha conta` (pede a senha, diz o que some e o que fica,
confirma; a entrada mostra "Conta excluída"); o dono, a conta de alguém da equipe, em
`Mais > Usuários > (pessoa) > Excluir conta`. O dono único não se exclui: passa antes o papel de
dono a outra pessoa (`Mais > Usuários > (pessoa) > Mudar papel`, também no app). A conta demo é
protegida no servidor de demonstração — as notas pedem ao revisor que crie uma conta de
funcionário e a exclua. A ficha **para antes de
falar com a Apple** se citar tela que o app deste commit não tem (`TELAS_CITADAS` em
`ficha.mjs`: rótulo citado → arquivo do app que o mostra; rótulo novo nas notas = uma linha lá),
e o CI reprova antes disso (`revisao.test.mjs` confere cada rótulo no código do commit).

O **leitor pelo celular** nas notas e no guia é o do chamado (ADR-47), antes do QR: no navegador
do computador, com a MESMA conta do app, "Abrir no app o leitor de código"; no app aberto, a faixa
"O computador está chamando" → "Abrir o leitor". O QR fica como alternativa
(`Mais > Leitor do computador > "Ler o QR do computador"`). As notas não prometem notificação —
o push nasce desligado no servidor (ver "Notificações no iPhone", abaixo) — e só citam a
permissão, opcional; o guia conta como ela funciona quando a loja liga.

**O guia PDF** (`revisao/app-review-guide.pdf`, em inglês, os sete itens por extenso e os
prints; é o anexo da revisão só enquanto não há vídeo, e por isso não diz que a gravação está
anexada — quem diz onde ela está são as notas) sai de `revisao/guia.mjs` por
`node publicar/revisao/gerar-guia.mjs` (Playwright + Chromium + fonte Inter). Mudou o texto, a
lista de aparelhos ou os prints? Rode de novo e faça
commit do PDF e do `app-review-guide.entradas.json` (a impressão digital das entradas) — o
`capturas/gerar.sh` já o refaz no fim. Nada que é segredo ou que muda por loja entra no PDF.

**Um anexo só.** A Apple aceita UM anexo por revisão: o segundo `POST /v1/appStoreReviewAttachments`
volta 409 `STATE_ERROR` ("There can be max of 1 attachment, please delete the existing attachment
before loading a new one" — foi o que parou a rodada nº 8, de 19/11/2026, subindo o guia com o
vídeo lá). O publicador escolhe um (`escolherAnexo`, em `anexos.mjs`), nesta ordem: o vídeo novo
desta rodada (`--video-revisao`); senão, o vídeo que já está anexado e processado (`COMPLETE` —
um vídeo bom nunca sai para o guia entrar; o que a Apple ainda processa é esperado antes da
escolha e, se ainda não terminou, fica do mesmo jeito — com `--enviar`, a rodada para e diz para
rodar de novo em alguns minutos); senão, o guia PDF. As notas citam só ele. Na troca (`trocarAnexo`): se o que está lá é
exatamente o escolhido (mesmo nome, mesmo MD5, processado), ele fica e os outros saem; senão,
TODOS os que estão lá saem ANTES e o escolhido sobe — reserva → bytes nas partes que a Apple
devolve → confirma com o MD5 → espera o processamento. Entre o apagar e o subir a revisão fica sem
anexo: se o envio falhar, a reserva pela metade sai, a pendência diz que a revisão ficou sem anexo,
o `--enviar` não manda a revisão, e a próxima rodada sobe de novo. O vídeo sobe sempre como
`screen-recording.mp4` (ou `.mov`) e fica anexado às próximas rodadas DESTA versão (o guia não
volta a ocupar o lugar dele); numa versão nova, passe o link de novo.

### Roteiro da gravação (iPhone físico, iOS mais novo, ~2 min)

Começar com o app FECHADO e gravar sem cortes no meio dos passos (dá para tirar o tempo parado
depois, sem mudar a ordem). É o que a nota 1 e o guia dizem que o vídeo mostra:

1. Abrir o app → tela de entrada → engrenagem → "Conectar à loja" → digitar o servidor de
   demonstração com `https://` → "Conectar".
2. Entrar com a conta demo (dono) → aba "Vender".
3. "Ler código de barras" → **o pedido de permissão da câmera aparece** → permitir → ler uma
   etiqueta (ou "Digitar código" com o código demo).
4. "Cobrar" → "Dinheiro" → "Confirmar venda" → a venda concluída → "Recibo para a cliente".
5. Mais → Usuários → "+" → criar uma conta de funcionário (vendedora).
6. Na pessoa criada → "Excluir conta" → confirmar (o dono excluindo alguém da equipe).
7. Criar outra conta de funcionário, sair (Mais → Sair), entrar com ela → Mais → Minha conta →
   "Excluir minha conta" → senha → confirmar → a entrada mostra "Conta excluída".

Depois: o aparelho e o iOS da gravação na 1ª linha de `ficha/aparelhos-testados.txt`, os
outros aparelhos testados nas linhas seguintes, `gerar-guia.mjs`, commit — e a rodada com o link
do vídeo.

## Pelo GitHub (sem Mac e sem terminal) — o caminho de todo dia

GitHub → **Actions** → **Publicar iOS na App Store** → **Run workflow**. É o mesmo botão do
Sistema Obras.

**Um clique: caixa "completo".** Antes de compilar, confere o que a revisão vai cobrar
(`publicar.mjs --conferir-envio`: a versão do app.json ainda aberta na Apple, a lista de
aparelhos, o vídeo, o guia em dia, a disponibilidade só no Brasil e o servidor de demonstração)
e para ali se faltar algo, sem gastar build. O link de `video_revisao_url` é baixado UMA vez, no
começo da rodada (`publicar/baixar-video.mjs`, conferido ali), e os passos seguintes recebem o
arquivo: um link pré-assinado (S3, sessão do BrowserStack) venceria durante a compilação. Depois compila na nuvem
da Expo esperando o build terminar (o envio automático do EAS sobe o binário à Apple), guarda o
**número desse build** (o `--json` do eas), sobe a ficha, espera a Apple processar ESSE build
(até 60 min, uma consulta por minuto) e manda (ou reenvia) para a revisão. Um build VALID mais
antigo da mesma versão — de outro commit — nunca vai no lugar dele. Vem desmarcada porque o
runner fica parado esperando a Expo e a Apple — até ~2 h de minutos do Actions por rodada (o job
tem teto de 150 min), e a conta já parou uma vez por limite de gasto.

**Duas rodadas curtas (o padrão):**

1. **Compilar** (+ **ficha**) marcados. O build leva ~20 min na Expo e, se o app já existe no
   App Store Connect, a própria Expo o envia à Apple ao terminar. A Apple processa mais
   10–30 min e manda e-mail.
2. Quando o build aparecer processado: rode de novo só com **revisão** marcada (desmarque
   compilar — "revisao" com "compilar" ou "enviar" na mesma rodada só no completo: com
   `--no-wait`, o build novo ainda não estaria na Apple e a revisão levaria o antigo; o passo
   "Decidir" para a rodada) — e, se o vídeo ainda não estiver anexado, cole o link em
   **video_revisao_url**. Ele prende o build mais novo da versão e **envia (ou reenvia) para a
   revisão**. Num envio que a Apple devolveu, ele RECUSA reenviar com o mesmo build que voltou
   (o app desta rodada não teria chegado à Apple, e as notas citariam telas que ele não tem):
   compile antes — ou, se a resposta à Apple não pede app novo, marque **mesmo_build**
   (`--mesmo-build`).

**Versão já enviada ou publicada**: compilar ou enviar um build com o mesmo número do app.json
não tem para onde ir. O passo "Conferir a versão na Apple antes de compilar" para a rodada
ANTES de gastar o build, com a frase do que fazer (esperar a resposta da Apple, ou subir
`"version"` no `mobile/app.json`).

**Por etiqueta (funciona antes de o botão existir).** O botão "Run workflow" só aparece depois
que o `publicar-apple.yml` chega na branch padrão. Uma etiqueta roda o modo completo a partir de
qualquer commit:

```bash
git tag ios-v1.0.0 && git push origin ios-v1.0.0     # a versão tem de ser a do mobile/app.json
git tag ios-v1.0.0-2 && git push origin ios-v1.0.0-2 # tentar de novo a MESMA versão
```

A etiqueta não tem campo de texto: o vídeo tem de já estar anexado à versão (de uma rodada do
botão com `video_revisao_url`). Versão nova = subir `"version"` no `mobile/app.json` antes (o
campo "versão" do botão e a etiqueta só conferem). O número do build sobe sozinho.

**Rodada completa que estourou o tempo** (fila longa na Expo, Apple lenta): o build segue na
Expo e é enviado à Apple mesmo assim. Quando chegar o e-mail da Apple, rode só com **ficha** +
**revisão** — ou empurre uma etiqueta com sufixo novo (essa compila outro build).

### Teste em iPhones reais — caixa "aparelhos" (experimental)

A Apple pediu a gravação num aparelho físico e a lista dos testados. Os iPhones reais da nuvem
do BrowserStack instalam um `.ipa` **ad hoc** (o da App Store não instala fora dela); o perfil
`teste-aparelhos` do `eas.json` (distribuição interna, `enterpriseProvisioning: "adhoc"`) gera
esse `.ipa`. Sem o `adhoc`, o eas-cli em modo não interativo parava em "couldn't find any
credentials suitable for internal distribution. Run this command again in interactive mode";
com ele e com `--refresh-ad-hoc-provisioning-profile`, a Expo cria (ou refaz) o perfil com a
chave da Apple — a caixa exige a chave (Secrets `ASC_KEY_ID` e `ASC_KEY_P8`) e o time da Apple
(`apple_team_id` do `padroes.json`, ou a Variable `APPLE_TEAM_ID`).

**Uma vez só, antes da 1ª rodada:** a 1ª credencial ad hoc (o certificado ligado a esse perfil)
o eas-cli só monta no modo interativo — no Actions ele para em "Credentials are not set up. Run
this command again in interactive mode" — e a Expo monta o perfil com os iPhones do cadastro
DELA, não os da Apple ("No devices are registered for this Apple team"). Num computador com
Node, dentro de `mobile/` e logado na conta da Expo: `npx eas-cli build --platform ios --profile
teste-aparelhos`. Ele entra na Apple, oferece registrar o iPhone na Expo (ou rode antes
`npx eas-cli device:create` → "Developer Portal", que importa os da Apple, ou "Input", com o
UDID) e monta a credencial; o `.ipa` desse build já serve para o BrowserStack. Daí em diante a
caixa refaz o perfil sozinha (`--refresh-ad-hoc-provisioning-profile`). Se o build da caixa
falhar, o passo diz isso.

1. Marque só **aparelhos** (as outras caixas ficam de fora nesta rodada; com "completo" junto,
   a rodada recusa). Na 1ª vez, preencha **udid_aparelho** com o UDID de um iPhone qualquer da
   loja: o perfil ad hoc só é assinado com pelo menos um iPhone registrado na conta da Apple, e o
   BrowserStack reassina o app para os aparelhos dele.
2. `publicar/ci.mjs aparelhos` pergunta à Apple quantos iPhones estão registrados
   (`GET /v1/devices`), registra o do UDID (`POST /v1/devices`, uma vez só; o UDID sai mascarado
   no log) e, sem nenhum, para dizendo como achar o UDID sem Mac. Registrar na Apple é a metade:
   o log lembra o cadastro da Expo (acima).
3. O eas compila esperando (`--wait --json`, teto de 90 min) e o **link do .ipa** vai para o
   resumo da execução. No BrowserStack, envie o app por esse link https.

É experimental até a primeira rodada de verdade.

**Sem compilar nada: o .ipa do build da loja.** O workflow à parte **"Link do .ipa (teste em
iPhone real)"** (`.github/workflows/link-ipa.yml`, sem entradas) só lê a lista de builds da Expo
com o `EXPO_TOKEN` e põe no resumo o link do .ipa do último build da LOJA que terminou. O
BrowserStack reassina todo .ipa enviado (a documentação dele recomenda ad hoc; o da loja é a
tentativa mais barata, porque já existe). Mora num arquivo à parte porque o formulário do
"Publicar iOS" já está no limite de 10 entradas do `workflow_dispatch` — o `ci.test.mjs` confere.

### Notificações no iPhone (passo único)

O chamado do leitor (ADR-47: na venda do computador, "Abrir no app o leitor de código" chama o
app do mesmo login) funciona **sem notificação**: com o app aberto, a faixa "O computador está
chamando" desce em 1–2 s e "Abrir o leitor" liga a câmera; o QR continua. A notificação é o
extra — o chamado chega também com o app fechado — e por isso o servidor nasce com ela
**desligada** (`NOTIFICACOES_PUSH=desligado`): o app só pede a permissão quando o servidor diz que
ela funciona (`GET /configuracao` → `notificacoes_push`), e ninguém vê um pedido de notificação
que não chegaria. **Nada disto trava o envio à Apple**: o revisor testa o chamado com o app
aberto e o QR, e as notas não prometem push.

O que já é automático: o `ci.mjs preparar` liga a capacidade **Push Notifications** no App ID
antes de compilar (`garantirPushNoAppId`, saída `push_no_app_id`: `ligado`, `ligou`,
`sem-bundle` ou `falhou`). O plugin do `expo-notifications` grava `aps-environment` no app em
todo build, e num App ID sem a capacidade a assinatura quebra. App ID que ainda não existe no
portal, ou a Apple recusando (chave sem permissão), viram aviso: o eas tenta de novo no build.
Ligar a capacidade invalida os perfis desse App ID; o eas refaz os que não estão ativos, e o
ad hoc já usa `--refresh-ad-hoc-provisioning-profile`. **Plano B**, se o build ainda reclamar de
`aps-environment`: `npx eas-cli credentials -p ios` → production → Provisioning Profile → apagar,
e compilar de novo. No primeiro `.ipa` com notificações, `codesign -d --entitlements :- <app>`
mostra `aps-environment` `production`.

O que só quem publica o app faz, **uma vez** (a chave é do time da Apple, não de cada loja):

1. **A chave APNs.** developer.apple.com → Certificates, Identifiers & Profiles → **Keys** → "+" →
   marque **Apple Push Notifications service (APNs)** → baixe a `.p8` (a Apple só deixa baixar
   UMA vez) e anote o **Key ID** e o **Team ID** (o `apple_team_id` do `padroes.json`).
2. **Entregar à Expo.** Num computador com Node, dentro de `mobile/`: `npx eas-cli login` e
   `npx eas-cli credentials -p ios` → production → **Push Notifications** → suba a `.p8` (ou deixe
   o eas criar uma, entrando com a conta da Apple). Tem de ser interativo: o eas recusa este passo
   com `--non-interactive`, e a chave da App Store Connect (a dos Secrets) não serve para ele —
   por isso não dá para fazer no Actions. A chave vale para sandbox e produção (TestFlight, App
   Store e o `.ipa` ad hoc) e não vence.
3. **Testar no TestFlight**, num iPhone de verdade, contra um servidor com o push ligado
   (`NOTIFICACOES_PUSH=expo`; na demonstração da instalação, `DEMO_NOTIFICACOES_PUSH=expo`, que só
   vale para ela): toque em "Abrir o leitor" e permita as notificações; feche o app; no
   computador, "Abrir no app o leitor de código". A notificação tem de chegar, com o mesmo sinal
   do computador, e o toque abre a câmera. Se o computador disser que o iPhone ainda não recebe as
   notificações ("falta um passo de quem publica o app"), a Expo não tem a chave: volte ao passo 2.
4. **Depois do teste no TestFlight, ligue `NOTIFICACOES_PUSH=expo` no servidor** de cada loja —
   na Vercel, a variável do projeto (Settings → Environment Variables) e um Redeploy; numa VPS ou
   no computador da loja, a linha no `.env` da raiz e `docker compose up -d api` (vale ao recriar
   a api; a demo da instalação tem a sua, `DEMO_NOTIFICACOES_PUSH`, e o `api-demo`). O app já
   aprovado passa a pedir a permissão no próximo "Abrir o leitor", **sem build novo**.

**Onde se testa o quê.** No BrowserStack, o `.ipa` é reassinado para os aparelhos de lá (por isso
qualquer iPhone registrado serve ao perfil ad hoc), e notificação de app reassinado não é prova:
lá se testam o chamado com o **app aberto** (a faixa, o sinal, "Abrir o leitor") e o **QR**. A
notificação com o app fechado — e o toque nela abrindo a câmera — se prova no **TestFlight**,
num iPhone da loja.

### Uma vez só: segredos e variáveis do repositório

Settings → Secrets and variables → Actions → **Secrets** → "Novo segredo do repositório"
(nunca em "Segredos do ambiente" nem em Variables). **Só três são exigidos**, e um quarto antes
da revisão:

| Secret | O quê | Quando |
|---|---|---|
| `EXPO_TOKEN` | expo.dev → Account settings → Access tokens (o nome do token lá é livre; o do Secret, não) | compilar, enviar |
| `ASC_KEY_ID` | App Store Connect → Usuários e acesso → Integrações → API → **Chaves da equipe** → coluna "ID da chave". Chave com acesso **Administrador** (Desenvolvedor não mexe na ficha nem envia para revisão) | ficha, enviar, revisão |
| `ASC_KEY_P8` | o TEXTO de dentro do arquivo `AuthKey_<ID>.p8` dessa chave (Bloco de Notas → Ctrl+A → Ctrl+C), não o nome do arquivo — a Apple só deixa baixar uma vez. Linhas juntadas ou sem BEGIN/END ainda servem; se não for a chave, o passo diz o que parece ter sido colado (sem mostrá-lo) | ficha, enviar, revisão |
| `APPLE_DEMO_PASSWORD` | a senha da conta demo do revisor: na demonstração que sobe com a loja, a que `./demo.sh --mostrar` mostra (na máquina dela); na Vercel, a de `DEMO_ADMIN_SENHA`. **Ou, sem Secret:** o workflow **"Senha da conta demo na Apple"** (`senha-demo.yml`, entrada mascarada no log antes de qualquer uso) grava a senha no campo "Senha" da revisão na Apple, e o publicador passa a usar a que está lá | só a revisão |

**O que não é segredo já está no repositório**, em `publicar/padroes.json`: o Issuer ID da chave,
o time da Apple (Team ID e tipo), nome e e-mail de contato, copyright, conta
demo e código de barras dela (o EAN da primeira camiseta do seed, `7890000000000`). Nunca ponha
senha, chave ou token nesse arquivo — o teste do `ci.mjs` recusa. Para trocar um valor sem mexer
no código, crie uma **Variable** de mesmo nome, que vence o padrão (o `ASC_ISSUER_ID` e o telefone
podem ser Variable ou Secret; o resto, só Variable — Secret com esses nomes é ignorado):

| Variable (opcional) | Padrão (`padroes.json`) |
|---|---|
| `ASC_ISSUER_ID` (Variable ou Secret) | `issuer_id` |
| `APPLE_TEAM_ID`, `APPLE_TEAM_TYPE` | `apple_team_id`, `apple_team_type` |
| `APPLE_EMAIL_SUPORTE`, `APPLE_NOME_CONTATO`, `APPLE_COPYRIGHT` | contato e copyright |
| `APPLE_EMAIL_DEMO`, `APPLE_CODIGO_DEMO` | conta demo (perfil **dono**) e um código de barras que exista nela |
| `APPLE_SERVIDOR_DEMO` | `https://loja-tria.vercel.app` (a demo da Vercel). A que sobe com a loja: `https://<domínio>/demo`, com o caminho |
| `APPLE_URL_PRIVACIDADE` | `<servidor demo>/privacidade` — não mora no `padroes.json`: troca junto com `APPLE_SERVIDOR_DEMO` |
| `APPLE_URL_SUPORTE` | a mesma URL da privacidade (a de cima): troca junto com ela |
| `APPLE_URL_ETIQUETAS_DEMO` | nenhum |
| `APPLE_TELEFONE_CONTATO` (Variable ou Secret: é dado pessoal) | nenhum: só a revisão pede, e só se a Apple ainda não tiver um telefone (de um envio anterior) |

Sem a senha da demo e sem telefone a **ficha sobe** (as notas dizem "(pending)") e o
`--enviar` para dizendo o que falta — sem mexer na Apple. Faltou outra peça? O passo que
precisa dela diz **quais nomes** faltam; os outros seguem. No modo completo, a falta aparece
ANTES de compilar.

**A conta demo do revisor mora no servidor de demonstração DA LOJA** (`APPLE_SERVIDOR_DEMO`),
uma loja só de dados fictícios, isolada de qualquer loja de verdade. São duas as formas:

- **A que sobe com a loja (ADR-46)**: o `./instalar.sh` já a deixa pronta em
  `https://<domínio>/demo`, com a conta de dono `dono@demo.example` protegida e os dados
  fictícios renovados toda madrugada. `./demo.sh --mostrar`, na máquina da loja, diz o que
  levar: as Variables `APPLE_SERVIDOR_DEMO` (o endereço COM o `/demo`) e `APPLE_EMAIL_DEMO`, e a
  senha — pelo workflow "Senha da conta demo na Apple" ou no Secret `APPLE_DEMO_PASSWORD`.
- **A da Vercel (ADR-42)**: é o padrão enquanto as Variables não apontarem para outra; a conta
  (`DEMO_ADMIN_EMAIL`/`DEMO_ADMIN_SENHA`) nasce no build de lá.

Esse servidor **fica no ar depois da revisão**: ele também serve a política de privacidade da
ficha (`<servidor>/privacidade`, com o caminho), que sem `APPLE_URL_SUPORTE` é também a URL de
suporte — desligá-lo derrubaria os dois links da App Store (5.1.1(i) e 1.5). Trocar de servidor
(da Vercel para a demo da loja) é rodar a ficha com as Variables novas: a URL de suporte segue
sozinha a privacidade (ou a Variable `APPLE_URL_SUPORTE`, se o dono quiser outra página), e a
conferência do `--enviar` abre as duas no endereço novo. Só que a rodada **não troca o link da
página que está à venda**: privacidade e suporte vão à Apple com a VERSÃO em preparação
(informações do app e textos da versão), e a App Store mostra os da versão à venda — os do
servidor antigo — até a versão nova ser **aprovada** e entrar no ar; com a versão em revisão
(travada para o publicador), só a próxima leva as URLs novas. **Antes de desligar o servidor
antigo**, então: (1) a versão com as URLs novas aprovada e no ar na App Store; (2) no Play
Console, as URLs de privacidade e de exclusão de dados trocadas (`<servidor novo>/privacidade`
e `<servidor novo>/exclusao-de-dados`, `docs/LOJAS-DE-APP.md`) — o Google Play não passa pelo
publicador, e a ficha de lá ficaria apontando para o servidor desligado. Só então desligue o
antigo. Para morar noutro endereço permanente, preencha `APPLE_URL_PRIVACIDADE` (o suporte vai
junto com ela; outra página de suporte, `APPLE_URL_SUPORTE`). Antes as notas mandavam o revisor
para `sistemaobras.com.br`, que hoje é o site do Sistema Obras — a revisão voltaria.

**Primeira vez da loja na Apple:** o registro do app (lá em cima) tem de existir — se o primeiro
build sair antes disso, ele fica na Expo: crie o app e rode com **enviar** marcado. Com a chave
da Apple e o time (`padroes.json`), a Expo cria certificado e perfil sozinha; sem a chave, usa o
que já guardou (nesta loja, certificado e perfil do primeiro build, válidos até 2027). O
`mobile/app.json` já guarda o `projectId` da Expo (`expo.extra.eas.projectId`), então o passo
"Ligar o projeto à Expo" só confere; sem ele, o `eas init` liga pelo nome a cada disparo.

Quem faz o quê: `publicar/ci.mjs preparar` monta chave e ficha dos Secrets/Variables numa pasta
do runner fora do repositório (permissão 600), acha o app pelo bundle, diz em que pé está a
versão do app.json na Apple e liga o envio pelo perfil `ci` do `eas.json` (que lê a chave das
variáveis do runner). Nenhum segredo vai para o log nem para arquivo do repositório — e a senha
da demo vira `•••` até em mensagem de erro da Apple.

## O que sobe, e de onde

| Na Apple | Vem de |
|---|---|
| Nome (30), subtítulo (30), palavras-chave (100) | `ficha/nome.txt`, `ficha/subtitulo.txt`, `ficha/palavras-chave.txt` |
| Texto promocional (170) | `ficha/texto-promocional.txt` — muda sem nova revisão |
| Descrição (4000) | `ficha/descricao.txt` |
| Novidades (4000) | `ficha/novidades.txt` — **só a partir da 2ª versão** (a Apple recusa na primeira). Reescreva a cada versão nova |
| Notas para o revisor (4000, em inglês) | `ficha/notas-revisao.txt` + `ficha/aparelhos-testados.txt` + o anexo escolhido (o vídeo ou o guia: as notas citam só ele) |
| Anexo da revisão (UM só: a Apple recusa o segundo) | o vídeo de `--video-revisao`, ou o que já está anexado e processado; sem vídeo, `revisao/app-review-guide.pdf` |
| Capturas iPhone 6,5" (**obrigatórias**) | `media/app-store/iphone-6.5/NN-nome.png` — 1242×2688, PNG RGB sem alfa, até 10 |
| Capturas iPhone 6,9" (extra) | `media/app-store/iphone-6.9/NN-nome.png` — 1320×2868 (ou 1290×2796, 1260×2736) |
| Classificação etária | `classificacao.mjs`: as 26 perguntas da API 4.6.1, "Não/Nenhum" → 4+ |
| Direitos de conteúdo, disponibilidade, preço, categorias | fixos no `publicar.mjs`: não usa conteúdo de terceiros; só Brasil (se a conta ainda não tiver disponibilidade — se já tiver, fica como está, mas é conferida: à venda fora do Brasil, o `--enviar` recusa, porque as notas dizem "Brazil only"); grátis; Negócios + Produtividade |

Os textos são conferidos antes de falar com a Apple: limite contado como a Apple conta
(caractere, não byte), marcador `{{...}}` sem valor, menção a outra plataforma (diretriz
2.3.10) e tela citada que o app deste commit não tem (diretriz 2.3) param a rodada com o nome do
arquivo.

**Idioma.** O app é só pt-BR. Se o registro foi criado com outro idioma principal, o publicador
troca para pt-BR e apaga as localizações do outro idioma na versão e no appInfo (vazias, elas
travariam o envio: a Apple cobra os campos de cada localização).

**Capturas.** A ordem da vitrine é a ordem dos nomes (`01-...` primeiro; as 3 primeiras aparecem
na busca). O reenvio substitui as antigas de cada conjunto, confirma cada arquivo pelo MD5 e
espera a Apple processar. O 6,5" é o conjunto obrigatório (em ago/2026 o formulário só aceitou
ele): com problema, a rodada para. O 6,9" é extra: pasta ausente, tamanho errado ou falha no
envio viram aviso, e o conjunto 6,9" que estiver na versão (pela metade, de uma rodada anterior
ou copiado pela Apple da versão no ar) é **apagado** — a App Store mostra o de 6,5" nos iPhones
maiores, e nunca telas velhas. Quem gera as imagens é `publicar/capturas/` (`gerar.sh` fotografa
o app rodando com os dados de demonstração e monta a arte) — veja `publicar/capturas/README.md`.

**Preço.** Só o ponto de preço **0,00** da lista inteira (paginada) do território-base: nunca o
primeiro da lista. Sem ponto grátis (ou lista vazia), nada é gravado e fica uma pendência — o app
nunca vira pago por engano.

**Classificação etária.** Se a Apple recusar uma pergunta (409 que a nomeia), sai só ela, a
declaração vai de novo e fica um aviso. Pergunta que a Apple criar antes de a especificação daqui
tê-la volta em branco: vira pendência com o nome dela e, se a Apple exigir no envio, a mensagem
dela aparece inteira — responda na tela (App Information → Age Rating) e rode de novo; a rodada
seguinte retoma o mesmo envio. Foi o caso das duas de 16/11/2026 — namoro e relacionamentos
(`datingAndRelationships`) e localização compartilhada (`sharedLocation`), que pararam a rodada
nº 8: a 4.6.1 as publicou, e o publicador responde "Não" às duas (o app não tem nada de namoro e
não pede nem compartilha a localização de ninguém).

**Envio.** Um envio ativo por plataforma: o publicador retoma o rascunho que ficou aberto
(`READY_FOR_REVIEW`) ou o devolvido pela Apple (`UNRESOLVED_ISSUES` — o REENVIO), sem repetir o
item da versão; com um envio já em andamento (`WAITING_FOR_REVIEW`, `IN_REVIEW`), para e diz
para esperar a resposta.

## Publicar pelo seu computador (dentro de `mobile/`)

Uma vez: em [appstoreconnect.apple.com](https://appstoreconnect.apple.com) →
**Users and Access → Integrations → App Store Connect API → Team Keys → +**, papel
**App Manager**; baixe o `.p8` (só dá uma vez), renomeie para `chave-apple.p8` e ponha nesta
pasta; copie `config.exemplo.json` para `config.json` e preencha. `config.json` e `*.p8` estão
no `.gitignore` desta pasta: **nunca** entram no git.

```bash
npx eas build --platform ios --profile production   # compila na nuvem
npm run publicar:build                              # sobe o build à Apple
npm run publicar -- --enviar --aguardar-build 60 --video-revisao gravacao.mp4
```

- `npm run publicar` (sem `--enviar`) prepara tudo e para na beira — bom para conferir no site.
- `--aguardar-build <minutos>` espera, antes de prender o build, até existir build VALID da
  versão do `app.json` (uma consulta a cada `PUBLICAR_INTERVALO_BUILD` segundos, padrão 60).
  Estourou o limite ou a Apple marcou o build como inválido: mensagem clara e saída com erro.
- `--build <número>` prende SÓ esse build (o CFBundleVersion que o eas devolveu) e espera por ele
  — é o que o modo completo do GitHub passa.
- `--mesmo-build` reenvia um envio devolvido com o build que a versão já tem preso (resposta à
  Apple que não pede app novo). Sem ela e sem `--build`, o `--enviar` de um envio devolvido é
  recusado quando o build mais novo da versão é o mesmo que voltou.
- `--video-revisao <arquivo ou https://...>` anexa a gravação de tela no lugar do anexo que estiver
  lá (MP4/MOV de verdade, pelo
  cabeçalho; até 500 MB). O link é baixado para a pasta temporária, conferido e apagado depois
  de lido. No Actions o workflow baixa o link UMA vez (`baixar-video.mjs`) e passa o arquivo.
- `--conferir-envio` só confere o que a revisão vai cobrar e a versão na Apple, sem escrever nada.
- `npm run publicar:simular` só confere textos e capturas, sem falar com a Apple.

## Teste

```bash
node --test publicar/teste/*.test.mjs   # o preparo do GitHub Actions e as peças da resposta à Apple
node publicar/teste/rodar.mjs           # todos os cenários, com capturas sintéticas geradas no teste
node publicar/teste/rodar.mjs --reais   # a primeira publicação com as capturas REAIS de media/app-store
```

`rodar.mjs` sobe uma App Store Connect de mentira (`teste/mock-asc.mjs`) e um servidor de
demonstração de mentira (`teste/demo-falso.mjs`) e roda o publicador de verdade contra eles:
primeira publicação com o vídeo como o anexo (o guia não sobe ao lado) e o servidor demo
conferido; atualização (novidades, disponibilidade intocada, capturas substituídas, o vídeo
anexado que fica, `--aguardar-build`); o
build DESTA rodada com um VALID antigo da mesma versão na Apple; recusada → corrige → reenvia
(o mesmo envio `UNRESOLVED_ISSUES`, com o build novo); pedido de informação sem build novo
(reenvio recusado, nada escrito) e com `--mesmo-build` (o mesmo build, vídeo novo no lugar do
antigo); devolvido com um build novo processado (preso sem `--build`); disponibilidade do site
com outros países (`--enviar` recusado, "Brazil only"); Apple que não aceita a marca de "resolvido"; app criado no site em
inglês; rodada sem 6,9" apagando o conjunto velho; preço (pago primeiro, grátis na 2ª página,
sem grátis, lista vazia); `--enviar` recusado sem aparelhos e sem vídeo (nenhuma escrita na
Apple); só a ficha com "(pending)" e o guia como o anexo; um anexo só (o guia velho sai antes de
o novo subir; o guia igual fica e a sobra ao lado sai; vídeo novo com o guia lá — só o vídeo fica, e
as notas o citam; vídeo já anexado numa rodada sem vídeo — ele fica e o guia sai; vídeo ainda
processando — espera e fica; falha no envio — pendência dizendo que a revisão ficou sem anexo, e a
rodada seguinte sobe); servidor demo fora do combinado (não-dono, código, leitor,
o chamado do leitor, exclusão, privacidade, senha, fora do ar); o suporte de fora que não abre daqui (aviso, e o
"Pronto" manda ver o aviso) e um aviso da conferência que não é do suporte (o "Pronto" segue
dando o suporte por conferido: quem o põe é o gancho `teste/aviso-a-mais.mjs`, carregado com
`--import`); `--conferir-envio`; versão já enviada; falha no upload
do vídeo; falha no 6,9"; pergunta recusada; perguntas novas exigidas no envio; limite de espera
estourado; tela citada que o app não tem; imagem com alfa; senha que a Apple ecoa num erro; app
inexistente; opção inválida. A Apple de mentira **cobra como a de verdade**: toda rota,
parâmetro e corpo é conferido contra o recorte da especificação oficial em
`teste/esquema-asc.mjs` (versão 4.6.1), um anexo por revisão (o segundo POST volta o 409
`STATE_ERROR` da Apple), um envio ativo por plataforma, e o envio só passa com a
ficha completa — inclusive TODAS as localizações. Saiu especificação nova? Baixe o JSON no site
da Apple e rode `node publicar/teste/gerar-esquema.mjs <arquivo.json>`: o diff mostra o que
mudou, e pergunta de idade nova quebra o teste até ganhar resposta em `classificacao.mjs`.

`revisao.test.mjs` confere as peças da resposta: o vídeo (cabeçalho, tamanho, download que não
deixa nada pela metade), a escolha e a troca do anexo (a ordem vídeo novo → vídeo anexado → guia;
o que está lá sai antes de o novo subir; o que não sai impede a subida), a lista de aparelhos
(formato), as telas citadas (na árvore de mentira e no código DESTE commit: cada rótulo de
`TELAS_CITADAS` tem de estar no arquivo do app ou do web), as notas (os sete itens, os dois
caminhos da exclusão, só o anexo que vai estar lá, até 4000 no pior caso com o vídeo e com o guia,
o chamado do leitor antes do QR e nenhuma promessa de push), que a política de privacidade conta
os serviços que as notas e o guia contam (Expo e APNs inclusive) e que o **guia PDF commitado é o
das entradas de agora**. `ci.test.mjs` confere o preparo do Actions: segredos fora do log, a versão
já enviada dita antes de compilar, os iPhones do perfil de teste e o Push Notifications no App ID
(já ligado não escreve; desligado, liga uma vez, com o corpo da especificação; App ID que não
existe — só a extensão de prefixo parecido — ou chave sem permissão viram aviso, e o preparar
segue).

Os testes rodam no CI, e o `--reais` também, depois de `node publicar/capturas/compor.mjs
--conferir` (as capturas commitadas nos bytes, contra as cenas do gerador). Variáveis que
encurtam as esperas (o teste usa): `PUBLICAR_INTERVALO_BUILD`, `PUBLICAR_INTERVALO_CAPTURAS`
(segundos) e `ASC_REPETIR_MS`; `PUBLICAR_CAPTURAS` aponta para outra pasta de capturas; e, só
no teste, `PUBLICAR_APARELHOS`, `PUBLICAR_TELAS` e `PUBLICAR_DEMO_BASE`.
