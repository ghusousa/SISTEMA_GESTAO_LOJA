/**
 * O chamado do celular (ADR-47) do lado do computador, contra um servidor de mentira.
 *
 * Roda sem navegador: `node --test testes/web/*.test.mjs`. O `fetch` responde como o contrato
 * da ADR-47 manda (POST /leitor/chamados e as rotas de pareamento da ADR-43); `sessionStorage`,
 * `document` e o WebSocket também são de mentira, só com o que `leitor-celular.js` toca. Aqui
 * fica o que a tela não mostra: a chave do chamado gravada ANTES do POST, o F5 no meio
 * retomando pela mesma chave, a rede que cai sem resposta, os erros (429, 409), o "Chamar de
 * novo" com leitor ligado, o cancelar, o chamado que vence, a troca que a rodada não pode
 * confundir com "leitores demais", o aviso "leitor_pareamento" acordando a aba na hora e a raiz
 * da demo. As frases e os estados (a parte pura) estão em `leitor-remoto.test.mjs`.
 *
 * Mora FORA de `web/` de propósito: tudo o que está lá é servido em `/app`.
 */

import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

// ------------------------------------------------------------- o navegador de mentira

// Um relógio de mentira só, para o arquivo inteiro: o leitor guarda o timer da rodada num
// módulo que vive de um teste para o outro, e o `clearTimeout` de um relógio por teste
// receberia o timer do relógio do teste anterior. O `setImmediate` continua de verdade.
mock.timers.enable({ apis: ['setTimeout'] });

/** O que a página guardou na aba (o `sessionStorage`). */
const guarda = new Map();
/** Os avisos que a tela mostrou: `{ texto, tipo }`. */
const avisos = [];
/** Os sockets do tempo real que a página abriu. */
const sockets = [];

globalThis.location = { pathname: '/app/', protocol: 'https:', host: 'loja.exemplo', href: 'https://loja.exemplo/app/' };
globalThis.window = { addEventListener() {} };
globalThis.sessionStorage = {
  getItem: (k) => (guarda.has(k) ? guarda.get(k) : null),
  setItem: (k, v) => void guarda.set(k, String(v)),
  removeItem: (k) => void guarda.delete(k),
};
// Sem BroadcastChannel ninguém mais cuida do leitor: a aba dona tem teste próprio.
globalThis.BroadcastChannel = undefined;
const areaDeAvisos = { append: (caixa) => avisos.push({ texto: caixa.textContent, tipo: caixa.className }) };
globalThis.document = {
  visibilityState: 'visible',
  body: null,
  addEventListener() {},
  removeEventListener() {},
  querySelector: () => null,
  getElementById: (id) => (id === 'avisos' ? areaDeAvisos : null),
  createElement: () => ({
    className: '',
    textContent: '',
    classList: { add() {}, remove() {} },
    setAttribute() {},
    addEventListener() {},
    remove() {},
  }),
};
globalThis.WebSocket = class {
  static OPEN = 1;
  constructor() {
    this.readyState = 0;
    this.ouvintes = {};
    sockets.push(this);
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

// ------------------------------------------------------------- o servidor de mentira

/** Cada pedido, com a pendência que a aba tinha guardada NA HORA em que ele saiu. */
const pedidos = [];
/** A regra de resposta do teste: `(pedido) => { status, corpo } | 'sem-rede' | Promise`. */
let responder = () => ({ status: 500, corpo: { code: 'ERRO', message: 'sem regra' } });

globalThis.fetch = async (url, opcoes = {}) => {
  const pedido = {
    url: String(url),
    metodo: opcoes.method,
    caminho: String(url).replace(/^(?:\/demo)?\/api\/v1/, ''),
    corpo: opcoes.body ? JSON.parse(opcoes.body) : undefined,
    pendencia: JSON.parse(guarda.get('leitor-celular-chamado') ?? 'null'),
    chaves: [...guarda.keys()],
  };
  pedidos.push(pedido);
  const r = await responder(pedido);
  if (r === 'sem-rede') throw new TypeError('Failed to fetch');
  return new Response(r.corpo === undefined ? null : JSON.stringify(r.corpo), { status: r.status ?? 200 });
};

const naoEsperado = (p) => ({ status: 500, corpo: { code: 'ERRO', message: `pedido não esperado: ${p.metodo} ${p.caminho}` } });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Um chamado como o `PareamentoOut` da ADR-47 o mostra (código nunca sai). */
function chamado(id, extra = {}) {
  const criado = Date.now();
  return {
    id,
    codigo: null,
    status: 'AGUARDANDO',
    chamado: true,
    sinal: '7K3',
    criado_em: new Date(criado).toISOString(),
    codigo_expira_em: new Date(criado + 300_000).toISOString(),
    aceito_em: null,
    expira_em: null,
    aparelho_nome: null,
    motivo_encerramento: null,
    ...extra,
  };
}

const ativo = (id, extra = {}) => chamado(id, { status: 'ATIVO', aparelho_nome: 'Maria', ...extra });
const lote = (p) => ({ items: [], descartados: 0, pareamento: p });

/** Uma promessa que o teste resolve quando quiser (a resposta que ainda não chegou). */
function adiada() {
  let resolver;
  const promessa = new Promise((r) => {
    resolver = r;
  });
  return { promessa, resolver };
}

/**
 * Deixa as respostas do servidor de mentira e as rodadas andarem, sem andar o relógio (o
 * `setTimeout` é de mentira; o `setImmediate`, não). Cada `Response.text()` do node leva algumas
 * voltas do laço, e uma rodada encadeia dois pedidos: as 60 voltas sobram.
 */
const assentar = async (vezes = 60) => {
  for (let i = 0; i < vezes; i += 1) await new Promise((r) => setImmediate(r));
};

// ------------------------------------------------------------- a página

const api = await import('../../web/js/api.js');
const leitor = await import('../../web/js/leitor-celular.js');
const { estadoDoChamado } = await import('../../web/js/leitor-remoto.js');
const tempoReal = await import('../../web/js/tempo-real.js');

responder = () => ({ corpo: { access_token: 'tok', usuario: { id: 1, nome: 'Dona' } } });
await api.entrar('dona@loja.com', 'senha');

/** A moldura sem botão nem selo: só a área do chamado importa aqui. */
const moldura = { querySelector: () => null };
const estado = (modulo = leitor) => estadoDoChamado(modulo.estadoDoLeitor());

/** Aba nova, sem leitor nem nada guardado. */
function comecar() {
  leitor.pararLeitorCelular();
  guarda.clear();
  pedidos.length = 0;
  avisos.length = 0;
  leitor.ligarLeitorCelular(moldura);
}

/** Leva a aba a "chamando" com o chamado `id` (a notificação saiu como `notificacao`). */
async function comChamado(id = 41, notificacao = 'DESLIGADA') {
  responder = (p) => {
    if (p.caminho === '/leitor/chamados') return { status: 201, corpo: { pareamento: chamado(id), notificacao, celulares: 1 } };
    if (p.caminho === `/leitor/pareamentos/${id}`) return { corpo: chamado(id) };
    return naoEsperado(p);
  };
  await leitor.chamarCelular();
  await assentar();
  assert.equal(estado(), 'chamando');
  pedidos.length = 0;
  avisos.length = 0;
}

// ------------------------------------------------------------- os casos

test('a chave do chamado vai ao sessionStorage ANTES do POST, e sai com a resposta', async () => {
  comecar();
  const pintadas = [];
  const soltar = leitor.aoMudarOLeitor(() => pintadas.push(estado()));
  const resposta = adiada();
  responder = (p) => {
    if (p.caminho === '/leitor/chamados') return resposta.promessa;
    if (p.caminho === '/leitor/pareamentos/41') return { corpo: chamado(41) };
    return naoEsperado(p);
  };

  const clique = leitor.chamarCelular();
  assert.equal(estado(), 'pedindo', '"Chamando…" no clique, antes da resposta');
  assert.deepEqual(pintadas, ['pedindo'], 'a área foi avisada no clique');
  await assentar();
  const [post] = pedidos;
  assert.equal(`${post.metodo} ${post.url}`, 'POST /api/v1/leitor/chamados');
  assert.match(post.corpo.client_uuid, UUID);
  assert.deepEqual(post.corpo, { client_uuid: post.corpo.client_uuid, substitui_id: null });
  assert.equal(post.pendencia?.client_uuid, post.corpo.client_uuid, 'a chave já estava guardada quando o POST saiu');
  assert.equal(post.pendencia.usuario_id, 1);

  resposta.resolver({ status: 201, corpo: { pareamento: chamado(41), notificacao: 'DESLIGADA', celulares: 1 } });
  await clique;
  await assentar();
  assert.equal(estado(), 'chamando');
  assert.equal(pintadas.at(-1), 'chamando');
  assert.deepEqual(leitor.estadoDoLeitor().notificacao, { situacao: 'DESLIGADA', celulares: 1 });
  assert.equal(guarda.get('leitor-celular'), '41', 'o id do chamado, para o F5');
  assert.equal(guarda.has('leitor-celular-chamado'), false, 'a pendência sai com a resposta');
  // E já pergunta se o celular atendeu enquanto a notificação saía (o commit vem antes dela).
  assert.ok(pedidos.some((p) => `${p.metodo} ${p.caminho}` === 'GET /leitor/pareamentos/41'));
  soltar();
});

test('F5 no meio do POST: a página nova reenvia a MESMA chave e retoma o mesmo chamado', async () => {
  comecar();
  // A página recarrega antes da resposta: este POST nunca é respondido a ela.
  responder = (p) => (p.caminho === '/leitor/chamados' ? new Promise(() => {}) : naoEsperado(p));
  void leitor.chamarCelular();
  await assentar();
  const primeiro = pedidos.find((p) => p.caminho === '/leitor/chamados');
  leitor.pararLeitorCelular({ esquecerAba: false }); // o módulo da página que saiu morre aqui

  const recarregada = await import('../../web/js/leitor-celular.js?f5');
  pedidos.length = 0;
  responder = (p) => {
    // O servidor já tinha criado o #41 com esta chave: devolve o mesmo, sem notificar de novo.
    if (p.caminho === '/leitor/chamados') return { status: 200, corpo: { pareamento: chamado(41), notificacao: null, celulares: 0 } };
    if (p.caminho === '/leitor/pareamentos/41') return { corpo: chamado(41) };
    return naoEsperado(p);
  };
  recarregada.ligarLeitorCelular(moldura);
  await assentar();
  const reenvio = pedidos.filter((p) => p.caminho === '/leitor/chamados');
  assert.equal(reenvio.length, 1);
  assert.deepEqual(reenvio[0].corpo, primeiro.corpo, 'a mesma chave e o mesmo substitui_id');
  assert.equal(estado(recarregada), 'chamando');
  assert.equal(recarregada.estadoDoLeitor().notificacao, null, 'o reenvio não diz como saiu: a dica é a geral');
  assert.equal(guarda.has('leitor-celular-chamado'), false);
  assert.equal(guarda.get('leitor-celular'), '41');
  recarregada.pararLeitorCelular();
});

test('F5 com a chave de outra pessoa, ou de mais de 5 min: esquecida, sem chamar celular nenhum', async () => {
  const chave = '6f1c1b1e-8f0a-4c3e-9b1d-2a7d5e4f3c21';
  for (const pendencia of [
    { client_uuid: chave, substitui_id: null, desde: Date.now(), usuario_id: 2 },
    { client_uuid: chave, substitui_id: null, desde: Date.now() - 6 * 60_000, usuario_id: 1 },
  ]) {
    leitor.pararLeitorCelular();
    guarda.clear();
    pedidos.length = 0;
    guarda.set('leitor-celular-chamado', JSON.stringify(pendencia));
    responder = naoEsperado;
    leitor.ligarLeitorCelular(moldura);
    await assentar();
    assert.deepEqual(pedidos, [], JSON.stringify(pendencia));
    assert.equal(guarda.has('leitor-celular-chamado'), false);
    assert.equal(estado(), 'livre');
  }
});

test('a rede caiu sem resposta: a chave fica, e o próximo clique reenvia a MESMA — sem chamado órfão', async () => {
  comecar();
  responder = () => 'sem-rede';
  await leitor.chamarCelular();
  assert.equal(estado(), 'livre');
  assert.equal(avisos.at(-1).tipo, 'aviso aviso--erro');
  const chave = pedidos.at(-1).corpo.client_uuid;
  assert.equal(JSON.parse(guarda.get('leitor-celular-chamado')).client_uuid, chave, 'sem resposta, o POST pode ter chegado');

  // Tinha chegado: o servidor criou o #41, e o reenvio da chave o devolve em vez de criar outro.
  responder = (p) =>
    p.caminho === '/leitor/chamados'
      ? { status: 200, corpo: { pareamento: chamado(41), notificacao: null, celulares: 0 } }
      : { corpo: chamado(41) };
  await leitor.chamarCelular();
  await assentar();
  assert.equal(pedidos.filter((p) => p.caminho === '/leitor/chamados').at(-1).corpo.client_uuid, chave);
  assert.equal(estado(), 'chamando');
  assert.equal(guarda.has('leitor-celular-chamado'), false);
});

test('429 LEITOR_CHAMADO_RAPIDO: "espere um instante", e a área volta ao que era', async () => {
  comecar();
  await comChamado(41);
  responder = (p) =>
    p.caminho === '/leitor/chamados'
      ? { status: 429, corpo: { code: 'LEITOR_CHAMADO_RAPIDO', message: 'Espere um instante antes de chamar o celular de novo.', detail: { retry_after: 2 } } }
      : naoEsperado(p);
  await leitor.chamarDeNovo();
  assert.equal(pedidos[0].corpo.substitui_id, 41);
  assert.deepEqual(avisos.at(-1), { texto: 'Espere um instante antes de chamar de novo.', tipo: 'aviso aviso--alerta' });
  assert.equal(estado(), 'chamando', 'o chamado que esperava continua');
  assert.equal(leitor.estadoDoLeitor().pareamento.id, 41);
  assert.equal(guarda.has('leitor-celular-chamado'), false, 'recusado pelo servidor: a chave não serve mais');
});

test('409 LEITOR_JA_LIGADO: o celular atendeu no meio — a rodada acha o ligado na hora', async () => {
  comecar();
  await comChamado(41);
  responder = (p) => {
    if (p.caminho === '/leitor/chamados') {
      return { status: 409, corpo: { code: 'LEITOR_JA_LIGADO', message: 'Este computador já tem um celular ligado como leitor.', detail: { pareamento_id: 41 } } };
    }
    if (p.caminho === '/leitor/pareamentos/41') return { corpo: ativo(41) };
    if (p.caminho === '/leitor/pareamentos/41/retirar') return { corpo: lote(ativo(41)) };
    return naoEsperado(p);
  };
  await leitor.chamarDeNovo();
  await assentar(); // sem andar o relógio: não esperou a rodada de 2 s
  assert.equal(estado(), 'ligado');
  assert.equal(avisos.at(-1).texto, 'Celular de Maria ligado como leitor (sinal 7K3).');
  assert.equal(guarda.has('leitor-celular-chamado'), false);
});

test('Chamar de novo com leitor ligado: desliga o antigo (DELETE, que entra no diário) e chama sem substituir', async () => {
  comecar();
  await comChamado(41);
  responder = (p) => {
    if (p.caminho === '/leitor/pareamentos/41') return { corpo: ativo(41) };
    if (p.caminho === '/leitor/pareamentos/41/retirar') return { corpo: lote(ativo(41)) };
    return naoEsperado(p);
  };
  mock.timers.tick(2000); // a rodada de rede de segurança acha o atendimento
  await assentar();
  assert.equal(estado(), 'ligado');
  pedidos.length = 0;

  const novo = chamado(42, { sinal: '4M8' });
  responder = (p) => {
    if (p.metodo === 'DELETE' && p.caminho === '/leitor/pareamentos/41') return { status: 204 };
    if (p.caminho === '/leitor/chamados') return { status: 201, corpo: { pareamento: novo, notificacao: 'SEM_CELULAR', celulares: 0 } };
    if (p.caminho === '/leitor/pareamentos/42') return { corpo: novo };
    return naoEsperado(p);
  };
  await leitor.chamarDeNovo();
  await assentar();
  assert.deepEqual(
    pedidos.slice(0, 2).map((p) => `${p.metodo} ${p.caminho}`),
    ['DELETE /leitor/pareamentos/41', 'POST /leitor/chamados'],
  );
  assert.equal(pedidos[1].corpo.substitui_id, null, 'um ATIVO nunca vai como substitui_id (o servidor daria 409)');
  assert.equal(estado(), 'chamando');
  assert.equal(leitor.estadoDoLeitor().pareamento.sinal, '4M8');
  assert.deepEqual(leitor.estadoDoLeitor().notificacao, { situacao: 'SEM_CELULAR', celulares: 0 });
});

test('Cancelar: DELETE do chamado que espera, com os botões apagados até a resposta; a área volta a livre', async () => {
  comecar();
  await comChamado(41);
  const resposta = adiada();
  responder = (p) => (p.metodo === 'DELETE' && p.caminho === '/leitor/pareamentos/41' ? resposta.promessa : naoEsperado(p));
  const clique = leitor.cancelarEspera();
  assert.equal(leitor.estadoDoLeitor().ocupado, true);
  resposta.resolver({ status: 204 });
  await clique;
  assert.deepEqual(pedidos.map((p) => `${p.metodo} ${p.caminho}`), ['DELETE /leitor/pareamentos/41']);
  assert.equal(estado(), 'livre');
  assert.equal(leitor.estadoDoLeitor().ocupado, false);
  assert.equal(leitor.estadoDoLeitor().notificacao, null);
  assert.equal(guarda.has('leitor-celular'), false);
  assert.deepEqual(avisos, [], 'cancelar foi a própria pessoa: sem aviso');
});

test('o chamado que ninguém atendeu em 5 min vira aviso, e a área volta a livre', async () => {
  comecar();
  await comChamado(41);
  responder = (p) => (p.caminho === '/leitor/pareamentos/41' ? { corpo: chamado(41, { status: 'EXPIRADO' }) } : naoEsperado(p));
  mock.timers.tick(2000);
  await assentar();
  assert.equal(estado(), 'livre');
  assert.deepEqual(avisos.at(-1), {
    texto: 'O celular não atendeu em 5 min. Toque de novo em “Abrir no app o leitor de código” — ou leia o QR.',
    tipo: 'aviso aviso--alerta',
  });
  assert.equal(guarda.has('leitor-celular'), false);
});

test('Chamar de novo: a rodada que vê o chamado anterior já trocado no meio não avisa "leitores demais"', async () => {
  comecar();
  await comChamado(41);
  const resposta = adiada();
  const novo = chamado(42, { sinal: '4M8' });
  responder = (p) => {
    if (p.caminho === '/leitor/chamados') return resposta.promessa; // a notificação segura a resposta
    // O servidor já trocou o #41: o commit vem antes do envio da notificação.
    if (p.caminho === '/leitor/pareamentos/41') return { corpo: chamado(41, { status: 'ENCERRADO', motivo_encerramento: 'SUBSTITUIDO' }) };
    if (p.caminho === '/leitor/pareamentos/42') return { corpo: novo };
    return naoEsperado(p);
  };
  const clique = leitor.chamarDeNovo();
  await assentar();
  mock.timers.tick(2000); // a rodada de rede de segurança cai no meio da troca
  await assentar();
  assert.ok(pedidos.some((p) => p.caminho === '/leitor/pareamentos/41'), 'a rodada perguntou pelo #41');
  assert.deepEqual(avisos, [], 'nada de "há leitores demais": a troca foi desta aba');
  assert.equal(estado(), 'pedindo');

  resposta.resolver({ status: 201, corpo: { pareamento: novo, notificacao: 'ENVIADA', celulares: 2 } });
  await clique;
  await assentar();
  assert.equal(estado(), 'chamando');
  assert.equal(leitor.estadoDoLeitor().pareamento.id, 42);
  assert.deepEqual(leitor.estadoDoLeitor().notificacao, { situacao: 'ENVIADA', celulares: 2 });
});

test('o aviso "leitor_pareamento" do tempo real acorda a aba na hora: atendido, a área diz "ligado"', async () => {
  comecar();
  tempoReal.conectarTempoReal();
  await assentar();
  const ws = sockets.at(-1);
  ws.disparar('open');
  ws.receber('conectado');
  await comChamado(41);
  responder = (p) => {
    if (p.caminho === '/leitor/pareamentos/41') return { corpo: ativo(41) };
    if (p.caminho === '/leitor/pareamentos/41/retirar') return { corpo: lote(ativo(41)) };
    return naoEsperado(p);
  };
  ws.receber('estoque');
  await assentar();
  assert.deepEqual(pedidos, [], 'assunto que não é do leitor não acorda nada');
  ws.receber('leitor_pareamento');
  await assentar(); // sem andar o relógio: nem a rodada de 2 s nem a de 1 s do tempo real
  assert.equal(pedidos[0]?.caminho, '/leitor/pareamentos/41');
  assert.equal(estado(), 'ligado');
  tempoReal.desconectarTempoReal();
});

test('a sessão saiu no meio do chamado: nada é adotado, e o chamado criado é encerrado no servidor', async () => {
  comecar();
  const resposta = adiada();
  responder = (p) => {
    if (p.caminho === '/leitor/chamados') return resposta.promessa;
    if (p.metodo === 'DELETE') return { status: 204 };
    return naoEsperado(p);
  };
  const clique = leitor.chamarCelular();
  await assentar();
  leitor.pararLeitorCelular(); // Sair: o token ainda está aqui enquanto o leitor desliga
  resposta.resolver({ status: 201, corpo: { pareamento: chamado(41), notificacao: 'ENVIADA', celulares: 1 } });
  await clique;
  await assentar();
  assert.equal(estado(), 'livre');
  assert.ok(pedidos.some((p) => `${p.metodo} ${p.caminho}` === 'DELETE /leitor/pareamentos/41'));
  assert.equal(guarda.has('leitor-celular'), false);
});

test('na demo (/demo/app/) o chamado vai à API da demo, e as chaves da aba levam a raiz (ADR-46)', async () => {
  leitor.pararLeitorCelular();
  guarda.clear();
  pedidos.length = 0;
  location.pathname = '/demo/app/';
  try {
    const daDemo = await import('../../web/js/leitor-celular.js?demo');
    responder = (p) =>
      p.caminho === '/leitor/chamados'
        ? { status: 201, corpo: { pareamento: chamado(41), notificacao: 'DESLIGADA', celulares: 1 } }
        : { corpo: chamado(41) };
    daDemo.ligarLeitorCelular(moldura);
    await daDemo.chamarCelular();
    await assentar();
    assert.equal(pedidos[0].url, '/demo/api/v1/leitor/chamados');
    assert.deepEqual(pedidos[0].chaves, ['leitor-celular-chamado@/demo'], 'a chave do chamado, com a raiz no nome');
    assert.equal(guarda.get('leitor-celular@/demo'), '41');
    assert.ok(!guarda.has('leitor-celular'), 'nada no nome da loja');
    assert.ok(pedidos.every((p) => p.url.startsWith('/demo/api/v1/')));
    daDemo.pararLeitorCelular();
  } finally {
    location.pathname = '/app/';
  }
});
