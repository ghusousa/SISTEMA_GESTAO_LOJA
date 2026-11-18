import assert from 'node:assert/strict';
import test from 'node:test';

import { montarUrlDaFoto } from './enderecoDaFoto';

const LOJA = 'http://192.168.0.10:8000';
const BLOB = 'https://loja123.public.blob.vercel-storage.com/produtos/7-abc.jpg';

test('foto do disco da loja: caminho relativo ganha o servidor do aparelho', () => {
  assert.equal(montarUrlDaFoto('/media/produtos/7-abc.jpg', LOJA), `${LOJA}/media/produtos/7-abc.jpg`);
  assert.equal(montarUrlDaFoto('/media/produtos/7-abc.jpg', `${LOJA}/`), `${LOJA}/media/produtos/7-abc.jpg`);
});

test('foto no Vercel Blob: a URL absoluta passa como está, sem o servidor na frente', () => {
  assert.equal(montarUrlDaFoto(BLOB, LOJA), BLOB);
  assert.equal(montarUrlDaFoto(BLOB, 'https://loja-tria.vercel.app'), BLOB);
});

test('sem foto não há endereço', () => {
  assert.equal(montarUrlDaFoto(null, LOJA), null);
  assert.equal(montarUrlDaFoto(undefined, LOJA), null);
  assert.equal(montarUrlDaFoto('', LOJA), null);
});

test('caminho que só COMEÇA com "http" não é endereço absoluto', () => {
  assert.equal(montarUrlDaFoto('httpfoto.jpg', LOJA), `${LOJA}/httpfoto.jpg`);
});
