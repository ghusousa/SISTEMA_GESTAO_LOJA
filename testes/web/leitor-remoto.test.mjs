/**
 * Celular como leitor do computador (ADR-43): o convite do QR, o código e a entrega.
 *
 * Roda sem navegador: `node --test testes/web/*.test.mjs`. A primeira metade são os MESMOS
 * casos de `mobile/src/lib/leitorRemoto.test.ts` — o web monta o convite que o app lê, e
 * as duas pontas têm de concordar em cada caractere. A segunda confere o lado que só o
 * computador tem: a rodada única do `retirar`, a frase do fim e o QR desenhado de verdade.
 *
 * Mora FORA de `web/` de propósito: tudo o que está lá é servido em `/app`.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ALFABETO,
  avisoDoFimNoComputador,
  BUSCA_COM_CANAL_MS,
  BUSCA_SEM_CANAL_MS,
  formatarCodigo,
  hostDoEndereco,
  intervaloDaBusca,
  lerConvite,
  mesmoServidor,
  montarConvite,
  normalizarCodigo,
  PRAZO_DO_BIPE_MS,
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

test('mesmoServidor: convite de loopback não acusa ninguém', () => {
  for (const host of ['localhost', '127.0.0.1', '127.1.2.3', '[::1]']) {
    assert.equal(mesmoServidor(`http://${host}:8000/api/v1`, 'https://loja.exemplo'), true, host);
  }
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
