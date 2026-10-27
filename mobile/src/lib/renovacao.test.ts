import assert from 'node:assert/strict';
import test from 'node:test';

import { refreshRecusado } from './renovacao';

test('token recusado pelo servidor encerra a sessão', () => {
  assert.equal(refreshRecusado(401), true);
  assert.equal(refreshRecusado(403), true);
});

test('queda de rede ou timeout no refresh não desloga', () => {
  // Sem resposta: o axios não tem `response`, e o status não existe.
  assert.equal(refreshRecusado(undefined), false);
});

test('servidor fora do ar no refresh não apaga o token nem o carrinho', () => {
  // 502/503/504 é o Caddy de pé com a API reiniciando no atualizar.sh.
  for (const status of [500, 502, 503, 504]) assert.equal(refreshRecusado(status), false);
});

test('outro erro do refresh não é prova de token inválido', () => {
  for (const status of [400, 404, 422, 429]) assert.equal(refreshRecusado(status), false);
});
