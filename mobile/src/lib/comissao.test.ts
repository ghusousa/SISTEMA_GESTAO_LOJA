/**
 * A parte sem tela da comissão e da meta (ADR-37). O que custaria dinheiro se quebrasse:
 * "2,5%" virar 25% (ou 250%) no caminho até a API, e a régua do PDV dizer "meta batida"
 * para quem ainda não bateu.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  metaParaApi,
  paraPercentualDecimal,
  percentualParaCampo,
  progressoDaMeta,
  resumoDaComissao,
} from './comissao';
import { formatar } from './money';

test('a % digitada vira string decimal, com vírgula ou ponto', () => {
  assert.equal(paraPercentualDecimal('2,5'), '2.50');
  assert.equal(paraPercentualDecimal('2.5'), '2.50');
  assert.equal(paraPercentualDecimal('5'), '5.00');
  assert.equal(paraPercentualDecimal('0'), '0.00');
  assert.equal(paraPercentualDecimal(''), '0.00');
  assert.equal(paraPercentualDecimal('100'), '100.00');
  assert.equal(paraPercentualDecimal(' 3,75 % '), '3.75');
});

test('% fora de 0 a 100, negativa ou com lixo é recusada, não arredondada', () => {
  assert.equal(paraPercentualDecimal('100,01'), null);
  assert.equal(paraPercentualDecimal('150'), null);
  assert.equal(paraPercentualDecimal('-1'), null);
  assert.equal(paraPercentualDecimal('2,555'), null);
  assert.equal(paraPercentualDecimal('0,005'), null); // a régua do dinheiro leria 5%
  assert.equal(paraPercentualDecimal('cinco'), null);
  assert.equal(paraPercentualDecimal('1.000'), null);
});

test('o valor da API volta para o campo do jeito que se fala', () => {
  assert.equal(percentualParaCampo('2.50'), '2,5');
  assert.equal(percentualParaCampo('5.00'), '5');
  assert.equal(percentualParaCampo('3.75'), '3,75');
  assert.equal(percentualParaCampo(undefined), '0');
  // ida e volta não muda o número
  assert.equal(paraPercentualDecimal(percentualParaCampo('12.30')), '12.30');
});

test('meta zerada é "sem meta"', () => {
  assert.equal(metaParaApi(0), null);
  assert.equal(metaParaApi(150000), '1500.00');
});

test('progresso da meta: barra, quanto falta e quando bateu', () => {
  assert.deepEqual(progressoDaMeta(30000, 100000), { pct: 30, falta: 70000, batida: false });
  assert.deepEqual(progressoDaMeta(100000, 100000), { pct: 100, falta: 0, batida: true });
  assert.deepEqual(progressoDaMeta(250000, 100000), { pct: 100, falta: 0, batida: true });
  // R$ 999,99 de R$ 1.000,00 ainda não é meta batida (nada de arredondar para 100%).
  assert.deepEqual(progressoDaMeta(99999, 100000), { pct: 99, falta: 1, batida: false });
  // Só devolução hoje: barra vazia, e falta a meta inteira mais o que voltou.
  assert.deepEqual(progressoDaMeta(-5000, 100000), { pct: 0, falta: 105000, batida: false });
  assert.deepEqual(progressoDaMeta(5000, 0), { pct: 0, falta: 0, batida: false });
});

test('resumo da comissão na lista da equipe', () => {
  assert.equal(resumoDaComissao('5.00', '1500.00', formatar), `5% · meta ${formatar(150000)}`);
  assert.equal(resumoDaComissao('0.00', null, formatar), '');
  assert.equal(resumoDaComissao('2.50', null, formatar), '2,5%');
});
