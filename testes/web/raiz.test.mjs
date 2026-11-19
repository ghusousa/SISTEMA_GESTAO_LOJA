/**
 * A raiz da página (ADR-46): a loja em `/app/`, a demonstração em `/demo/app/` — no MESMO
 * domínio, cada uma com a sua API. Tudo o que o web pede ao servidor sai da raiz da página:
 * um `/api/v1` seco, na página da demo, entraria, venderia e buscaria fotos na loja de
 * verdade; e as chaves do navegador, com o mesmo nome, seriam divididas entre as duas.
 *
 * Roda sem navegador: `node --test testes/web/*.test.mjs`. A primeira metade confere as
 * regras de `web/js/raiz.js`; a segunda, a ligação de verdade em `api.js` e `tempo-real.js`.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { enderecoDaFoto, naRaiz, nomeNaRaiz, raizDaPagina, raizDoCaminho } from '../../web/js/raiz.js';

/** Abre a "página" neste endereço: o que o navegador poria em `location`. */
const naPagina = (endereco) => {
  globalThis.location = new URL(endereco);
};

const microtarefas = () => new Promise((r) => setImmediate(r));

// ------------------------------------------------------------------ raiz.js

test('raizDoCaminho: a loja em /app/ tem raiz vazia, a demo em /demo/app/ tem /demo', () => {
  assert.equal(raizDoCaminho('/app/'), '');
  assert.equal(raizDoCaminho('/app/index.html'), '');
  assert.equal(raizDoCaminho('/app'), '');
  assert.equal(raizDoCaminho('/demo/app/'), '/demo');
  assert.equal(raizDoCaminho('/demo/app/index.html'), '/demo');
  assert.equal(raizDoCaminho('/demo/app'), '/demo');
});

test('raizDoCaminho: endereço que não é o /app da página fica na origem, como sempre foi', () => {
  for (const caminho of [undefined, null, '', '/', '/index.html', '/demo/', '/apple/', '/app-novo/']) {
    assert.equal(raizDoCaminho(caminho), '', String(caminho));
  }
});

test('raizDoCaminho: o /app que conta é o do fim', () => {
  // Um prefixo que também se chame "app" (o servidor aceita qualquer `^/[a-z0-9-]+$`).
  assert.equal(raizDoCaminho('/app/app/'), '/app');
  assert.equal(raizDoCaminho('/lojas/app-centro/app/'), '/lojas/app-centro');
});

test('raizDoCaminho: barra dobrada não vira endereço de outro site', () => {
  // "//outro.site" + "/api/v1" é URL sem esquema: o fetch iria a OUTRO host, com o token.
  assert.equal(raizDoCaminho('//outro.site/app/'), '/outro.site');
  assert.equal(raizDoCaminho('/demo//app/'), '/demo');
  const pedido = new URL(`${raizDoCaminho('//outro.site/app/')}/api/v1`, 'https://loja.exemplo/demo/app/');
  assert.equal(pedido.host, 'loja.exemplo');
});

test('raizDaPagina e naRaiz leem o endereço da página a cada chamada', () => {
  naPagina('https://loja.exemplo/demo/app/');
  assert.equal(raizDaPagina(), '/demo');
  assert.equal(naRaiz('/privacidade'), '/demo/privacidade');
  naPagina('https://loja.exemplo/app/');
  assert.equal(raizDaPagina(), '');
  assert.equal(naRaiz('/privacidade'), '/privacidade');
  // Sem `location` (Node puro) é a origem, sem quebrar.
  delete globalThis.location;
  assert.equal(raizDaPagina(), '');
});

test('nomeNaRaiz: na loja o nome de sempre (nada guardado se perde), na demo com a raiz', () => {
  assert.equal(nomeNaRaiz('leitor-celular', ''), 'leitor-celular');
  assert.equal(nomeNaRaiz('loja.etiqueta.formato', ''), 'loja.etiqueta.formato');
  assert.equal(nomeNaRaiz('leitor-celular', '/demo'), 'leitor-celular@/demo');
  assert.equal(nomeNaRaiz('loja.etiqueta.formato', '/demo'), 'loja.etiqueta.formato@/demo');

  naPagina('https://loja.exemplo/app/');
  assert.equal(nomeNaRaiz('leitor-celular'), 'leitor-celular');
  naPagina('https://loja.exemplo/demo/app/');
  assert.equal(nomeNaRaiz('leitor-celular'), 'leitor-celular@/demo');
});

test('enderecoDaFoto: a foto do disco ganha a raiz, a URL absoluta do Blob passa direto', () => {
  assert.equal(enderecoDaFoto('/media/produtos/7.jpg', ''), '/media/produtos/7.jpg');
  assert.equal(enderecoDaFoto('/media/produtos/7.jpg', '/demo'), '/demo/media/produtos/7.jpg');
  assert.equal(enderecoDaFoto('media/produtos/7.jpg', '/demo'), '/demo/media/produtos/7.jpg');

  const blob = 'https://abc123.public.blob.vercel-storage.com/produtos/production/7.jpg';
  assert.equal(enderecoDaFoto(blob, ''), blob);
  assert.equal(enderecoDaFoto(blob, '/demo'), blob);
  assert.equal(enderecoDaFoto('HTTP://192.168.0.10:8000/media/7.jpg', '/demo'), 'HTTP://192.168.0.10:8000/media/7.jpg');

  assert.equal(enderecoDaFoto(null, '/demo'), null);
  assert.equal(enderecoDaFoto('', '/demo'), null);

  naPagina('https://loja.exemplo/demo/app/');
  assert.equal(enderecoDaFoto('/media/produtos/7.jpg'), '/demo/media/produtos/7.jpg');
  naPagina('https://loja.exemplo/app/');
  assert.equal(enderecoDaFoto('/media/produtos/7.jpg'), '/media/produtos/7.jpg');
});

// ------------------------------------------------------- a ligação de verdade

test('api.js: o pedido, a renovação pelo cookie e o convite do leitor saem da raiz', async () => {
  const pedidos = [];
  globalThis.fetch = async (url) => {
    pedidos.push(url);
    return new Response(JSON.stringify({ access_token: 'tok', usuario: { id: 1 } }), { status: 200 });
  };
  const { api, baseDaApi, restaurarSessao } = await import('../../web/js/api.js');

  naPagina('https://loja.exemplo/demo/app/');
  await api.get('/configuracao');
  assert.equal(pedidos.at(-1), '/demo/api/v1/configuracao');
  // O cookie do refresh da demo vale só em /demo/api/v1/auth: a renovação tem de ir lá.
  await restaurarSessao();
  assert.equal(pedidos.at(-1), '/demo/api/v1/auth/refresh');
  // O convite do QR leva o caminho: loja e demo têm o mesmo host.
  assert.equal(baseDaApi(), 'https://loja.exemplo/demo/api/v1');

  naPagina('https://loja.exemplo/demo/app/index.html');
  await api.get('/variantes', { q: 'blusa' });
  assert.equal(pedidos.at(-1), '/demo/api/v1/variantes?q=blusa');

  naPagina('https://loja.exemplo/app/');
  await api.get('/configuracao');
  assert.equal(pedidos.at(-1), '/api/v1/configuracao');
  await restaurarSessao();
  assert.equal(pedidos.at(-1), '/api/v1/auth/refresh');
  assert.equal(baseDaApi(), 'https://loja.exemplo/api/v1');

  naPagina('http://192.168.0.10:8000/app/');
  assert.equal(baseDaApi(), 'http://192.168.0.10:8000/api/v1');
});

test('tempo-real.js: o canal liga no tempo real da raiz da página', async () => {
  const criados = [];
  globalThis.WebSocket = class {
    static OPEN = 1;
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      criados.push(this);
    }
    addEventListener() {}
    send() {}
    close() {
      this.readyState = 3;
    }
  };
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ access_token: 'tok', usuario: { id: 1 } }), { status: 200 });

  const { entrar } = await import('../../web/js/api.js');
  const tr = await import('../../web/js/tempo-real.js');
  await entrar('dono@demo.example', 'senha');

  naPagina('https://loja.exemplo/demo/app/');
  tr.conectarTempoReal();
  await microtarefas();
  assert.equal(criados.length, 1);
  assert.equal(criados[0].url, 'wss://loja.exemplo/demo/api/v1/tempo-real');
  tr.desconectarTempoReal();

  naPagina('http://192.168.0.10:8000/app/');
  tr.conectarTempoReal();
  await microtarefas();
  assert.equal(criados.length, 2);
  assert.equal(criados[1].url, 'ws://192.168.0.10:8000/api/v1/tempo-real');
  tr.desconectarTempoReal();
});
