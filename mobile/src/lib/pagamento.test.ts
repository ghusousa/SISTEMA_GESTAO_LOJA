import assert from 'node:assert/strict';
import test from 'node:test';

import { passaDoDevido } from './pagamento';

test('crédito com valor maior que o devido avisa, como PIX e débito', () => {
  // R$ 120,00 digitados numa venda de R$ 100,00: em crédito não há troco.
  for (const forma of ['CREDITO', 'DEBITO', 'PIX']) {
    assert.equal(passaDoDevido(forma, 12000, 10000), true, forma);
  }
});

test('o valor exato ou menor não avisa', () => {
  assert.equal(passaDoDevido('CREDITO', 10000, 10000), false);
  assert.equal(passaDoDevido('CREDITO', 1200, 10000), false);
});

test('dinheiro tem troco; vale e fiado têm conta própria', () => {
  assert.equal(passaDoDevido('DINHEIRO', 12000, 10000), false);
  assert.equal(passaDoDevido('VALE', 12000, 10000), false);
  assert.equal(passaDoDevido('FIADO', 12000, 10000), false);
});
