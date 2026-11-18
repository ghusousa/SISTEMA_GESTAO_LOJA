/**
 * Os cartões do resumo de Relatórios fecham à vista: quem soma o que está escrito neles chega
 * no lucro bruto e no resultado que eles mostram.
 *
 * Roda sem navegador: `node --test testes/web/*.test.mjs`. O lucro bruto da API já vem sem as
 * devoluções (`RelatorioService.resumo`); sem o cartão de Devoluções, faturamento − custo dava
 * R$ 198,61 a mais que o lucro bruto do cartão ao lado. O app mostra as mesmas parcelas no
 * Financeiro (`mobile/src/lib/resumoFinanceiro.ts`, com teste).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { cartoesDoResumo } from '../../web/js/views/relatorios-resumo.js';

/** `GET /relatorios/resumo` de novembro na loja de demonstração (api/scripts/seed_demo.py). */
const NOVEMBRO = {
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

/** "R$ 15.129,90" (com espaço comum ou o fino do Intl) em centavos. */
function centavos(texto) {
  const numero = texto.replace(/[^\d,-]/g, '').replace(',', '.');
  return Math.round(Number(numero) * 100);
}

/** O valor grande de cada cartão, pelo rótulo dele, como aparece na tela. */
function valoresDosCartoes(html) {
  const valores = {};
  const cartao = /indicador__rotulo">([^<]+?)\s*(?:<button[^>]*>[^<]*<\/button>)?<\/div>\s*<div class="indicador__valor[^"]*">\s*([^<]+?)\s*<\/div>/g;
  for (const [, rotulo, valor] of html.matchAll(cartao)) valores[rotulo.trim()] = centavos(valor);
  return valores;
}

test('os cartões fecham: faturamento − devoluções − custo + o que voltou = lucro bruto', () => {
  const html = String(cartoesDoResumo(NOVEMBRO));
  const v = valoresDosCartoes(html);
  assert.equal(v['Devoluções'], 33861);
  const voltou = html.match(/(R\$\s*[\d.,]+) de custo voltou com as peças ao estoque/);
  assert.ok(voltou, 'o cartão de Devoluções diz quanto custo voltou ao estoque');
  assert.equal(
    v['Faturamento'] - v['Devoluções'] - v['Custo da mercadoria'] + centavos(voltou[1]),
    v['Lucro bruto'],
  );
  assert.equal(v['Lucro bruto'] - v['Despesas'] - v['Taxas de cartão'], v['Resultado']);
});

test('sem devolução no período, o cartão some (e a conta continua fechando)', () => {
  const semDevolucao = {
    ...NOVEMBRO,
    devolucoes: '0.00',
    faturamento_liquido: '15129.90',
    cmv_devolvido: '0.00',
    pecas_devolvidas: 0,
    lucro_bruto: '8797.90',
    resultado: '281.70',
  };
  const html = String(cartoesDoResumo(semDevolucao));
  assert.ok(!html.includes('Devoluções'));
  const v = valoresDosCartoes(html);
  assert.equal(v['Faturamento'] - v['Custo da mercadoria'], v['Lucro bruto']);
});

test('peça devolvida que não voltou ao estoque: o cartão conta quantas voltaram', () => {
  const html = String(cartoesDoResumo({ ...NOVEMBRO, cmv_devolvido: '0.00', lucro_bruto: '8459.29' }));
  assert.ok(html.includes('1 peça devolvida'));
  assert.ok(!html.includes('de custo voltou'));
});

test('servidor que não manda os campos da devolução: sem cartão e sem erro', () => {
  const { devolucoes: _d, cmv_devolvido: _c, pecas_devolvidas: _p, ...antigo } = NOVEMBRO;
  const html = String(cartoesDoResumo(antigo));
  assert.ok(!html.includes('Devoluções'));
  assert.ok(html.includes('Lucro bruto'));
});
