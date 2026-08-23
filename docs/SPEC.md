# SPEC — Sistema de Gestão de Loja de Roupas (v1)

## Objetivo

Dar ao dono de uma loja de roupas o controle completo do negócio pelo celular: cadastrar peças por
código de barras, saber o estoque real de cada tamanho/cor, vender bipando a etiqueta, registrar
despesas e enxergar quanto sobrou no fim do mês.

## Quem usa

Quatro cargos, do balcão para cima. Cada degrau soma ao de baixo — ninguém tem um poder que
o superior não tenha.

| Cargo | Além do degrau anterior | O que NÃO alcança |
|---|---|---|
| **Vendedora** (`VENDEDOR`) | Vende no PDV, bipa e consulta preço, cadastra peça nova, dá entrada de mercadoria | Custo, lucro, despesas, relatórios, estorno, ajuste de estoque, inventário, vendas das colegas |
| **Supervisora** (`SUPERVISORA`) | Ajusta estoque, faz inventário, edita e exclui produtos e categorias, confere e fecha o caixa do dia, vê as vendas de toda a equipe | Custo, lucro, despesas, relatórios, estorno, logins da equipe |
| **Gerente** (`GERENTE`) | Vê custo, lucro e margem; lança despesas; abre relatórios; cancela venda concluída; administra os logins da equipe | A conta do dono: não cria, não promove, não edita, não redefine a senha dele |
| **Dono** (`ADMIN`) | Tudo, inclusive criar e promover outro dono | — |

**Três decisões que a loja tomou e que o sistema faz valer:**

- **Quem vende não desfaz.** Estornar é do dono e do gerente. A vendedora que errar no caixa
  chama alguém — é o controle clássico contra desvio, e vale inclusive para a venda dela.
- **Quem confere o caixa não vê a margem.** A supervisora fecha o dia e sabe quanto entrou,
  mas não sabe quanto sobrou.
- **Gerir logins não é virar dono.** O gerente contrata, promove até supervisora e desliga;
  a conta do dono é intocável para ele, senão a permissão de administrar a equipe seria, na
  prática, a permissão de se promover.

Quem recusa é **sempre o servidor** — schemas de resposta distintos por capacidade e uma
tabela única em `app/core/permissoes.py`. O app e o sistema web só escondem o que daria 403,
para não oferecer um botão que não funciona.

**Onde se usa.** O mesmo sistema em duas telas, com as mesmas regras e os mesmos papéis:
o **app** (Android/iOS) para andar pela loja bipando com a câmera, e o **sistema web** no
computador do balcão, onde o leitor USB digita o código como teclado e o teclado resolve
o que é chato no celular — digitar preço, lançar despesa, fechar o caixa, editar a grade.
A loja consegue operar 100% sem celular.

## Entidades centrais

- **Produto** — a peça (ex.: "Camiseta Básica Gola V"). Tem categoria, descrição e foto.
- **Variante** — o que de fato se vende e se conta: produto + tamanho + cor. Cada variante tem seu
  **código de barras** (o EAN da etiqueta do fornecedor ou um código interno gerado pelo sistema
  quando a peça vem sem etiqueta), preço de custo, preço de venda e estoque mínimo.
- **Movimentação de estoque** — todo evento que muda o saldo (entrada, ajuste, inventário, venda,
  estorno). O saldo nunca é editado direto: é consequência das movimentações. Isso dá auditoria
  completa ("por que tenho 3 e não 5?").
- **Venda** — o que saiu no PDV: itens (com preço e custo **congelados** no momento da venda),
  pagamentos (pode ser misto) e desconto.
- **Despesa** — saída de dinheiro que não é compra de mercadoria (aluguel, energia, salário...),
  com categoria e marcação de recorrente.
- **Fechamento de caixa** — conferência diária: quanto o sistema esperava por forma de pagamento
  versus quanto foi contado.

## Casos de uso principais

1. **Vender (PDV)** — bipar a etiqueta → a peça entra no carrinho com preço → repetir → aplicar
   desconto se houver → cobrar (dinheiro/PIX/débito/crédito, podendo dividir entre formas) →
   confirmar. O estoque baixa na mesma transação. Se o código não existir, o app oferece cadastro
   rápido. Se não houver saldo, a venda é recusada.
2. **Cadastrar peça nova** — dados do produto + grade de variantes (gerar P/M/G/GG de uma vez);
   para cada uma: bipar o EAN da etiqueta ou pedir um código interno ao sistema, informar custo,
   preço e estoque inicial.
3. **Repor estoque** — modo bipagem contínua: bipa cada peça que chegou, o app soma, ao final envia
   uma entrada única (com fornecedor e observação).
4. **Conferir estoque (inventário)** — contar fisicamente e lançar as contagens; o sistema gera as
   movimentações de acerto e mostra as diferenças.
5. **Lançar despesas** — valor, categoria, data, se é recorrente. Despesas recorrentes podem ser
   replicadas para a competência seguinte sem duplicar.
6. **Ver o resultado** — faturamento, custo das mercadorias vendidas (CMV), lucro bruto, despesas e
   resultado do período; produtos mais vendidos; peças com estoque abaixo do mínimo; curva de vendas
   por dia.
7. **Fechar o caixa do dia** — conferir o esperado por forma de pagamento contra o contado.

## Regras de negócio que não podem ser violadas

- Saldo de estoque nunca fica negativo; toda alteração de saldo tem uma movimentação correspondente.
- Venda é atômica: itens, pagamentos e baixas de estoque acontecem juntos ou nada acontece.
- A soma dos pagamentos é exatamente igual ao total da venda.
- Preço e custo do item são congelados na venda — mudar o preço amanhã não altera o lucro de ontem.
- Cancelar uma venda nunca apaga: marca como CANCELADA e devolve o estoque por movimentação.
- Desconto existe apenas no total da venda (não por item).
- Vendedor não recebe custo em nenhuma resposta da API.
- Retry de rede não duplica venda nem entrada (idempotência por `client_uuid`).

## Fora do escopo do v1

Funcionamento offline com sincronização (v2 — já preparado pelo `client_uuid`), emissão fiscal
(NF-e/NFC-e), impressão de etiquetas e de recibo, cadastro de clientes e fidelidade, trocas com
vale-crédito, condicional, múltiplas lojas, e-commerce, limite de desconto por vendedor, sessões de
inventário compartilhadas no servidor, contagem cega, foto por variante, notificações push.
