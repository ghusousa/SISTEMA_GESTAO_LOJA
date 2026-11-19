/**
 * O canal de tempo real do web cai e volta, e ao voltar redesenha a tela.
 *
 * Roda sem navegador: `node --test testes/web/*.test.mjs`. Na Vercel o servidor FECHA o socket no
 * `maxDuration` da função, toda vez; o que mudou enquanto a aba não ouvia só aparece se o
 * "conectado" da religação mandar redesenhar. A regra mora em `web/js/canal.js` (espelho de
 * `mobile/src/lib/canal.ts`, que tem os mesmos casos em `canal.test.ts`), e a segunda metade
 * deste arquivo confere a ligação de verdade em `web/js/tempo-real.js`.
 *
 * Mora FORA de `web/` de propósito: tudo o que está lá é servido em `/app` (imagem Docker e
 * cópia da Vercel), e teste não é página da loja.
 */

import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import {
  criarCanal,
  ESPERA_INICIAL,
  ESPERA_MAXIMA,
  esperaDaTentativa,
} from '../../web/js/canal.js';

const microtarefas = () => new Promise((r) => setImmediate(r));

/** O servidor do outro lado, controlado pelo teste. */
class SocketFalso {
  constructor(ouvidos) {
    this.ouvidos = ouvidos;
    this.enviados = [];
    this.fechado = false;
    this.estado = 'abrindo';
  }
  enviar(dados) {
    this.enviados.push(JSON.parse(dados));
  }
  fechar() {
    this.fechado = true;
    this.estado = 'fechado';
  }
  aberta() {
    return this.estado === 'aberto';
  }
  abrir() {
    this.estado = 'aberto';
    this.ouvidos.aoAbrir();
  }
  mandar(assunto) {
    this.ouvidos.aoReceber(JSON.stringify({ assunto, dados: {} }));
  }
  cair() {
    this.estado = 'fechado';
    this.ouvidos.aoCair();
  }
}

function relogioDeTeste() {
  let agora = 0;
  let proximoId = 0;
  const pendentes = new Map();
  return {
    relogio: {
      agendar: (fn, ms) => {
        proximoId += 1;
        pendentes.set(proximoId, { quando: agora + ms, fn });
        return proximoId;
      },
      cancelar: (id) => pendentes.delete(id),
    },
    avancar(ms) {
      const alvo = agora + ms;
      for (;;) {
        const vencidos = [...pendentes.entries()]
          .filter(([, t]) => t.quando <= alvo)
          .sort((a, b) => a[1].quando - b[1].quando);
        if (vencidos.length === 0) break;
        const [id, t] = vencidos[0];
        pendentes.delete(id);
        agora = t.quando;
        t.fn();
      }
      agora = alvo;
    },
  };
}

function montar() {
  const { relogio, avancar } = relogioDeTeste();
  const sockets = [];
  const avisos = [];
  let recargas = 0;
  const canal = criarCanal({
    abrirSocket(ouvidos) {
      const s = new SocketFalso(ouvidos);
      sockets.push(s);
      return s;
    },
    lerToken: () => 'tok',
    relogio,
    aoConectar: () => {
      recargas += 1;
    },
    aoAvisar: (a) => avisos.push(a),
  });
  return {
    canal,
    sockets,
    avisos,
    recargas: () => recargas,
    ultimo: () => sockets.at(-1),
    async esperar(ms) {
      avancar(ms);
      await microtarefas();
    },
  };
}

// ------------------------------------------------------------------------- canal.js

test('a espera dobra a cada falha e para em 30 s', () => {
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5, 6].map(esperaDaTentativa),
    [1000, 2000, 4000, 8000, 16000, 30000, 30000],
  );
});

test('a Vercel fecha o socket no maxDuration: religa em 1 s e redesenha de novo', async () => {
  const t = montar();
  t.canal.ligar();
  await microtarefas();
  t.ultimo().abrir();
  assert.deepEqual(t.ultimo().enviados, [{ tipo: 'entrar', token: 'tok' }]);
  t.ultimo().mandar('conectado');
  assert.equal(t.recargas(), 1);

  for (let volta = 1; volta <= 3; volta += 1) {
    t.ultimo().cair();
    await t.esperar(ESPERA_INICIAL - 1);
    assert.equal(t.sockets.length, volta, 'ainda esperando');
    await t.esperar(1);
    assert.equal(t.sockets.length, volta + 1, 'religou em 1 s');
    t.ultimo().abrir();
    t.ultimo().mandar('conectado');
    assert.equal(t.recargas(), volta + 1, 'o buraco da queda vira redesenho');
  }
});

test('servidor fora do ar: espera crescente até o teto, zerada só pelo conectado', async () => {
  const t = montar();
  t.canal.ligar();
  await microtarefas();
  for (const espera of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
    const antes = t.sockets.length;
    t.ultimo().cair();
    await t.esperar(espera - 1);
    assert.equal(t.sockets.length, antes, `não religa antes de ${espera} ms`);
    await t.esperar(1);
    assert.equal(t.sockets.length, antes + 1, `religa em ${espera} ms`);
  }
  t.ultimo().abrir();
  t.ultimo().mandar('conectado');
  t.ultimo().cair();
  const antes = t.sockets.length;
  await t.esperar(ESPERA_INICIAL);
  assert.equal(t.sockets.length, antes + 1);
});

test('close e error juntos religam uma vez; ping não vira aviso; logout não religa', async () => {
  const t = montar();
  t.canal.ligar();
  await microtarefas();
  t.ultimo().cair();
  t.ultimo().cair();
  await t.esperar(ESPERA_MAXIMA);
  assert.equal(t.sockets.length, 2);

  t.ultimo().abrir();
  t.ultimo().mandar('conectado');
  t.ultimo().mandar('ping');
  t.ultimo().mandar('estoque');
  assert.deepEqual(t.avisos, ['estoque']);

  t.canal.desligar();
  assert.ok(t.ultimo().fechado);
  t.ultimo().cair();
  await t.esperar(ESPERA_MAXIMA * 2);
  assert.equal(t.sockets.length, 2);
});

// ------------------------------------------------------------- tempo-real.js de verdade

test('tempo-real.js: o conectado de cada religação redesenha a tela inscrita', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const criados = [];
    globalThis.location = { protocol: 'https:', host: 'loja.exemplo' };
    globalThis.WebSocket = class {
      static OPEN = 1;
      constructor(url) {
        this.url = url;
        this.readyState = 0;
        this.enviados = [];
        this.ouvintes = {};
        criados.push(this);
      }
      addEventListener(tipo, fn) {
        (this.ouvintes[tipo] ??= []).push(fn);
      }
      send(dados) {
        this.enviados.push(JSON.parse(dados));
      }
      close() {
        this.readyState = 3;
      }
      disparar(tipo, evento = {}) {
        if (tipo === 'open') this.readyState = 1;
        if (tipo === 'close') this.readyState = 3;
        for (const fn of this.ouvintes[tipo] ?? []) fn(evento);
      }
      receber(assunto) {
        this.disparar('message', { data: JSON.stringify({ assunto, dados: {} }) });
      }
    };
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ access_token: 'tok', usuario: { id: 1 } }), { status: 200 });

    const { entrar } = await import('../../web/js/api.js');
    const tr = await import('../../web/js/tempo-real.js');
    await entrar('dona@loja.com', 'senha');

    const redesenhos = [];
    const parar = tr.ouvir(['estoque', 'reconectado'], (motivo) => redesenhos.push(motivo));

    tr.conectarTempoReal();
    await microtarefas();
    assert.equal(criados.length, 1);
    assert.equal(criados[0].url, 'wss://loja.exemplo/api/v1/tempo-real');
    criados[0].disparar('open');
    assert.deepEqual(criados[0].enviados, [{ tipo: 'entrar', token: 'tok' }]);
    criados[0].receber('conectado');
    assert.deepEqual(redesenhos, ['reconectado']);

    // O servidor fecha no maxDuration. Uma venda em outra instância acontece no buraco.
    criados[0].disparar('close');
    mock.timers.tick(ESPERA_INICIAL);
    await microtarefas();
    assert.equal(criados.length, 2, 'religou sozinho');
    criados[1].disparar('open');
    criados[1].receber('conectado');
    assert.deepEqual(redesenhos, ['reconectado', 'reconectado'], 'o buraco vira redesenho');

    // Avisos normais seguem em rodada (1 s de silêncio).
    criados[1].receber('estoque');
    assert.equal(redesenhos.length, 2);
    mock.timers.tick(1000);
    assert.deepEqual(redesenhos.at(-1), 'estoque');

    parar();
    tr.desconectarTempoReal();
  } finally {
    mock.timers.reset();
  }
});

test('tempo-real.js: ouvirNaHora chama no instante do aviso, sem esperar a rodada', async () => {
  // O celular-leitor (ADR-43): o bipe tem de cair no carrinho já, e a rodada segura o
  // aviso de 1 a 2 s. Quem ouve pela rodada continua igual.
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const criados = [];
    globalThis.location = { protocol: 'https:', host: 'loja.exemplo' };
    globalThis.WebSocket = class {
      static OPEN = 1;
      constructor() {
        this.readyState = 0;
        this.ouvintes = {};
        criados.push(this);
      }
      addEventListener(tipo, fn) {
        (this.ouvintes[tipo] ??= []).push(fn);
      }
      send() {}
      close() {
        this.readyState = 3;
      }
      disparar(tipo, evento = {}) {
        if (tipo === 'open') this.readyState = 1;
        if (tipo === 'close') this.readyState = 3;
        for (const fn of this.ouvintes[tipo] ?? []) fn(evento);
      }
      receber(assunto) {
        this.disparar('message', { data: JSON.stringify({ assunto }) });
      }
    };
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ access_token: 'tok', usuario: { id: 1 } }), { status: 200 });

    const { entrar } = await import('../../web/js/api.js');
    const tr = await import('../../web/js/tempo-real.js');
    await entrar('dona@loja.com', 'senha');

    const naHora = [];
    const naRodada = [];
    const pararNaHora = tr.ouvirNaHora(['leitor', 'reconectado'], (a) => naHora.push(a));
    const pararRodada = tr.ouvir(['leitor'], (a) => naRodada.push(a));

    tr.conectarTempoReal();
    await microtarefas();
    const ws = criados.at(-1);
    ws.disparar('open');
    assert.equal(tr.canalConectado(), false, 'socket aberto ainda não é "conectado"');
    ws.receber('conectado');
    assert.equal(tr.canalConectado(), true);
    assert.deepEqual(naHora, ['reconectado'], 'o canal de volta também acorda o leitor');

    ws.receber('leitor');
    assert.deepEqual(naHora, ['reconectado', 'leitor'], 'na hora, sem tick');
    assert.deepEqual(naRodada, [], 'a rodada ainda espera');
    mock.timers.tick(1000);
    assert.deepEqual(naRodada, ['leitor'], 'quem ouve pela rodada não mudou');

    ws.receber('estoque');
    assert.equal(naHora.length, 2, 'assunto que não interessa não chama');

    ws.disparar('close');
    assert.equal(tr.canalConectado(), false, 'caiu: o leitor volta a buscar de 2 em 2 s');

    pararNaHora();
    pararRodada();
    tr.desconectarTempoReal();
    assert.equal(tr.canalConectado(), false);
  } finally {
    mock.timers.reset();
  }
});

test('tempo-real.js: o atendimento do chamado ("leitor_pareamento") também chega na hora', async () => {
  // ADR-47: "leitor" ficou só para o bipe; o celular que atende o chamado (ou aceita o QR)
  // sai como "leitor_pareamento", e a área do computador tem de dizer "ligado" sem esperar a
  // rodada de 1 a 2 s. O assunto novo passa pelo canal como qualquer outro.
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const criados = [];
    globalThis.location = { protocol: 'https:', host: 'loja.exemplo' };
    globalThis.WebSocket = class {
      static OPEN = 1;
      constructor() {
        this.readyState = 0;
        this.ouvintes = {};
        criados.push(this);
      }
      addEventListener(tipo, fn) {
        (this.ouvintes[tipo] ??= []).push(fn);
      }
      send() {}
      close() {
        this.readyState = 3;
      }
      disparar(tipo, evento = {}) {
        if (tipo === 'open') this.readyState = 1;
        if (tipo === 'close') this.readyState = 3;
        for (const fn of this.ouvintes[tipo] ?? []) fn(evento);
      }
      receber(assunto) {
        this.disparar('message', { data: JSON.stringify({ assunto }) });
      }
    };
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ access_token: 'tok', usuario: { id: 1 } }), { status: 200 });

    const { entrar } = await import('../../web/js/api.js');
    const tr = await import('../../web/js/tempo-real.js');
    await entrar('dona@loja.com', 'senha');

    const naHora = [];
    const naRodada = [];
    const pararNaHora = tr.ouvirNaHora(['leitor', 'leitor_pareamento', 'reconectado'], (a) => naHora.push(a));
    const pararRodada = tr.ouvir(['leitor_pareamento'], (a) => naRodada.push(a));

    tr.conectarTempoReal();
    await microtarefas();
    const ws = criados.at(-1);
    ws.disparar('open');
    ws.receber('conectado');
    ws.receber('leitor_pareamento');
    assert.deepEqual(naHora, ['reconectado', 'leitor_pareamento'], 'na hora, sem tick');
    assert.deepEqual(naRodada, [], 'a rodada ainda espera');
    ws.receber('leitor');
    assert.deepEqual(naHora, ['reconectado', 'leitor_pareamento', 'leitor'], 'o bipe segue chegando na hora');
    mock.timers.tick(1000);
    assert.deepEqual(naRodada, ['leitor_pareamento']);

    pararNaHora();
    pararRodada();
    tr.desconectarTempoReal();
  } finally {
    mock.timers.reset();
  }
});
