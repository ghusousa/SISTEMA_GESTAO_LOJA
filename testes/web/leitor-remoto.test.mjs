/**
 * Celular como leitor do computador (ADR-43): o convite do QR, o código e a entrega.
 *
 * Roda sem navegador: `node --test testes/web/*.test.mjs`. A primeira metade são os MESMOS
 * casos de `mobile/src/lib/leitorRemoto.test.ts` — o web monta o convite que o app lê, e
 * as duas pontas têm de concordar em cada caractere. A segunda confere o lado que só o
 * computador tem: a rodada única do `retirar`, a frase do fim, o QR desenhado de verdade, a
 * entrega ao leitor da tela (tela ocupada, janela que abre no meio), a fila de entrega, o aviso
 * dos descartados e a aba dona do leitor.
 *
 * Mora FORA de `web/` de propósito: tudo o que está lá é servido em `/app`.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ALFABETO,
  avisoDaEntrega,
  avisoDaNotificacao,
  avisoDoChamadoQueAcabou,
  avisoDoFimNoComputador,
  avisoDosDescartados,
  BUSCA_COM_CANAL_MS,
  BUSCA_SEM_CANAL_MS,
  criarDonaDaAba,
  criarEntrega,
  ESPERA_DA_DONA_MS,
  ESPERA_DA_TELA_MS,
  ESPERA_DO_LEITOR_MS,
  estadoDoChamado,
  formatarCodigo,
  hostDoEndereco,
  intervaloDaBusca,
  lerConvite,
  mesmoServidor,
  montarConvite,
  normalizarCodigo,
  oQueMostrar,
  PRAZO_DO_BIPE_MS,
  ROTULOS_DO_CHAMADO,
  umaPorVez,
  venceu,
} from '../../web/js/leitor-remoto.js';
import qrcode from '../../web/js/vendor/qrcode.js';

// ------------------------------------------------------------ espelho do app

test('alfabeto sem 0, O, 1 e I, sem repetição', () => {
  assert.equal(ALFABETO, '23456789ABCDEFGHJKLMNPQRSTUVWXYZ');
  for (const proibido of ['0', 'O', '1', 'I']) assert.ok(!ALFABETO.includes(proibido));
  assert.equal(new Set(ALFABETO).size, ALFABETO.length);
});

test('normalizarCodigo aceita o que a pessoa digita de verdade', () => {
  assert.equal(normalizarCodigo('ABC234'), 'ABC234');
  assert.equal(normalizarCodigo('ABC 234'), 'ABC234');
  assert.equal(normalizarCodigo('abc-234'), 'ABC234');
  assert.equal(normalizarCodigo('  abc 2-34  '), 'ABC234');
});

test('normalizarCodigo recusa o que não é código', () => {
  assert.equal(normalizarCodigo(''), null);
  assert.equal(normalizarCodigo(null), null);
  assert.equal(normalizarCodigo(undefined), null);
  assert.equal(normalizarCodigo('ABC23'), null, 'curto');
  assert.equal(normalizarCodigo('ABC2345'), null, 'comprido');
  assert.equal(normalizarCodigo('ABC2O4'), null, 'letra O');
  assert.equal(normalizarCodigo('ABC204'), null, 'zero');
  assert.equal(normalizarCodigo('ABCI34'), null, 'letra I');
  assert.equal(normalizarCodigo('ABC134'), null, 'um');
  assert.equal(normalizarCodigo('ABC_34'), null);
  assert.equal(normalizarCodigo('7891234567895'), null, 'EAN-13 de peça');
});

test('cada símbolo do alfabeto vale num código', () => {
  for (let i = 0; i < ALFABETO.length; i += 6) {
    const pedaco = ALFABETO.slice(i, i + 6).padEnd(6, '2');
    assert.equal(normalizarCodigo(pedaco), pedaco);
  }
});

test('formatarCodigo separa em dois grupos de três', () => {
  assert.equal(formatarCodigo('ABC234'), 'ABC 234');
  assert.equal(formatarCodigo('abc-234'), 'ABC 234');
  assert.equal(formatarCodigo('xyz'), 'xyz', 'o que não é código volta como veio');
  assert.equal(formatarCodigo(null), '');
});

test('montarConvite: esquema do app, versão, código e a API codificada', () => {
  assert.equal(
    montarConvite('ABC234', 'https://loja.exemplo/api/v1'),
    'gestaoloja://leitor?v=1&c=ABC234&api=https%3A%2F%2Floja.exemplo%2Fapi%2Fv1',
  );
  assert.equal(montarConvite('ABC234', null), 'gestaoloja://leitor?v=1&c=ABC234');
  assert.equal(montarConvite('ABC234', ''), 'gestaoloja://leitor?v=1&c=ABC234');
});

test('lerConvite lê o que montarConvite escreveu', () => {
  const api = 'http://192.168.0.10:8000/api/v1';
  assert.deepEqual(lerConvite(montarConvite('K7M9QX', api)), { codigo: 'K7M9QX', api });
  assert.deepEqual(lerConvite(montarConvite('K7M9QX')), { codigo: 'K7M9QX', api: null });
});

test('lerConvite aceita o código solto, digitado do jeito que vier', () => {
  assert.deepEqual(lerConvite('abc 234'), { codigo: 'ABC234', api: null });
  assert.deepEqual(lerConvite(' ABC-234 '), { codigo: 'ABC234', api: null });
});

test('lerConvite tolera variações do mesmo convite', () => {
  const esperado = { codigo: 'ABC234', api: null };
  assert.deepEqual(lerConvite('gestaoloja://leitor?c=ABC234'), esperado, 'sem v');
  assert.deepEqual(lerConvite('GESTAOLOJA://LEITOR?v=1&c=abc234'), esperado, 'caixa alta');
  assert.deepEqual(lerConvite('gestaoloja:///leitor?v=1&c=ABC234'), esperado, 'três barras');
  assert.deepEqual(lerConvite('gestaoloja://leitor/?v=1&c=ABC234'), esperado, 'barra final');
  assert.deepEqual(lerConvite('  gestaoloja://leitor?v=1&c=ABC%20234  '), esperado);
  assert.deepEqual(lerConvite('gestaoloja://leitor?v=1&c=ABC234&extra=1#x'), esperado);
});

test('lerConvite recusa o que não é convite', () => {
  assert.equal(lerConvite(''), null);
  assert.equal(lerConvite(null), null);
  assert.equal(lerConvite('7891234567895'), null, 'etiqueta de peça lida por engano');
  assert.equal(lerConvite('https://loja.exemplo/leitor?v=1&c=ABC234'), null, 'outro esquema');
  assert.equal(lerConvite('outroapp://leitor?v=1&c=ABC234'), null, 'outro app');
  assert.equal(lerConvite('gestaoloja://venda?c=ABC234'), null, 'outro caminho');
  assert.equal(lerConvite('gestaoloja://leitor?v=2&c=ABC234'), null, 'versão desconhecida');
  assert.equal(lerConvite('gestaoloja://leitor?v=1'), null, 'sem código');
  assert.equal(lerConvite('gestaoloja://leitor?v=1&c=ABC0O1'), null, 'código fora do alfabeto');
  assert.equal(lerConvite('gestaoloja://leitor?v=1&c=%E0%A4%A'), null, 'escape quebrado');
});

test('lerConvite descarta api que não é http(s), mas fica com o código', () => {
  assert.deepEqual(lerConvite('gestaoloja://leitor?v=1&c=ABC234&api=javascript%3Aalert(1)'), {
    codigo: 'ABC234',
    api: null,
  });
  assert.deepEqual(lerConvite('gestaoloja://leitor?v=1&c=ABC234&api='), {
    codigo: 'ABC234',
    api: null,
  });
});

test('mesmoServidor compara host e porta, com a porta padrão preenchida', () => {
  assert.equal(mesmoServidor('https://loja.exemplo/api/v1', 'https://loja.exemplo'), true);
  assert.equal(mesmoServidor('https://LOJA.exemplo/api/v1/', 'https://loja.exemplo:443'), true);
  assert.equal(mesmoServidor('http://192.168.0.10/api/v1', 'http://192.168.0.10:80'), true);
  assert.equal(
    mesmoServidor('http://192.168.0.10:8000/api/v1', 'http://192.168.0.10:8000/api/v1'),
    true,
  );
  assert.equal(mesmoServidor('http://192.168.0.10:8000/api/v1', 'http://192.168.0.11:8000'), false);
  assert.equal(mesmoServidor('http://192.168.0.10:8000/api/v1', 'http://192.168.0.10'), false);
  assert.equal(mesmoServidor('https://a.exemplo/api/v1', 'https://b.exemplo'), false);
  assert.equal(mesmoServidor('http://loja.exemplo/api/v1', 'https://loja.exemplo'), false);
});

test('mesmoServidor: o caminho da base conta — a demo mora em /demo no host da loja (ADR-46)', () => {
  // O convite leva a base da API da página (`baseDaApi()`), o app compara com a dele.
  assert.equal(mesmoServidor('https://loja.exemplo/demo/api/v1', 'https://loja.exemplo/demo'), true);
  assert.equal(mesmoServidor('https://loja.exemplo/demo/api/v1', 'https://loja.exemplo/demo/api/v1'), true);
  assert.equal(mesmoServidor('https://loja.exemplo/demo/api/v1/', 'https://loja.exemplo/demo/'), true);
  // O código da demo lido pelo app da loja (e o contrário) é de outro servidor.
  assert.equal(mesmoServidor('https://loja.exemplo/demo/api/v1', 'https://loja.exemplo'), false);
  assert.equal(mesmoServidor('https://loja.exemplo/api/v1', 'https://loja.exemplo/demo'), false);
  assert.equal(mesmoServidor('https://loja.exemplo/demo/api/v1', 'https://loja.exemplo/demo2'), false);
});

test('mesmoServidor: convite de loopback não acusa pelo host, mas a raiz conta', () => {
  for (const host of ['localhost', '127.0.0.1', '127.1.2.3', '[::1]']) {
    assert.equal(mesmoServidor(`http://${host}:8000/api/v1`, 'https://loja.exemplo'), true, host);
  }
  // O computador que abriu a demonstração por localhost sabe a raiz dela (ADR-46).
  assert.equal(mesmoServidor('http://localhost/demo/api/v1', 'https://loja.exemplo/demo/api/v1'), true);
  assert.equal(mesmoServidor('http://localhost/demo/api/v1', 'https://loja.exemplo/api/v1'), false);
  assert.equal(mesmoServidor('http://localhost/api/v1', 'https://loja.exemplo/demo'), false);
});

test('mesmoServidor: a tela copiada da barra (/app/...) e barras dobradas não mudam a raiz', () => {
  assert.equal(mesmoServidor('https://loja.exemplo//demo//api/v1', 'https://loja.exemplo/demo/app/#/pdv'), true);
  assert.equal(mesmoServidor('https://loja.exemplo/api/v1', 'https://loja.exemplo/app/'), true);
});

test('mesmoServidor: endereço ilegível também não acusa', () => {
  assert.equal(mesmoServidor(null, 'https://loja.exemplo'), true);
  assert.equal(mesmoServidor('https://loja.exemplo/api/v1', ''), true);
  assert.equal(mesmoServidor('lixo', 'https://loja.exemplo'), true);
});

test('hostDoEndereco mostra só o que identifica o servidor', () => {
  assert.equal(hostDoEndereco('https://Loja.Exemplo/api/v1'), 'loja.exemplo');
  assert.equal(hostDoEndereco('http://192.168.0.10:8000/api/v1'), '192.168.0.10:8000');
  assert.equal(hostDoEndereco('http://loja.exemplo:443'), 'loja.exemplo:443');
  assert.equal(hostDoEndereco('lixo'), 'lixo');
  // Com caminho, ele vai junto: "loja.exemplo" e "loja.exemplo/demo" são servidores diferentes.
  assert.equal(hostDoEndereco('https://Loja.Exemplo/demo/api/v1'), 'loja.exemplo/demo');
  assert.equal(hostDoEndereco('https://loja.exemplo:8443/demo/'), 'loja.exemplo:8443/demo');
});

test('venceu: o bipe vale por dois minutos, como no servidor', () => {
  assert.equal(PRAZO_DO_BIPE_MS, 120_000);
  const bipe = { lidoEm: 1_000_000 };
  assert.equal(venceu(bipe, 1_000_000), false);
  assert.equal(venceu(bipe, 1_000_000 + PRAZO_DO_BIPE_MS), false);
  assert.equal(venceu(bipe, 1_000_000 + PRAZO_DO_BIPE_MS + 1), true);
});

// ------------------------------------------------------------ só do computador

test('intervaloDaBusca: 2 s sem canal, 10 s de rede de segurança com ele', () => {
  assert.equal(intervaloDaBusca(false), BUSCA_SEM_CANAL_MS);
  assert.equal(intervaloDaBusca(true), BUSCA_COM_CANAL_MS);
  assert.equal(BUSCA_SEM_CANAL_MS, 2000);
  assert.equal(BUSCA_COM_CANAL_MS, 10_000);
});

test('avisoDoFimNoComputador explica por que o leitor parou', () => {
  assert.match(avisoDoFimNoComputador({ status: 'EXPIRADO' }), /12 h/);
  assert.equal(
    avisoDoFimNoComputador({ status: 'ENCERRADO', motivo_encerramento: 'CELULAR' }),
    'O celular desligou o leitor.',
  );
  assert.match(
    avisoDoFimNoComputador({ status: 'ENCERRADO', motivo_encerramento: 'TROCOU' }),
    /outro computador/,
  );
  const generico = 'O leitor do celular foi desligado.';
  assert.equal(avisoDoFimNoComputador({ status: 'ENCERRADO', motivo_encerramento: 'COMPUTADOR' }), generico);
  assert.equal(avisoDoFimNoComputador({ status: 'ENCERRADO', motivo_encerramento: 'SUBSTITUIDO' }), generico);
  assert.equal(avisoDoFimNoComputador(null), generico, 'sumiu (404)');
});

/** Uma promessa que o teste resolve quando quiser. */
function adiada() {
  let resolver;
  let rejeitar;
  const promessa = new Promise((r, j) => {
    resolver = r;
    rejeitar = j;
  });
  return { promessa, resolver, rejeitar };
}

const microtarefas = () => new Promise((r) => setImmediate(r));

test('umaPorVez: pedido no meio vira UMA rodada a mais, nunca duas em paralelo', async () => {
  let emParalelo = 0;
  let maximo = 0;
  const rodadas = [];
  const pedir = umaPorVez(async () => {
    emParalelo += 1;
    maximo = Math.max(maximo, emParalelo);
    const vez = adiada();
    rodadas.push(vez);
    await vez.promessa;
    emParalelo -= 1;
  });

  const fim = pedir();
  await microtarefas();
  assert.equal(rodadas.length, 1);

  // Três avisos chegam enquanto a primeira rodada espera o servidor.
  pedir();
  pedir();
  pedir();
  await microtarefas();
  assert.equal(rodadas.length, 1, 'nenhuma rodada paralela');

  rodadas[0].resolver();
  await microtarefas();
  assert.equal(rodadas.length, 2, 'os três pedidos do meio viraram uma rodada só');

  rodadas[1].resolver();
  await fim;
  assert.equal(rodadas.length, 2);
  assert.equal(maximo, 1);

  // Terminado, o próximo pedido abre rodada nova.
  const outra = pedir();
  await microtarefas();
  assert.equal(rodadas.length, 3);
  rodadas[2].resolver();
  await outra;
});

test('umaPorVez: rodada que falha não trava as próximas', async () => {
  const erros = [];
  let vezes = 0;
  const pedir = umaPorVez(
    async () => {
      vezes += 1;
      if (vezes === 1) throw new Error('rede caiu');
    },
    { aoErro: (e) => erros.push(e.message) },
  );
  await pedir();
  await pedir();
  assert.equal(vezes, 2);
  assert.deepEqual(erros, ['rede caiu']);

  // Nem quando a rodada quebra antes de devolver promessa.
  let sincronas = 0;
  const pedirSincrona = umaPorVez(
    () => {
      sincronas += 1;
      throw new Error('quebrou na hora');
    },
    { aoErro: (e) => erros.push(e.message) },
  );
  await pedirSincrona();
  await pedirSincrona();
  assert.equal(sincronas, 2);
});

test('o QR vendorizado codifica o convite inteiro (versão e módulos coerentes)', () => {
  const convite = montarConvite('K7M9QX', 'https://loja.exemplo:8443/api/v1');
  const qr = qrcode(0, 'M');
  qr.addData(convite);
  qr.make();
  const n = qr.getModuleCount();
  // Versão v tem 17 + 4v módulos; o convite (~75 bytes) cabe na 4 ou 5 com correção M.
  assert.equal((n - 17) % 4, 0);
  assert.ok(n >= 33 && n <= 45, `módulos: ${n}`);
  // Os três padrões de posição (borda escura, anel claro, miolo escuro) nos cantos.
  for (const [l, c] of [[0, 0], [0, n - 7], [n - 7, 0]]) {
    assert.equal(qr.isDark(l, c), true, 'borda');
    assert.equal(qr.isDark(l + 1, c + 1), false, 'anel claro');
    assert.equal(qr.isDark(l + 3, c + 3), true, 'miolo');
  }
  assert.equal(qr.isDark(7, 7), false, 'separador claro');
});

test('caminhoDoQr: um quadrado por módulo escuro, deslocado pela margem branca', async () => {
  const { caminhoDoQr } = await import('../../web/js/qr.js');
  const convite = montarConvite('ABC234', 'https://loja.exemplo/api/v1');
  const qr = qrcode(0, 'M');
  qr.addData(convite);
  qr.make();
  const n = qr.getModuleCount();
  let escuros = 0;
  for (let l = 0; l < n; l += 1) for (let c = 0; c < n; c += 1) if (qr.isDark(l, c)) escuros += 1;

  const { lado, d } = caminhoDoQr(convite, 4);
  assert.equal(lado, n + 8);
  assert.equal(d.match(/M/g).length, escuros);
  assert.ok(d.startsWith('M4 4h1v1h-1z'), 'o canto do padrão de posição, já com a margem');
  assert.match(d, /^(M\d+ \d+h1v1h-1z)+$/, 'só números no caminho: o texto do convite não vira SVG');
});

// ------------------------------------------------------------ entrega ao leitor da tela

/** Um `document` de mentira: só o que `leitor.js` toca. */
function documentoFalso() {
  const campo = {
    classList: {
      itens: new Set(),
      add(c) {
        this.itens.add(c);
      },
      remove(c) {
        this.itens.delete(c);
      },
    },
    offsetWidth: 100,
  };
  const doc = {
    modalAberto: false,
    campo,
    querySelector(seletor) {
      if (seletor === '.modal-fundo') return doc.modalAberto ? {} : null;
      if (seletor === '[data-leitor]') return campo;
      return null;
    },
    addEventListener() {},
    removeEventListener() {},
  };
  return doc;
}

test('entregarCodigoDeFora: chega ao aoLer da tela, sem a trava de repetição e em ordem', async () => {
  globalThis.document = documentoFalso();
  const { criarLeitor, entregarCodigoDeFora } = await import('../../web/js/leitor.js');

  assert.equal(await entregarCodigoDeFora('7891234567895'), 'sem-leitor', 'nenhuma tela lê código');

  const lidos = [];
  const leitor = criarLeitor({
    // Como o PDV: busca a peça antes de pôr no carrinho. O segundo código não pode passar
    // na frente do primeiro.
    aoLer: async (codigo) => {
      await new Promise((r) => setTimeout(r, codigo === 'AAAA' ? 20 : 0));
      lidos.push(codigo);
    },
  });
  leitor.ligar();

  assert.equal(await entregarCodigoDeFora('AAAA'), 'entregue');
  assert.equal(await entregarCodigoDeFora('AAAA'), 'entregue', 'duas peças iguais são duas peças');
  assert.equal(await entregarCodigoDeFora('BBBB'), 'entregue');
  assert.deepEqual(lidos, ['AAAA', 'AAAA', 'BBBB']);
  assert.ok(document.campo.classList.itens.has('is-remoto'), 'o campo acende');

  document.modalAberto = true;
  assert.equal(await entregarCodigoDeFora('CCCC'), 'janela-aberta');
  assert.deepEqual(lidos, ['AAAA', 'AAAA', 'BBBB'], 'com janela aberta não atropela');
  document.modalAberto = false;

  leitor.desligar();
  assert.equal(await entregarCodigoDeFora('DDDD'), 'sem-leitor', 'a tela saiu de cena');
});

test('entregarCodigoDeFora: vale o leitor da tela que montou por último', async () => {
  globalThis.document = documentoFalso();
  const { criarLeitor, entregarCodigoDeFora } = await import('../../web/js/leitor.js');
  const deQuem = [];
  const velho = criarLeitor({ aoLer: () => deQuem.push('velho') });
  const novo = criarLeitor({ aoLer: () => deQuem.push('novo') });
  velho.ligar();
  novo.ligar();
  // O roteador pode limpar a tela velha DEPOIS de desenhar a nova: isso não desliga a nova.
  velho.desligar();
  assert.equal(await entregarCodigoDeFora('1234'), 'entregue');
  assert.deepEqual(deQuem, ['novo']);
  novo.desligar();
});

// ------------------------------------------------------------ a tela ocupada e a janela que abre

/** O `document` de mentira com foco, área da lista e `body` para o observador de janelas. */
function documentoComFoco() {
  const doc = documentoFalso();
  doc.body = {};
  doc.activeElement = null;
  return doc;
}

/** `MutationObserver` de mentira: o teste chama `mutou()` quando "pendura" um modal. */
function observadorFalso() {
  const vivos = new Set();
  globalThis.MutationObserver = class {
    constructor(aoMudar) {
      this.aoMudar = aoMudar;
    }
    observe() {
      vivos.add(this);
    }
    disconnect() {
      vivos.delete(this);
    }
  };
  return {
    mutou: () => [...vivos].forEach((o) => o.aoMudar([])),
    quantos: () => vivos.size,
  };
}

test('entregarCodigoDeFora: tela gravando não recebe — o código espera (tela-ocupada)', async () => {
  globalThis.document = documentoComFoco();
  const { criarLeitor, entregarCodigoDeFora } = await import('../../web/js/leitor.js');
  let enviando = true;
  const lidos = [];
  const leitor = criarLeitor({ aoLer: (c) => lidos.push(c), ocupadoQuando: () => enviando });
  leitor.ligar();

  assert.equal(await entregarCodigoDeFora('7891234567895'), 'tela-ocupada');
  assert.deepEqual(lidos, [], 'no meio da gravação o código entraria na lista que vai ser limpa');
  enviando = false;
  assert.equal(await entregarCodigoDeFora('7891234567895'), 'entregue');
  assert.deepEqual(lidos, ['7891234567895']);
  leitor.desligar();
});

test('digitandoEm: o cursor num campo de digitar dentro da lista, e só isso', async () => {
  globalThis.document = documentoComFoco();
  const { digitandoEm } = await import('../../web/js/leitor.js');
  const dentro = new Set();
  const area = { contains: (el) => dentro.has(el) };
  const quantidade = { tagName: 'INPUT', type: 'number' };
  const marcar = { tagName: 'INPUT', type: 'checkbox' };
  const motivo = { tagName: 'TEXTAREA' };
  const fornecedor = { tagName: 'INPUT', type: 'text' };
  dentro.add(quantidade).add(marcar).add(motivo);

  document.activeElement = quantidade;
  assert.equal(digitandoEm(area), true, 'digitando a quantidade da lista');
  document.activeElement = motivo;
  assert.equal(digitandoEm(area), true);
  document.activeElement = marcar;
  assert.equal(digitandoEm(area), false, 'caixa de marcar não se digita: não segura o bipe');
  document.activeElement = fornecedor;
  assert.equal(digitandoEm(area), false, 'campo fora da lista não é redesenhado pelo bipe');
  document.activeElement = null;
  assert.equal(digitandoEm(area), false);
  assert.equal(digitandoEm(null), false);
});

test('entregarCodigoDeFora: aoLer que abre janela não segura a entrega', async () => {
  globalThis.document = documentoComFoco();
  const observador = observadorFalso();
  const { criarLeitor, entregarCodigoDeFora } = await import('../../web/js/leitor.js');
  let responder;
  // A Entrada: código desconhecido abre "Peça ainda não cadastrada" e espera a pessoa.
  const leitor = criarLeitor({
    aoLer: async () => {
      await Promise.resolve();
      document.modalAberto = true;
      observador.mutou();
      await new Promise((r) => {
        responder = r;
      });
    },
  });
  leitor.ligar();

  assert.equal(await entregarCodigoDeFora('0000000000000'), 'entregue', 'não espera a pessoa');
  assert.equal(observador.quantos(), 0, 'o observador foi solto');
  assert.equal(await entregarCodigoDeFora('7891234567895'), 'janela-aberta', 'o próximo vê a janela');
  responder();
  delete globalThis.MutationObserver;
  leitor.desligar();
});

// ------------------------------------------------------------ a fila de entrega

/** Relógio de mentira: `andar(ms)` dispara o que venceu e deixa a fila trabalhar. */
function relogio() {
  const r = { agora: 1_000_000, timers: [] };
  r.agendar = (fn, ms) => {
    const t = { quando: r.agora + ms, fn, vivo: true };
    r.timers.push(t);
    return () => {
      t.vivo = false;
    };
  };
  r.andar = async (ms) => {
    const fim = r.agora + ms;
    for (;;) {
      const proximo = r.timers.filter((t) => t.vivo && t.quando <= fim).sort((a, b) => a.quando - b.quando)[0];
      if (!proximo) break;
      r.agora = proximo.quando;
      proximo.vivo = false;
      proximo.fn();
      await microtarefas();
    }
    r.agora = fim;
    await microtarefas();
  };
  return r;
}

function montarEntrega(responder) {
  const r = relogio();
  const ctx = { tentativas: [], avisos: [], erros: [] };
  const entrega = criarEntrega({
    entregar: async (codigo) => {
      ctx.tentativas.push(codigo);
      return responder(codigo);
    },
    avisar: (texto) => ctx.avisos.push(texto),
    aoErro: (erro) => ctx.erros.push(erro.message),
    agora: () => r.agora,
    agendar: r.agendar,
  });
  return { r, ctx, entrega };
}

test('criarEntrega: entrega em ordem e avisa na hora o que encontrou janela aberta', async () => {
  const { ctx, entrega } = montarEntrega((c) => (c === 'B' ? 'janela-aberta' : 'entregue'));
  await entrega.receber(['A', 'B', 'C']);
  assert.deepEqual(ctx.tentativas, ['A', 'B', 'C']);
  assert.deepEqual(ctx.avisos, [avisoDaEntrega('janela-aberta', 'B')]);
  assert.equal(entrega.esperando(), 0);
});

test('criarEntrega: tela ocupada segura o código (e os de trás) até ela liberar', async () => {
  let ocupada = true;
  const { r, ctx, entrega } = montarEntrega(() => (ocupada ? 'tela-ocupada' : 'entregue'));
  // A rodada do `retirar` não espera a tela: `receber` volta logo.
  await entrega.receber(['A']);
  await entrega.receber(['B']);
  assert.equal(entrega.esperando(), 2, 'nada se perde enquanto a tela grava');
  await r.andar(4000);
  assert.equal(entrega.esperando(), 2);
  assert.deepEqual(ctx.avisos, []);

  ocupada = false;
  await r.andar(300);
  assert.equal(entrega.esperando(), 0);
  assert.deepEqual(ctx.tentativas.slice(-2), ['A', 'B'], 'na ordem da leitura');
  assert.ok(ctx.tentativas.slice(0, -2).every((c) => c === 'A'), 'B nunca passa na frente de A');
  assert.deepEqual(ctx.avisos, []);
});

test('criarEntrega: tela ocupada por tempo demais — avisa e segue, não entra minutos depois', async () => {
  let ocupada = true;
  const { r, ctx, entrega } = montarEntrega((c) => (ocupada && c === 'A' ? 'tela-ocupada' : 'entregue'));
  await entrega.receber(['A', 'B']);
  await r.andar(ESPERA_DA_TELA_MS + 500);
  assert.deepEqual(ctx.avisos, [avisoDaEntrega('tela-ocupada', 'A')]);
  assert.deepEqual(ctx.tentativas.slice(-1), ['B'], 'o de trás segue');
  assert.equal(entrega.esperando(), 0);
  ocupada = false;
});

test('criarEntrega: F5 — o código espera a tela que lê código aparecer', async () => {
  let comLeitor = false;
  const { r, ctx, entrega } = montarEntrega(() => (comLeitor ? 'entregue' : 'sem-leitor'));
  await entrega.receber(['7891234567895']);
  await r.andar(400);
  assert.deepEqual(ctx.avisos, [], 'a tela ainda está carregando: nada de "abra o PDV"');
  comLeitor = true;
  await r.andar(300);
  assert.equal(entrega.esperando(), 0);
  assert.deepEqual(ctx.avisos, []);

  // Numa tela que não lê código, o aviso vem depois da espera curta.
  comLeitor = false;
  await entrega.receber(['ABCD']);
  await r.andar(ESPERA_DO_LEITOR_MS + 300);
  assert.deepEqual(ctx.avisos, [avisoDaEntrega('sem-leitor', 'ABCD')]);
});

test('criarEntrega: falha do aoLer vai para aoErro e a fila segue', async () => {
  const { ctx, entrega } = montarEntrega((c) => {
    if (c === 'A') throw new Error('rede');
    return 'entregue';
  });
  await entrega.receber(['A', 'B']);
  assert.deepEqual(ctx.erros, ['rede']);
  assert.deepEqual(ctx.tentativas, ['A', 'B']);
});

test('criarEntrega: limpar (a sessão saiu) esquece o que esperava e para de tentar', async () => {
  const { r, ctx, entrega } = montarEntrega(() => 'tela-ocupada');
  await entrega.receber(['A', 'B']);
  entrega.limpar();
  const antes = ctx.tentativas.length;
  await r.andar(ESPERA_DA_TELA_MS * 2);
  assert.equal(ctx.tentativas.length, antes, 'nenhuma tentativa depois do logout');
  assert.equal(entrega.esperando(), 0);
  assert.deepEqual(ctx.avisos, []);
});

test('avisoDosDescartados: o celular disse "enviado" — o computador avisa o que não entrou', () => {
  assert.equal(avisoDosDescartados(0, 'ATIVO'), null);
  assert.equal(avisoDosDescartados(undefined, 'ATIVO'), null);
  assert.equal(
    avisoDosDescartados(1, 'ATIVO'),
    '1 leitura do celular chegou depois de 2 min e foi descartada — bipe de novo.',
  );
  assert.equal(
    avisoDosDescartados(3, 'ATIVO'),
    '3 leituras do celular chegaram depois de 2 min e foram descartadas — bipe de novo.',
  );
  assert.equal(
    avisoDosDescartados(2, 'ENCERRADO'),
    '2 leituras do celular não entraram: o leitor foi desligado antes de chegarem aqui.',
  );
});

// ------------------------------------------------------------ um leitor, uma aba

/** Dois (ou mais) `BroadcastChannel` de mentira ligados entre si, como abas do mesmo site. */
function abas() {
  const canais = [];
  return () => {
    const ouvintes = [];
    const canal = {
      ouvintes,
      addEventListener: (_tipo, fn) => ouvintes.push(fn),
      postMessage: (dados) => {
        for (const outro of canais) {
          if (outro !== canal) queueMicrotask(() => outro.ouvintes.forEach((fn) => fn({ data: dados })));
        }
      },
    };
    canais.push(canal);
    return canal;
  };
}

test('criarDonaDaAba: a cópia de "Duplicar aba" não retoma o leitor da aba de origem', async () => {
  const novaAba = abas();
  let daOrigem = 7;
  criarDonaDaAba({ canal: novaAba(), meu: () => daOrigem });
  const r = relogio();
  const copia = criarDonaDaAba({ canal: novaAba(), meu: () => null, agendar: r.agendar });

  assert.equal(await copia.outraCuida(7), true, 'a origem responde: a cópia não retoma');

  const outro = copia.outraCuida(8);
  await r.andar(ESPERA_DA_DONA_MS);
  assert.equal(await outro, false, 'ninguém cuida do 8: retoma (o F5 da própria aba)');

  daOrigem = null; // a origem desligou o leitor
  const depois = copia.outraCuida(7);
  await r.andar(ESPERA_DA_DONA_MS);
  assert.equal(await depois, false);
});

test('criarDonaDaAba: a cópia que pergunta enquanto a origem ainda espera a resposta dela ouve que a origem cuida — só a origem retoma', async () => {
  // O F5 da origem (o leitor guardado, ou a chave do chamado reenviada) pergunta e espera; a cópia
  // de "Duplicar aba" feita nesse meio carrega rápido e pergunta pelo MESMO leitor antes de a
  // origem retomar. Ela nunca ouviu a pergunta da origem (nem existia), e a origem ainda não é
  // dona: sem resposta, as duas retomariam, e os bipes se dividiriam entre dois carrinhos.
  const novaAba = abas();
  const r = relogio();
  const origem = criarDonaDaAba({ canal: novaAba(), meu: () => null, agendar: r.agendar, agora: () => r.agora });
  const daOrigem = origem.outraCuida(7);
  await r.andar(50);
  const copia = criarDonaDaAba({ canal: novaAba(), meu: () => null, agendar: r.agendar, agora: () => r.agora });
  const daCopia = copia.outraCuida(7);
  await microtarefas(); // as mensagens chegam na hora, bem antes de a espera de qualquer uma vencer
  await r.andar(ESPERA_DA_DONA_MS);
  assert.equal(await daCopia, true, 'a origem perguntou antes: responde, e a cópia não retoma');
  assert.equal(await daOrigem, false, 'ninguém respondeu à origem: ela retoma');
});

test('criarDonaDaAba: duas abas que perguntam juntas pelo mesmo leitor — vence a que perguntou primeiro, e no mesmo instante o sorteio: uma retoma, nunca as duas nem nenhuma', async () => {
  for (const [quandoA, sorteioA, quandoB, sorteioB, venceA] of [
    [0, 0.9, 1, 0.1, true], // A perguntou 1 ms antes: o sorteio não conta
    [1, 0.1, 0, 0.9, false],
    [0, 0.2, 0, 0.8, true], // o mesmo instante: o menor sorteio
    [0, 0.8, 0, 0.2, false],
  ]) {
    const novaAba = abas();
    const r = relogio();
    const canalA = novaAba();
    const canalB = novaAba(); // as duas já abertas: cada uma ouve a pergunta da outra
    const a = criarDonaDaAba({ canal: canalA, meu: () => null, agendar: r.agendar, agora: () => r.agora + quandoA, sortear: () => sorteioA });
    const b = criarDonaDaAba({ canal: canalB, meu: () => null, agendar: r.agendar, agora: () => r.agora + quandoB, sortear: () => sorteioB });
    const deA = a.outraCuida(7);
    const deB = b.outraCuida(7);
    await microtarefas();
    await r.andar(ESPERA_DA_DONA_MS);
    assert.deepEqual([await deA, await deB], [!venceA, venceA], `quem vence: ${venceA ? 'A' : 'B'}`);
  }
});

test('criarDonaDaAba: três abas perguntando pelo mesmo leitor — a resposta de quem ainda pergunta só vale para quem perguntou depois dela, e a primeira retoma', async () => {
  // C pergunta primeiro, A logo depois, B em seguida. A responde a B (perguntou antes dele), mas a
  // resposta vai a todas as abas: se C a aceitasse, as três desistiriam e ninguém retomaria.
  const novaAba = abas();
  const r = relogio();
  const aba = (atraso) => criarDonaDaAba({ canal: novaAba(), meu: () => null, agendar: r.agendar, agora: () => r.agora + atraso });
  const [c, a, b] = [aba(0), aba(50), aba(51)];
  const deC = c.outraCuida(7);
  const deA = a.outraCuida(7);
  const deB = b.outraCuida(7);
  await microtarefas();
  await r.andar(ESPERA_DA_DONA_MS);
  assert.deepEqual([await deC, await deA, await deB], [false, true, true], 'só C retoma');
});

test('criarDonaDaAba: sem BroadcastChannel, ninguém responde e nada muda', async () => {
  const dona = criarDonaDaAba({ canal: null, meu: () => 7 });
  assert.equal(await dona.outraCuida(7), false);
});

// ------------------------------------------------------------- o chamado (ADR-47)

const CHAMADO = { id: 41, status: 'AGUARDANDO', chamado: true, sinal: '7K3', codigo: null };
const DO_QR = { id: 40, status: 'AGUARDANDO', chamado: false, sinal: null, codigo: 'ABC234' };

test('estadoDoChamado: livre, pedindo, chamando, qr e ligado', () => {
  assert.equal(estadoDoChamado({ pareamento: null, pedindo: false }), 'livre');
  assert.equal(estadoDoChamado({}), 'livre');
  assert.equal(estadoDoChamado({ pareamento: { ...CHAMADO, status: 'EXPIRADO' } }), 'livre');
  assert.equal(estadoDoChamado({ pareamento: { ...CHAMADO, status: 'ENCERRADO' } }), 'livre');
  // O clique pinta "pedindo" antes da resposta — também por cima do chamado que vai ser trocado.
  assert.equal(estadoDoChamado({ pareamento: null, pedindo: true }), 'pedindo');
  assert.equal(estadoDoChamado({ pareamento: CHAMADO, pedindo: true }), 'pedindo');
  assert.equal(estadoDoChamado({ pareamento: CHAMADO }), 'chamando');
  assert.equal(estadoDoChamado({ pareamento: DO_QR }), 'qr');
  // Pareamento sem o campo (como era antes da ADR-47) é QR.
  assert.equal(estadoDoChamado({ pareamento: { id: 9, status: 'AGUARDANDO', codigo: 'ABC234' } }), 'qr');
  assert.equal(estadoDoChamado({ pareamento: { ...CHAMADO, status: 'ATIVO' } }), 'ligado');
  assert.equal(estadoDoChamado({ pareamento: { ...DO_QR, status: 'ATIVO' } }), 'ligado');
});

const acoesDe = (m) => m.acoes.map((a) => a.acao);
const rotulosDe = (m) => m.acoes.map((a) => a.rotulo);

test('oQueMostrar livre: o botão do pedido do dono e o QR recolhido num link', () => {
  const m = oQueMostrar('livre', {});
  assert.deepEqual(acoesDe(m), ['chamar', 'qr']);
  assert.deepEqual(rotulosDe(m), ['Abrir no app o leitor de código', 'Celular de outra pessoa? Ler o QR']);
  assert.equal(m.acoes[0].jeito, 'principal');
  assert.equal(m.acoes[1].jeito, 'link');
  assert.equal(m.texto, '');
  assert.deepEqual(m.trechos, []);
  assert.equal(m.dica, null);
  assert.equal(m.travado, false);
  assert.equal(ROTULOS_DO_CHAMADO.chamar, 'Abrir no app o leitor de código');
});

test('oQueMostrar pedindo: "Chamando…" já no clique, sem sinal e com tudo apagado', () => {
  const m = oQueMostrar('pedindo', { pareamento: null });
  assert.equal(m.texto, 'Chamando o leitor no seu celular…');
  assert.equal(m.dica, null, 'a situação da notificação ainda não chegou');
  assert.deepEqual(acoesDe(m), ['chamar-de-novo', 'cancelar', 'qr']);
  assert.equal(m.travado, true);
  // O sinal do chamado que está sendo TROCADO não aparece: não é o que o celular vai mostrar.
  assert.doesNotMatch(oQueMostrar('pedindo', { pareamento: CHAMADO }).texto, /7K3/);
});

test('oQueMostrar chamando: o sinal em destaque, a dica da notificação e as três saídas', () => {
  const m = oQueMostrar('chamando', {
    pareamento: CHAMADO,
    notificacao: { situacao: 'SEM_CELULAR', celulares: 0 },
  });
  assert.equal(m.texto, 'Chamando o leitor no seu celular… Sinal 7K3 — confira o mesmo no celular.');
  assert.deepEqual(m.trechos, ['Chamando o leitor no seu celular… Sinal ', { sinal: '7K3' }, ' — confira o mesmo no celular.']);
  assert.equal(m.dica, avisoDaNotificacao('SEM_CELULAR', { celulares: 0 }));
  assert.deepEqual(acoesDe(m), ['chamar-de-novo', 'cancelar', 'qr']);
  assert.deepEqual(rotulosDe(m), ['Chamar de novo', 'Cancelar', 'Ler o QR']);
  assert.equal(m.travado, false);
  assert.equal(oQueMostrar('chamando', { pareamento: CHAMADO, ocupado: true }).travado, true, 'cancelando');
  // Depois do F5 a situação não vem de novo: a frase depende do push do servidor.
  assert.equal(oQueMostrar('chamando', { pareamento: CHAMADO }).dica, avisoDaNotificacao('DESLIGADA'));
  assert.equal(
    oQueMostrar('chamando', { pareamento: CHAMADO, pushLigado: true }).dica,
    'Toque na notificação no celular — ou abra o app: o chamado aparece lá.',
  );
  assert.equal(
    oQueMostrar('chamando', { pareamento: CHAMADO, notificacao: { situacao: 'SEM_CELULAR', celulares: 0 }, pushLigado: true }).dica,
    avisoDaNotificacao('SEM_CELULAR'),
  );
});

test('oQueMostrar qr: esperando a leitura, com o QR de novo e o cancelar', () => {
  const m = oQueMostrar('qr', { pareamento: DO_QR });
  assert.equal(m.texto, 'Esperando um celular ler o QR…');
  assert.deepEqual(acoesDe(m), ['mostrar-qr', 'cancelar']);
  assert.deepEqual(rotulosDe(m), ['Mostrar o QR', 'Cancelar']);
  assert.equal(m.dica, null);
});

test('oQueMostrar ligado: com o sinal pelo chamado; pelo QR, sem sinal e sem "Chamar de novo"', () => {
  const pelo = oQueMostrar('ligado', { pareamento: { ...CHAMADO, status: 'ATIVO', aparelho_nome: 'Maria' } });
  assert.equal(pelo.texto, 'Celular de Maria ligado (sinal 7K3): as leituras caem aqui.');
  assert.deepEqual(pelo.trechos[1], { sinal: '7K3' });
  assert.deepEqual(acoesDe(pelo), ['chamar-de-novo', 'desligar']);
  assert.deepEqual(rotulosDe(pelo), ['Chamar de novo', 'Desligar']);

  // Pelo QR pode ser o celular de OUTRA pessoa: chamar o do próprio login o desligaria.
  const qr = oQueMostrar('ligado', { pareamento: { ...DO_QR, status: 'ATIVO', aparelho_nome: 'Bia' } });
  assert.equal(qr.texto, 'Celular de Bia ligado: as leituras caem aqui.');
  assert.deepEqual(acoesDe(qr), ['desligar']);
  assert.ok(!rotulosDe(qr).includes('Chamar de novo'));

  // O nome vem do servidor e vai como TEXTO (a tela usa textContent): nada de marcação aqui.
  const nome = '<img src=x onerror=alert(1)>';
  const comNome = oQueMostrar('ligado', { pareamento: { ...CHAMADO, status: 'ATIVO', aparelho_nome: nome } });
  assert.equal(comNome.trechos[0], `Celular de ${nome} ligado (sinal `);
  assert.equal(oQueMostrar('ligado', { pareamento: { ...DO_QR, status: 'ATIVO' } }).texto, 'Celular de alguém ligado: as leituras caem aqui.');
});

test('avisoDaNotificacao: cada situação diz por que o celular foi avisado, ou não', () => {
  assert.equal(
    avisoDaNotificacao('ENVIADA', { celulares: 1 }),
    'Notificação enviada a 1 celular com o seu login: toque nela — ou abra o app, o chamado aparece lá.',
  );
  assert.match(avisoDaNotificacao('ENVIADA', { celulares: 2 }), /^Notificação enviada a 2 celulares com o seu login/);
  assert.equal(
    avisoDaNotificacao('SEM_CELULAR'),
    'Nenhum celular com o seu login tem o app atualizado. Atualize o app, entre com o MESMO login e abra-o — ou leia o QR.',
  );
  assert.equal(
    avisoDaNotificacao('SEM_NOTIFICACAO'),
    'O celular com o seu login não recebe notificações deste app: com o app aberto, o chamado aparece lá. Para receber com o app fechado: no celular, Mais → Leitor do computador.',
  );
  assert.equal(
    avisoDaNotificacao('SEM_CHAVE_DA_APPLE'),
    'O iPhone ainda não recebe as notificações deste app (falta um passo de quem publica o app): com o app aberto, o chamado aparece lá — ou leia o QR.',
  );
  assert.equal(
    avisoDaNotificacao('FALHOU'),
    'A notificação não saiu agora: com o app aberto, o chamado aparece lá — ou leia o QR.',
  );
  // F5 ou reenvio da mesma chave: o servidor não conta de novo; e um valor que este web não
  // conhece. Com o push ligado no servidor, a notificação pode ter saído.
  const geral = 'Toque na notificação no celular — ou abra o app: o chamado aparece lá.';
  assert.equal(avisoDaNotificacao(null, { pushLigado: true }), geral);
  assert.equal(avisoDaNotificacao(undefined, { pushLigado: true }), geral);
  assert.equal(avisoDaNotificacao('OUTRA_COISA', { pushLigado: true }), geral);
});

test('avisoDaNotificacao: sem situação e com o push desligado (E1), nada de prometer notificação', () => {
  // O padrão do servidor é NOTIFICACOES_PUSH=desligado: depois do F5 a área dizia "Toque na
  // notificação" a quem nunca ia receber uma. Sem `pushLigado` (a configuração ainda não chegou,
  // ou o servidor é antigo) vale o desligado, como no app.
  const semPush = avisoDaNotificacao('DESLIGADA');
  for (const situacao of [null, undefined, 'OUTRA_COISA']) {
    assert.equal(avisoDaNotificacao(situacao, { pushLigado: false }), semPush, String(situacao));
    assert.equal(avisoDaNotificacao(situacao), semPush, `${situacao}, sem dizer`);
    assert.doesNotMatch(avisoDaNotificacao(situacao), /notifica/i);
  }
  // Com situação, o push do servidor não muda a frase: ela já diz o que aconteceu.
  assert.equal(avisoDaNotificacao('ENVIADA', { celulares: 1, pushLigado: false }), avisoDaNotificacao('ENVIADA', { celulares: 1 }));
  assert.equal(avisoDaNotificacao('DESLIGADA', { pushLigado: true }), semPush);
});

test('avisoDaNotificacao: o push desligado (o padrão do servidor) só fala do app aberto e do QR', () => {
  const desligada = avisoDaNotificacao('DESLIGADA', { celulares: 1 });
  assert.equal(desligada, 'Com o app aberto no celular, o chamado aparece lá. Ou leia o QR.');
  assert.doesNotMatch(desligada, /chave|Apple|publica|notifica/i);
});

test('avisoDaNotificacao: nenhuma frase manda o dono a um passo que é de quem publica o app', () => {
  for (const situacao of ['ENVIADA', 'SEM_CELULAR', 'SEM_NOTIFICACAO', 'DESLIGADA', 'SEM_CHAVE_DA_APPLE', 'FALHOU', null]) {
    for (const pushLigado of [false, true]) {
      const frase = avisoDaNotificacao(situacao, { celulares: 1, pushLigado });
      assert.doesNotMatch(frase, /\bdono\b|README|mobile\/|publicar\/|APNs|Expo/i, `${situacao}: ${frase}`);
      // Toda frase deixa um caminho que funciona sem a notificação.
      assert.match(frase, /abra|aberto|QR/, `${situacao}: ${frase}`);
    }
  }
});

test('avisoDoChamadoQueAcabou: venceu sem atender, ou o teto de leitores do login', () => {
  assert.equal(
    avisoDoChamadoQueAcabou({ status: 'EXPIRADO' }),
    'O celular não atendeu em 5 min. Toque de novo em “Abrir no app o leitor de código” — ou leia o QR.',
  );
  assert.match(avisoDoChamadoQueAcabou({ status: 'EXPIRADO' }), new RegExp(ROTULOS_DO_CHAMADO.chamar));
  assert.equal(
    avisoDoChamadoQueAcabou({ status: 'ENCERRADO', motivo_encerramento: 'SUBSTITUIDO' }),
    'Este chamado foi encerrado: há leitores demais abertos com o seu login.',
  );
  // Cancelado aqui (COMPUTADOR), sumido (404) ou ainda vivo: sem aviso.
  assert.equal(avisoDoChamadoQueAcabou({ status: 'ENCERRADO', motivo_encerramento: 'COMPUTADOR' }), null);
  assert.equal(avisoDoChamadoQueAcabou(null), null);
  assert.equal(avisoDoChamadoQueAcabou({ status: 'AGUARDANDO' }), null);
});
