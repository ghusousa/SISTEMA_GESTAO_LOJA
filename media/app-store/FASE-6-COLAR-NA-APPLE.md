# Fase 6 — a ficha do App Store Connect

> **Isto virou UM comando (ou um clique).** `mobile/publicar/` faz esta página inteira sozinho
> pela API da Apple — ficha, capturas, classificação, disponibilidade, revisão (notas em inglês e
> os anexos: o guia PDF e a gravação de tela), preço e envio, inclusive o REENVIO depois de uma
> recusa ou de um pedido de informação: caixa **completo** no GitHub Actions, etiqueta
> `ios-v<versão>` ou `npm run publicar -- --enviar --aguardar-build 60`. Leia
> `mobile/publicar/README.md` (lá está também a resposta à Guideline 2.1).
> Esta página fica como referência do que sobe — e das **duas** coisas que nenhum programa faz
> (a API 4.6 da Apple não tem rota para elas): criar o registro do app e a ficha de
> Privacidade do App. Responder na Central de Resolução também não tem API, mas não precisa: o
> reenvio leva as notas e os anexos novos.

## Capturas — dois tamanhos

| Pasta | Slot na Apple | Tamanho | Papel |
|---|---|---|---|
| `media/app-store/iphone-6.5/` | iPhone 6,5" (`APP_IPHONE_65`) | 1242 × 2688 | **obrigatório** — em ago/2026 o formulário só aceitou este |
| `media/app-store/iphone-6.9/` | iPhone 6,7"/6,9" (`APP_IPHONE_67`) | 1320 × 2868 | extra — nítido nos iPhones grandes; faltou ou falhou, a App Store usa o de 6,5" (e o 6,9" velho que estiver na versão é apagado) |

PNG RGB **sem canal alfa** (a Apple recusa transparência), nomes `NN-nome.png` — a ordem do
número é a ordem da vitrine, e as 3 primeiras aparecem na busca. As duas pastas têm os mesmos
nomes, na mesma ordem. Só existe tela de iPhone porque o app declara `supportsTablet: false`: a
Apple não pede iPad. Elas saem das telas do app (o export web do próprio código), com os dados
de demonstração da "Loja Tria" num banco local, mais a arte por cima: `mobile/publicar/capturas/gerar.sh`
refaz todas (ver o README de lá). O cabeçalho e o "Cobrar" em tela cheia são os do navegador: no
iPhone o cabeçalho é o nativo (título centralizado, "‹ Voltar") e o Cobrar é uma folha. A lista abaixo espelha as cenas de lá, e quem manda é a pasta.

| Ordem | Arquivo | Título · subtítulo | O que mostra |
|---|---|---|---|
| 1 | `01-vender.png` | Venda feita em segundos · Bipe a etiqueta ou busque pelo nome | PDV com 4 peças no carrinho, o total e o Cobrar |
| 2 | `02-cobrar.png` | Pix, cartão e fiado · Divida a conta e parcele no crédito | Cobrança dividida: PIX + crédito 3x Visa lançados, o que falta e as 6 formas |
| 3 | `03-financeiro.png` | Seu lucro de verdade · Já descontados custo, despesas e taxas | Resultado do mês e a conta que fecha: faturamento, devoluções, custo, lucro bruto, despesas, taxas e margem |
| 4 | `04-relatorios.png` | Saiba o que mais vende · Vendas por dia e o lucro de cada peça | Vendas por dia (30 dias) e o ranking dos mais vendidos com o lucro |
| 5 | `05-estoque.png` | Estoque por tamanho e cor · O app avisa a hora de repor | As blusas (pela busca): saldo por tamanho e cor, valor em custo e a etiqueta "repor" |
| 6 | `06-produtos.png` | Catálogo na palma da mão · Grade, preço e saldo de cada peça | As calças (pela busca): preço, grade e saldo de cada tamanho, o zerado em vermelho |
| 7 | `07-caixa.png` | Feche o caixa sem planilha · O esperado e o contado, forma por forma | Conferência por forma (a gaveta batendo), o total contado, a diferença e o Fechar caixa |
| 8 | `08-crediario.png` | Fiado sob controle · O que levou, o que pagou e o que falta | Conta da cliente: deve, passou do limite, compras e pagamentos |
| 9 | `09-condicional.png` | Condicional sem caderno · O que voltou para a arara e o que cobrar | Fechamento de condicional: o que voltou, o que ficou, o que cobrar e as formas de pagamento |
| 10 | `10-recibo.png` | Recibo na hora · Mande para a cliente pelo celular | Recibo da venda com as 3 formas de pagamento e o Enviar recibo |

---

## Campo a campo (o que o publicador grava)

| Campo | Valor | Fonte |
|---|---|---|
| Nome | `Gestão de Loja` | `mobile/publicar/ficha/nome.txt` |
| Subtítulo (30) | `PDV, estoque, caixa e fiado` | `ficha/subtitulo.txt` |
| Palavras-chave (100) | `controle,vendas,código,barras,leitor,crediário,condicional,roupas,boutique,varejo,inventário,nfce` | `ficha/palavras-chave.txt` |
| Texto promocional (170) | ver `ficha/texto-promocional.txt` | muda sem nova revisão |
| Descrição (4000) | ver `ficha/descricao.txt` | `docs/LOJAS-DE-APP.md`, seção App Store |
| Novidades (4000) | só a partir da 2ª versão | `ficha/novidades.txt` |
| Categoria | principal **Business**, secundária **Productivity** | fixo |
| URL de privacidade | `https://loja-tria.vercel.app/privacidade` | a página que o próprio sistema serve |
| URL de suporte | a do contato do dono (`APPLE_URL_SUPORTE`) | — |
| Classificação etária | **4+**: "Não/Nenhum" nas 24 perguntas da API 4.6, inclusive as novas (conteúdo gerado por usuário, conversa, rede social, anúncios, verificação de idade, controle parental, caixa de recompensa, saúde, armas) | `mobile/publicar/classificacao.mjs` |
| Direitos de conteúdo | **não usa conteúdo de terceiros** | fixo |
| Disponibilidade | **só Brasil**, sem entrar sozinho em países novos — se a conta ainda não tiver; se tiver, fica como está | fixo |
| Preço | **grátis** | fixo |
| Revisão | login exigido, conta demo e as notas **em inglês** de `ficha/notas-revisao.txt` (com a lista de `ficha/aparelhos-testados.txt`) | config / Secrets |
| Anexos da revisão | o guia `app-review-guide.pdf` (os sete itens da Guideline 2.1, com os prints) e a gravação de tela num iPhone físico | `mobile/publicar/revisao/` e o link `video_revisao_url` |

Kids Category: **não** inscrever (é ferramenta de trabalho). O publicador não mexe na faixa
infantil nem nos ajustes manuais de idade.

---

## O que nenhum programa faz — uma vez só

1. **Registro do app** — appstoreconnect.apple.com → Apps → **+** → Novo app → iOS, nome
   "Gestão de Loja", **Idioma principal "Português (Brasil)"**, bundle `com.gestaoloja.app`,
   SKU `gestao-loja`. (Com outro idioma, o publicador troca para pt-BR e apaga as localizações
   vazias do outro — elas travariam o envio.)
2. **Privacidade do App (App Privacy)** — siga a tabela do item 5 de `docs/LOJAS-DE-APP.md`:
   - "Coletamos dados": **Sim**. Rastreamento (tracking): **NENHUM** — logo, sem ATT.
   - Coletados (todos "Vinculados a você", finalidade única **Funcionalidade do App**):
     Nome · E-mail · Telefone · Outras informações financeiras · Histórico de compras ·
     Fotos ou vídeos · Outro conteúdo do usuário · ID do usuário · Interação com o produto ·
     Outros dados.
   - Todo o resto: **Não coletado** (em especial: sem localização, sem contatos da agenda,
     sem ID do dispositivo, sem diagnóstico de terceiros).

## O que o dono fornece (no GitHub, uma vez — não no site da Apple)

As variáveis e segredos da tabela de `mobile/publicar/README.md`: a chave da API da Apple, o
contato, e a **conta de demonstração** — um usuário de perfil **dono** criado no servidor de
demonstração (`loja-tria.vercel.app`) só para a Apple, mais um **código de barras que exista**
nele (é o caminho "Digitar código", que salva a revisão feita sem câmera). Antes de enviar, o
publicador confere tudo isso no próprio servidor (no ar, login de dono, código, privacidade,
leitor e exclusão de conta). O servidor de demonstração **fica no ar depois da revisão**: ele
serve a política de privacidade da ficha. O `privacidade@sistemaobras.com.br` citado na
política de privacidade precisa existir.

Para a revisão sair, também: a lista de iPhones físicos testados em
`mobile/publicar/ficha/aparelhos-testados.txt` e a gravação de tela (link no
`video_revisao_url` do botão) — sem elas, só a ficha sobe.

Depois de uma revisão aprovada, versão nova = subir `"version"` no `mobile/app.json`,
reescrever `ficha/novidades.txt` e rodar de novo.
