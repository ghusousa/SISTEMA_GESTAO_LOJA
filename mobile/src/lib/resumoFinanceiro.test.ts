import assert from 'node:assert/strict';
import test from 'node:test';

import type { ResumoFinanceiro } from '../api/tipos';
import { paraCentavos } from './money';
import { contasDoResumo, type LinhaDoResumo } from './resumoFinanceiro';

/**
 * `GET /relatorios/resumo` de novembro na loja de demonstração (api/scripts/seed_demo.py),
 * como a API devolveu: 80 vendas, uma devolução de R$ 338,61 cuja peça (custo R$ 140,00)
 * voltou ao estoque, e o mês ainda sem taxa de maquininha.
 */
const NOVEMBRO: ResumoFinanceiro = {
  inicio: '2026-11-01',
  fim: '2026-11-30',
  faturamento: '15129.90',
  devolucoes: '338.61',
  faturamento_liquido: '14791.29',
  custo_mercadoria_vendida: '6332.00',
  cmv_devolvido: '140.00',
  lucro_bruto: '8599.29',
  despesas: '8516.20',
  taxas_cartao: '0.00',
  resultado: '83.09',
  margem_bruta_pct: '58.14',
  quantidade_vendas: 80,
  quantidade_pecas: 101,
  pecas_devolvidas: 1,
  ticket_medio: '189.12',
  vendas_canceladas: 1,
};

/** Faz a conta que a pessoa faz olhando a tela: de cima para baixo, com os sinais. */
function contaDaTela(linhas: LinhaDoResumo[]) {
  const i = linhas.findIndex((l) => l.subtotal);
  const aplicar = (acc: number, l: LinhaDoResumo) =>
    l.sinal === '−' ? acc - l.valor : acc + l.valor;
  return {
    ateOSubtotal: linhas.slice(0, i).reduce(aplicar, 0),
    subtotal: linhas[i].valor,
    depois: linhas.slice(i).reduce(aplicar, 0),
  };
}

test('o cartão fecha: as linhas dão o lucro bruto e o resultado da API', () => {
  const { linhas } = contasDoResumo(NOVEMBRO);
  const conta = contaDaTela(linhas);
  assert.equal(conta.ateOSubtotal, paraCentavos(NOVEMBRO.lucro_bruto));
  assert.equal(conta.subtotal, paraCentavos(NOVEMBRO.lucro_bruto));
  assert.equal(conta.depois, paraCentavos(NOVEMBRO.resultado));
});

test('a devolução e o custo que voltou aparecem como linha (sem elas faltavam R$ 198,61)', () => {
  const { linhas } = contasDoResumo(NOVEMBRO);
  assert.deepEqual(
    linhas.map((l) => [l.rotulo, l.sinal, l.valor]),
    [
      ['Faturamento', null, 1512990],
      ['Devoluções', '−', 33861],
      ['Custo das peças vendidas', '−', 633200],
      ['Custo das peças que voltaram ao estoque', '+', 14000],
      ['Lucro bruto', null, 859929],
      ['Despesas', '−', 851620],
      ['Taxas de cartão', '−', 0],
    ],
  );
  // O cartão antigo: faturamento − custo ≠ lucro bruto.
  assert.equal(1512990 - 633200 - 859929, 19861);
});

test('a fórmula impressa é a conta que o servidor faz', () => {
  const r = NOVEMBRO;
  assert.equal(contasDoResumo(r).formula, 'Lucro bruto − despesas − taxas de cartão');
  assert.equal(
    paraCentavos(r.lucro_bruto) - paraCentavos(r.despesas) - paraCentavos(r.taxas_cartao!),
    paraCentavos(r.resultado),
  );
});

test('mês sem devolução: nada de linha zerada', () => {
  const semDevolucao: ResumoFinanceiro = {
    ...NOVEMBRO,
    devolucoes: '0.00',
    faturamento_liquido: '15129.90',
    cmv_devolvido: '0.00',
    pecas_devolvidas: 0,
    lucro_bruto: '8797.90',
    taxas_cartao: '312.40',
    resultado: '-30.70',
  };
  const { linhas } = contasDoResumo(semDevolucao);
  assert.deepEqual(
    linhas.map((l) => l.rotulo),
    ['Faturamento', 'Custo das peças vendidas', 'Lucro bruto', 'Despesas', 'Taxas de cartão'],
  );
  const conta = contaDaTela(linhas);
  assert.equal(conta.ateOSubtotal, conta.subtotal);
  assert.equal(conta.depois, -3070);
});

test('peça devolvida com defeito (não voltou ao estoque): o custo continua contando', () => {
  const comDefeito: ResumoFinanceiro = {
    ...NOVEMBRO,
    cmv_devolvido: '0.00',
    lucro_bruto: '8459.29',
    resultado: '-56.91',
  };
  const { linhas } = contasDoResumo(comDefeito);
  assert.ok(!linhas.some((l) => l.rotulo.startsWith('Custo das peças que voltaram')));
  const conta = contaDaTela(linhas);
  assert.equal(conta.ateOSubtotal, conta.subtotal);
  assert.equal(conta.depois, -5691);
});

test('servidor sem taxa de cartão: a linha e a parte da fórmula somem', () => {
  const { taxas_cartao: _fora, ...semTaxas } = NOVEMBRO;
  const contas = contasDoResumo(semTaxas);
  assert.ok(!contas.linhas.some((l) => l.rotulo === 'Taxas de cartão'));
  assert.equal(contas.formula, 'Lucro bruto − despesas');
  assert.equal(contaDaTela(contas.linhas).depois, paraCentavos(NOVEMBRO.resultado));
});
