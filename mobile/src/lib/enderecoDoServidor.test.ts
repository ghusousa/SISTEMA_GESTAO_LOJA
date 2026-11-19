import assert from 'node:assert/strict';
import test from 'node:test';

import axios from 'axios';

import { montarUrlDaFoto } from './enderecoDaFoto';
import {
  ehRedeLocal,
  mensagemDoTesteRecusado,
  normalizarEndereco,
  urlDaApi,
  urlDaPrivacidade,
  urlDeSaude,
  urlDoTempoReal,
} from './enderecoDoServidor';

const DEMO = 'https://loja.x.com.br/demo';

test('o caminho fica: a demonstração mora em <domínio>/demo (ADR-46)', () => {
  assert.equal(normalizarEndereco('loja.x.com.br/demo'), 'https://loja.x.com.br/demo');
  assert.equal(normalizarEndereco('https://loja.x.com.br/demo'), 'https://loja.x.com.br/demo');
  assert.equal(normalizarEndereco('https://loja.x.com.br/demo/'), 'https://loja.x.com.br/demo');
});

test('host em minúsculas; sem barra no fim, sem query e sem hash', () => {
  assert.equal(normalizarEndereco('https://LOJA.x.com.br/demo/?a=1#b'), 'https://loja.x.com.br/demo');
  assert.equal(normalizarEndereco('https://loja.x.com.br/demo#/pdv'), 'https://loja.x.com.br/demo');
  assert.equal(normalizarEndereco('https://loja.x.com.br?a=1'), 'https://loja.x.com.br');
  assert.equal(normalizarEndereco('https://loja.x.com.br//demo//'), 'https://loja.x.com.br/demo');
  assert.equal(normalizarEndereco('  loja.x.com.br.  '), 'https://loja.x.com.br');
});

test('o endereço copiado da barra do navegador perde a tela (/app) e a API (/api)', () => {
  assert.equal(normalizarEndereco('http://192.168.0.10/app/#/pdv'), 'http://192.168.0.10');
  assert.equal(normalizarEndereco('http://192.168.0.10:8000/app/'), 'http://192.168.0.10:8000');
  assert.equal(normalizarEndereco('https://loja.x.com.br/demo/app/#/pdv'), DEMO);
  assert.equal(normalizarEndereco('https://loja.x.com.br/demo/api/v1/'), DEMO);
  assert.equal(normalizarEndereco('https://loja.x.com.br/api/v1/auth/login'), 'https://loja.x.com.br');
  // Só segmento inteiro: um caminho que só COMEÇA com "app" é caminho.
  assert.equal(normalizarEndereco('https://loja.x.com.br/apple'), 'https://loja.x.com.br/apple');
});

test('sem esquema: http na rede local (IP, localhost, nome sem ponto, *.local)', () => {
  assert.equal(normalizarEndereco('192.168.0.10:8000'), 'http://192.168.0.10:8000');
  assert.equal(normalizarEndereco('192.168.0.10'), 'http://192.168.0.10');
  assert.equal(normalizarEndereco('localhost'), 'http://localhost');
  assert.equal(normalizarEndereco('localhost:8000'), 'http://localhost:8000');
  assert.equal(normalizarEndereco('servidor-da-loja'), 'http://servidor-da-loja');
  assert.equal(normalizarEndereco('Loja.Local:8000/demo'), 'http://loja.local:8000/demo');
  assert.equal(normalizarEndereco('[::1]:8000'), 'http://[::1]:8000');
});

test('sem esquema: https para domínio — o único que o iPhone abre na internet', () => {
  assert.equal(normalizarEndereco('loja.x.com.br'), 'https://loja.x.com.br');
  assert.equal(normalizarEndereco('loja.x.com.br:8443/demo'), 'https://loja.x.com.br:8443/demo');
  assert.equal(normalizarEndereco('192.168.0.10.sslip.io'), 'https://192.168.0.10.sslip.io');
});

test('esquema digitado é respeitado, e a porta padrão dele some', () => {
  assert.equal(normalizarEndereco('HTTP://192.168.0.10:8000/'), 'http://192.168.0.10:8000');
  assert.equal(normalizarEndereco('http://loja.x.com.br/demo'), 'http://loja.x.com.br/demo');
  assert.equal(normalizarEndereco('https://loja.x.com.br:443/demo'), DEMO);
  assert.equal(normalizarEndereco('http://192.168.0.10:80'), 'http://192.168.0.10');
  assert.equal(normalizarEndereco('https://192.168.0.10'), 'https://192.168.0.10');
  assert.equal(normalizarEndereco('http://192.168.000.010:08000'), 'http://192.168.0.10:8000');
});

test('usuário e senha de dentro do endereço não vão para o aparelho', () => {
  assert.equal(normalizarEndereco('https://dono:segredo@loja.x.com.br/demo'), DEMO);
});

test('o que não dá para aproveitar é null (a tela pede para conferir)', () => {
  for (const ruim of [
    '',
    '   ',
    null,
    undefined,
    'http://',
    'https:///demo',
    '://loja',
    'ftp://loja.x.com.br',
    'gestaoloja://leitor?v=1&c=ABC234',
    '192.168.0.300',
    '192.168.0',
    '192.168.0.10:99999',
    '192.168.0.10:0',
    'loja.x.com.br:abc',
    'loja x.com.br',
    'loja.x.com.br/de mo',
    '[zz::1]',
  ]) {
    assert.equal(normalizarEndereco(ruim), null, String(ruim));
  }
});

test('o mesmo resultado no Hermes: não depende do URL do JavaScript', () => {
  // O `URL` do React Native não baixa a caixa nem sabe IPv6; o Node tem o completo. Sem
  // `URL` nenhum, a resposta tem de ser a mesma — senão o teste passaria e o iPhone, não.
  const original = globalThis.URL;
  try {
    // @ts-expect-error de propósito: o código não pode depender disto.
    globalThis.URL = undefined;
    assert.equal(normalizarEndereco('https://LOJA.x.com.br/demo/?a=1#b'), DEMO);
    assert.equal(normalizarEndereco('[::1]:8000'), 'http://[::1]:8000');
  } finally {
    globalThis.URL = original;
  }
});

test('rede local é o que o ATS do iOS libera por http', () => {
  for (const host of ['192.168.0.10', '[::1]', 'localhost', 'servidor', 'loja.local', 'LOJA.LOCAL.']) {
    assert.equal(ehRedeLocal(host), true, host);
  }
  for (const host of ['loja.x.com.br', 'loja.local.com.br', '192.168.0.10.sslip.io']) {
    assert.equal(ehRedeLocal(host), false, host);
  }
});

// ------------------------------------------------------------------ junções com a base

test('API e renovação da sessão: o caminho da base vem junto', () => {
  assert.equal(urlDaApi(DEMO), 'https://loja.x.com.br/demo/api/v1');
  assert.equal(`${urlDaApi(DEMO)}/auth/refresh`, 'https://loja.x.com.br/demo/api/v1/auth/refresh');
  assert.equal(urlDaApi('http://192.168.0.10:8000'), 'http://192.168.0.10:8000/api/v1');
});

test('REST: o axios junta a rota à base por texto, sem perder o /demo', () => {
  // O cliente põe `baseURL = urlDaApi(base)` e chama `api.get('/vendas')`. Se o axios um
  // dia resolvesse como `new URL('/vendas', base)`, o celular da demonstração falaria com a
  // loja de verdade — este teste é o alarme.
  const baseURL = urlDaApi(DEMO);
  assert.equal(axios.getUri({ baseURL, url: '/vendas' }), 'https://loja.x.com.br/demo/api/v1/vendas');
  assert.equal(
    axios.getUri({ baseURL, url: '/auth/login', params: { a: 1 } }),
    'https://loja.x.com.br/demo/api/v1/auth/login?a=1',
  );
  assert.equal(
    axios.getUri({ baseURL: urlDaApi('http://192.168.0.10:8000'), url: 'vendas' }),
    'http://192.168.0.10:8000/api/v1/vendas',
  );
});

test('tempo real: wss para https, ws para http, com porta e caminho', () => {
  assert.equal(urlDoTempoReal(DEMO), 'wss://loja.x.com.br/demo/api/v1/tempo-real');
  assert.equal(urlDoTempoReal('https://loja.x.com.br'), 'wss://loja.x.com.br/api/v1/tempo-real');
  assert.equal(
    urlDoTempoReal('http://192.168.0.10:8000'),
    'ws://192.168.0.10:8000/api/v1/tempo-real',
  );
});

test('saúde e privacidade saem da base, com o caminho', () => {
  assert.equal(urlDeSaude(DEMO), 'https://loja.x.com.br/demo/health');
  assert.equal(urlDaPrivacidade(DEMO), 'https://loja.x.com.br/demo/privacidade');
  assert.equal(urlDeSaude('http://192.168.0.10'), 'http://192.168.0.10/health');
});

test('teste do endereço com a demonstração desligada: o motivo, não "erro 503"', () => {
  // O proxy responde assim em /demo/api/* com a demonstração fora do ar (ADR-46).
  const foraDoAr = {
    code: 'DEMONSTRACAO_FORA_DO_AR',
    message: 'A demonstração está desligada ou começando. Tente de novo em um minuto.',
    detail: {},
  };
  assert.equal(mensagemDoTesteRecusado(503, foraDoAr), foraDoAr.message);
  // No /demo/health a resposta é a página simples, sem JSON: a frase é a do app.
  for (const status of [502, 503, 504]) {
    assert.equal(
      mensagemDoTesteRecusado(status, null),
      'O servidor está desligado ou começando. Tente de novo em um minuto.',
      String(status),
    );
  }
  assert.equal(
    mensagemDoTesteRecusado(503, { message: '   ' }),
    'O servidor está desligado ou começando. Tente de novo em um minuto.',
  );
});

test('teste do endereço com outro erro: o número, como antes', () => {
  assert.equal(mensagemDoTesteRecusado(404, { detail: 'Not Found' }), 'O servidor respondeu com erro 404.');
  assert.equal(mensagemDoTesteRecusado(500), 'O servidor respondeu com erro 500.');
  assert.equal(mensagemDoTesteRecusado(500, 'texto'), 'O servidor respondeu com erro 500.');
});

test('foto do disco da demonstração: /media/... ganha a base inteira', () => {
  assert.equal(montarUrlDaFoto('/media/a.jpg', DEMO), 'https://loja.x.com.br/demo/media/a.jpg');
  assert.equal(montarUrlDaFoto('/media/a.jpg', `${DEMO}/`), 'https://loja.x.com.br/demo/media/a.jpg');
});

test('o que a tela guarda serve de base para tudo, ida e volta', () => {
  // O endereço normalizado é estável: normalizar de novo não muda nada.
  for (const digitado of [
    'loja.x.com.br/demo',
    'https://LOJA.x.com.br/demo/app/#/pdv',
    '192.168.0.10:8000',
    'localhost',
    '[::1]:8000',
  ]) {
    const base = normalizarEndereco(digitado);
    assert.ok(base, digitado);
    assert.equal(normalizarEndereco(base), base, digitado);
  }
});
