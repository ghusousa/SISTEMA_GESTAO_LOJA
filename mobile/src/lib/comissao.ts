/**
 * Comissão e meta do dia, a parte sem tela (ADR-37) — para dar para testar.
 *
 * A % é digitada como a pessoa fala ("2,5") e viaja como string decimal ("2.50"): a mesma
 * régua do dinheiro, em centésimos, sem float. A meta é dinheiro (centavos); zero não é
 * meta, é "sem meta" (`null` no fio), e a régua some do PDV.
 */

import { paraCentavos, paraDecimalString, type Centavos } from './money';

/** O teto da % de comissão, em centésimos (100,00%). O banco tem o mesmo CHECK. */
const CEM_POR_CENTO = 10_000;

/**
 * "2,5" -> "2.50"; "" -> "0.00". `null` quando não é uma % de 0 a 100 com até duas casas.
 *
 * Três casas ("2,555", "0,005") são recusadas antes de chegar à régua do dinheiro, que lê
 * três dígitos depois do separador como MILHAR: "0,005%" viraria 5% em silêncio.
 */
export function paraPercentualDecimal(texto: string): string | null {
  const limpo = texto.replace('%', '').trim();
  if (limpo === '') return '0.00';
  if (!/^\d+([.,]\d{1,2})?$/.test(limpo)) return null;
  const centesimos = paraCentavos(limpo);
  if (centesimos < 0 || centesimos > CEM_POR_CENTO) return null;
  return paraDecimalString(centesimos);
}

/** "2.50" -> "2,5"; "5.00" -> "5". Para preencher o campo com o valor de hoje. */
export function percentualParaCampo(decimal: string | null | undefined): string {
  const centesimos = paraCentavos(decimal ?? '0');
  const texto = paraDecimalString(centesimos).replace('.', ',');
  return texto.replace(/,00$/, '').replace(/(,\d)0$/, '$1');
}

/** Meta em centavos -> o que vai no corpo do pedido. Zero tira a meta. */
export function metaParaApi(centavos: Centavos): string | null {
  return centavos > 0 ? paraDecimalString(centavos) : null;
}

export interface ProgressoDaMeta {
  /** 0 a 100, inteiro — largura da barra. Passou da meta, para em 100. */
  pct: number;
  /** Quanto falta, em centavos; zero quando bateu. */
  falta: Centavos;
  batida: boolean;
}

/**
 * Onde a pessoa está na meta do dia. Vendido negativo (só devolução hoje) é barra vazia,
 * não barra "para trás".
 */
export function progressoDaMeta(vendido: Centavos, meta: Centavos): ProgressoDaMeta {
  if (meta <= 0) return { pct: 0, falta: 0, batida: false };
  const pct = Math.min(100, Math.max(0, Math.floor((vendido / meta) * 100)));
  const falta = Math.max(meta - vendido, 0);
  return { pct, falta, batida: falta === 0 };
}

/** Rótulo curto para a lista da equipe: "5% · meta R$ 1.500,00". Vazio sem os dois. */
export function resumoDaComissao(
  comissao: string | null | undefined,
  meta: string | null | undefined,
  formatarDinheiro: (c: Centavos) => string,
): string {
  const partes: string[] = [];
  if (paraCentavos(comissao ?? '0') > 0) partes.push(`${percentualParaCampo(comissao)}%`);
  if (meta) partes.push(`meta ${formatarDinheiro(paraCentavos(meta))}`);
  return partes.join(' · ');
}
