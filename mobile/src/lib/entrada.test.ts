import assert from 'node:assert/strict';
import test from 'node:test';

import { tirarOQueJaEntrou } from './entrada';

const peca = (varianteId: number, quantidade: number) => ({ varianteId, quantidade, codigo: `c${varianteId}` });

test('o que a entrada gravada levou sai; o bipado depois fica', () => {
  // 10 P gravadas; depois a pessoa bipou mais 7 M e reenviou a lista com as duas.
  const lista = [peca(1, 10), peca(2, 7)];
  assert.deepEqual(tirarOQueJaEntrou(lista, [{ variante_id: 1, quantidade: 10 }]), [peca(2, 7)]);
});

test('peça bipada a mais depois da gravação fica só com a diferença', () => {
  const lista = [peca(1, 12)];
  assert.deepEqual(tirarOQueJaEntrou(lista, [{ variante_id: 1, quantidade: 10 }]), [peca(1, 2)]);
});

test('peça que a lista nem tem mais não inventa linha nem fica negativa', () => {
  const lista = [peca(2, 3)];
  assert.deepEqual(tirarOQueJaEntrou(lista, [{ variante_id: 1, quantidade: 10 }]), [peca(2, 3)]);
  assert.deepEqual(tirarOQueJaEntrou([peca(1, 4)], [{ variante_id: 1, quantidade: 10 }]), []);
});
