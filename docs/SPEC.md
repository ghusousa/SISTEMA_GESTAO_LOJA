# SPEC — Sistema de Gestão de Loja de Roupas (v1)

## Objetivo

Dar ao dono de uma loja de roupas o controle completo do negócio pelo celular: cadastrar peças por
código de barras, saber o estoque real de cada tamanho/cor, vender bipando a etiqueta, registrar
despesas e enxergar quanto sobrou no fim do mês.

## Quem usa

| Papel | O que faz | O que NÃO vê |
|---|---|---|
| **ADMIN** (dono) | Tudo: cadastros, vendas, entradas, ajustes, inventário, despesas, relatórios, fechamento de caixa, gestão de usuários | — |
| **VENDEDOR** (funcionário) | Cadastra produtos, consulta estoque, registra entradas, vende, cancela a própria venda do dia | Preço de custo, lucro/margem, despesas, relatórios, usuários |

A restrição do vendedor é aplicada **no servidor** (schemas de resposta distintos + checagem de papel
no service). O app apenas oculta as abas.

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
