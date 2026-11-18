import assert from 'node:assert/strict';
import test from 'node:test';

import {
  faixaDeParcelas,
  formatarTaxa,
  MAX_PARCELAS,
  rotuloPagamento,
  taxaDigitada,
  valorDaParcela,
} from './cartao';

test('a parcela mostrada é a menor: o centavo que sobra vai na primeira', () => {
  // R$ 100,00 em 3x = 33,34 + 33,33 + 33,33 — a tela diz "3x de R$ 33,33".
  assert.equal(valorDaParcela(10000, 3), 3333);
  assert.equal(valorDaParcela(10000, 1), 10000);
  assert.equal(valorDaParcela(999, 12), 83);
});

test('parcela impossível não divide nada', () => {
  assert.equal(valorDaParcela(10000, 0), 10000);
  assert.equal(valorDaParcela(10000, 2.5), 10000);
});

test('o teto do balcão é 12x, igual ao servidor', () => {
  assert.equal(MAX_PARCELAS, 12);
});

test('o rótulo diz forma, parcelas e bandeira', () => {
  assert.equal(rotuloPagamento({ forma: 'CREDITO', parcelas: 3, bandeira: 'Visa' }), 'Crédito 3x · Visa');
  assert.equal(rotuloPagamento({ forma: 'CREDITO', parcelas: 1 }), 'Crédito');
  assert.equal(rotuloPagamento({ forma: 'DEBITO', bandeira: 'Elo' }), 'Débito · Elo');
  assert.equal(rotuloPagamento({ forma: 'PIX' }), 'PIX');
  assert.equal(
    rotuloPagamento({ forma: 'CREDITO', parcelas: 2 }, { CREDITO: 'Cartão de crédito' }),
    'Cartão de crédito 2x',
  );
});

test('a faixa de uma parcela só não repete o número', () => {
  assert.equal(faixaDeParcelas({ parcelas_de: 1, parcelas_ate: 1 }), '1x');
  assert.equal(faixaDeParcelas({ parcelas_de: 2, parcelas_ate: 6 }), '2x a 6x');
});

test('a taxa digitada com vírgula vira o decimal da API', () => {
  assert.equal(taxaDigitada('3,19'), '3.19');
  assert.equal(taxaDigitada(' 4 '), '4');
  assert.equal(taxaDigitada('2.5%'), '2.5');
});

test('taxa impossível é recusada antes de ir ao servidor', () => {
  assert.equal(taxaDigitada(''), null);
  assert.equal(taxaDigitada('100'), null);
  assert.equal(taxaDigitada('3,199'), null);
  assert.equal(taxaDigitada('-1'), null);
  assert.equal(taxaDigitada('três'), null);
});

test('a taxa aparece como no contrato', () => {
  assert.equal(formatarTaxa('3.19'), '3,19%');
});
