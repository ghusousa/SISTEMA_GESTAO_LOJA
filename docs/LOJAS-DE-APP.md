# Textos para as fichas das lojas

Prontos para colar no Play Console e no App Store Connect.
Gerados junto com a política de privacidade — se um mudar, confira os outros.

As páginas legais são servidas pela própria API, em cada servidor da loja (`<servidor>/privacidade`
e `<servidor>/exclusao-de-dados`). As fichas das lojas usam as do servidor de demonstração, que
fica no ar depois da revisão justamente por isso (outro endereço permanente: `APPLE_URL_PRIVACIDADE`
e `APPLE_URL_SUPORTE`). Hoje, as da Vercel:

- `https://loja-tria.vercel.app/privacidade` (na App Store, também a URL de suporte)
- `https://loja-tria.vercel.app/exclusao-de-dados`

**Trocar de servidor** (da Vercel para a demonstração que sobe com a loja, `https://<domínio>/demo`,
ADR-46): na App Store, a privacidade e a URL de suporte seguem `APPLE_SERVIDOR_DEMO` sozinhas, na
próxima rodada da ficha (`mobile/publicar/README.md`). O Google Play não passa pelo publicador:
**antes de desligar o servidor antigo**, troque no Play Console a URL da política de privacidade
e a de exclusão de dados por `<servidor novo>/privacidade` e `<servidor novo>/exclusao-de-dados`
— desligado antes, a ficha de lá fica apontando para páginas fora do ar.

(`sistemaobras.com.br` é o site do Sistema Obras, outro sistema: não cole esses endereços dele.)

## Exclusão de conta — o caminho que as duas lojas pedem (ADR-45)

A Apple (5.1.1(v)) exige que quem tem conta consiga **iniciar a exclusão da própria conta dentro
do app** — desativar não vale, "peça ao administrador" também não. O Google pede o mesmo, mais uma
URL pública. Os caminhos, com os rótulos exatos que a pessoa vê (as notas da revisão citam assim):

- **Qualquer pessoa, a própria conta:** `Mais > Minha conta > Excluir minha conta` (no
  computador, `Minha conta`). A tela diz o que some e o que fica, pede a senha e confirma ("Excluir
  a sua conta?" → "Excluir conta"). Deu certo, o app volta à entrada com "Conta excluída". Senha
  errada não derruba a sessão: a tela só pede de novo.
- **O dono, a conta de alguém da equipe:** `Mais > Usuários > (pessoa) > Excluir conta`, com
  confirmação. O gerente faz o mesmo com quem não é dono. Para um afastamento, existe o
  `Desativar`, que se desfaz.
- **O único dono não se exclui:** a tela responde "Você é o único dono da loja. Passe o papel de
  dono a outra pessoa em Usuários antes de excluir a sua conta." — e o caminho existe no app:
  `Mais > Usuários > (pessoa) > Mudar papel`. Na demonstração, a conta de revisão é **protegida**
  no servidor (não se exclui, não perde o papel nem troca de senha: o revisor seguinte precisa
  entrar com ela) — o revisor testa a exclusão numa conta de funcionário criada por ele
  (`Mais > Usuários > +`): entra com ela e usa `Mais > Minha conta > Excluir minha conta`, ou a
  exclui pela conta de dono em `Mais > Usuários > (pessoa) > Excluir conta`.
- **Sem acesso ao app** (saiu da loja, perdeu a senha): a página pública
  `<servidor>/exclusao-de-dados` explica o pedido por e-mail — é a URL do formulário do Google.

O que some: e-mail, senha, sessões em todos os aparelhos, o celular ligado como leitor e o e-mail
no diário (vira máscara). O que fica: as vendas, devoluções, caixas e o diário que a pessoa fez,
com o nome de quem fez — são a contabilidade da loja. Quem já vendeu também consegue excluir: a
conta sai do mesmo jeito e só o nome fica preso às vendas.

---

## Google Play

# Ficha do Google Play — "Gestão de Loja"

Textos prontos para colar. Contagem de caracteres entre parênteses (contando espaços e acentos, como o Play conta).

---

## 1. NOME DO APP (máx. 30)

**Recomendado:**

```
Gestão de Loja
```

**(14 caracteres)** — igual ao `name` de `mobile/app.json`, então o nome na loja, no ícone e na splash batem.

**Alternativa com palavra-chave** (o Play indexa o título; "estoque" e "PDV" são o que a dona da loja digita na busca):

```
Gestão de Loja: Estoque e PDV
```

**(29 caracteres)**

---

## 2. DESCRIÇÃO CURTA (máx. 80)

**Recomendada:**

```
Estoque, PDV, devolução, fiado e caixa. Exige o servidor da própria loja.
```

**(73 caracteres)** — diz o que é e já avisa do servidor, que é o que evita a nota 1 estrela.

**Opção B:**

```
Estoque por código de barras, PDV, fiado e caixa no servidor da sua loja.
```

**(73 caracteres)**

**Opção C:**

```
App de balcão do sistema da loja: estoque, PDV, fiado, caixa e relatórios.
```

**(74 caracteres)**

---

## 3. DESCRIÇÃO COMPLETA (máx. 4000)

**(2951 caracteres)**

```
Gestão de Loja é o aplicativo de balcão de um sistema de gestão para lojas de roupas. No celular, a equipe faz o que faria no computador do balcão: bipar o código de barras, vender, registrar devolução, controlar o fiado, lançar despesa, fechar o caixa e ver os relatórios — sempre com o dado que está no servidor da própria loja.

IMPORTANTE: ESTE APP NÃO FUNCIONA SOZINHO
Ele é somente o aplicativo cliente. Para usar, a sua loja precisa ter o servidor do sistema instalado e no ar (numa máquina da loja ou num servidor na internet), e você precisa de uma conta criada pelo dono ou pelo gerente dentro do sistema.
Não existe cadastro pelo aplicativo, não há teste embutido e não existe um servidor nosso guardando os seus dados. Sem servidor e sem conta, o app abre apenas na tela de configuração. Se você procura um aplicativo pronto para sair usando na hora, este não é ele.

COMO CONECTAR
Na primeira abertura você digita o endereço do servidor da sua loja. O endereço fica guardado no aparelho, não dentro do instalador: o mesmo aplicativo serve a várias lojas, e mudar o servidor de endereço não obriga ninguém a reinstalar nada.

O QUE O APP FAZ
• PDV: a câmera do celular vira leitor de código de barras; busca da peça por nome, cor ou código; desconto; mais de uma forma de pagamento na mesma venda.
• Estoque: entrada de mercadoria, saldo por variante (tamanho e cor), foto da peça e histórico de movimentação.
• Devolução e vale: o valor volta pelas formas em que entrou; o que não couber vira vale de crédito para a cliente.
• Crediário (fiado): cadastro das clientes da loja, saldo devedor, pagamentos e abatimentos.
• Despesas: lançamento do que sai do caixa, por categoria.
• Fechamento de caixa: conferência da gaveta por forma de pagamento, com a diferença apurada na hora.
• Relatórios: venda do dia e do período, por vendedora, por forma de pagamento, resultado do mês.
• Equipe e papéis: dono, gerente, supervisora e vendedora veem coisas diferentes — custo, lucro e despesa só aparecem para quem tem permissão.
• Auditoria: cada alteração fica registrada com autor, data e hora. Só o dono lê.
• Tempo real: vendeu no balcão, a tela do celular se atualiza sozinha.

POR QUE O APP PEDE CADA PERMISSÃO
• Câmera: ler o código de barras da etiqueta e fotografar a peça no cadastro.
• Fotos: escolher na galeria a imagem de uma peça.
Nenhuma imagem é enviada a terceiros: a foto vai para o servidor da sua loja e para mais lugar nenhum.

PRIVACIDADE
Sem anúncios, sem analytics, sem rastreamento, sem venda e sem compartilhamento de dados com terceiros. Tudo o que o app registra fica no servidor da sua loja. Pela LGPD, a loja que hospeda o servidor é a CONTROLADORA dos dados; o fornecedor do software atua como OPERADOR, e apenas quando presta suporte.
Dúvidas sobre dados pessoais: privacidade@sistemaobras.com.br

REQUISITOS
Android 7.0 ou superior; conexão com o servidor da loja (rede local ou internet); conta criada pela loja.
```

---

## 4. SEGURANÇA DOS DADOS (Data safety)

### 4.1 Perguntas gerais

| Pergunta do formulário | Resposta |
|---|---|
| Seu app coleta ou compartilha algum dos tipos de dados exigidos? | **Sim** (o app transmite dados do aparelho para o servidor da loja — para o Google isso é "coleta", mesmo o servidor sendo da própria loja) |
| Todos os dados coletados são criptografados em trânsito? | **Sim** — porém só depois do ajuste descrito em 4.4. Hoje a resposta honesta seria "não". **Leia antes de marcar.** |
| Você oferece uma forma de o usuário pedir a exclusão dos dados? | **Sim — "os usuários podem solicitar a exclusão dos dados"** |
| O app permite criar conta? | **Sim** — não há autocadastro, mas o dono/gerente cria as contas da equipe dentro do app (Mais › Usuários). A exclusão existe no app (Mais › Minha conta › Excluir minha conta; o dono em Mais › Usuários › Excluir conta) e fora dele: a URL de exclusão é `<servidor>/exclusao-de-dados` (ADR-45) |
| O app tem anúncios? | **Não** |
| Passou por revisão de segurança independente? | **Não** (opcional; não marque) |

### 4.2 Dados COLETADOS (todos: compartilhados = **NÃO**; processados de forma efêmera = **NÃO**)

"Compartilhado" no Play significa transferir a terceiros. Os dados vão só para o servidor da própria loja, que é o backend do app — por isso **nada é declarado como compartilhado**. Não há SDK de terceiros no app (verificado: sem analytics, sem crash reporting, sem publicidade).

| # | Categoria › Tipo | Obrigatório/Opcional | Finalidade a marcar | O que é, na prática |
|---|---|---|---|---|
| 1 | Informações pessoais › **Nome** | Obrigatório | Funcionalidade do app; Gerenciamento de conta | Nome do funcionário; nome da cliente do fiado, digitado pela loja |
| 2 | Informações pessoais › **Endereço de e-mail** | Obrigatório | Funcionalidade do app; Gerenciamento de conta | Login do funcionário |
| 3 | Informações pessoais › **Número de telefone** | Opcional | Funcionalidade do app | Telefone da cliente do crediário (campo opcional) |
| 4 | Informações pessoais › **IDs do usuário** | Obrigatório | Funcionalidade do app; Gerenciamento de conta | ID interno do funcionário e da cliente |
| 5 | Informações pessoais › **Outras informações** | Opcional | Funcionalidade do app | CPF/CNPJ da cliente do crediário (campo opcional) |
| 6 | Informações financeiras › **Histórico de compras** | Obrigatório | Funcionalidade do app | Vendas, itens, devoluções e vales registrados pela loja |
| 7 | Informações financeiras › **Outras informações financeiras** | Obrigatório | Funcionalidade do app | Pagamentos (só forma e valor), despesas, saldo do fiado, fechamento de caixa. **Não há número de cartão em lugar nenhum** — o modelo guarda apenas forma de pagamento e valor |
| 8 | Fotos e vídeos › **Fotos** | Opcional | Funcionalidade do app | Foto da peça, tirada pela câmera ou escolhida da galeria |
| 9 | Atividade no app › **Interações no app** | Obrigatório | Funcionalidade do app; **Prevenção de fraudes, segurança e conformidade** | `audit_log`: quem mudou o quê e quando, mais tentativas de login |
| 10 | IDs do dispositivo ou outros › **IDs do dispositivo ou outros** | Obrigatório | **Prevenção de fraudes, segurança e conformidade** | **Endereço IP**, gravado em `audit_log` e em `login_attempts` (anti-força-bruta). O formulário não tem um tipo "endereço IP"; como o IP fica **armazenado** (não é efêmero), ele precisa ser declarado, e esta é a caixa mais próxima |

Nenhum dos itens acima deve ser marcado para "Publicidade ou marketing", "Personalização" nem "Análise" — nada disso existe no app.

### 4.3 Dados NÃO coletados (deixe todas as caixas vazias)

Localização (aproximada ou precisa) · Contatos · Agenda · Mensagens (SMS/e-mail do aparelho) · Áudio e gravações · Arquivos e documentos · Histórico de navegação · Apps instalados · Saúde e atividade física · Informações de pagamento do usuário (cartão) · Orientação sexual, religião, etnia, dados biométricos · **Registros de falhas (crash logs)** · **Diagnósticos/desempenho** · Anúncios e IDs de publicidade.

O microfone está explicitamente desligado nos plugins de câmera e de galeria (`microphonePermission: false`) — a câmera só lê código de barras e tira foto de peça.

### 4.4 O ponto que precisa de decisão antes de enviar o formulário

Declaração falsa aqui suspende o app, então este item não pode passar batido:

O app **não obriga HTTPS hoje**. Em `mobile/src/api/servidor.ts`, `normalizarEndereco()` completa com `http://` quando a pessoa digita só o IP, e `mobile/app.json` liga `usesCleartextTraffic: true` (mais `NSAllowsLocalNetworking` no iOS). Ou seja: quando a loja aponta o app para um IP da rede local, o tráfego **não é criptografado** — e aí "todos os dados são criptografados em trânsito" seria mentira.

Dois caminhos honestos:

- **A (recomendado):** exigir HTTPS antes de publicar — `normalizarEndereco()` passa a assumir `https://`, remova `usesCleartextTraffic` (ou restrinja o texto claro a IPs privados por Network Security Config) e trate `http://` como endereço inválido. Feito isso, **marque "Sim"** com tranquilidade, já que `https://sistemaobras.com.br` tem certificado válido.
- **B:** manter como está e **marcar "Não"**. O Play passa a exibir "Os dados não são criptografados" na ficha — péssimo cartão de visita para um app que mexe com dinheiro e CPF.

### 4.5 Texto para a página de exclusão de dados (a URL vai no formulário)

```
Como pedir a exclusão dos seus dados

As contas de funcionário e os cadastros de clientes deste aplicativo ficam no servidor
da loja que usa o sistema — é a loja que decide o que guardar e por quanto tempo
(controladora dos dados, na LGPD). O fornecedor do software não hospeda esses dados.

Para excluir a sua conta: no aplicativo, toque em Mais > Minha conta > Excluir minha
conta, confirme com a sua senha, e pronto (no computador, Minha conta). O dono ou o
gerente da loja também excluem a conta de alguém da equipe em Mais > Usuários > Excluir
conta. Sem acesso ao aplicativo, escreva para privacidade@sistemaobras.com.br e
encaminhamos o pedido ao responsável pela loja. Cadastros de clientes do crediário são
excluídos pela própria loja.

Registros de auditoria e de tentativas de login são mantidos como exigência legal e de
segurança e podem ser preservados mesmo após a exclusão dos demais dados.
```

---

## 5. CLASSIFICAÇÃO DE CONTEÚDO (questionário IARC)

Categoria do app no questionário: **"Utilitários, Produtividade, Comunicação ou Outros"** (não é jogo).

| Seção | Pergunta | Resposta |
|---|---|---|
| Violência | Qualquer violência, realista ou desenhada | **Não** para todas |
| Sexualidade | Nudez, conteúdo sexual, insinuação | **Não** para todas |
| Linguagem | Palavrão, linguagem obscena | **Não** |
| Substâncias controladas | Drogas, álcool, tabaco | **Não** |
| Terror / humor grosseiro | Medo, sangue, humor escatológico | **Não** |
| Jogos de azar | Aposta real ou simulada | **Não** |
| Interação entre usuários | O app permite que usuários interajam ou troquem conteúdo entre si | **Não** — não há chat, comentário, fórum nem conteúdo público. Funcionários da mesma loja veem os registros do negócio, o que não é interação social |
| Compartilhamento de localização | O app compartilha a localização do usuário com outros usuários | **Não** — o app não usa localização |
| Informações pessoais | O app permite que o usuário compartilhe informações pessoais com terceiros | **Não** |
| Compras digitais | Compra de bens digitais dentro do app | **Não** |
| Anúncios | Exibe anúncios | **Não** |
| Navegador / busca aberta | É navegador ou buscador | **Não** |

Resultado esperado: **Livre (L)** no ClassInd/Brasil, **3+** PEGI, **Everyone** ESRB.

Ainda na aba "Conteúdo do app", duas declarações vizinhas que derrubam envio se saírem erradas:

- **Público-alvo:** faixas **18+** (ou 18+ e 16–17); **não é destinado a crianças** — não entra no Programa para Famílias.
- **Recursos financeiros:** marque **"Meu app não oferece nenhum recurso financeiro"**. O crediário é o registro de uma dívida que a loja concedeu no balcão; o app não empresta dinheiro, não processa pagamento e não é carteira. Se essa pergunta for respondida como "empréstimo pessoal", cai na política de apps de crédito e trava a publicação.

---

## 6. CATEGORIA E ETIQUETAS

- **Tipo:** Apps (não é jogo)
- **Categoria:** **Negócios**
  Alternativas defensáveis: *Produtividade* (menos aderente) e *Finanças* (evite — puxa exigências de apps financeiros).
- **Etiquetas** (o Play só aceita as da lista fixa da categoria, até 5 — escolha as que existirem no seu console, nesta ordem de preferência):
  1. Ponto de venda / PDV
  2. Gestão de estoque ou inventário
  3. Ferramentas para pequenas empresas
  4. Vendas
  5. Faturamento e cobrança / Contas a receber
- **E-mail de contato:** `privacidade@sistemaobras.com.br` (o mesmo pode servir de suporte, ou crie `suporte@`)
- **Política de privacidade (URL obrigatória):** publique em endereço público, ex. `https://sistemaobras.com.br/privacidade`, e a página de exclusão em `https://sistemaobras.com.br/privacidade/exclusao`

---

## Pendências antes de enviar

1. **HTTPS obrigatório** — item 4.4. É o único ponto em que a ficha, do jeito que o app está hoje, seria imprecisa. Arquivos: `/home/user/SISTEMA_GESTAO_LOJA/mobile/src/api/servidor.ts` (função `normalizarEndereco`, que hoje faz `texto = \`http://${texto}\``) e `/home/user/SISTEMA_GESTAO_LOJA/mobile/app.json` (`expo-build-properties` → `usesCleartextTraffic: true`).
2. **Android mínimo** — a descrição diz "Android 7.0 ou superior", que é o `minSdkVersion 24` do Expo SDK 54 / RN 0.81. Confirme no `build.gradle` gerado pelo prebuild e ajuste o texto se o EAS subir esse piso.
3. **E-mail `privacidade@sistemaobras.com.br`** — confirmar com o dono que a caixa existe e é lida; o Play envia verificação para o e-mail de contato.
4. **Nome de exibição** — se optar por "Gestão de Loja: Estoque e PDV" na ficha, mantenha `name: "Gestão de Loja"` no `app.json` (é o nome sob o ícone) para não ficar um nome comprido no launcher.

---

## App Store

**Quem preenche é o publicador** (`mobile/publicar/`, ADR-44): os textos abaixo são cópia de `mobile/publicar/ficha/` — mudou lá, mude aqui (e vice-versa). Conferidos contra o código do app (telas de `mobile/src/app/`, `components/`, `lib/`) e o grafo do projeto: cada função citada existe no app de hoje; o "leitor do computador" é o ADR-43 e a exclusão de conta, o ADR-45. O publicador **para antes de falar com a Apple** se um texto citar tela que o app daquele commit não tem (`TELAS_CITADAS` em `mobile/publicar/ficha.mjs`). Servidor de demonstração do revisor: o da LOJA — hoje `https://loja-tria.vercel.app` (Vercel, ADR-42); com a loja instalada numa VPS, a demonstração que sobe com ela em `https://<domínio>/demo` (ADR-46, `./demo.sh --mostrar` imprime o que levar) — `GET /api/v1/configuracao` responde com o nome da loja; antes de enviar, o publicador confere lá o `/health`, o login da conta demo (dono), o código de barras, a privacidade, o leitor e a exclusão de conta. O `sistemaobras.com.br` hoje é o site do Sistema Obras: notas que mandem o revisor para lá derrubam a revisão. No publicador, o endereço é o campo `url_servidor_demo` (no GitHub Actions, a variável `APPLE_SERVIDOR_DEMO`).

Limites contados como a Apple conta: caractere, não byte (`[...texto].length`). Nada de citar outra plataforma ou loja (diretriz 2.3.10) — o publicador recusa o texto antes de enviar.

**Resposta à Guideline 2.1 (nov/2026).** A 1ª submissão voltou com "Information Needed": gravação de tela num iPhone físico, aparelhos testados, propósito e público, como acessar, serviços externos, regiões, setor regulado. As notas (§6) passaram a ser em **inglês**, com os sete itens; o guia `mobile/publicar/revisao/app-review-guide.pdf` os traz por extenso, com os prints, e sobe como anexo da revisão junto com o vídeo; a lista de aparelhos mora em `mobile/publicar/ficha/aparelhos-testados.txt`. O publicador reenvia o MESMO envio devolvido (`UNRESOLVED_ISSUES`) — passo a passo e roteiro da gravação em `mobile/publicar/README.md`.

---

# Ficha da App Store — Gestão de Loja (pt-BR)

## 1. NOME, SUBTÍTULO e TEXTO PROMOCIONAL

**NOME — 14 caracteres** (limite 30; idêntico ao `expo.name` do `app.json`, o nome sob o ícone)
```
Gestão de Loja
```

**SUBTÍTULO — 27 caracteres** (limite 30)
```
PDV, estoque, caixa e fiado
```
> "Fiado" é como o balcão chama o crediário — e é o que a dona digita na busca. "Loja" já está no nome: repetir no subtítulo gastaria caractere sem ganhar busca.

**TEXTO PROMOCIONAL — 154 caracteres** (limite 170)
```
Novo: o celular vira o leitor de código de barras do computador do balcão. E segue tudo na mão: venda bipando, fiado, condicional, estoque, caixa e lucro.
```
> Aparece acima da descrição e muda **sem nova revisão** — é o lugar da novidade do momento.

---

## 2. PALAVRAS-CHAVE — 97 caracteres (limite 100)

```
controle,vendas,código,barras,leitor,crediário,condicional,roupas,boutique,varejo,inventário,nfce
```

> Sem espaço após as vírgulas e sem repetir palavra do nome ou do subtítulo (a Apple já indexa os dois: gestão, loja, pdv, estoque, caixa, fiado). A Apple junta palavras de campos diferentes: "controle" aqui + "estoque" no subtítulo casa com "controle de estoque". A Apple normaliza acentos, então "credito"/"crédito" caem na mesma busca.

---

## 3. DESCRIÇÃO — 3.791 caracteres com os marcadores (limite 4.000)

`{{EMAIL_SUPORTE}}` e `{{URL_PRIVACIDADE}}` o publicador troca pelo e-mail de suporte e pela política de privacidade do servidor de demonstração.

```
IMPORTANTE — LEIA ANTES DE BAIXAR

Este é o aplicativo de um sistema de gestão que roda em um SERVIDOR PRÓPRIO DA LOJA. Sem esse servidor instalado, e sem um login criado por quem administra a loja, o app não funciona: não existe cadastro nem conta de teste dentro do app. Se a sua loja ainda não tem o sistema, fale com quem cuida dele antes de baixar.

O QUE O APP FAZ

Do balcão ao resultado do mês, na palma da mão:

• Vender bipando — a câmera lê o código de barras e a peça entra no carrinho com preço e saldo. Sem etiqueta? Ache pelo nome, com ou sem acento, ou digite o código.
• Cobrar do jeito que a cliente paga — dinheiro, PIX, débito, crédito parcelado com bandeira, vale-troca e fiado, divididos na mesma venda, com desconto e troco calculado. A taxa da maquininha fica anotada em cada venda, e o relatório mostra quanto o cartão ainda vai depositar, e quando.
• Crediário (fiado) — quem deve, quanto deve, e receber em um toque.
• Devolução e troca — o valor volta pelas mesmas formas em que entrou; o que não couber vira vale-troca.
• Condicional — a cliente leva peças para provar em casa; o que ela ficar vira venda, e o resto volta ao estoque.
• Estoque por tamanho e cor — cada peça com o seu saldo, cada movimento no extrato e o aviso de hora de repor.
• Entrada de mercadoria — fornecedor e custo de cada compra; a nota do fornecedor vira contas a pagar, com o que vence na semana em destaque.
• Inventário — conte a prateleira e acerte só o que divergiu.
• Caixa do dia — o esperado por forma de pagamento contra o que foi contado na gaveta.
• Despesas e resultado — faturamento, custo da mercadoria vendida, lucro, margem e o resultado do mês.
• Relatórios — mais vendidos, curva ABC, vendas e comissão de cada vendedora (com a meta do dia no PDV de cada uma), estoque parado e quanto vale o estoque.
• Clientes — histórico de compras e os aniversariantes do mês.
• NFC-e — com o emissor fiscal contratado pela loja ligado ao sistema, a nota do consumidor sai da própria venda.
• Recibo — vai pelo compartilhamento do iPhone (WhatsApp, e-mail).

CELULAR E COMPUTADOR JUNTOS

• Tudo se atualiza na hora entre os aparelhos da loja: vendeu no balcão, o estoque do celular já mostra.
• O celular vira o leitor de código de barras do computador: no navegador, o botão "Celular como leitor" mostra um QR; no app, Mais > Leitor do computador > "Ler o QR do computador". Cada etiqueta bipada entra na venda aberta lá.
• No computador, o mesmo sistema abre no navegador, com leitor USB e teclado.

CADA UM VÊ O QUE É DO SEU CARGO

Dono, gerente, supervisora e vendedora. A vendedora vende e consulta preço, mas não recebe custo, lucro nem despesa — quem recusa é o servidor, não a tela. A auditoria, que guarda o que cada login fez, é só do dono.

Não há cadastro aberto: o dono cria as contas da equipe em Mais > Usuários. Cada pessoa exclui a própria conta no app, em Mais > Minha conta > Excluir minha conta; o dono exclui a de alguém da equipe em Mais > Usuários > (pessoa) > Excluir conta.

SERVE A MAIS DE UM RAMO

Roupas, calçados, autopeças, informática, cosméticos, alimentos e material de construção. O sistema troca as palavras conforme o ramo: onde a loja de roupas lê "Tamanho e Cor", a de autopeças lê "Aplicação e Posição".

OS DADOS FICAM NA SUA LOJA

Sem anúncios, sem rastreamento, sem analytics, sem venda de dados. As informações ficam no servidor da própria loja: quem publica o app fornece o software, e a loja é a controladora dos dados (LGPD). A câmera serve só para ler códigos e fotografar a peça.

O QUE VOCÊ PRECISA TER

• Um servidor com o sistema instalado e alcançável pelo celular.
• Um login criado pelo dono ou pelo gerente da loja.
• Internet, ou a rede local da loja.

Suporte: {{EMAIL_SUPORTE}}
Política de privacidade: {{URL_PRIVACIDADE}}
```

---

## 4. NOVIDADES DESTA VERSÃO — 252 caracteres (limite 4.000)

**Só a partir da 2ª versão**: na primeira a Apple recusa o campo, e o publicador não manda. Reescreva `ficha/novidades.txt` a cada versão nova.

```
Nesta versão: correções e ajustes nas telas de venda, estoque e financeiro.

Lembrete: o app conversa com o servidor da sua própria loja. As funções novas do sistema chegam quando o servidor também é atualizado — quem cuida do sistema da loja faz isso.
```

---

## 5. FICHA DE PRIVACIDADE (App Privacy) — o único formulário SEM API

> A API 4.6 da Apple não tem rota para esta ficha: é a única parte que nenhum programa preenche (a outra coisa fora do alcance da API é criar o registro do app). Responda UMA vez na tela com a tabela abaixo; depois ela vale para as próximas versões. O publicador lembra disso no resumo de toda rodada e, se a Apple recusar o envio por causa dela, mostra a mensagem.

**Resposta global: "Sim, coletamos dados deste app."**
**Dados usados para rastrear você: NENHUM.** Nenhum tipo de dado responde "Sim" a rastreamento — não há SDK de terceiros, IDFA, publicidade nem *data broker*. Logo, sem prompt de ATT.
Finalidade única em todos os itens coletados: **Funcionalidade do App**. Nunca Analytics, Personalização, Publicidade do Desenvolvedor ou de Terceiros.

### Coletados — todos VINCULADOS à identidade, todos SEM rastreamento

| Tipo de dado (Apple) | Coletado | Vinculado | Rastreio | O que é, no app |
|---|---|---|---|---|
| Contato › **Nome** | Sim | Sim | Não | Nome do funcionário; nome do cliente do crediário (digitado pela loja) |
| Contato › **E-mail** | Sim | Sim | Não | Login do funcionário |
| Contato › **Telefone** | Sim | Sim | Não | Telefone do cliente do crediário (opcional) |
| Financeiro › **Outras informações financeiras** | Sim | Sim | Não | Valores de venda, desconto, dívida do fiado, despesas da loja |
| Compras › **Histórico de compras** | Sim | Sim | Não | Itens e valores das vendas; ficam ligados ao cliente quando a venda é no fiado |
| Conteúdo › **Fotos ou vídeos** | Sim | Sim | Não | Foto da peça, tirada ou escolhida pelo usuário |
| Conteúdo › **Outro conteúdo do usuário** | Sim | Sim | Não | Nome/descrição de produto, observações de entrada e de despesa |
| Identificadores › **ID do usuário** | Sim | Sim | Não | Conta do funcionário e sessão |
| Uso › **Interação com o produto** | Sim | Sim | Não | `audit_log`: cada mutação registra quem, o quê e quando. É prestação de contas da equipe, não métrica de produto |
| **Outros dados** | Sim | Sim | Não | CPF/CNPJ do cliente do crediário (opcional) e endereço IP gravado na auditoria e no anti-força-bruta |

### Não coletados — responda "Não" e por quê

| Tipo | Por quê |
|---|---|
| Contato › Endereço físico, Outras info. de contato | Não existem campos para isso |
| Saúde e preparo físico | Não se aplica |
| Financeiro › **Informações de pagamento**, Informações de crédito | O app nunca vê número de cartão nem conta bancária. Ele grava só o rótulo da forma ("Débito") e o valor — a maquininha é externa. *(Se o revisor de privacidade questionar, o rótulo alternativo defensável é Payment Info, porque a definição da Apple cita "form of payment"; a nossa leitura é que sem instrumento de pagamento o item correto é Outras informações financeiras.)* |
| Localização precisa / aproximada | Sem GPS, sem permissão de localização, sem `expo-location`. O IP é declarado em Outros dados e **não** é convertido em localização |
| Informações sensíveis | Nada nas categorias sensíveis da Apple |
| **Contatos (agenda)** | O app nunca pede acesso à agenda; telefone do cliente é digitado à mão |
| Conteúdo › E-mails ou mensagens, Áudio, Conteúdo de jogo, Suporte ao cliente | O recibo sai pela folha de compartilhamento do iOS; o app não envia nem guarda a mensagem |
| Histórico de navegação | Não há navegador nem WebView |
| **Histórico de pesquisa** | A busca por nome é atendida em tempo real e não é armazenada — cabe na exceção "somente para atender a solicitação" |
| Identificadores › ID do dispositivo | Sem IDFA/IDFV e sem SDK de anúncio |
| Uso › Dados de publicidade, Outros dados de uso | Não existem |
| Diagnóstico › Falhas, Desempenho, Outros | Sem crash reporting de terceiros. Relatórios do próprio sistema da Apple não entram na ficha |

### Nota metodológica (leia antes de preencher)

A Apple define "coletar" como transmitir dados para fora do aparelho de modo que **você ou seus parceiros** possam acessá-los. Na instalação típica o servidor é da loja e o fornecedor do software não tem acesso — o que sustentaria marcar "Dados não coletados". **Recomendo mesmo assim declarar tudo acima como coletado**, por dois fatos concretos: (a) o servidor de demonstração (`loja-tria.vercel.app`) é operado por quem publica o app, e ali há dados de teste; (b) o fornecedor atua como **operador** durante o suporte, com acesso potencial ao servidor da loja. Declarar a mais é honesto e não custa nada na revisão; declarar a menos e ser contestado custa uma rejeição por rótulo de privacidade inconsistente.

Dois campos obrigatórios que precisam bater com esta ficha: **URL da Política de Privacidade** (deve dizer, com todas as letras, que a LOJA é a controladora e o fornecedor é o operador) e **URL de Suporte**.

---

## 6. NOTAS PARA A REVISÃO (App Review Notes) — 3.585 caracteres com os marcadores (limite 4.000)

**Em inglês** (o revisor lê inglês), com os rótulos das telas entre aspas em português, como aparecem no app, e os sete itens que a Apple pediu na Guideline 2.1. O publicador troca `{{SERVIDOR_DEMO}}`, `{{EMAIL_DEMO}}`, `{{SENHA_DEMO}}`, `{{CODIGO_DEMO}}` e `{{EMAIL_SUPORTE}}` pelos valores do config/Secrets; `{{APARELHOS_TESTADOS}}` e `{{APARELHO_DO_VIDEO}}` pela lista de `mobile/publicar/ficha/aparelhos-testados.txt` (a 1ª linha é o aparelho da gravação); `{{VIDEO}}` pelo nome do vídeo anexado; e `{{LINHA_ETIQUETAS}}` pela frase da folha de etiquetas (ou some, sem `url_etiquetas_demo`). Sem lista ou sem vídeo, os marcadores viram "(pending)": a ficha sobe, mas o `--enviar` é recusado. Com endereços, e-mails e sete aparelhos de nomes longos o texto chega perto dos 4.000 — o publicador confere depois da troca e para, dizendo o tamanho, se passar (o teste mede o pior caso).

Os serviços externos (item 5) são o que o código faz: dado e login só do servidor da loja (a demonstração é uma loja como outra, sem provedor a citar: a da Vercel, com Neon e Vercel Blob, ou a que sobe com a loja em `<domínio>/demo`, ADR-46 — as notas não nomeiam nenhum); NFC-e opcional pela Focus NFe, desligada na demonstração; nada de pagamento, IA, login de terceiros, analytics ou anúncio. A única outra chamada é a da biblioteca de rede do React Native (NetInfo), que, no iPhone, testa a conexão com um pedido vazio ao `generate_204` do Google — sem dado nenhum; as notas dizem isso para não afirmar "nenhum outro servidor".

```
B2B APP FOR SHOP STAFF; IT NEEDS THE SHOP'S SERVER. Answers to Guideline 2.1 below; the attached "app-review-guide.pdf" has them in full, with screenshots.

DEMO SERVER (stays online after the review; it also serves our privacy policy)
Server: {{SERVIDOR_DEMO}}
E-mail: {{EMAIL_DEMO}}
Password: {{SENHA_DEMO}}
Barcode to type: {{CODIGO_DEMO}}
Shop OWNER account: every screen is visible. Fictitious data only, isolated from any real shop: sell, cancel, return freely.

1) SCREEN RECORDING: attachment {{VIDEO}}, made on a physical {{APARELHO_DO_VIDEO}}. From app launch: server setup, sign-in, camera permission, a sale, creating a staff account, deleting accounts.

2) TESTED ON (physical devices): {{APARELHOS_TESTADOS}}. Minimum iOS 15.1; iPhone only, portrait.

3) PURPOSE: point of sale and stock control for small physical shops in Brazil (clothing, shoes, auto parts), used by the owner and staff at the counter. It replaces notebooks and spreadsheets: barcode sales, cash/PIX/card/store credit, returns, consignment, stock by size and color, cash count, expenses, profit, reports. Not a consumer app.

4) SET UP AND ACCESS
1. On the sign-in screen tap the GEAR (top right): "Conectar à loja" opens.
2. In "Endereço do servidor" type the server above exactly as written (with https://), and tap "Conectar".
3. Enter e-mail and password, tap "Entrar": the "Vender" tab (point of sale) opens.
4. Add an item: "Ler código de barras" (camera), "Digitar código" (type the barcode above) or "Buscar" (part of a name, e.g. "cami").
{{LINHA_ETIQUETAS}}
5. Tap "Cobrar", "Dinheiro", then "Confirmar venda". The completed sale opens; tap "Recibo para a cliente" to see the receipt.
More in the "Produtos", "Estoque", "Financeiro" and "Mais" tabs.
Phone as the computer's barcode reader: in a computer browser, sign in at the server address and click "Celular como leitor" (left bar) for a QR code; in the app: Mais > Leitor do computador > "Ler o QR do computador".

ACCOUNTS: no sign-up. The owner creates staff accounts in Mais > Usuários > "+" (bottom right).
ACCOUNT DELETION (5.1.1(v)), inside the app:
- Any user, own account: Mais > Minha conta > Excluir minha conta. It asks for the password, lists what is deleted and confirms; the sign-in screen then shows "Conta excluída".
- Owner, a staff account: Mais > Usuários > (pessoa) > Excluir conta ("pessoa" is the person's card).
The demo account is protected (can't be deleted) for the next reviewer: please create a staff account and delete it either way.

5) EXTERNAL SERVICES: data and sign-in come only from the shop's own server (FastAPI + PostgreSQL, installed by the shop). NFC-e (Brazilian e-receipt) is optional, via an accredited issuer (Focus NFe); off in the demo. No payments in the app (the card terminal is separate; the app only records the method), no AI, no third-party sign-in, no analytics or ad SDKs. The network library only checks connectivity (empty request to Google's generate_204).

6) REGIONS: Brazil only, in Portuguese (Brazil); the same everywhere.

7) REGULATION: not a regulated industry; no third-party protected content. The optional NFC-e is issued by the accredited issuer with the shop's own digital certificate.

USER CONTENT: item names, photos and notes stay private to one shop's team. No publishing, feed or messaging between users, so nothing to report or block.
PERMISSIONS: camera (barcode reader, item photo), photos (pick an item photo), local network (only when the server is on the shop's network).
IN-APP PURCHASES: none; goods are paid at the counter.
Contact: {{EMAIL_SUPORTE}}
```

---

## 7. CLASSIFICAÇÃO ETÁRIA — 4+ (o publicador responde todas)

A API 4.6 tem 24 perguntas na declaração de idade (`AgeRatingDeclaration`); o publicador responde **todas** (`mobile/publicar/classificacao.mjs`) — "Nenhum" nas de frequência e "Não" nas de sim/não:

- **Frequência → Nenhum:** violência (de desenho, realista, prolongada), conteúdo sexual e nudez, horror/medo, temas maduros, palavrão/humor grosseiro, álcool/tabaco/drogas, jogo de azar simulado, concursos, informação médica, **armas** (pergunta nova). O app mostra estoque, preço e relatório.
- **Sim/não → Não:** jogo de azar com dinheiro, **acesso irrestrito à web** (não há `WebView` nem navegador: o app só fala com a API da loja), e as perguntas novas: **conteúdo gerado por usuário** (fotos e textos ficam no servidor de UMA loja, só a equipe dela vê — sem feed, comentários nem descoberta de perfis; não se aplica a moderação da 1.2), **mensagens e conversa** (não há conversa entre usuários), **rede social** e rede social com restrição de idade, **anúncios** (sem publicidade nem SDK de anúncio), **verificação de idade**, **controle parental**, **caixa de recompensa** (sem compra no app) e **saúde e bem-estar**.

Ficam como o dono deixar (não são perguntas): a faixa da **Kids Category** (não inscreva: é ferramenta de trabalho, e a categoria infantil traria regras de publicidade e coleta que não fazem sentido aqui), os ajustes manuais de idade, o número da GRAC coreana e a página opcional sobre a classificação. Categoria certa na loja: **Business** (secundária: Productivity).

Se a Apple recusar uma pergunta (saiu da API), o publicador tira só ela, envia de novo e avisa. Se a Apple criar perguntas novas (vieram duas em 16/11/2026, ainda fora da 4.6), elas voltam em branco: o publicador lista os nomes como pendência e, se o envio for recusado por causa delas, mostra a mensagem da Apple — responda na tela (App Information → Age Rating) e rode de novo; o envio que ficou aberto é retomado.

Mais duas respostas que o publicador grava fora da declaração: **direitos de conteúdo** = não usa conteúdo de terceiros; **disponibilidade** = só Brasil, sem entrar sozinho em países novos (app em pt-BR, com PIX e NFC-e) — só se a conta ainda não tiver disponibilidade; se tiver, fica como está.

---

## 8. CAPTURAS — 10 por tamanho, tiradas das telas do app

O publicador sobe o que estiver nas duas pastas, na ordem do nome (as 3 primeiras aparecem na busca). PNG RGB sem canal alfa, os mesmos nomes nas duas. Saem do export web do próprio app: o conteúdo de cada tela é o do iPhone, mas o cabeçalho (seta "←", título à esquerda) e o "Cobrar" em tela cheia são os do navegador — no iPhone, o cabeçalho nativo ("‹ Voltar", título centralizado) e o Cobrar como folha. Fotos com o cabeçalho nativo, só de um aparelho ou simulador.

| Pasta | Slot na Apple | Tamanho | Papel |
|---|---|---|---|
| `media/app-store/iphone-6.5/` | iPhone 6,5" (`APP_IPHONE_65`) | 1242 × 2688 | obrigatório |
| `media/app-store/iphone-6.9/` | iPhone 6,7"/6,9" (`APP_IPHONE_67`) | 1320 × 2868 | extra |

| # | Arquivo | Título · subtítulo da arte |
|---|---|---|
| 1 | `01-vender.png` | Venda feita em segundos · Bipe a etiqueta ou busque pelo nome |
| 2 | `02-cobrar.png` | Pix, cartão e fiado · Divida a conta e parcele no crédito |
| 3 | `03-financeiro.png` | Seu lucro de verdade · Já descontados custo, despesas e taxas |
| 4 | `04-relatorios.png` | Saiba o que mais vende · Vendas por dia e o lucro de cada peça |
| 5 | `05-estoque.png` | Estoque por tamanho e cor · O app avisa a hora de repor |
| 6 | `06-produtos.png` | Catálogo na palma da mão · Grade, preço e saldo de cada peça |
| 7 | `07-caixa.png` | Feche o caixa sem planilha · O esperado e o contado, forma por forma |
| 8 | `08-crediario.png` | Fiado sob controle · O que levou, o que pagou e o que falta |
| 9 | `09-condicional.png` | Condicional sem caderno · O que voltou para a arara e o que cobrar |
| 10 | `10-recibo.png` | Recibo na hora · Mande para a cliente pelo celular |

Quem faz as imagens é `mobile/publicar/capturas/gerar.sh`: o app rodando com os dados de exemplo da "Loja Tria" num banco local, fotografado numa tela de iPhone, com a arte por cima (`mobile/publicar/capturas/README.md`). Mudou uma tela, roda de novo. O que cada uma mostra está em `media/app-store/FASE-6-COLAR-NA-APPLE.md`; título, subtítulo e ordem moram em `mobile/publicar/capturas/cenas.mjs` — mudou lá, mude as duas tabelas.

---

## Antes de enviar — o que ainda falta, e onde

O `--enviar` do publicador (caixa "revisao" no GitHub) confere tudo o que é conferível e, faltando algo, para ANTES de mexer na Apple, com uma pendência por item.

- **Registro do app** (uma vez, no site, com Idioma principal "Português (Brasil)") e **Privacidade do App** (uma vez, na tela, §5): as duas coisas sem API.
- **Gravação de tela** num iPhone FÍSICO, iOS mais novo, desde a abertura do app (roteiro em `mobile/publicar/README.md`): anexo da revisão pela API (`/v1/appStoreReviewAttachments`) — `--video-revisao <arquivo ou https://...>`, no GitHub a entrada `video_revisao_url`. Sem ela (nem já anexada à versão), a revisão não sai.
- **Aparelhos testados**: `mobile/publicar/ficha/aparelhos-testados.txt`, uma linha por iPhone em que o teste rodou de verdade (`iPhone 17 — iOS 26.1`; a 1ª é a da gravação). Vazia, a revisão não sai. Mudou? Refaça o guia PDF (`node publicar/revisao/gerar-guia.mjs`) e faça commit.
- **Telas citadas** — leitor do computador (ADR-43) e exclusão de conta (ADR-45): a descrição e as notas citam "Mais > Leitor do computador" e "Mais > Minha conta > Excluir minha conta". O publicador recusa a ficha de um commit cujo app não tenha essas telas, e confere no servidor de demonstração as rotas das duas — publique com o servidor na mesma versão.
- `{{EMAIL_DEMO}}`, `{{SENHA_DEMO}}`: conta de perfil **dono** no servidor de demonstração (a Apple exige conta de demonstração sempre que o login não é público) — variável `APPLE_EMAIL_DEMO` e segredo `APPLE_DEMO_PASSWORD`. O publicador entra com ela antes de enviar e recusa se não for dona.
- `{{CODIGO_DEMO}}`: um código de barras que exista no banco de demonstração (`APPLE_CODIGO_DEMO`) — é o caminho sem câmera. O publicador o procura lá antes de enviar.
- `{{URL_ETIQUETAS_DEMO}}` (opcional): página com códigos de barras de exemplo para bipar da tela; sem ela, a frase some e "Digitar código" e "Buscar" bastam.
- `{{EMAIL_SUPORTE}}`: o e-mail de suporte (`APPLE_EMAIL_SUPORTE`). O `privacidade@sistemaobras.com.br` da política de privacidade precisa existir e ser lido.
- **Servidor de demonstração no ar depois da revisão**: ele serve a política de privacidade da ficha (`<servidor>/privacidade`), que sem `APPLE_URL_SUPORTE` é também a URL de suporte. Desligá-lo derrubaria os links da App Store (5.1.1(i) e 1.5) e os do Play Console; outro endereço permanente vai em `APPLE_URL_PRIVACIDADE` e `APPLE_URL_SUPORTE`.
- Resposta na Central de Resolução: opcional (não tem API, e o reenvio já leva notas e anexos novos). Texto pronto, em inglês: `mobile/publicar/revisao/resposta-ao-app-review.txt`.

## Um achado do código que afeta a revisão

`mobile/src/api/servidor.ts` → `normalizarEndereco()` prefixa **`http://`** quando a pessoa digita só o host (`if (!/^https?:\/\//i.test(texto)) texto = \`http://${texto}\``). Em iOS, o ATS bloqueia cleartext para domínio público — `NSAllowsLocalNetworking` só libera rede local —, então um revisor que digitasse `loja-tria.vercel.app` sem o esquema levaria "Não foi possível alcançar esse endereço" e provavelmente uma rejeição. Um servidor na internet costuma responder **308 → https** ao `http://`, o que salva o Android (cleartext liberado no build) mas não o iPhone, porque o bloqueio acontece antes do redirecionamento. Por isso o passo 2 das notas manda digitar `https://` explicitamente. Vale corrigir no app: quando o host não for IP nem nome local, prefixar `https://` — e, se falhar, só então tentar `http://`.
