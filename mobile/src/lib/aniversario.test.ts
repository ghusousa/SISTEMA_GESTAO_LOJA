import assert from 'node:assert/strict';
import test from 'node:test';

import { dataBR, mascararData, paraDataISO } from './aniversario';

const HOJE = new Date(2026, 10, 2); // 02/11/2026, no relógio local

test('a data falada vira a data da API', () => {
  assert.equal(paraDataISO('14/03/1990', HOJE), '1990-03-14');
  assert.equal(paraDataISO('14031990', HOJE), '1990-03-14');
});

test('29 de fevereiro só existe em ano bissexto', () => {
  assert.equal(paraDataISO('29/02/2000', HOJE), '2000-02-29');
  assert.equal(paraDataISO('29/02/1999', HOJE), null);
  assert.equal(paraDataISO('31/04/1990', HOJE), null);
});

test('nascer no futuro ou em 1850 é erro de digitação', () => {
  assert.equal(paraDataISO('03/11/2026', HOJE), null);
  assert.equal(paraDataISO('02/11/2026', HOJE), '2026-11-02');
  assert.equal(paraDataISO('01/01/1850', HOJE), null);
});

test('data pela metade não vale', () => {
  assert.equal(paraDataISO('14/03', HOJE), null);
  assert.equal(paraDataISO('', HOJE), null);
  assert.equal(paraDataISO('00/01/1990', HOJE), null);
  assert.equal(paraDataISO('10/13/1990', HOJE), null);
});

test('a data da API aparece sem o fuso comer um dia', () => {
  assert.equal(dataBR('1990-03-14'), '14/03/1990');
  assert.equal(dataBR(null), '');
});

test('a máscara põe as barras enquanto a pessoa digita', () => {
  assert.equal(mascararData('14'), '14');
  assert.equal(mascararData('1403'), '14/03');
  assert.equal(mascararData('14031990'), '14/03/1990');
  assert.equal(mascararData('14/03/19901'), '14/03/1990');
});
