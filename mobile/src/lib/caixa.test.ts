import assert from 'node:assert/strict';
import test from 'node:test';

import { camposDoContado } from './caixa';

const linha = (forma: string, esperado: string, contado: string | null = null) => ({
  forma,
  esperado,
  contado,
});

test('a tela abre com o esperado em cada campo', () => {
  const campos = camposDoContado(
    [linha('DINHEIRO', '1234.50'), linha('PIX', '0.00')],
    {},
    new Set(),
  );
  assert.deepEqual(campos, { DINHEIRO: '1234,50', PIX: '0,00' });
});

test('venda que entra com a tela aberta move o campo que ninguém mexeu', () => {
  // Abriu com R$ 500,00 na gaveta; entrou uma venda de R$ 50,00 em dinheiro. Confirmar
  // direto gravava R$ 500,00 contra R$ 550,00 esperados: uma "falta" de R$ 50,00 que não existe.
  const abertura = camposDoContado([linha('DINHEIRO', '500.00')], {}, new Set());
  const depois = camposDoContado([linha('DINHEIRO', '550.00')], abertura, new Set());
  assert.equal(depois.DINHEIRO, '550,00');
});

test('o que a pessoa digitou é dela: o esperado novo não passa por cima', () => {
  const editados = new Set(['DINHEIRO']);
  const campos = camposDoContado(
    [linha('DINHEIRO', '550.00'), linha('PIX', '80.00')],
    { DINHEIRO: '498,00', PIX: '30,00' },
    editados,
  );
  assert.deepEqual(campos, { DINHEIRO: '498,00', PIX: '80,00' });
});

test('campo apagado de propósito continua vazio', () => {
  const campos = camposDoContado(
    [linha('DINHEIRO', '550.00')],
    { DINHEIRO: '' },
    new Set(['DINHEIRO']),
  );
  assert.equal(campos.DINHEIRO, '');
});

test('dia já fechado parte do que foi contado, não do esperado', () => {
  const campos = camposDoContado([linha('DINHEIRO', '550.00', '540.00')], {}, new Set());
  assert.equal(campos.DINHEIRO, '540,00');
});

test('valor com milhar sai sem ponto, do jeito que se digita', () => {
  const campos = camposDoContado([linha('CREDITO', '12500.00')], {}, new Set());
  assert.equal(campos.CREDITO, '12500,00');
});
