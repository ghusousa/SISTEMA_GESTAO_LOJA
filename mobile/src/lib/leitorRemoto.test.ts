import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ALFABETO,
  avisoDoFim,
  destinoDaFalha,
  esperaDaTentativa,
  formatarCodigo,
  hostDoEndereco,
  lerConvite,
  mesmoServidor,
  montarConvite,
  normalizarCodigo,
  PRAZO_DO_BIPE_MS,
  venceu,
} from './leitorRemoto';

// Os mesmos casos de `testes/web/leitor-remoto.test.mjs`: as duas pontas leem o mesmo QR.

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

test('esperaDaTentativa dobra a cada falha, com teto de 10 s', () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6, 50].map(esperaDaTentativa),
    [1000, 2000, 4000, 8000, 10_000, 10_000, 10_000],
  );
  assert.equal(esperaDaTentativa(0), 1000);
  assert.equal(esperaDaTentativa(-3), 1000);
  assert.equal(esperaDaTentativa(Number.NaN), 1000);
  assert.equal(esperaDaTentativa(Number.POSITIVE_INFINITY), 10_000);
});

test('venceu: o bipe vale por dois minutos, como no servidor', () => {
  assert.equal(PRAZO_DO_BIPE_MS, 120_000);
  const bipe = { lidoEm: 1_000_000 };
  assert.equal(venceu(bipe, 1_000_000), false);
  assert.equal(venceu(bipe, 1_000_000 + PRAZO_DO_BIPE_MS), false);
  assert.equal(venceu(bipe, 1_000_000 + PRAZO_DO_BIPE_MS + 1), true);
});

test('destinoDaFalha: rede e servidor fora tentam de novo', () => {
  assert.equal(destinoDaFalha(undefined, null), 'tentar-de-novo');
  assert.equal(destinoDaFalha(0, null), 'tentar-de-novo');
  assert.equal(destinoDaFalha(502, null), 'tentar-de-novo');
  assert.equal(destinoDaFalha(503, null), 'tentar-de-novo');
  assert.equal(destinoDaFalha(408, null), 'tentar-de-novo');
  assert.equal(destinoDaFalha(429, null), 'tentar-de-novo');
  assert.equal(destinoDaFalha(409, 'LEITOR_FILA_CHEIA'), 'tentar-de-novo');
});

test('destinoDaFalha: pareamento acabado para a fila inteira', () => {
  assert.equal(destinoDaFalha(409, 'LEITOR_DESLIGADO'), 'leitor-desligado');
  assert.equal(destinoDaFalha(404, 'NAO_ENCONTRADO'), 'leitor-desligado');
});

test('destinoDaFalha: recusa deste bipe descarta só ele', () => {
  assert.equal(destinoDaFalha(422, 'VALIDACAO'), 'descartar');
  assert.equal(destinoDaFalha(409, 'DUPLICADO'), 'descartar');
  assert.equal(destinoDaFalha(401, null), 'descartar');
  assert.equal(destinoDaFalha(403, null), 'descartar');
});

test('avisoDoFim explica por que o leitor parou', () => {
  assert.match(avisoDoFim({ status: 'EXPIRADO' }), /12 horas/);
  assert.equal(
    avisoDoFim({ status: 'ENCERRADO', motivo_encerramento: 'COMPUTADOR' }),
    'O computador desligou o leitor.',
  );
  assert.match(avisoDoFim({ status: 'ENCERRADO', motivo_encerramento: 'TROCOU' }), /outro computador/);
  assert.match(avisoDoFim({ status: 'ENCERRADO', motivo_encerramento: 'CELULAR' }), /neste celular/);
  assert.equal(avisoDoFim(null), 'O computador desligou o leitor.');
});
