import assert from 'node:assert/strict';
import test from 'node:test';

import { itensDoFechamento, limitarDevolvida, resumirFechamento, textoDoPrazo } from './condicional';

const itens = [
  { variante_id: 1, quantidade: 2, preco_venda: '199.90' },
  { variante_id: 2, quantidade: 1, preco_venda: '89.90' },
];

test('o que não voltou é o que a cliente paga', () => {
  const r = resumirFechamento(itens, new Map([[1, 1], [2, 1]]));
  assert.equal(r.total, 19_990);
  assert.equal(r.pecasQueFicaram, 1);
  assert.equal(r.pecasQueVoltaram, 2);
  assert.deepEqual([...r.ficaram], [[1, 1]]);
});

test('tudo voltou: nada a cobrar', () => {
  const r = resumirFechamento(itens, new Map([[1, 2], [2, 1]]));
  assert.equal(r.total, 0);
  assert.equal(r.ficaram.size, 0);
});

test('peça sem resposta conta como ficou (o padrão é cobrar, não dar de presente)', () => {
  const r = resumirFechamento(itens, new Map());
  assert.equal(r.total, 2 * 19_990 + 8_990);
  assert.equal(r.pecasQueFicaram, 3);
});

test('voltou mais do que levou é digitação: limita ao que levou', () => {
  assert.equal(limitarDevolvida(2, 5), 2);
  assert.equal(limitarDevolvida(2, -1), 0);
  assert.equal(limitarDevolvida(2, Number.NaN), 0);
  assert.deepEqual(itensDoFechamento(itens, new Map([[1, 9]])), [
    { variante_id: 1, devolvida: 2 },
    { variante_id: 2, devolvida: 0 },
  ]);
});

test('o prazo em palavras', () => {
  assert.equal(textoDoPrazo(0), 'vence hoje');
  assert.equal(textoDoPrazo(1), 'vence amanhã');
  assert.equal(textoDoPrazo(4), 'vence em 4 dias');
  assert.equal(textoDoPrazo(-1), 'venceu ontem');
  assert.equal(textoDoPrazo(-3), 'venceu há 3 dias');
});
