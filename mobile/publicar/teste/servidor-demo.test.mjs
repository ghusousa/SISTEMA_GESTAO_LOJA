/**
 * O servidor de demonstração com CAMINHO — a demo que sobe com a loja mora em <domínio>/demo
 * (ADR-46), com a loja de verdade na raiz do mesmo domínio. Sem Apple nenhuma no meio:
 *
 *   node --test publicar/teste/servidor-demo.test.mjs
 *
 * O que não pode quebrar: o caminho do endereço chega inteiro a toda rota que o publicador
 * confere e à URL de privacidade (junção por texto — new URL('/x', base) apaga o /demo e
 * confere a LOJA no lugar da demonstração), e o que não é base de servidor para na config,
 * antes de ir às notas que o revisor lê. A URL de suporte que não é a privacidade também é
 * aberta: a ficha publica as duas.
 */

import { createServer } from 'node:http';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { servidorDemo } from '../ficha.mjs';
import { conferirServidorDemo, debaixoDe, trocarBase } from '../servidor-demo.mjs';
import { subirDemoFalso } from './demo-falso.mjs';

const CONTA = { email: 'revisao@teste.dev', senha: 'segredo-demo', codigo: '7890000000000' };

test('url_servidor_demo: o caminho fica (sem a barra do fim); o que não é base de servidor para', () => {
  assert.equal(servidorDemo(' https://loja.teste.dev/demo/ '), 'https://loja.teste.dev/demo');
  assert.equal(servidorDemo('https://loja.teste.dev:8443/demo'), 'https://loja.teste.dev:8443/demo', 'porta e caminho');
  assert.equal(servidorDemo('https://loja.teste.dev/lojas/demo'), 'https://loja.teste.dev/lojas/demo', 'mais de um trecho');
  assert.equal(servidorDemo('https://loja-tria.vercel.app/'), 'https://loja-tria.vercel.app', 'sem caminho continua valendo');
  for (const torto of [
    'http://loja.teste.dev/demo', // o iOS não conecta (ATS)
    'loja.teste.dev/demo',
    'https://loja.teste.dev/demo?x=1', // viraria pedaço de toda rota
    'https://loja.teste.dev/demo#topo',
    'https://loja.teste.dev//demo',
    'https://loja.teste.dev/de mo',
    'https://dona:senha@loja.teste.dev/demo',
    '',
  ]) {
    assert.throws(() => servidorDemo(torto), /url_servidor_demo tem de ser https:\/\/endereço/, `"${torto}" passou`);
  }
  // Copiado da barra do navegador (a página) ou da API: o app cortaria o pedaço, e a
  // conferência bateria em <página>/health.
  for (const pagina of ['https://loja.teste.dev/demo/app', 'https://loja.teste.dev/demo/api/v1', 'https://loja.teste.dev/api']) {
    assert.throws(() => servidorDemo(pagina), /BASE do servidor/, `"${pagina}" passou`);
  }
});

test('trocarBase: só o que mora debaixo do servidor, no limite do caminho, vai para a base da conferência', () => {
  const de = 'https://loja.teste.dev/demo';
  const para = 'http://127.0.0.1:9/demo';
  assert.equal(trocarBase('https://loja.teste.dev/demo/privacidade', de, para), 'http://127.0.0.1:9/demo/privacidade');
  assert.equal(trocarBase('https://loja.teste.dev/demo', de, `${para}/`), 'http://127.0.0.1:9/demo');
  assert.equal(trocarBase('https://loja.teste.dev/demo?v=2', de, para), 'http://127.0.0.1:9/demo?v=2');
  // A loja da raiz e outro caminho que só COMEÇA igual não são a demo.
  assert.equal(trocarBase('https://loja.teste.dev/privacidade', de, para), 'https://loja.teste.dev/privacidade');
  assert.equal(trocarBase('https://loja.teste.dev/demonstracao/privacidade', de, para), 'https://loja.teste.dev/demonstracao/privacidade');
  assert.equal(trocarBase('https://outro.dev/privacidade', de, para), 'https://outro.dev/privacidade');
});

test('conferência na demo em /demo: toda rota sai debaixo do caminho, e nada vai à loja da raiz', async () => {
  const demo = await subirDemoFalso({ prefixo: '/demo' });
  try {
    const r = await conferirServidorDemo({
      ...CONTA,
      base: `${demo.base}/demo/`,
      servidor: 'https://loja.teste.dev/demo',
      urlPrivacidade: `${demo.base}/demo/privacidade`,
    });
    assert.deepEqual(r.problemas, []);
    assert.ok(r.conferidos.includes('https://loja.teste.dev/demo/health no ar'), r.conferidos.join(' | '));
    assert.deepEqual(demo.chamadas.filter((c) => c.naLoja).map((c) => `${c.metodo} ${c.cheio}`), [], 'chamada na loja da raiz');
    const feitas = demo.chamadas.map((c) => `${c.metodo} ${c.cheio}`);
    for (const rota of [
      'GET /demo/health',
      'POST /demo/api/v1/auth/login',
      `GET /demo/api/v1/variantes/codigo-barras/${CONTA.codigo}`,
      'GET /demo/api/v1/leitor/pareamentos/0',
      'DELETE /demo/api/v1/usuarios/me',
      'POST /demo/api/v1/auth/logout',
      'GET /demo/privacidade',
    ]) {
      assert.ok(feitas.includes(rota), `faltou ${rota} (feitas: ${feitas.join(', ')})`);
    }
  } finally {
    await demo.fechar();
  }
});

test('URL de suporte: outra página também tem de abrir; a mesma da privacidade abre uma vez só', async () => {
  const demo = await subirDemoFalso({ prefixo: '/demo' });
  try {
    const base = `${demo.base}/demo`;
    // O padrão: o suporte é a própria privacidade do servidor (ci.mjs/ficha.mjs) — já conferida.
    const mesma = await conferirServidorDemo({ ...CONTA, base, urlPrivacidade: `${base}/privacidade`, urlSuporte: `${base}/privacidade` });
    assert.deepEqual(mesma.problemas, []);
    assert.equal(demo.chamadas.filter((c) => c.cheio === '/demo/privacidade').length, 1, 'a privacidade abriu mais de uma vez');
    // APPLE_URL_SUPORTE com outra página: a Apple quer o suporte no ar tanto quanto a privacidade.
    const outra = await conferirServidorDemo({ ...CONTA, base, urlPrivacidade: `${base}/privacidade`, urlSuporte: `${base}/suporte` });
    assert.deepEqual(outra.problemas, []);
    assert.ok(outra.conferidos.includes('a página de suporte abre'), outra.conferidos.join(' | '));
    assert.ok(demo.chamadas.some((c) => c.metodo === 'GET' && c.cheio === '/demo/suporte'), 'o suporte não foi aberto');
  } finally {
    await demo.fechar();
  }
  const fora = await subirDemoFalso({ suporte: 404 });
  try {
    const r = await conferirServidorDemo({ ...CONTA, base: fora.base, urlPrivacidade: `${fora.base}/privacidade`, urlSuporte: `${fora.base}/suporte` });
    // Debaixo do servidor da demo, o suporte é página do sistema: segura o envio, como a privacidade.
    assert.match(r.problemas.join('\n'), /URL de suporte da ficha não abre \(HTTP 404\)/);
    assert.match(r.problemas.join('\n'), /APPLE_URL_SUPORTE/);
    assert.deepEqual(r.avisos, []);
    assert.ok(r.conferidos.includes('a política de privacidade abre'), 'a privacidade continua conferida à parte');
  } finally {
    await fora.fechar();
  }
});

test('URL de suporte FORA do servidor da demo: pedida como página; a que não abre daqui é aviso, não segura o envio', async () => {
  // A página de contato do dono, noutro servidor: como muita página de terceiro, ela só
  // entrega HTML a quem pede HTML (o navegador); o resto, recusa. A outra rota saiu do ar.
  const pedidos = [];
  const deFora = createServer((req, res) => {
    pedidos.push({ caminho: req.url, aceita: req.headers.accept ?? '' });
    if (req.url === '/contato' && /text\/html/.test(req.headers.accept ?? '')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<!doctype html><title>Contato</title>');
    }
    res.writeHead(req.url === '/contato' ? 406 : 404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('não');
  });
  await new Promise((pronto) => deFora.listen(0, '127.0.0.1', pronto));
  const paginaDeFora = `http://127.0.0.1:${deFora.address().port}`;
  const demo = await subirDemoFalso({ prefixo: '/demo' });
  try {
    const base = `${demo.base}/demo`;
    const abre = await conferirServidorDemo({ ...CONTA, base, urlPrivacidade: `${base}/privacidade`, urlSuporte: `${paginaDeFora}/contato` });
    assert.deepEqual(abre.problemas, [], 'a página que o navegador abre não pode virar "não abre"');
    assert.deepEqual(abre.avisos, []);
    assert.ok(abre.conferidos.includes('a página de suporte abre'), abre.conferidos.join(' | '));
    assert.match(pedidos.at(-1).aceita, /^text\/html/, 'o suporte não foi pedido como página');
    const privacidade = demo.chamadas.find((c) => c.cheio === '/demo/privacidade');
    assert.match(privacidade?.aceita ?? '', /^text\/html/, 'a privacidade não foi pedida como página');

    const caiu = await conferirServidorDemo({ ...CONTA, base, urlPrivacidade: `${base}/privacidade`, urlSuporte: `${paginaDeFora}/saiu` });
    assert.deepEqual(caiu.problemas, [], 'a página de fora que não abre daqui segurou o envio');
    assert.match(caiu.avisos.join('\n'), /URL de suporte da ficha \(http:\/\/127\.0\.0\.1:\d+\/saiu\) não abriu daqui \(HTTP 404\)/);
    assert.match(caiu.avisos.join('\n'), /APPLE_URL_SUPORTE/);
    assert.ok(caiu.conferidos.includes('a política de privacidade abre'), 'a privacidade continua conferida à parte');
  } finally {
    await demo.fechar();
    await new Promise((fim) => deFora.close(fim));
  }
});

test('debaixoDe: no limite do caminho, como o trocarBase', () => {
  assert.equal(debaixoDe('https://x.dev/demo/suporte', 'https://x.dev/demo/'), true);
  assert.equal(debaixoDe('https://x.dev/demo', 'https://x.dev/demo'), true);
  assert.equal(debaixoDe('https://x.dev/demo?x=1', 'https://x.dev/demo'), true);
  assert.equal(debaixoDe('https://x.dev/demonstracao/suporte', 'https://x.dev/demo'), false);
  assert.equal(debaixoDe('https://x.dev/contato', 'https://x.dev/demo'), false, 'a loja, na raiz do mesmo domínio, é fora');
  assert.equal(debaixoDe('http://127.0.0.1:12345/x', 'http://127.0.0.1:1234'), false, 'outra porta');
});

test('o endereço sem o /demo cai na loja de verdade, e a conferência recusa (nunca passa por ela)', async () => {
  const demo = await subirDemoFalso({ prefixo: '/demo' });
  try {
    const r = await conferirServidorDemo({ ...CONTA, base: demo.base, servidor: 'https://loja.teste.dev' });
    assert.ok(demo.chamadas.length > 0 && demo.chamadas.every((c) => c.naLoja), 'tudo foi à raiz');
    assert.match(r.problemas.join('\n'), /não entra no servidor de demonstração/);
    assert.ok(!r.problemas.join('\n').includes(CONTA.senha), 'a senha não aparece');
  } finally {
    await demo.fechar();
  }
});
