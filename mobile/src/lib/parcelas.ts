/**
 * Parcelas da nota do fornecedor (ADR-40): a sugestão 30/60/90 e a conferência da soma.
 *
 * A sugestão é da tela; o servidor só confere que as parcelas somam a nota. Dividir em
 * centavos inteiros (`dividir`) é o que faz R$ 1.000,00 em 3 virar 333,34 + 333,33 + 333,33
 * — e não 333,33 x 3, que deixaria um centavo da nota sem conta para pagar.
 *
 * Espelho de `web/js/parcelas.js` — mudou um, mude o outro.
 */

import { dividir, somar, type Centavos } from './money';

export interface Parcela {
  /** `YYYY-MM-DD`, dia de calendário (nunca passa por fuso). */
  vencimento: string;
  valor: Centavos;
}

/** Soma dias a um dia `YYYY-MM-DD` sem passar por fuso: conta em UTC puro. */
export function somarDias(dia: string, dias: number): string {
  const [ano, mes, d] = dia.split('-').map(Number);
  const data = new Date(Date.UTC(ano, mes - 1, d + dias));
  return data.toISOString().slice(0, 10);
}

/**
 * `quantidade` parcelas a cada `intervalo` dias contados de `hoje` (30/60/90 por padrão).
 * O centavo que sobra vai para as primeiras parcelas: a soma volta exatamente ao total.
 */
export function sugerirParcelas(
  total: Centavos,
  quantidade: number,
  hoje: string,
  intervalo = 30,
): Parcela[] {
  if (total <= 0 || quantidade < 1) return [];
  return dividir(total, quantidade).map((valor, i) => ({
    vencimento: somarDias(hoje, intervalo * (i + 1)),
    valor,
  }));
}

/** Quanto falta (positivo) ou sobra (negativo) para as parcelas fecharem com a nota. */
export function diferencaDaNota(total: Centavos, parcelas: Parcela[]): Centavos {
  return total - somar(parcelas.map((p) => p.valor));
}

/** Pronta para gravar: total positivo, toda parcela com valor e data, e a soma fecha. */
export function notaFecha(total: Centavos, parcelas: Parcela[]): boolean {
  return (
    total > 0 &&
    parcelas.length > 0 &&
    parcelas.every((p) => p.valor > 0 && /^\d{4}-\d{2}-\d{2}$/.test(p.vencimento)) &&
    diferencaDaNota(total, parcelas) === 0
  );
}
