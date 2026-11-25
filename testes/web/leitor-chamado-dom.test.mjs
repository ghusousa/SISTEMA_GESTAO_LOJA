/**
 * A área do chamado (ADR-47) no DOM: `leitor-chamado.js`, a camada que pinta o que `oQueMostrar`
 * decide. O que só esta camada garante: o nome do celular (vem do servidor) entra como TEXTO,
 * nunca como marcação; botão apagado não age; `soltar()` desliga a área de vez; repintar igual
 * não refaz os botões (o foco de quem usa o teclado) nem a frase (o leitor de tela a repetiria);
 * e a dica do chamado sem situação segue o `notificacoes_push` de `GET /configuracao`.
 *
 * As frases e os estados estão em `leitor-remoto.test.mjs`; o vaivém com o servidor, em
 * `leitor-chamado.test.mjs`. Roda sem navegador: `node --test testes/web/*.test.mjs`, com um DOM
 * de mentira só com o que a área toca. Mora FORA de `web/` de propósito: tudo lá é servido em `/app`.
 */

import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

mock.timers.enable({ apis: ['setTimeout'] });

// ------------------------------------------------------------- um DOM de mentira

/** Toda atribuição a `innerHTML`, em qualquer elemento: `{ el, html }`. */
const htmlAtribuido = [];
const VAZIAS = new Set(['img', 'br', 'hr', 'input', 'meta', 'link']);
const ENTIDADES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };
const decodificar = (texto) => texto.replace(/&(?:amp|lt|gt|quot|#39);/g, (e) => ENTIDADES[e]);

class Texto {
  constructor(texto) {
    this.nodeType = 3;
    this.textContent = texto;
    this.parentNode = null;
  }
}

class Elemento {
  constructor(tag, doc) {
    this.nodeType = 1;
    this.tagName = tag.toUpperCase();
    this.ownerDocument = doc;
    this.atributos = new Map();
    this.dataset = {};
    this.childNodes = [];
    this.parentNode = null;
    this.hidden = false;
    this.disabled = false;
    this.className = '';
    this.ouvintes = new Map();
    /** Quantas vezes os filhos foram trocados (`replaceChildren`, `textContent`, `innerHTML`). */
    this.trocas = 0;
    this.classList = { add() {}, remove() {} };
  }

  setAttribute(nome, valor = '') {
    this.atributos.set(nome, String(valor));
    if (nome === 'class') this.className = String(valor);
    if (nome === 'hidden') this.hidden = true;
    if (nome === 'disabled') this.disabled = true;
    if (nome.startsWith('data-')) {
      this.dataset[nome.slice(5).replace(/-([a-z])/g, (_, letra) => letra.toUpperCase())] = String(valor);
    }
  }

  hasAttribute(nome) {
    return this.atributos.has(nome) || (nome.startsWith('data-') && this.dataset[nome.slice(5)] !== undefined);
  }

  get textContent() {
    return this.childNodes.map((n) => n.textContent).join('');
  }

  set textContent(valor) {
    const texto = String(valor ?? '');
    this.replaceChildren(...(texto ? [new Texto(texto)] : []));
  }

  set innerHTML(valor) {
    const html = String(valor);
    htmlAtribuido.push({ el: this, html });
    this.replaceChildren(...analisar(html, this.ownerDocument));
  }

  replaceChildren(...nos) {
    for (const n of this.childNodes) n.parentNode = null;
    this.childNodes = [];
    this.trocas += 1;
    this.append(...nos);
  }

  append(...nos) {
    for (const n of nos) {
      n.parentNode = this;
      this.childNodes.push(n);
    }
  }

  remove() {
    this.parentNode?.childNodes.splice(this.parentNode.childNodes.indexOf(this), 1);
    this.parentNode = null;
  }

  *descendentes() {
    for (const n of this.childNodes) {
      if (n.nodeType !== 1) continue;
      yield n;
      yield* n.descendentes();
    }
  }

  querySelectorAll(seletor) {
    return [...this.descendentes()].filter((el) => casa(el, seletor));
  }

  querySelector(seletor) {
    return this.querySelectorAll(seletor)[0] ?? null;
  }

  closest(seletor) {
    for (let el = this; el; el = el.parentNode) if (casa(el, seletor)) return el;
    return null;
  }

  contains(outro) {
    for (let n = outro; n; n = n.parentNode) if (n === this) return true;
    return false;
  }

  addEventListener(tipo, fn) {
    if (!this.ouvintes.has(tipo)) this.ouvintes.set(tipo, []);
    this.ouvintes.get(tipo).push(fn);
  }

  removeEventListener(tipo, fn) {
    const lista = this.ouvintes.get(tipo) ?? [];
    if (lista.includes(fn)) lista.splice(lista.indexOf(fn), 1);
  }

  /** O clique sobe do alvo até a raiz, como no navegador (a área escuta por delegação). */
  clicar() {
    const evento = { type: 'click', target: this };
    for (let el = this; el; el = el.parentNode) for (const fn of [...(el.ouvintes.get('click') ?? [])]) fn(evento);
  }
}

/** Os seletores que a área usa: `[atributo]` e o nome da tag. */
function casa(el, seletor) {
  const atributo = /^\[([\w-]+)\]$/.exec(seletor);
  if (atributo) return el.hasAttribute(atributo[1]);
  return el.tagName === seletor.toUpperCase();
}

/**
 * Um HTML simples em nós: tags (as vazias, como `<img>`, sem fechar), atributos com valor entre
 * aspas, sem aspas ou sem valor, e texto. Basta para a marcação da área — e para mostrar uma
 * `<img onerror>` virando elemento, se o nome do celular entrasse como HTML.
 */
function analisar(html, doc) {
  const raiz = new Elemento('raiz', doc);
  const pilha = [raiz];
  for (const [, fecha, abre, atributos, texto] of html.matchAll(/<\/([a-z][\w-]*)\s*>|<([a-z][\w-]*)([^>]*)>|([^<]+)/gi)) {
    const topo = pilha.at(-1);
    if (fecha) {
      if (pilha.length > 1) pilha.pop();
    } else if (abre) {
      const el = new Elemento(abre, doc);
      for (const [, nome, aspas, simples, solto] of atributos.matchAll(/([\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
        el.setAttribute(nome, decodificar(aspas ?? simples ?? solto ?? ''));
      }
      topo.append(el);
      if (!VAZIAS.has(abre.toLowerCase()) && !atributos.trim().endsWith('/')) pilha.push(el);
    } else if (texto.trim()) {
      topo.append(new Texto(decodificar(texto)));
    }
  }
  const nos = raiz.childNodes;
  for (const n of nos) n.parentNode = null;
  return nos;
}

// ------------------------------------------------------------- o navegador de mentira

const guarda = new Map();
const avisos = [];
const areaDeAvisos = { append: (caixa) => avisos.push(caixa.textContent) };

globalThis.location = { pathname: '/app/', protocol: 'https:', host: 'loja.exemplo', href: 'https://loja.exemplo/app/' };
globalThis.window = { addEventListener() {} };
globalThis.sessionStorage = {
  getItem: (k) => (guarda.has(k) ? guarda.get(k) : null),
  setItem: (k, v) => void guarda.set(k, String(v)),
  removeItem: (k) => void guarda.delete(k),
};
// Sem BroadcastChannel ninguém mais cuida do leitor (a aba dona tem teste próprio).
globalThis.BroadcastChannel = undefined;
globalThis.WebSocket = class {
  addEventListener() {}
  send() {}
  close() {}
};
const documento = {
  title: '',
  visibilityState: 'visible',
  body: null,
  addEventListener() {},
  removeEventListener() {},
  querySelector: () => null,
  getElementById: (id) => (id === 'avisos' ? areaDeAvisos : null),
  createElement: (tag) => new Elemento(tag, documento),
  createTextNode: (texto) => new Texto(String(texto)),
};
globalThis.document = documento;

// ------------------------------------------------------------- o servidor de mentira

const pedidos = [];
let responder = () => ({ status: 500, corpo: { code: 'ERRO', message: 'sem regra' } });
globalThis.fetch = async (url, opcoes = {}) => {
  const pedido = {
    metodo: opcoes.method ?? 'GET',
    caminho: String(url).replace(/^(?:\/demo)?\/api\/v1/, ''),
    corpo: opcoes.body ? JSON.parse(opcoes.body) : undefined,
  };
  pedidos.push(pedido);
  // A leitura completa da configuração que o login dispara (`loja.js`).
  const r = pedido.caminho === '/configuracao/completa' ? { corpo: { nome: 'Loja', segmento: 'ROUPAS' } } : await responder(pedido);
  if (r === 'sem-rede') throw new TypeError('Failed to fetch');
  return new Response(r.corpo === undefined ? null : JSON.stringify(r.corpo), { status: r.status ?? 200 });
};
const naoEsperado = (p) => ({ status: 500, corpo: { code: 'ERRO', message: `pedido não esperado: ${p.metodo} ${p.caminho}` } });

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
const lote = (p) => ({ items: [], descartados: 0, pareamento: p });

function adiada() {
  let resolver;
  const promessa = new Promise((r) => {
    resolver = r;
  });
  return { promessa, resolver };
}

const assentar = async (vezes = 60) => {
  for (let i = 0; i < vezes; i += 1) await new Promise((r) => setImmediate(r));
};

// ------------------------------------------------------------- a página

const { ligarBotaoDoCelular } = await import('../../web/js/leitor-chamado.js');
const leitor = await import('../../web/js/leitor-celular.js');
const { definirLoja, loja } = await import('../../web/js/loja.js');
const api = await import('../../web/js/api.js');

responder = () => ({ corpo: { access_token: 'tok', usuario: { id: 1, nome: 'Dona' } } });
await api.entrar('dona@loja.com', 'senha');
await assentar();

const moldura = { querySelector: () => null };
const SEM_PUSH = 'Com o app aberto no celular, o chamado aparece lá. Ou leia o QR.';
const COM_PUSH = 'Toque na notificação no celular — ou abra o app: o chamado aparece lá.';

/** Aba nova e uma área ligada nela, como a tela do PDV a liga. */
function comecar() {
  leitor.pararLeitorCelular();
  guarda.clear();
  pedidos.length = 0;
  avisos.length = 0;
  htmlAtribuido.length = 0;
  definirLoja({ ...loja(), notificacoes_push: false });
  const caixa = documento.createElement('div');
  caixa.setAttribute('data-leitor-chamado', '');
  const soltar = ligarBotaoDoCelular(caixa);
  return {
    caixa,
    soltar,
    texto: caixa.querySelector('[data-texto]'),
    acoes: caixa.querySelector('[data-acoes]'),
    dica: caixa.querySelector('[data-dica]'),
    botao: (acao) => caixa.querySelectorAll('button').find((b) => b.dataset.acao === acao),
  };
}

/** O F5 da aba que guardava o pareamento `p` (o leitor volta pelo `restaurar`). */
async function retomar(p) {
  guarda.set('leitor-celular', String(p.id));
  responder = (pedido) => {
    if (pedido.caminho === `/leitor/pareamentos/${p.id}`) return { corpo: p };
    if (pedido.caminho === `/leitor/pareamentos/${p.id}/retirar`) return { corpo: lote(p) };
    return naoEsperado(pedido);
  };
  leitor.ligarLeitorCelular(moldura);
  await assentar();
}

// ------------------------------------------------------------- os casos

test('o nome do celular entra como TEXTO: marcação nele não vira elemento, e só a moldura da área usa innerHTML', async () => {
  const area = comecar();
  const nome = '<img src=x onerror=alert(1)>';
  await retomar(chamado(41, { status: 'ATIVO', aparelho_nome: nome }));
  assert.equal(area.caixa.dataset.estado, 'ligado');
  assert.equal(area.texto.textContent, `Celular de ${nome} ligado (sinal 7K3): as leituras caem aqui.`);
  // A frase é texto solto e o sinal num <strong> — nada mais, e nenhuma <img> nascida do nome.
  for (const no of area.texto.childNodes) {
    assert.ok(no.nodeType === 3 || (no.tagName === 'STRONG' && no.childNodes.every((f) => f.nodeType === 3)), no.tagName);
  }
  assert.deepEqual(area.caixa.querySelectorAll('img'), []);
  assert.equal(area.texto.hidden, false);
  // innerHTML só na moldura (uma vez, ao ligar) e nos botões (rótulos fixos nossos).
  for (const { el, html } of htmlAtribuido) {
    assert.ok(el === area.caixa || el === area.acoes, `innerHTML num lugar que pinta dado: ${html}`);
    assert.ok(!html.includes('onerror'), html);
  }
  assert.equal(htmlAtribuido.filter(({ el }) => el === area.caixa).length, 1);
  area.soltar();
});

test('a dica do chamado sem situação (F5) segue o push do servidor: desligado, nada de "toque na notificação"', async () => {
  const area = comecar();
  // F5 no meio do chamado: o reenvio da chave volta sem situação (o servidor não conta de novo).
  guarda.set(
    'leitor-celular-chamado',
    JSON.stringify({ client_uuid: '6f1c1b1e-8f0a-4c3e-9b1d-2a7d5e4f3c21', substitui_id: null, desde: Date.now(), usuario_id: 1 }),
  );
  responder = (p) => {
    if (p.caminho === '/leitor/chamados') return { status: 200, corpo: { pareamento: chamado(41), notificacao: null, celulares: 0 } };
    if (p.caminho === '/leitor/pareamentos/41') return { corpo: chamado(41) };
    return naoEsperado(p);
  };
  leitor.ligarLeitorCelular(moldura);
  await assentar();
  assert.equal(area.caixa.dataset.estado, 'chamando');
  assert.equal(area.dica.textContent, SEM_PUSH, 'o padrão do servidor (E1): o push desligado');
  assert.equal(area.dica.hidden, false);

  // `GET /configuracao` diz que o push está ligado (a resposta pode chegar depois da área pintada).
  definirLoja({ ...loja(), notificacoes_push: true });
  assert.equal(area.dica.textContent, COM_PUSH);
  definirLoja({ ...loja(), notificacoes_push: false });
  assert.equal(area.dica.textContent, SEM_PUSH);
  area.soltar();
});

test('clique em botão apagado não chama a ação — nem quando o alvo é o texto dentro dele', async () => {
  const area = comecar();
  assert.equal(area.caixa.dataset.estado, 'livre');
  responder = naoEsperado;
  const chamar = area.botao('chamar');
  assert.ok(chamar, 'o botão "Abrir no app o leitor de código"');
  chamar.disabled = true; // como a área o pinta enquanto um pedido está no ar
  chamar.querySelector('span').clicar();
  chamar.clicar();
  await assentar();
  assert.deepEqual(pedidos, []);
  assert.equal(area.caixa.dataset.estado, 'livre');

  // Aceso, o mesmo clique chama.
  chamar.disabled = false;
  responder = (p) => (p.caminho === '/leitor/chamados' ? { status: 201, corpo: { pareamento: chamado(41), notificacao: 'DESLIGADA', celulares: 1 } } : { corpo: chamado(41) });
  chamar.querySelector('span').clicar();
  await assentar();
  assert.ok(pedidos.some((p) => `${p.metodo} ${p.caminho}` === 'POST /leitor/chamados'));
  assert.equal(area.caixa.dataset.estado, 'chamando');
  area.soltar();
});

test('com um pedido no ar a área apaga os botões, e acende de novo com a resposta', async () => {
  const area = comecar();
  const resposta = adiada();
  responder = (p) => (p.caminho === '/leitor/chamados' ? resposta.promessa : { corpo: chamado(41) });
  area.botao('chamar').clicar();
  await assentar();
  assert.equal(area.caixa.dataset.estado, 'pedindo');
  assert.ok(area.caixa.querySelectorAll('button').every((b) => b.disabled), 'tudo apagado até a resposta');
  resposta.resolver({ status: 201, corpo: { pareamento: chamado(41), notificacao: 'DESLIGADA', celulares: 1 } });
  await assentar();
  assert.equal(area.caixa.dataset.estado, 'chamando');
  assert.ok(area.caixa.querySelectorAll('button').every((b) => !b.disabled));
  area.soltar();
});

test('repintar igual não refaz os botões nem a frase; "Chamando…" e "chamando" usam os MESMOS botões', async () => {
  const area = comecar();
  responder = (p) => (p.caminho === '/leitor/chamados' ? { status: 201, corpo: { pareamento: chamado(41), notificacao: 'DESLIGADA', celulares: 1 } } : { corpo: chamado(41) });
  await leitor.chamarCelular();
  await assentar();
  assert.equal(area.caixa.dataset.estado, 'chamando');
  const botoes = area.caixa.querySelectorAll('button');
  const trocasDaFrase = area.texto.trocas;
  const marcacoes = htmlAtribuido.length;

  // Uma repintura sem mudança nenhuma (a configuração da loja chegou igual).
  definirLoja({ ...loja() });
  assert.equal(area.texto.trocas, trocasDaFrase, 'a frase não foi refeita: o leitor de tela não a repete');
  assert.equal(htmlAtribuido.length, marcacoes, 'os botões não foram refeitos');

  // "Chamar de novo" recusado (429): pedindo → chamando, e os botões são os mesmos objetos — o foco
  // de quem usa o teclado fica onde estava.
  responder = (p) =>
    p.caminho === '/leitor/chamados'
      ? { status: 429, corpo: { code: 'LEITOR_CHAMADO_RAPIDO', message: 'Espere um instante.', detail: { retry_after: 2 } } }
      : { corpo: chamado(41) };
  area.botao('chamar-de-novo').clicar();
  await assentar();
  assert.equal(area.caixa.dataset.estado, 'chamando');
  assert.deepEqual(avisos.at(-1), 'Espere um instante antes de chamar de novo.');
  const depois = area.caixa.querySelectorAll('button');
  assert.equal(depois.length, botoes.length);
  depois.forEach((b, i) => assert.equal(b, botoes[i], b.dataset.acao));
  assert.equal(htmlAtribuido.length, marcacoes);
  area.soltar();
});

test('soltar() desliga a área de vez: nem clique, nem mudança do leitor, nem da loja a repintam', async () => {
  const area = comecar();
  assert.equal(area.caixa.dataset.estado, 'livre');
  const chamar = area.botao('chamar');
  area.soltar();
  assert.deepEqual(area.caixa.ouvintes.get('click'), [], 'o ouvinte do clique saiu');

  responder = naoEsperado;
  chamar.clicar();
  await assentar();
  assert.deepEqual(pedidos, [], 'o clique na área solta não chama ninguém');

  // O leitor da aba muda (outra tela chamou) e a loja também: a área solta fica como estava.
  responder = (p) => (p.caminho === '/leitor/chamados' ? { status: 201, corpo: { pareamento: chamado(41), notificacao: 'DESLIGADA', celulares: 1 } } : { corpo: chamado(41) });
  await leitor.chamarCelular();
  await assentar();
  assert.equal(leitor.estadoDoLeitor().pareamento?.id, 41);
  definirLoja({ ...loja(), notificacoes_push: true });
  assert.equal(area.caixa.dataset.estado, 'livre');
  assert.equal(area.texto.textContent, '');
  leitor.pararLeitorCelular();
});
