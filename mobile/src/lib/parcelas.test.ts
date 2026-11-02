import assert from 'node:assert/strict';
import test from 'node:test';

import { diferencaDaNota, notaFecha, somarDias, sugerirParcelas } from './parcelas';

test('30/60/90 a partir de hoje, sem perder centavo', () => {
  const parcelas = sugerirParcelas(100_000, 3, '2026-11-02');
  assert.deepEqual(parcelas, [
    { vencimento: '2026-12-02', valor: 33_334 },
    { vencimento: '2027-01-01', valor: 33_333 },
    { vencimento: '2027-01-31', valor: 33_333 },
  ]);
  assert.equal(diferencaDaNota(100_000, parcelas), 0);
  assert.equal(notaFecha(100_000, parcelas), true);
});

test('somar dias atravessa mês e ano bissexto sem fuso', () => {
  assert.equal(somarDias('2028-02-28', 1), '2028-02-29');
  assert.equal(somarDias('2026-12-31', 1), '2027-01-01');
  assert.equal(somarDias('2026-03-01', -1), '2026-02-28');
});

test('parcela mexida à mão que não fecha com a nota não grava', () => {
  const parcelas = sugerirParcelas(90_000, 3, '2026-11-02');
  parcelas[2] = { ...parcelas[2], valor: 20_000 };
  assert.equal(diferencaDaNota(90_000, parcelas), 10_000);
  assert.equal(notaFecha(90_000, parcelas), false);
});

test('nota sem valor, sem parcela ou com parcela zerada não grava', () => {
  assert.deepEqual(sugerirParcelas(0, 3, '2026-11-02'), []);
  assert.equal(notaFecha(0, []), false);
  assert.equal(notaFecha(100, [{ vencimento: '2026-12-02', valor: 0 }, { vencimento: '2027-01-01', valor: 100 }]), false);
  assert.equal(notaFecha(100, [{ vencimento: '', valor: 100 }]), false);
});
