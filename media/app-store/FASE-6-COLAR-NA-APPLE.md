# Fase 6 — tudo para colar no App Store Connect

> **Atalho: isso aqui virou UM comando.** `mobile/publicar/` faz esta página inteira
> sozinho — ficha, capturas, revisão, preço e envio (`npm run publicar -- --enviar`).
> Leia `mobile/publicar/README.md`. Este documento continua valendo como referência
> e para preencher a ficha de Privacidade, que a Apple obriga a ser manual.

As capturas estão em `media/app-store/iphone-6.5/` (1242 × 2688, o slot obrigatório de
iPhone 6,5") e, as mesmas, em `media/app-store/iphone-6.9/` (1320 × 2868, o slot de
6,7"/6,9"). Suba **na ordem dos números** — as 3 primeiras aparecem na busca da App Store.
Só existe tela de iPhone porque o app declara `supportsTablet: false`: a Apple não pede iPad.
Elas saem do app de verdade, com os dados de exemplo: `mobile/publicar/capturas/gerar.sh`
refaz todas (ver o README de lá).

| Ordem | Arquivo | Título · subtítulo | O que mostra |
|---|---|---|---|
| 1 | `01-vender.png` | Venda feita em segundos · Bipe a etiqueta ou busque pelo nome | PDV com 4 peças no carrinho, o total e o Cobrar |
| 2 | `02-cobrar.png` | Pix, cartão e fiado · Divida a conta e parcele no crédito | Cobrança dividida: PIX + crédito 3x Visa lançados, o que falta e as 6 formas |
| 3 | `03-financeiro.png` | Seu lucro de verdade · Já descontados custo, despesas e taxas | Resultado do mês, faturamento, custo, lucro bruto, despesas, taxas e margem |
| 4 | `04-relatorios.png` | Saiba o que mais vende · Vendas por dia e o lucro de cada peça | Vendas por dia (30 dias) e o ranking dos mais vendidos com o lucro |
| 5 | `05-estoque.png` | Estoque por tamanho e cor · O app avisa a hora de repor | Saldo por tamanho e cor, valor em custo e a etiqueta "repor" |
| 6 | `06-produtos.png` | Catálogo na palma da mão · Grade, preço e saldo de cada peça | Catálogo com preço, grade e saldo de cada tamanho |
| 7 | `07-caixa.png` | Feche o caixa sem planilha · O esperado e o contado, forma por forma | Conferência por forma, a diferença na gaveta e o Fechar caixa |
| 8 | `08-crediario.png` | Fiado sob controle · O que levou, o que pagou e o que falta | Conta da cliente: deve, passou do limite, compras e pagamentos |
| 9 | `09-condicional.png` | Condicional sem caderno · O que voltou para a arara e o que cobrar | Fechamento de condicional: o que voltou, o que ficou e o pagamento |
| 10 | `10-recibo.png` | Recibo na hora · Mande para a cliente pelo celular | Recibo da venda com as 3 formas de pagamento e o Enviar recibo |

---

## Campo a campo

**Nome** (aba Informações do App)
```
Gestão de Loja
```

**Subtítulo**
```
PDV, estoque e caixa da loja
```

**Categoria**: principal **Business** · secundária **Productivity**

**Palavras-chave** (100 caracteres exatos, sem espaço depois das vírgulas)
```
código,barras,leitor,varejo,fiado,crediário,vendas,despesas,inventário,lucro,balcão,confecção,roupas
```

**URL de Privacidade**
```
https://loja-tria.vercel.app/privacidade
```
(a página que o próprio sistema serve em `/privacidade` — troque pelo endereço do seu
servidor de demonstração, se for outro)

**URL de Suporte** → o site ou e-mail público que você quiser dar (obrigatório; pode ser
o próprio servidor de demonstração, `https://loja-tria.vercel.app`).

**Descrição** e **Novidades desta versão** → copie de `docs/LOJAS-DE-APP.md`, seção
"App Store", itens 3 e 4 (já contados: 2.828 e 480 caracteres). Antes de colar, troque
`{{EMAIL_SUPORTE}}` pelo seu e-mail real.

**Classificação etária** → responda **Não/Nenhum em tudo** (sem violência, sem compras,
sem web aberta, sem conteúdo de usuário público). Resultado: **4+**. Não inscreva na
Kids Category.

**Privacidade do App (App Privacy)** → siga a tabela do item 5 de `docs/LOJAS-DE-APP.md`:
- "Coletamos dados": **Sim**. Rastreamento (tracking): **NENHUM** — logo, sem ATT.
- Coletados (todos "Vinculados a você", finalidade única **Funcionalidade do App**):
  Nome · E-mail · Telefone · Outras informações financeiras · Histórico de compras ·
  Fotos ou vídeos · Outro conteúdo do usuário · ID do usuário · Interação com o produto ·
  Outros dados.
- Todo o resto: **Não coletado** (em especial: sem localização, sem contatos da agenda,
  sem ID do dispositivo, sem diagnóstico de terceiros).

**Informações de Revisão (App Review)** →
- Marque **"É necessário fazer login"** e preencha a conta de demonstração (abaixo).
- No campo de notas, cole o item 6 de `docs/LOJAS-DE-APP.md` ("Notas para a revisão") —
  é o passo a passo que ensina o revisor a conectar no servidor de demonstração DA LOJA
  (`https://loja-tria.vercel.app`; o `sistemaobras.com.br` hoje é o site de outro sistema)
  e a vender sem precisar de câmera.

---

## O que SÓ VOCÊ pode preencher (4 coisas)

1. **Conta de demonstração**: crie no servidor de demonstração (`loja-tria.vercel.app`) um usuário de perfil
   **dono** só para a Apple (ex.: `revisao@sualoja.com`) e ponha e-mail e senha no campo
   de conta de demonstração e nas notas (onde está `{{EMAIL_DEMO}}` / `{{SENHA_DEMO}}`).
2. **Um código de barras que exista** nesse servidor de demonstração — entra nas notas no
   lugar de `{{CODIGO_DEMO}}` (é o caminho "Digitar código", que salva a revisão feita
   sem câmera).
3. **E-mail de suporte** no lugar de `{{EMAIL_SUPORTE}}` (descrição e notas).
4. **Confirmar** que `privacidade@sistemaobras.com.br` existe (está na descrição e na
   política de privacidade).

Com isso preenchido: selecione o build (Fase 5), **Salvar** e **Enviar para revisão**.
