/**
 * Cartão no balcão: parcelas, bandeira e a tabela de taxas do dono (ADR-35).
 *
 * Lógica pura, sem tela, para ter teste. A taxa NÃO é calculada aqui: quem a decide é a
 * tabela do dono e quem a fotografa na venda é o servidor. O app só pergunta à cliente
 * "em quantas vezes?" e escreve isso direito.
 */

import type { Centavos } from './money';

/** O teto do balcão. Espelho de `MAX_PARCELAS` em `api/app/modules/taxas/models.py`. */
export const MAX_PARCELAS = 12;

/** Sugestões, não lista fechada: a bandeira é texto livre no servidor. */
export const BANDEIRAS = ['Visa', 'Mastercard', 'Elo', 'Hipercard', 'Amex'] as const;

export const NOMES_DAS_FORMAS: Record<string, string> = {
  DINHEIRO: 'Dinheiro',
  PIX: 'PIX',
  DEBITO: 'Débito',
  CREDITO: 'Crédito',
  VALE: 'Vale de troca',
  FIADO: 'Fiado',
};

/**
 * Quanto é cada parcela, para mostrar "3x de R$ 33,33". O centavo que sobra da divisão
 * vai na 1ª parcela (é assim que o servidor monta a agenda), então a parcela "de" é a menor.
 */
export function valorDaParcela(total: Centavos, parcelas: number): Centavos {
  if (parcelas < 1 || !Number.isInteger(parcelas)) return total;
  return Math.floor(total / parcelas);
}

/**
 * "Crédito 3x · Visa": a forma com o que a cliente combinou no cartão. `nomes` deixa o
 * recibo usar os nomes longos ("Cartão de crédito").
 */
export function rotuloPagamento(
  p: { forma: string; parcelas?: number | null; bandeira?: string | null },
  nomes: Record<string, string> = NOMES_DAS_FORMAS,
): string {
  const nome = nomes[p.forma] ?? p.forma;
  const forma = p.parcelas && p.parcelas > 1 ? `${nome} ${p.parcelas}x` : nome;
  return p.bandeira ? `${forma} · ${p.bandeira}` : forma;
}

/** "2x a 6x", ou só "1x" quando a faixa é de uma parcela só. */
export function faixaDeParcelas(t: { parcelas_de: number; parcelas_ate: number }): string {
  return t.parcelas_de === t.parcelas_ate
    ? `${t.parcelas_de}x`
    : `${t.parcelas_de}x a ${t.parcelas_ate}x`;
}

/**
 * A taxa como a pessoa digita ("3,19", "3.19", "4") para o que a API espera ("3.19").
 * `null` quando não é uma taxa possível — de 0 a 99,99, no máximo dois decimais.
 */
export function taxaDigitada(texto: string): string | null {
  const limpo = texto.trim().replace('%', '').replace(',', '.');
  if (!/^\d{1,2}(\.\d{1,2})?$/.test(limpo)) return null;
  return limpo;
}

/** "3.19" → "3,19%": como o contrato da credenciadora escreve. */
export function formatarTaxa(percentual: string): string {
  return `${percentual.replace('.', ',')}%`;
}
