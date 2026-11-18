# Publicação automática na App Store

Publica a ficha inteira sem clicar em nada: nome, subtítulo, descrição, texto promocional,
palavras-chave, novidades (em atualização), as capturas de iPhone 6,5" e 6,9", categoria,
classificação etária completa, direitos de conteúdo, disponibilidade (Brasil), preço grátis,
conta de demonstração, notas para o revisor (em inglês), os anexos da revisão (o guia PDF e a
gravação de tela), o build — e o envio para a revisão, **inclusive o reenvio** depois de uma
recusa ou de um pedido de informação da Apple.

**O que nenhum programa faz** (a API 4.6 da Apple não tem rota para isso), uma vez só:

1. **Criar o registro do app** no site: appstoreconnect.apple.com → Apps → **+** → Novo app →
   iOS, nome "Gestão de Loja", **Idioma principal "Português (Brasil)"**, bundle
   `com.gestaoloja.app`, SKU `gestao-loja`. (Escolheu outro idioma sem querer? O publicador põe
   o pt-BR como principal e apaga as localizações vazias do outro, que travariam o envio.)
2. **Responder a "Privacidade do App"** na tela, com as respostas prontas de
   `docs/LOJAS-DE-APP.md` §5. Depois de respondida, vale para as próximas versões.

E uma coisa que **não precisa**: escrever na Central de Resolução (a mensagem do App Review).
A API também não escreve lá — mas o reenvio leva as notas e os anexos novos, e é isso que a
Apple lê. Se quiser responder também, o texto pronto, em inglês, está em
`revisao/resposta-ao-app-review.txt` (cole depois do reenvio).

O resto o publicador faz, e o **resumo do fim** de cada rodada diz o que ficou feito, os avisos e
as pendências (no GitHub, o mesmo resumo aparece na página da execução).

## A resposta à Apple (Guideline 2.1 — "Information Needed")

A Apple devolveu a 1ª submissão pedindo sete coisas. Tudo sai deste repositório, e **o
publicador reenvia sozinho**: o envio que voltou em `UNRESOLVED_ISSUES` é retomado (o MESMO
envio, com a versão dentro e, se houver, o build novo — a Apple recusa abrir outro), as notas e
os anexos sobem de novo e ele marca o item recusado como resolvido antes de reenviar. Não há
nada a clicar no site.

| A Apple pediu | Onde mora | Quem faz |
|---|---|---|
| 1. Gravação de tela num iPhone **físico**, iOS mais novo, desde a abertura do app | anexo da revisão (`--video-revisao` / entrada `video_revisao_url`) | a sessão no iPhone real (BrowserStack), seguindo o roteiro abaixo |
| 2. Modelos e versões de iOS testados | `ficha/aparelhos-testados.txt` (uma linha por aparelho, `iPhone 17 — iOS 26.1`; a 1ª é a da gravação) | quem testou — **nada inventado** |
| 3 a 7. Para que serve e para quem, como acessar (conta demo), serviços externos, regiões, setor regulado | `ficha/notas-revisao.txt` (inglês, até 4000) e o guia `revisao/app-review-guide.pdf` | já escritos |

As notas citam a lista e o vídeo por marcadores (`{{APARELHOS_TESTADOS}}`, `{{APARELHO_DO_VIDEO}}`,
`{{VIDEO}}`): sem eles, viram "(pending)" — **a ficha sobe, a revisão não**. O `--enviar`
(caixa "revisao" no GitHub) é RECUSADO, antes de mexer em qualquer coisa na Apple, quando:

- `ficha/aparelhos-testados.txt` está vazio (só comentários) ou tem linha fora do formato;
- não há vídeo: nem `--video-revisao`, nem um já anexado (e processado) à revisão desta versão;
- o guia PDF commitado não é o das entradas de agora (texto, lista de aparelhos, prints);
- o servidor de demonstração não está como as notas dizem: `GET /health` no ar; a conta demo
  entra e é de **dono**; o código de barras demo existe e tem ao menos 3 peças em estoque (as
  notas mandam vender, e o PDV recusa peça sem estoque: reponha pela Entrada na demo); a
  política de privacidade abre; há rota para o leitor pelo celular e para a exclusão da própria
  conta (deploy na mesma versão); e a conta demo é **protegida** lá (ADR-45: não se exclui, não
  perde o papel nem troca de senha — senão o revisor que cria outro dono apaga a conta das notas
  no meio da revisão). Tudo pela API pública do sistema, a mesma do app; a sessão aberta para
  conferir é encerrada. A conferência da exclusão manda corpo vazio (a validação recusa antes de
  a rota rodar) e, para a proteção, uma senha aleatória: a recusa da conta da demonstração vem
  antes de a senha ser conferida, e uma senha que nunca confere não exclui nada. Nenhuma
  mensagem leva a senha da demo. Login recusado (401): confira `APPLE_EMAIL_DEMO` e
  `APPLE_DEMO_PASSWORD`; se a conta foi excluída lá antes da proteção, um Redeploy da demo a
  recria com `DEMO_ADMIN_EMAIL`/`DEMO_ADMIN_SENHA` da Vercel (que tem de ser o mesmo e-mail).

O que as notas e o guia dizem da **exclusão de conta** (5.1.1(v)) é o que o app faz: qualquer
pessoa em `Mais > Minha conta > Excluir minha conta` (pede a senha, diz o que some e o que fica,
confirma; a entrada mostra "Conta excluída"); o dono, a conta de alguém da equipe, em
`Mais > Usuários > (pessoa) > Excluir conta`. O dono único não se exclui: passa antes o papel de
dono a outra pessoa (`Mais > Usuários > (pessoa) > Mudar papel`, também no app). A conta demo é
protegida no servidor de demonstração — as notas pedem ao revisor que crie uma conta de
funcionário e a exclua. A ficha **para antes de
falar com a Apple** se citar tela que o app deste commit não tem (`TELAS_CITADAS` em
`ficha.mjs`: rótulo citado → arquivo do app que o mostra; rótulo novo nas notas = uma linha lá).

**O guia PDF** (`revisao/app-review-guide.pdf`, em inglês, os sete itens por extenso e os
prints) sai de `revisao/guia.mjs` por `node publicar/revisao/gerar-guia.mjs` (Playwright +
Chromium + fonte Inter). Mudou o texto, a lista de aparelhos ou os prints? Rode de novo e faça
commit do PDF e do `app-review-guide.entradas.json` (a impressão digital das entradas) — o
`capturas/gerar.sh` já o refaz no fim. Nada que é segredo ou que muda por loja entra no PDF.

**Anexos.** O guia e o vídeo sobem pela rota de anexos da revisão
(`/v1/appStoreReviewAttachments`): reserva → bytes nas partes que a Apple devolve → confirma
com o MD5 → espera o processamento. O reenvio **substitui** o anexo de mesmo nome e nunca
duplica: igual (mesmo MD5) fica; diferente sobe primeiro e só então o antigo sai — se o novo
falhar, a reserva pela metade é apagada e o antigo continua lá. O vídeo sobe sempre como
`screen-recording.mp4` (ou `.mov`) e fica anexado às próximas rodadas DESTA versão; numa versão
nova, passe o link de novo.

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

### Uma vez só: segredos e variáveis do repositório

Settings → Secrets and variables → Actions → **Secrets** → "Novo segredo do repositório"
(nunca em "Segredos do ambiente" nem em Variables). **Só três são exigidos**, e um quarto antes
da revisão:

| Secret | O quê | Quando |
|---|---|---|
| `EXPO_TOKEN` | expo.dev → Account settings → Access tokens (o nome do token lá é livre; o do Secret, não) | compilar, enviar |
| `ASC_KEY_ID` | App Store Connect → Usuários e acesso → Integrações → API → **Chaves da equipe** → coluna "ID da chave". Chave com acesso **Administrador** (Desenvolvedor não mexe na ficha nem envia para revisão) | ficha, enviar, revisão |
| `ASC_KEY_P8` | o arquivo `AuthKey_<ID>.p8` dessa chave, INTEIRO (linhas BEGIN/END) — a Apple só deixa baixar uma vez | ficha, enviar, revisão |
| `APPLE_DEMO_PASSWORD` | a senha da conta demo do revisor: a mesma de `DEMO_ADMIN_SENHA` na Vercel | só a revisão |

**O que não é segredo já está no repositório**, em `publicar/padroes.json`: o Issuer ID da chave,
o time da Apple (Team ID e tipo), nome e e-mail de contato, URL de suporte, copyright, conta
demo e código de barras dela (o EAN da primeira camiseta do seed, `7890000000000`). Nunca ponha
senha, chave ou token nesse arquivo — o teste do `ci.mjs` recusa. Para trocar um valor sem mexer
no código, crie uma **Variable** (ou Secret) de mesmo assunto, que vence o padrão:

| Variable (opcional) | Padrão (`padroes.json`) |
|---|---|
| `ASC_ISSUER_ID` (pode ser Secret) | `issuer_id` |
| `APPLE_TEAM_ID`, `APPLE_TEAM_TYPE` | `apple_team_id`, `apple_team_type` |
| `APPLE_EMAIL_SUPORTE`, `APPLE_URL_SUPORTE`, `APPLE_NOME_CONTATO`, `APPLE_COPYRIGHT` | contato, suporte e copyright |
| `APPLE_EMAIL_DEMO`, `APPLE_CODIGO_DEMO` | conta demo (perfil **dono**) e um código de barras que exista nela |
| `APPLE_SERVIDOR_DEMO` | `https://loja-tria.vercel.app` |
| `APPLE_URL_PRIVACIDADE`, `APPLE_URL_ETIQUETAS_DEMO` | `<servidor demo>/privacidade` e nenhum |
| `APPLE_TELEFONE_CONTATO` | nenhum: só a revisão pede, e só se a Apple ainda não tiver um telefone (de um envio anterior) |

Sem a senha da demo e sem telefone a **ficha sobe** (as notas dizem "(pending)") e o
`--enviar` para dizendo o que falta — sem mexer na Apple. Faltou outra peça? O passo que
precisa dela diz **quais nomes** faltam; os outros seguem. No modo completo, a falta aparece
ANTES de compilar.

**A conta demo do revisor mora no servidor de demonstração DA LOJA** (`APPLE_SERVIDOR_DEMO`):
crie lá um usuário de perfil dono só para a Apple. Esse servidor **fica no ar depois da
revisão**: ele também serve a política de privacidade da ficha (`/privacidade`) — desligá-lo
derrubaria o link da App Store (5.1.1(i)). Para morar noutro endereço permanente, preencha
`APPLE_URL_PRIVACIDADE`. Antes as notas mandavam o revisor para `sistemaobras.com.br`, que hoje
é o site do Sistema Obras — a revisão voltaria.

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
| Notas para o revisor (4000, em inglês) | `ficha/notas-revisao.txt` + `ficha/aparelhos-testados.txt` + o nome do vídeo |
| Anexos da revisão | `revisao/app-review-guide.pdf` e o vídeo de `--video-revisao` |
| Capturas iPhone 6,5" (**obrigatórias**) | `media/app-store/iphone-6.5/NN-nome.png` — 1242×2688, PNG RGB sem alfa, até 10 |
| Capturas iPhone 6,9" (extra) | `media/app-store/iphone-6.9/NN-nome.png` — 1320×2868 (ou 1290×2796, 1260×2736) |
| Classificação etária | `classificacao.mjs`: as 24 perguntas da API 4.6, "Não/Nenhum" → 4+ |
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
declaração vai de novo e fica um aviso. Pergunta que a Apple criou depois da 4.6 (vieram duas
em 16/11/2026) volta em branco: vira pendência com o nome dela e, se a Apple exigir no envio, a
mensagem dela aparece inteira — responda na tela (App Information → Age Rating) e rode de novo;
a rodada seguinte retoma o mesmo envio.

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
- `--video-revisao <arquivo ou https://...>` anexa a gravação de tela (MP4/MOV de verdade, pelo
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
primeira publicação com guia e vídeo anexados e o servidor demo conferido; atualização
(novidades, disponibilidade intocada, capturas e anexos substituídos, `--aguardar-build`); o
build DESTA rodada com um VALID antigo da mesma versão na Apple; recusada → corrige → reenvia
(o mesmo envio `UNRESOLVED_ISSUES`, com o build novo); pedido de informação sem build novo
(reenvio recusado, nada escrito) e com `--mesmo-build` (o mesmo build, vídeo novo no lugar do
antigo); devolvido com um build novo processado (preso sem `--build`); disponibilidade do site
com outros países (`--enviar` recusado, "Brazil only"); Apple que não aceita a marca de "resolvido"; app criado no site em
inglês; rodada sem 6,9" apagando o conjunto velho; preço (pago primeiro, grátis na 2ª página,
sem grátis, lista vazia); `--enviar` recusado sem aparelhos e sem vídeo (nenhuma escrita na
Apple); só a ficha com "(pending)"; servidor demo fora do combinado (não-dono, código, leitor,
exclusão, privacidade, senha, fora do ar); `--conferir-envio`; versão já enviada; falha no upload
do vídeo; falha no 6,9"; pergunta recusada; perguntas novas exigidas no envio; limite de espera
estourado; tela citada que o app não tem; imagem com alfa; senha que a Apple ecoa num erro; app
inexistente; opção inválida. A Apple de mentira **cobra como a de verdade**: toda rota,
parâmetro e corpo é conferido contra o recorte da especificação oficial em
`teste/esquema-asc.mjs` (versão 4.6), um envio ativo por plataforma, e o envio só passa com a
ficha completa — inclusive TODAS as localizações. Saiu especificação nova? Baixe o JSON no site
da Apple e rode `node publicar/teste/gerar-esquema.mjs <arquivo.json>`: o diff mostra o que
mudou, e pergunta de idade nova quebra o teste até ganhar resposta em `classificacao.mjs`.

`revisao.test.mjs` confere as peças da resposta: o vídeo (cabeçalho, tamanho, download que não
deixa nada pela metade), a lista de aparelhos (formato), as telas citadas, as notas (os sete
itens, os dois caminhos da exclusão, até 4000 no pior caso) e que o **guia PDF commitado é o das
entradas de agora**. `ci.test.mjs` confere o preparo do Actions: segredos fora do log, a versão
já enviada dita antes de compilar e os iPhones do perfil de teste.

Os testes rodam no CI, e o `--reais` também, depois de `node publicar/capturas/compor.mjs
--conferir` (as capturas commitadas nos bytes, contra as cenas do gerador). Variáveis que
encurtam as esperas (o teste usa): `PUBLICAR_INTERVALO_BUILD`, `PUBLICAR_INTERVALO_CAPTURAS`
(segundos) e `ASC_REPETIR_MS`; `PUBLICAR_CAPTURAS` aponta para outra pasta de capturas; e, só
no teste, `PUBLICAR_APARELHOS`, `PUBLICAR_TELAS` e `PUBLICAR_DEMO_BASE`.
