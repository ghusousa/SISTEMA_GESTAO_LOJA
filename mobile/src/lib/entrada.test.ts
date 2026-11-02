import assert from 'node:assert/strict';
import test from 'node:test';

import { notaDepoisDoDuplicado, tirarOQueJaEntrou } from './entrada';

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

const notaGravada = {
  numero: 'NF 4512',
  valor_total: '900.00',
  parcelas: [
    { vencimento: '2026-12-02', valor: '300.00' },
    { vencimento: '2027-01-01', valor: '300.00' },
    { vencimento: '2027-01-31', valor: '300.00' },
  ],
};

test('a gravada já levou a nota: ela sai do formulário e a pessoa fica sabendo', () => {
  // Sem isso o reenvio do que falta lançava as 3 parcelas de novo: R$ 1.800 a pagar.
  const r = notaDepoisDoDuplicado({ nota: notaGravada }, true);
  assert.equal(r.tirarNota, true);
  assert.match(r.frase, /A nota NF 4512 \(R\$\s900,00 em 3 parcelas\) já está em Contas a pagar/);
  assert.match(r.frase, /tirei a nota do formulário/);
});

test('a gravada foi sem nota: a do formulário fica e vai com o resto', () => {
  const r = notaDepoisDoDuplicado({ nota: null }, true);
  assert.equal(r.tirarNota, false);
  assert.match(r.frase, /foi sem nota/);
});

test('formulário sem nota: nada a tirar; só avisa se a gravada tinha', () => {
  assert.deepEqual(notaDepoisDoDuplicado({ nota: null }, false), { tirarNota: false, frase: '' });
  const avulsa = { numero: null, valor_total: '300.00', parcelas: [notaGravada.parcelas[0]] };
  const r = notaDepoisDoDuplicado({ nota: avulsa }, false);
  assert.equal(r.tirarNota, false);
  assert.match(r.frase, /^A nota \(R\$\s300,00 em 1 parcela\) já está em Contas a pagar/);
});

test('servidor que não diz a nota (sem a chave): mantém e pede para conferir', () => {
  const r = notaDepoisDoDuplicado({}, true);
  assert.equal(r.tirarNota, false);
  assert.match(r.frase, /Confira em Contas a pagar/);
});
