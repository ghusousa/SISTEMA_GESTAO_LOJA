# Textos para as fichas das lojas

Prontos para colar no Play Console e no App Store Connect.
Gerados junto com a política de privacidade — se um mudar, confira os outros.

As páginas legais são servidas pela própria API:

- `https://sistemaobras.com.br/privacidade`
- `https://sistemaobras.com.br/exclusao-de-dados`

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
| O app permite criar conta? | **Não** (contas são criadas pelo dono/gerente dentro do sistema — logo não se aplica a exigência de URL de exclusão de conta; ainda assim, publique a página de solicitação) |
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

Para excluir: peça ao dono ou ao gerente da sua loja, que faz a exclusão dentro do
próprio sistema (equipe, clientes e cadastros). Se preferir, escreva para
privacidade@sistemaobras.com.br e encaminhamos o pedido ao responsável pela loja.

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

Textos verificados contra o código do app (`mobile/src/app/(auth)/login.tsx`, `servidor.ts`, PDV e tela de pagamento) — rótulos, posição da engrenagem e passos conferem com a UI real. Servidor de demonstração do revisor: o da LOJA, `https://loja-tria.vercel.app` (Vercel, ADR-42) — `GET /api/v1/configuracao` responde com o nome da loja. O `sistemaobras.com.br` hoje é o site do Sistema Obras: notas que mandem o revisor para lá derrubam a revisão. No publicador, o endereço é o campo `url_servidor_demo` (no GitHub Actions, a variável `APPLE_SERVIDOR_DEMO`).

---

# Ficha da App Store — Gestão de Loja (pt-BR)

## 1. NOME e SUBTÍTULO

**NOME (recomendado) — 14 caracteres**
```
Gestão de Loja
```

**NOME (alternativo, mais buscável) — 29 caracteres**
```
Gestão de Loja: PDV e Estoque
```
> Use o alternativo só se quiser o reforço de ASO. O recomendado é idêntico ao `expo.name` do `app.json`, o que evita divergência entre a ficha e o ícone na tela do aparelho.

**SUBTÍTULO (recomendado) — 28 caracteres**
```
PDV, estoque e caixa da loja
```

**SUBTÍTULO (alternativo) — 30 caracteres**
```
Venda bipando. Estoque na mão.
```

---

## 2. PALAVRAS-CHAVE — 100 caracteres (no limite exato)

```
código,barras,leitor,varejo,fiado,crediário,vendas,despesas,inventário,lucro,balcão,confecção,roupas
```

> Sem espaços após as vírgulas e sem repetir nenhuma palavra que já esteja no nome ou no subtítulo (a Apple já indexa os dois). A Apple normaliza acentos, então "credito"/"crédito" caem na mesma busca. Se preferir o genérico ao específico, troque `balcão` por `comércio` e remova `roupas` (fica 96).

---

## 3. DESCRIÇÃO — 2.828 caracteres (limite 4.000)

```
IMPORTANTE — LEIA ANTES DE BAIXAR

Este é o aplicativo de um sistema de gestão que roda em um SERVIDOR PRÓPRIO DA LOJA. Sem esse servidor instalado, e sem um login criado por quem administra a loja, o app não funciona: não existe cadastro nem conta de teste dentro do app. Se a sua loja ainda não tem o sistema instalado, fale com quem cuida dele antes de baixar.

O QUE O APP FAZ

Gestão de loja de balcão, do estoque ao resultado do mês, na palma da mão:

• Vender bipando — a câmera lê o código de barras da etiqueta e a peça entra no carrinho com preço e saldo. Etiqueta rasgada? Ache pelo nome ou digite o código.
• Pagamento misto — dinheiro, PIX, débito, crédito, vale de troca e fiado na mesma venda, com desconto e troco.
• Estoque de verdade — cada tamanho e cor tem o seu saldo. Entrada, ajuste, venda e devolução viram movimentação: o saldo nunca é editado à mão e nunca fica negativo.
• Entrada de mercadoria e inventário — registrar o que chegou e conferir o que existe na prateleira.
• Devolução com regra — o valor volta pelas mesmas formas em que entrou; o que não couber vira vale de troca. Peça com defeito não volta ao estoque.
• Crediário (fiado) — quem está devendo, quanto deve, e receber em um toque.
• Despesas e relatórios — faturamento, custo da mercadoria vendida, lucro, despesas e resultado do período, mais vendidos e peças abaixo do estoque mínimo.
• Fechamento de caixa — o esperado por forma de pagamento contra o que foi contado na gaveta.
• Recibo para a cliente — sai pelo compartilhamento do iPhone (WhatsApp, e-mail). Não é documento fiscal.

CADA UM VÊ O QUE É DO SEU CARGO

Vendedora, supervisora, gerente e dono. A vendedora vende e consulta preço, mas não recebe custo, lucro nem despesa — quem recusa é o servidor, não a tela. O diário de auditoria, que guarda o que cada login fez, é só do dono.

SERVE A MAIS DE UM RAMO

Roupas, calçados, autopeças, informática, cosméticos, alimentos e material de construção. O sistema troca as palavras conforme o ramo: onde a loja de roupas lê "Tamanho e Cor", a autopeças lê "Aplicação e Posição".

TAMBÉM NO COMPUTADOR DO BALCÃO

O mesmo sistema abre no navegador, com leitor USB e teclado. Celular e computador enxergam os mesmos dados, na mesma hora.

OS DADOS FICAM NA SUA LOJA

Sem anúncios, sem rastreamento, sem analytics, sem venda de dados. As informações ficam no servidor da própria loja: quem publica o app fornece o software, e a loja é a controladora dos dados (LGPD). A câmera serve só para ler código de barras e fotografar a peça. A sessão fica guardada no cofre do sistema.

O QUE VOCÊ PRECISA TER

• Um servidor com o sistema instalado e alcançável pelo celular.
• Um login criado pelo dono ou pelo gerente da loja.
• Internet, ou a rede local da loja.

Suporte: {{EMAIL_SUPORTE}}
Privacidade: privacidade@sistemaobras.com.br
```

---

## 4. NOVIDADES DESTA VERSÃO — 480 caracteres (limite 4.000)

```
Primeira versão.

Todo o sistema da loja no celular: vender bipando o código de barras, pagamento misto (dinheiro, PIX, débito, crédito, vale e fiado), estoque por tamanho e cor, entrada de mercadoria, inventário, devolução com vale de troca, crediário, despesas, relatórios, fechamento de caixa e diário de auditoria — cada cargo enxergando só o que é dele.

Lembrando: o app conversa com o servidor da sua própria loja. O endereço é configurado na engrenagem da tela de entrada.
```

---

## 5. FICHA DE PRIVACIDADE (App Privacy)

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

A Apple define "coletar" como transmitir dados para fora do aparelho de modo que **você ou seus parceiros** possam acessá-los. Na instalação típica o servidor é da loja e o fornecedor do software não tem acesso — o que sustentaria marcar "Dados não coletados". **Recomendo mesmo assim declarar tudo acima como coletado**, por dois fatos concretos: (a) o servidor de demonstração de `sistemaobras.com.br` é operado por quem publica o app, e ali há dados reais de teste; (b) o fornecedor atua como **operador** durante o suporte, com acesso potencial ao servidor da loja. Declarar a mais é honesto e não custa nada na revisão; declarar a menos e ser contestado custa uma rejeição por rótulo de privacidade inconsistente.

Dois campos obrigatórios que precisam bater com esta ficha: **URL da Política de Privacidade** (deve dizer, com todas as letras, que a LOJA é a controladora e o fornecedor é o operador) e **URL de Suporte**.

---

## 6. NOTAS PARA A REVISÃO (App Review Notes) — 3.952 caracteres (limite 4.000)

```
APP DE USO PROFISSIONAL (B2B) QUE EXIGE UM SERVIDOR — POR FAVOR, LEIA ANTES DE TESTAR

1) O QUE É
Gestão para lojas de balcão (varejo físico): estoque por código de barras, PDV, devolução, crediário, despesas, relatórios, caixa e auditoria. Não é app de consumidor final e não vende nada dentro do app.

2) POR QUE EXIGE SERVIDOR
O sistema é auto-hospedado: cada loja instala o servidor e é dona dos próprios dados; o app é só o cliente. Por isso o endereço do servidor é DIGITADO NO APARELHO — um mesmo app serve várias lojas. Não existe autocadastro: as contas dos funcionários são criadas pelo dono ou pelo gerente dentro do sistema.

3) SERVIDOR DE DEMONSTRAÇÃO PARA A REVISÃO
Mantemos um servidor completo, com dados de exemplo, exclusivamente para esta revisão:
  Endereço: https://sistemaobras.com.br   (HTTPS válido)
  E-mail:   {{EMAIL_DEMO}}
  Senha:    {{SENHA_DEMO}}
A conta é de perfil "dono", então todas as abas ficam visíveis. O banco é de teste: podem vender, cancelar e devolver à vontade.

4) PASSO A PASSO PARA TESTAR (5 minutos)
1. Abra o app. Aparece a tela de entrada.
2. Toque na ENGRENAGEM no canto superior direito. Abre "Conectar à loja".
3. No campo "Endereço do servidor", digite exatamente, com o https://:
     https://sistemaobras.com.br
4. Toque em "Conectar". O app testa o endereço e volta para a tela de entrada.
5. Informe {{EMAIL_DEMO}} e {{SENHA_DEMO}} e toque em "Entrar".
6. Abre a aba "Vender" (o PDV), com o carrinho vazio.
7. Para colocar uma peça no carrinho, use QUALQUER um dos três caminhos:
   a) "Ler código de barras" — liga a câmera (o iOS pedirá permissão). Aponte para um código de barras. Se não tiver uma etiqueta à mão, abra {{URL_ETIQUETAS_DEMO}} em outra tela/monitor: é uma folha de códigos de exemplo, feita para ser bipada.
   b) "Digitar código" — digite {{CODIGO_DEMO}} e confirme. Não precisa de câmera.
   c) "Buscar" — digite parte do nome da peça (ex.: "cami") e escolha na lista.
8. A peça entra no carrinho com preço e quantidade. Repita se quiser.
9. Toque em "Cobrar".
10. Toque na forma de pagamento "Dinheiro" (isso quita o valor inteiro; digitando um valor no teclado antes, o pagamento vira parcial e dá para dividir entre formas).
11. Toque em "Confirmar venda". Aparece o recibo, e o estoque baixa na hora.
O resto está nas abas "Estoque" (entrada, inventário), "Financeiro" (caixa, despesas, relatórios) e "Mais" (devolução, crediário, usuários, auditoria).

5) PONTOS QUE COSTUMAM GERAR DÚVIDA
• Nada é comprado dentro do app. As vendas registradas são de mercadoria física, paga presencialmente no balcão (dinheiro, PIX, maquininha). O app só ANOTA forma e valor: não processa pagamento, não guarda número de cartão e não vende bem digital (3.1.1).
• O recibo enviado pelo compartilhamento do iPhone é um comprovante da loja, não documento fiscal, e está escrito no rodapé dele.
• Sem criação de conta no app: não havendo autocadastro, a exclusão (5.1.1(v)) é feita pelo administrador da loja em "Mais > Usuários" — e o dono pode apagar o servidor inteiro, que é dele.
• Sem conteúdo público e sem contato entre usuários: fotos e textos ficam no servidor de uma única loja, visíveis só para os funcionários dela. Não há feed, comentários, mensagens nem descoberta de usuários.
• Câmera: só para ler código de barras e fotografar a peça no cadastro. Galeria: só para escolher a imagem do produto. Nada vai para terceiros.
• ATS: o app declara NSAllowsLocalNetworking porque muitas lojas rodam o servidor na própria rede, em IP local, sem certificado. Servidores na internet, como o da demonstração, usam HTTPS normalmente. O iOS pode pedir permissão de Rede Local nesse cenário.
• Sem analytics, sem SDK de rastreamento, sem publicidade e sem IDFA — por isso não há prompt de ATT.

6) CONTATO DURANTE A REVISÃO
{{EMAIL_SUPORTE}} — respondemos no mesmo dia útil. Se o servidor de demonstração não responder, avise por aqui antes de rejeitar: ele é nosso e religamos rápido.
```

---

## 7. CLASSIFICAÇÃO ETÁRIA

**Sugestão: 4+ (Livre).** No questionário, marque **"Nenhum"/"Não"** em tudo:

- Violência (real ou de desenho), conteúdo sexual, nudez, horror, temas maduros, palavrão, álcool/tabaco/drogas, jogos de azar simulados ou com dinheiro real, concursos, informação médica/tratamento: **nada disso existe** — o app mostra estoque, preço e relatório.
- **Acesso irrestrito à web: Não.** Verificado no código: não há `WebView` nem `Linking.openURL`; o app só fala com a API da loja.
- **Conteúdo gerado por usuário: Não.** Fotos e textos ficam no servidor de uma única loja e só os funcionários dela enxergam. Não há feed público, comentários, mensagens entre usuários nem descoberta de perfis — logo não se aplicam as exigências de moderação, bloqueio e denúncia da diretriz 1.2. (Vale repetir essa frase nas notas da revisão, como está no item 5.)
- **Compras e apostas: Não.** Sem compra no app, sem moeda virtual.
- **Localização: Não.** Sem GPS.

Dois cuidados no preenchimento: **não** inscreva o app na **Kids Category** (é ferramenta de trabalho, e a categoria infantil traria regras de publicidade e de coleta que não fazem sentido aqui); e, na pergunta sobre público-alvo do novo fluxo de classificação, marque que o app **não é destinado a crianças**. A categoria certa na loja é **Business** (secundária sugerida: Productivity).

---

## Antes de enviar — o que ainda falta preencher

- `{{EMAIL_DEMO}}`, `{{SENHA_DEMO}}`: conta de perfil **dono** no servidor de demonstração (a Apple exige conta de demonstração sempre que o login não é público).
- `{{CODIGO_DEMO}}`: um código de barras que exista no banco de demonstração — é o caminho sem câmera, e é o que salva a revisão feita em simulador.
- `{{URL_ETIQUETAS_DEMO}}`: página com códigos de barras de exemplo para bipar da tela. Se não quiser publicá-la, remova a frase; os caminhos (b) e (c) já bastam.
- `{{EMAIL_SUPORTE}}`: o e-mail de suporte (o `privacidade@` da descrição ainda está "a confirmar pelo dono", conforme você indicou).
- Vídeo de demonstração (opcional, mas ajuda muito quando o app depende de servidor): um screencast de 40 s do passo a passo, anexado como App Review Attachment.

## Um achado do código que afeta a revisão

`mobile/src/api/servidor.ts` → `normalizarEndereco()` prefixa **`http://`** quando a pessoa digita só o host (`if (!/^https?:\/\//i.test(texto)) texto = \`http://${texto}\``). Em iOS, o ATS bloqueia cleartext para domínio público — `NSAllowsLocalNetworking` só libera rede local —, então um revisor que digitasse `sistemaobras.com.br` sem o esquema levaria "Não foi possível alcançar esse endereço" e provavelmente uma rejeição. Confirmei que `http://sistemaobras.com.br/health` responde **308 → https**, o que salva o Android (cleartext liberado no build) mas não o iPhone, porque o bloqueio acontece antes do redirecionamento. Por isso o passo 3 das notas manda digitar `https://` explicitamente. Vale corrigir no app: quando o host não for IP nem nome local, prefixar `https://` — e, se falhar, só então tentar `http://`.
