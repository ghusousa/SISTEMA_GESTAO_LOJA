/**
 * As contas do cartão "Resultado do mês" (aba Financeiro), linha por linha.
 *
 * Regra: quem somar a tela chega no número que ela mostra. Antes o cartão tinha só
 * faturamento, custo e lucro bruto — e o lucro bruto do servidor já descontava as
 * devoluções do mês (ADR-19). Com uma devolução de R$ 338,61 cuja peça (custo R$ 140,00)
 * voltou ao estoque, faltavam R$ 198,61 na conta, e a fórmula impressa no cartão dava outro
 * resultado. Aqui toda parcela que o servidor usa vira linha.
 *
 * Espelho de `RelatorioService.resumo` (api/app/modules/relatorios/service.py):
 *   lucro_bruto = faturamento − devoluções − (custo das peças vendidas − custo das que voltaram)
 *   resultado   = lucro_bruto − despesas − taxas de cartão
 */

import type { ResumoContas, ResumoFinanceiro } from '../api/tipos';
import { formatar, paraCentavos, type Centavos } from './money';
import { plural } from './texto';

export interface LinhaDoResumo {
  rotulo: string;
  /** Sempre positivo: quem diz se soma ou tira é o `sinal`. */
  valor: Centavos;
  /** `null` no ponto de partida (faturamento) e no subtotal (lucro bruto). */
  sinal: '+' | '−' | null;
  /** O lucro bruto: fecha a primeira conta e abre a segunda. */
  subtotal?: boolean;
}

export interface ContasDoResumo {
  linhas: LinhaDoResumo[];
  /** A conta do resultado, escrita como ela é feita. */
  formula: string;
}

/** Linha que só aparece com valor: devolução e custo que voltou são exceção, não regra. */
function seHouver(linha: LinhaDoResumo): LinhaDoResumo[] {
  return linha.valor > 0 ? [linha] : [];
}

export function contasDoResumo(r: ResumoFinanceiro): ContasDoResumo {
  // Taxa da maquininha: servidor sem o cálculo não manda o campo, e a linha some — nada de
  // "R$ 0,00" mentindo. Os campos da devolução, quando faltam, valem zero: servidor que não
  // os manda também não os desconta do lucro bruto.
  const temTaxas = r.taxas_cartao !== undefined && r.taxas_cartao !== null;
  const linhas: LinhaDoResumo[] = [
    { rotulo: 'Faturamento', valor: paraCentavos(r.faturamento), sinal: null },
    ...seHouver({ rotulo: 'Devoluções', valor: paraCentavos(r.devolucoes ?? '0'), sinal: '−' }),
    { rotulo: 'Custo das peças vendidas', valor: paraCentavos(r.custo_mercadoria_vendida), sinal: '−' },
    ...seHouver({
      rotulo: 'Custo das peças que voltaram ao estoque',
      valor: paraCentavos(r.cmv_devolvido ?? '0'),
      sinal: '+',
    }),
    { rotulo: 'Lucro bruto', valor: paraCentavos(r.lucro_bruto), sinal: null, subtotal: true },
    { rotulo: 'Despesas', valor: paraCentavos(r.despesas), sinal: '−' },
    ...(temTaxas
      ? [{ rotulo: 'Taxas de cartão', valor: paraCentavos(r.taxas_cartao!), sinal: '−' as const }]
      : []),
  ];
  return {
    linhas,
    formula: temTaxas ? 'Lucro bruto − despesas − taxas de cartão' : 'Lucro bruto − despesas',
  };
}

/**
 * O aviso de boleto do Financeiro, cada faixa com o SEU valor (ADR-40). As faixas da API são
 * disjuntas — vencidas (antes de hoje) e os próximos 7 dias (de hoje em diante) —, e o aviso
 * contava só as vencidas no texto com a soma das duas no valor: um boleto de R$ 500,00 vencido e
 * dois da semana viravam "1 conta vencida — R$ 1.500,00", e Contas a pagar dizia R$ 500,00.
 * `null` quando não há nada a pagar até 7 dias.
 */
export function avisoDeContasAPagar(r: ResumoContas | undefined | null): string | null {
  if (!r) return null;
  const vencidas = r.vencidas.quantidade;
  const semana = r.proximos_7_dias.quantidade;
  const valorVencidas = formatar(paraCentavos(r.vencidas.valor));
  const valorSemana = formatar(paraCentavos(r.proximos_7_dias.valor));
  if (vencidas && semana) {
    return (
      `${plural(vencidas, 'conta de fornecedor vencida', 'contas de fornecedor vencidas')} (${valorVencidas}) ` +
      `e ${plural(semana, 'vencendo', 'vencendo')} nos próximos 7 dias (${valorSemana})`
    );
  }
  if (vencidas) {
    return `${plural(vencidas, 'conta de fornecedor vencida', 'contas de fornecedor vencidas')} — ${valorVencidas}`;
  }
  if (semana) {
    return `${plural(semana, 'conta de fornecedor', 'contas de fornecedor')} nos próximos 7 dias — ${valorSemana}`;
  }
  return null;
}
