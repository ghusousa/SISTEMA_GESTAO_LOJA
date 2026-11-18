/**
 * A arte das capturas não corrige o app: a barra de status sai na cor que o app pede para a
 * tela, e a montagem para se essa cor sumir sobre o fundo (`compor.mjs`).
 *
 *   node --test publicar/teste/capturas.test.mjs
 *
 * Antes, a cor vinha da luminância da foto: o print 01-vender saía com a hora em preto,
 * legível, enquanto o app real pintava a barra de branco sobre o fundo quase branco do PDV.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { tintaDaBarra } from '../capturas/compor.mjs';

test('a barra sai na cor que o app pediu, quando ela se lê sobre o fundo', () => {
  assert.equal(tintaDaBarra('escura', true), '#000000', 'PDV: fundo claro, barra escura');
  assert.equal(tintaDaBarra('clara', false), '#FFFFFF', 'cabeçalho azul, barra clara');
});

test('a cor pedida que some sobre o fundo PARA a montagem, em vez de virar a outra', () => {
  // O caso do achado: o app pede clara (a raiz) numa tela de fundo claro sem cabeçalho.
  assert.throws(() => tintaDaBarra('clara', true, '01-vender'), /01-vender: o app pede a barra de status clara sobre um fundo claro/);
  assert.throws(() => tintaDaBarra('escura', false, '04-relatorios'), /escura sobre um fundo escuro/);
});
