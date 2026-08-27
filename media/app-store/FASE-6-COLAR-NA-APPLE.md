# Fase 6 — tudo para colar no App Store Connect

As capturas estão em `media/app-store/iphone-6.7/` (1290 × 2796, o tamanho exato do
iPhone 6,7"). Suba **na ordem dos números** — as 3 primeiras aparecem na busca da App Store.
Só existe tela de iPhone porque o app declara `supportsTablet: false`: a Apple não pede iPad.

| Ordem | Arquivo | O que mostra |
|---|---|---|
| 1 | `01-pdv.png` | PDV com 3 peças no carrinho e total |
| 2 | `02-pagamento.png` | Cobrança: formas de pagamento + teclado |
| 3 | `03-financeiro.png` | Resultado do mês (faturamento, lucro, margem) |
| 4 | `04-relatorios.png` | Vendas por dia + mais vendidos |
| 5 | `05-estoque.png` | Saldo por tamanho e cor, aviso de repor |
| 6 | `06-produtos.png` | Catálogo com busca e grade |
| 7 | `07-caixa.png` | Fechamento de caixa por forma de pagamento |
| 8 | `08-crediario.png` | Crediário: quem deve e quanto |
| 9 | `09-vendas.png` | Histórico de vendas (com uma cancelada) |
| 10 | `10-entrada.png` | Tela de entrada com o nome da loja |

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
https://sistemaobras.com.br/privacidade
```

**URL de Suporte** → o site ou e-mail público que você quiser dar (obrigatório; pode ser
`https://sistemaobras.com.br`).

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
  é o passo a passo que ensina o revisor a conectar em `https://sistemaobras.com.br`
  e a vender sem precisar de câmera.

---

## O que SÓ VOCÊ pode preencher (4 coisas)

1. **Conta de demonstração**: crie no servidor `sistemaobras.com.br` um usuário de perfil
   **dono** só para a Apple (ex.: `revisao@sualoja.com`) e ponha e-mail e senha no campo
   de conta de demonstração e nas notas (onde está `{{EMAIL_DEMO}}` / `{{SENHA_DEMO}}`).
2. **Um código de barras que exista** nesse servidor de demonstração — entra nas notas no
   lugar de `{{CODIGO_DEMO}}` (é o caminho "Digitar código", que salva a revisão feita
   sem câmera).
3. **E-mail de suporte** no lugar de `{{EMAIL_SUPORTE}}` (descrição e notas).
4. **Confirmar** que `privacidade@sistemaobras.com.br` existe (está na descrição e na
   política de privacidade).

Com isso preenchido: selecione o build (Fase 5), **Salvar** e **Enviar para revisão**.
