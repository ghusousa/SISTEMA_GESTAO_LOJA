# Fase 6 — a ficha do App Store Connect

> **Isto virou UM comando (ou um clique).** `mobile/publicar/` faz esta página inteira sozinho
> pela API da Apple — ficha, capturas, classificação, disponibilidade, revisão, preço e envio:
> caixa **completo** no GitHub Actions, etiqueta `ios-v<versão>` ou
> `npm run publicar -- --enviar --aguardar-build 60`. Leia `mobile/publicar/README.md`.
> Esta página fica como referência do que sobe — e das **duas** coisas que nenhum programa faz
> (a API 4.6 da Apple não tem rota para elas): criar o registro do app e a ficha de
> Privacidade do App.

## Capturas — dois tamanhos

| Pasta | Slot na Apple | Tamanho | Papel |
|---|---|---|---|
| `media/app-store/iphone-6.5/` | iPhone 6,5" (`APP_IPHONE_65`) | 1242 × 2688 | **obrigatório** — em ago/2026 o formulário só aceitou este |
| `media/app-store/iphone-6.9/` | iPhone 6,7"/6,9" (`APP_IPHONE_67`) | 1320 × 2868 | extra — nítido nos iPhones grandes; faltou ou falhou, a App Store usa o de 6,5" |

PNG RGB **sem canal alfa** (a Apple recusa transparência), nomes `NN-nome.png` — a ordem do
número é a ordem da vitrine, e as 3 primeiras aparecem na busca. As duas pastas têm os mesmos
nomes, na mesma ordem. Só existe tela de iPhone porque o app declara `supportsTablet: false`: a
Apple não pede iPad. As imagens são geradas por `mobile/publicar/capturas/` (o app rodando com os
dados de demonstração da "Loja Tria" num banco local, mais a arte por cima); a lista abaixo
espelha as cenas de lá, e quem manda é a pasta.

| Ordem | Arquivo | O que mostra |
|---|---|---|
| 1 | `01-vender.png` | Venda feita em segundos — bipe a etiqueta ou busque pelo nome |
| 2 | `02-cobrar.png` | PIX, cartão e fiado — divida a conta e parcele no crédito |
| 3 | `03-financeiro.png` | O lucro de verdade — já descontados custo, despesas e taxas |
| 4 | `04-relatorios.png` | O que mais vende — vendas por dia e o lucro de cada peça |
| 5 | `05-estoque.png` | Estoque por tamanho e cor — o app avisa a hora de repor |
| 6 | `06-produtos.png` | Catálogo na palma da mão — grade, preço e saldo de cada peça |
| 7 | `07-caixa.png` | Fechar o caixa sem planilha — o esperado e o contado, forma por forma |
| 8 | `08-crediario.png` | Fiado sob controle — quem deve, quanto e quem passou do limite |
| 9 | `09-condicional.png` | Condicional sem caderno — o que voltou para a arara e o que cobrar |
| 10 | `10-recibo.png` | Recibo na hora — mande para a cliente pelo celular |

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
| Revisão | login exigido, conta demo e as notas de `ficha/notas-revisao.txt` | config / Secrets |

Kids Category: **não** inscrever (é ferramenta de trabalho). O publicador não mexe na faixa
infantil nem nos ajustes manuais de idade.

---

## O que nenhum programa faz — uma vez só

1. **Registro do app** — appstoreconnect.apple.com → Apps → **+** → Novo app → iOS, nome
   "Gestão de Loja", bundle `com.gestaoloja.app`, SKU `gestao-loja`.
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
nele (é o caminho "Digitar código", que salva a revisão feita sem câmera). O
`privacidade@sistemaobras.com.br` citado na política de privacidade precisa existir.

Depois de uma revisão aprovada, versão nova = subir `"version"` no `mobile/app.json`,
reescrever `ficha/novidades.txt` e rodar de novo.
