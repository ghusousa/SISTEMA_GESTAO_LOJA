/**
 * O fechamento da condicional, em conta de balcão (ADR-39).
 *
 * A vendedora diz quanto VOLTOU de cada peça; o que ficou é o que a cliente paga. O preço
 * é o de venda de hoje (o servidor recalcula e recusa se divergir, ADR-4) — aqui é só o
 * total que a tela mostra e o corpo que ela manda.
 *
 * Espelho de `web/js/condicional.js` — mudou um, mude o outro.
 */

import { paraCentavos, somar, type Centavos } from './money';

export interface ItemDaCondicional {
  variante_id: number;
  quantidade: number;
  /** Como a API manda: string decimal ("199.90"). */
  preco_venda: string;
}

export interface Fechamento {
  /** variante -> quantas ficaram com a cliente. Só entra quem ficou com pelo menos uma. */
  ficaram: Map<number, number>;
  pecasQueFicaram: number;
  pecasQueVoltaram: number;
  /** Quanto a cliente paga pelo que ficou, antes de desconto. */
  total: Centavos;
}

/** Voltou mais do que levou (ou negativo) é erro de digitação: limita entre 0 e o que levou. */
export function limitarDevolvida(quantidade: number, devolvida: number): number {
  if (!Number.isFinite(devolvida)) return 0;
  return Math.max(0, Math.min(quantidade, Math.trunc(devolvida)));
}

export function resumirFechamento(
  itens: ItemDaCondicional[],
  devolvidas: Map<number, number>,
): Fechamento {
  const ficaram = new Map<number, number>();
  let pecasQueFicaram = 0;
  let pecasQueVoltaram = 0;
  const valores: Centavos[] = [];
  for (const item of itens) {
    const voltou = limitarDevolvida(item.quantidade, devolvidas.get(item.variante_id) ?? 0);
    const ficou = item.quantidade - voltou;
    pecasQueVoltaram += voltou;
    pecasQueFicaram += ficou;
    if (ficou > 0) {
      ficaram.set(item.variante_id, ficou);
      valores.push(paraCentavos(item.preco_venda) * ficou);
    }
  }
  return { ficaram, pecasQueFicaram, pecasQueVoltaram, total: somar(valores) };
}

/** O corpo de `POST /condicionais/{id}/fechamento`, sem a chave e sem os pagamentos. */
export function itensDoFechamento(
  itens: ItemDaCondicional[],
  devolvidas: Map<number, number>,
): { variante_id: number; devolvida: number }[] {
  return itens.map((i) => ({
    variante_id: i.variante_id,
    devolvida: limitarDevolvida(i.quantidade, devolvidas.get(i.variante_id) ?? 0),
  }));
}

/** "vence hoje", "vence amanhã", "vence em 3 dias", "venceu há 2 dias". */
export function textoDoPrazo(diasParaVencer: number): string {
  if (diasParaVencer === 0) return 'vence hoje';
  if (diasParaVencer === 1) return 'vence amanhã';
  if (diasParaVencer > 1) return `vence em ${diasParaVencer} dias`;
  if (diasParaVencer === -1) return 'venceu ontem';
  return `venceu há ${-diasParaVencer} dias`;
}
