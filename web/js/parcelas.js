/**
 * Parcelas da nota do fornecedor (ADR-40): a sugestão 30/60/90 e a conferência da soma.
 *
 * A sugestão é da tela; o servidor só confere que as parcelas somam a nota. Dividir em
 * centavos inteiros (`dividir`) é o que faz R$ 1.000,00 em 3 virar 333,34 + 333,33 + 333,33
 * — e não 333,33 x 3, que deixaria um centavo da nota sem conta para pagar.
 *
 * **Espelho de `mobile/src/lib/parcelas.ts`** (lá, com teste) — mudou um, mude o outro.
 */

import { dividir, somar } from './dinheiro.js';

/** Soma dias a um dia `YYYY-MM-DD` sem passar por fuso: conta em UTC puro. */
export function somarDias(dia, dias) {
  const [ano, mes, d] = dia.split('-').map(Number);
  return new Date(Date.UTC(ano, mes - 1, d + dias)).toISOString().slice(0, 10);
}

/**
 * `quantidade` parcelas a cada `intervalo` dias contados de `hoje` (30/60/90 por padrão).
 * O centavo que sobra vai para as primeiras parcelas: a soma volta exatamente ao total.
 */
export function sugerirParcelas(total, quantidade, hoje, intervalo = 30) {
  if (total <= 0 || quantidade < 1) return [];
  return dividir(total, quantidade).map((valor, i) => ({
    vencimento: somarDias(hoje, intervalo * (i + 1)),
    valor,
  }));
}

/** Quanto falta (positivo) ou sobra (negativo) para as parcelas fecharem com a nota. */
export function diferencaDaNota(total, parcelas) {
  return total - somar(parcelas.map((p) => p.valor));
}

/** Pronta para gravar: total positivo, toda parcela com valor e data, e a soma fecha. */
export function notaFecha(total, parcelas) {
  return (
    total > 0 &&
    parcelas.length > 0 &&
    parcelas.every((p) => p.valor > 0 && /^\d{4}-\d{2}-\d{2}$/.test(p.vencimento)) &&
    diferencaDaNota(total, parcelas) === 0
  );
}
