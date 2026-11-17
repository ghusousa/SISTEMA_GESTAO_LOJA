/**
 * O preparo do GitHub Actions (publicar/ci.mjs), contra a App Store Connect de mentira.
 *
 *   node --test publicar/teste/ci.test.mjs
 *
 * O que não pode quebrar: segredo nunca aparece na saída; chave e ficha saem com
 * permissão 600 FORA do repositório; o ascAppId só vai para o perfil "ci" do eas.json;
 * faltou peça → diz QUAIS nomes faltam, sem derrubar o build.
 */

import { spawn } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { comAscAppId, montar, normalizarP8, SERVIDOR_DEMO_PADRAO } from '../ci.mjs';
import { subirMock } from './mock-asc.mjs';

const AQUI = dirname(fileURLToPath(import.meta.url));
const MOBILE = resolve(AQUI, '..', '..');
const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const P8 = privateKey.export({ type: 'pkcs8', format: 'pem' }).trim();

const FICHA = {
  APPLE_EMAIL_SUPORTE: 'suporte@teste.dev',
  APPLE_URL_SUPORTE: 'https://demo.teste.dev',
  APPLE_NOME_CONTATO: 'Dona Teste',
  APPLE_TELEFONE_CONTATO: '+55 11 90000-0000',
  APPLE_COPYRIGHT: 'Loja Teste',
  APPLE_EMAIL_DEMO: 'revisao@teste.dev',
  APPLE_DEMO_PASSWORD: 'senha-que-nao-pode-vazar',
  APPLE_CODIGO_DEMO: '7890000000000',
};
const CHAVE = { ASC_KEY_ID: 'TESTE123', ASC_ISSUER_ID: '00000000-0000-0000-0000-000000000000', ASC_KEY_P8: P8 };

test('o .p8 colado com \\n literal ou \\r\\n vira PEM de verdade; lixo é recusado', () => {
  assert.equal(normalizarP8(P8), `${P8}\n`);
  assert.equal(normalizarP8(P8.replace(/\n/g, '\\n')), `${P8}\n`);
  assert.equal(normalizarP8(P8.replace(/\n/g, '\r\n')), `${P8}\n`);
  assert.equal(normalizarP8('  \n' + P8 + '\n\n'), `${P8}\n`);
  assert.equal(normalizarP8('MIGTAgEAMBMGByqGSM49'), null);
  assert.equal(normalizarP8(''), null);
  assert.equal(normalizarP8(undefined), null);
});

test('montar: diz quais nomes faltam e nunca põe a ficha sem a chave', () => {
  const vazio = montar({});
  assert.equal(vazio.temChave, false);
  assert.equal(vazio.temFicha, false);
  assert.deepEqual(vazio.faltandoChave, ['ASC_KEY_ID', 'ASC_ISSUER_ID', 'ASC_KEY_P8']);

  const soChave = montar({ ...CHAVE });
  assert.equal(soChave.temChave, true);
  assert.equal(soChave.temFicha, false);
  assert.ok(soChave.faltandoFicha.includes('APPLE_DEMO_PASSWORD'));

  const quebrada = montar({ ...CHAVE, ASC_KEY_P8: 'não é chave' });
  assert.equal(quebrada.temChave, false);
  assert.match(quebrada.faltandoChave.join(), /ASC_KEY_P8 \(não parece/);

  const tudo = montar({ ...CHAVE, ...FICHA });
  assert.equal(tudo.temFicha, true);
  assert.equal(tudo.config.url_servidor_demo, SERVIDOR_DEMO_PADRAO);
  assert.equal(tudo.config.senha_demo, FICHA.APPLE_DEMO_PASSWORD);
  assert.equal(montar({ ...CHAVE, ...FICHA, APPLE_SERVIDOR_DEMO: ' https://outra.dev ' }).config.url_servidor_demo, 'https://outra.dev');
});

test('ascAppId vai só para o perfil "ci", e o production fica intocado', () => {
  const eas = JSON.parse(readFileSync(join(MOBILE, 'eas.json'), 'utf8'));
  const novo = comAscAppId(eas, 6700000001);
  assert.equal(novo.submit.ci.ios.ascAppId, '6700000001');
  assert.equal(novo.submit.production.ios.ascAppId, undefined);
  assert.equal(eas.submit.ci.ios.ascAppId, undefined, 'não muta a entrada');
  // As três chaves do envio são interpoladas pelo eas a partir do ambiente do runner.
  assert.equal(novo.submit.ci.ios.ascApiKeyPath, '$ASC_API_KEY_PATH');
  assert.throws(() => comAscAppId({ submit: {} }, 1), /perfil de envio "ci"/);
});

function rodarPreparar(env) {
  return new Promise((resolver) => {
    const filho = spawn(process.execPath, [join(MOBILE, 'publicar', 'ci.mjs'), 'preparar'], {
      cwd: MOBILE,
      env: { PATH: process.env.PATH, ...env },
    });
    let saida = '';
    filho.stdout.on('data', (p) => (saida += p));
    filho.stderr.on('data', (p) => (saida += p));
    filho.on('exit', (codigo) => resolver({ codigo, saida }));
  });
}

const lerSaidas = (arquivo) =>
  Object.fromEntries(
    readFileSync(arquivo, 'utf8')
      .trim()
      .split('\n')
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  );

test('preparar de ponta a ponta: arquivos 600 fora do repo, app achado, segredo fora do log', async () => {
  const { porta, fechar } = await subirMock();
  try {
    const pasta = mkdtempSync(join(tmpdir(), 'ci-apple-'));
    const eas = join(pasta, 'eas.json');
    copyFileSync(join(MOBILE, 'eas.json'), eas);
    const github = join(pasta, 'github-output');
    const { codigo, saida } = await rodarPreparar({
      ...CHAVE,
      ...FICHA,
      ASC_BASE: `http://127.0.0.1:${porta}`,
      PASTA_SAIDA: join(pasta, 'apple'),
      EAS_JSON: eas,
      GITHUB_OUTPUT: github,
    });
    assert.equal(codigo, 0, saida);
    const s = lerSaidas(github);
    assert.equal(s.tem_chave, 'sim');
    assert.equal(s.tem_ficha, 'sim');
    assert.equal(s.app_id, 'APP1');
    assert.equal(statSync(s.chave_p8).mode & 0o777, 0o600);
    assert.equal(statSync(s.config).mode & 0o777, 0o600);
    assert.equal(readFileSync(s.chave_p8, 'utf8'), `${P8}\n`);
    const config = JSON.parse(readFileSync(s.config, 'utf8'));
    assert.equal(config.arquivo_p8, 'chave-apple.p8');
    assert.equal(config.url_servidor_demo, SERVIDOR_DEMO_PADRAO);
    assert.equal(JSON.parse(readFileSync(eas, 'utf8')).submit.ci.ios.ascAppId, 'APP1');
    assert.ok(!saida.includes(FICHA.APPLE_DEMO_PASSWORD), 'senha da demo apareceu no log');
    assert.ok(!saida.includes('PRIVATE KEY'), 'a chave apareceu no log');
  } finally {
    fechar();
  }
});

test('sem a chave: não chama a Apple, não grava nada e diz o que falta', async () => {
  const pasta = mkdtempSync(join(tmpdir(), 'ci-apple-'));
  const github = join(pasta, 'github-output');
  const { codigo, saida } = await rodarPreparar({
    ...FICHA,
    ASC_BASE: 'http://127.0.0.1:9', // ninguém escuta: se chamasse, falharia
    PASTA_SAIDA: join(pasta, 'apple'),
    EAS_JSON: join(pasta, 'nao-existe.json'),
    GITHUB_OUTPUT: github,
  });
  assert.equal(codigo, 0, saida);
  const s = lerSaidas(github);
  assert.equal(s.tem_chave, 'nao');
  assert.equal(s.tem_ficha, 'nao');
  assert.match(s.faltando_ficha, /ASC_KEY_ID/);
  assert.equal(s.chave_p8, undefined);
});
