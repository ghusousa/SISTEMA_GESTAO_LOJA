/**
 * Regras do pagamento no PDV, sem tela, para ter teste (como `leitura.ts` e `caixa.ts`).
 */

import type { Centavos } from './money';

/**
 * Onde não existe troco: o valor a mais é erro de digitação, nunca pagamento a mais.
 * Dinheiro tem troco; vale e fiado têm conta própria (o saldo do vale, a dívida da cliente).
 */
export const FORMAS_SEM_TROCO: readonly string[] = ['PIX', 'DEBITO', 'CREDITO'];

/**
 * O digitado passa do que falta numa forma sem troco: a tela avisa "Valor maior que o
 * devido" e não lança nada. Cortar em silêncio para o que falta escondia o erro — e o
 * crédito, que pergunta as parcelas antes, já tinha voltado a cortar assim.
 */
export function passaDoDevido(forma: string, digitado: Centavos, restante: Centavos): boolean {
  return FORMAS_SEM_TROCO.includes(forma) && digitado > restante;
}
