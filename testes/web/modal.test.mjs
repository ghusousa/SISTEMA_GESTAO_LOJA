/**
 * O modal do web (`ui.js`) preso enquanto um pedido roda (ADR-45).
 *
 * "Excluir minha conta" e o "Excluir" de Usuários ficam alguns segundos com o pedido no ar
 * (bcrypt e banco; mais na Vercel fria). Antes, Esc, ✕ ou um clique fora fechavam o modal no
 * meio: a promessa resolvia `undefined`, o `fechar('excluida')` que chegava depois era
 * ignorado, e a aba ficava em Minha conta como se nada tivesse acontecido — com a conta já
 * excluída no servidor. `travar(true)` segura; `fechar` de quem chamou continua valendo.
 *
 * Roda sem navegador: `node --test testes/web/*.test.mjs`, com um `document` de mentira só
 * com o que o `modal` toca. Mora FORA de `web/` de propósito: tudo lá é servido em `/app`.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { modal } from '../../web/js/ui.js';

/** Um elemento de mentira: guarda ouvintes e devolve um filho fixo por seletor. */
function elemento() {
  const ouvintes = {};
  const filhos = {};
  return {
    className: '',
    innerHTML: '',
    disabled: false,
    isConnected: true,
    addEventListener(tipo, fn) {
      (ouvintes[tipo] ??= []).push(fn);
    },
    disparar(tipo, evento = {}) {
      for (const fn of ouvintes[tipo] ?? []) fn(evento);
    },
    querySelector(seletor) {
      filhos[seletor] ??= elemento();
      return filhos[seletor];
    },
    remove() {
      this.isConnected = false;
    },
    focus() {},
  };
}

function documentoFalso() {
  const doc = elemento();
  doc.activeElement = null;
  doc.criados = [];
  doc.removeEventListener = () => {};
  doc.createElement = () => {
    const el = elemento();
    doc.criados.push(el);
    return el;
  };
  doc.body = { append() {} };
  return doc;
}

/** Abre um modal e devolve o fundo, o ✕, as funções do `aoAbrir` e a promessa. */
function abrir() {
  globalThis.document = documentoFalso();
  let controle;
  const promessa = modal({
    titulo: 'Excluir minha conta',
    render: () => '',
    aoAbrir: (_corpo, fechar, travar) => {
      controle = { fechar, travar };
    },
  });
  const fundo = document.criados[0];
  return { promessa, fundo, xis: fundo.querySelector('[data-fechar]'), ...controle };
}

const PENDENTE = Symbol('pendente');
const situacao = (promessa) => Promise.race([promessa, new Promise((r) => setImmediate(() => r(PENDENTE)))]);
const escape = { key: 'Escape', stopPropagation() {} };

test('preso: Esc, ✕ e clique fora não fecham, e o resultado do pedido chega a quem chamou', async () => {
  const { promessa, fundo, xis, fechar, travar } = abrir();
  travar(true);
  assert.equal(xis.disabled, true, 'o ✕ fica desligado enquanto o pedido roda');

  document.disparar('keydown', escape);
  xis.disparar('click');
  fundo.disparar('mousedown', { target: fundo });
  assert.equal(await situacao(promessa), PENDENTE, 'o modal fechou no meio do pedido');

  fechar('excluida');
  assert.equal(await promessa, 'excluida');
});

test('solto de novo (o pedido voltou com erro), Esc volta a fechar', async () => {
  const { promessa, xis, travar } = abrir();
  travar(true);
  travar(false);
  assert.equal(xis.disabled, false);
  document.disparar('keydown', escape);
  assert.equal(await promessa, undefined);
});

test('sem trava, o modal de sempre: ✕ e clique fora fecham com undefined', async () => {
  const primeiro = abrir();
  primeiro.xis.disparar('click');
  assert.equal(await primeiro.promessa, undefined);

  const segundo = abrir();
  segundo.fundo.disparar('mousedown', { target: {} });
  assert.equal(await situacao(segundo.promessa), PENDENTE, 'clique DENTRO da caixa não fecha');
  segundo.fundo.disparar('mousedown', { target: segundo.fundo });
  assert.equal(await segundo.promessa, undefined);
});
