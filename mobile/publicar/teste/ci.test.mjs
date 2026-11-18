/**
 * O preparo do GitHub Actions (publicar/ci.mjs), contra a App Store Connect de mentira.
 *
 *   node --test publicar/teste/ci.test.mjs
 *
 * O que não pode quebrar: segredo nunca aparece na saída; chave e ficha saem com
 * permissão 600 FORA do repositório; o ascAppId só vai para o perfil "ci" do eas.json;
 * faltou peça → diz QUAIS nomes faltam, sem derrubar o build; versão do app.json já enviada
 * ou publicada é dita ANTES de compilar; o .ipa de teste (ad hoc) não sai sem um iPhone
 * registrado, e o UDID nunca aparece inteiro no log.
 */

import { spawn, spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { comAscAppId, montar, normalizarP8, SERVIDOR_DEMO_PADRAO, UDID } from '../ci.mjs';
import { lerPadroes } from '../ficha.mjs';
import { subirMock } from './mock-asc.mjs';

const AQUI = dirname(fileURLToPath(import.meta.url));
const MOBILE = resolve(AQUI, '..', '..');
const VERSAO = JSON.parse(readFileSync(join(MOBILE, 'app.json'), 'utf8')).expo.version;
const UDID_NOVO = '00008030-001A2B3C4D5E802E';
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
  // Senha da demo e telefone: só a revisão exige — nunca seguram a ficha.
  assert.ok(!soChave.faltandoFicha.includes('APPLE_DEMO_PASSWORD'));
  assert.deepEqual(soChave.faltandoRevisao, ['APPLE_TELEFONE_CONTATO', 'APPLE_DEMO_PASSWORD']);

  const quebrada = montar({ ...CHAVE, ASC_KEY_P8: 'não é chave' });
  assert.equal(quebrada.temChave, false);
  assert.match(quebrada.faltandoChave.join(), /ASC_KEY_P8 \(não parece/);

  const tudo = montar({ ...CHAVE, ...FICHA });
  assert.equal(tudo.temFicha, true);
  assert.equal(tudo.config.url_servidor_demo, SERVIDOR_DEMO_PADRAO);
  assert.equal(tudo.config.senha_demo, FICHA.APPLE_DEMO_PASSWORD);
  assert.equal(montar({ ...CHAVE, ...FICHA, APPLE_SERVIDOR_DEMO: ' https://outra.dev ' }).config.url_servidor_demo, 'https://outra.dev');
});

const PADROES_DO_REPO = join(MOBILE, 'publicar', 'padroes.json');

/** EAN-13 com o dígito verificador certo (o leitor e a tela de etiquetas recusam o errado). */
const ean13Valido = (codigo) => {
  if (!/^\d{13}$/.test(codigo)) return false;
  const soma = [...codigo.slice(0, 12)].reduce((s, d, i) => s + Number(d) * (i % 2 ? 3 : 1), 0);
  return (10 - (soma % 10)) % 10 === Number(codigo[12]);
};

test('padroes.json: nada secreto, e a ficha sobe só com ASC_KEY_ID + ASC_KEY_P8', () => {
  const bruto = readFileSync(PADROES_DO_REPO, 'utf8');
  const padroes = lerPadroes(PADROES_DO_REPO);
  const PERMITIDOS = new Set([
    'issuer_id', 'apple_team_id', 'apple_team_type', 'nome_contato', 'titular_copyright', 'email_suporte',
    'url_suporte', 'email_demo', 'codigo_demo', 'url_servidor_demo', 'url_privacidade', 'url_etiquetas_demo',
  ]);
  for (const chave of Object.keys(padroes)) assert.ok(PERMITIDOS.has(chave), `padroes.json não guarda "${chave}"`);
  assert.ok(!/PRIVATE KEY|senha_demo|password|token|key_id|telefone/i.test(JSON.stringify(padroes)), 'segredo no padroes.json');
  assert.ok(!('_leia' in padroes), 'comentário ("_…") não vira padrão');
  assert.match(bruto, /"_leia"/);
  assert.match(padroes.issuer_id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.match(padroes.apple_team_id, /^[A-Z0-9]{10}$/);
  assert.ok(['INDIVIDUAL', 'COMPANY_OR_ORGANIZATION'].includes(padroes.apple_team_type));
  assert.ok(ean13Valido(padroes.codigo_demo), `codigo_demo ${padroes.codigo_demo} não é um EAN-13 válido`);
  assert.match(padroes.url_suporte, /^https:\/\//);

  const so = montar({ ASC_KEY_ID: 'TESTE123', ASC_KEY_P8: P8 }, padroes);
  assert.equal(so.temChave, true, 'o issuer vem do padroes.json');
  assert.deepEqual(so.faltandoChave, []);
  assert.equal(so.temFicha, true);
  assert.deepEqual(so.faltandoFicha, []);
  assert.deepEqual(so.faltandoRevisao, ['APPLE_TELEFONE_CONTATO', 'APPLE_DEMO_PASSWORD']);
  assert.equal(so.config.issuer_id, padroes.issuer_id);
  assert.equal(so.config.email_demo, padroes.email_demo);
  assert.equal(so.config.senha_demo, '');
  assert.deepEqual(so.time, { id: padroes.apple_team_id, tipo: padroes.apple_team_type });

  // Secret/Variable vence o padrão.
  const outro = montar(
    {
      ASC_KEY_ID: 'TESTE123',
      ASC_KEY_P8: P8,
      ASC_ISSUER_ID: '11111111-2222-3333-4444-555555555555',
      APPLE_URL_SUPORTE: 'https://suporte.outro.dev',
      APPLE_TEAM_ID: 'ABCDE12345',
      APPLE_TEAM_TYPE: 'COMPANY_OR_ORGANIZATION',
      ...{ APPLE_DEMO_PASSWORD: FICHA.APPLE_DEMO_PASSWORD, APPLE_TELEFONE_CONTATO: FICHA.APPLE_TELEFONE_CONTATO },
    },
    padroes,
  );
  assert.equal(outro.config.issuer_id, '11111111-2222-3333-4444-555555555555');
  assert.equal(outro.config.url_suporte, 'https://suporte.outro.dev');
  assert.deepEqual(outro.time, { id: 'ABCDE12345', tipo: 'COMPANY_OR_ORGANIZATION' });
  assert.deepEqual(outro.faltandoRevisao, []);
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

/** Sem padroes.json: os testes de "faltou peça" olham só o ambiente (o de padrões tem o seu). */
const SEM_PADROES = join(mkdtempSync(join(tmpdir(), 'ci-sem-padroes-')), 'nao-existe.json');

function rodarPreparar(env, comando = 'preparar') {
  return new Promise((resolver) => {
    const filho = spawn(process.execPath, [join(MOBILE, 'publicar', 'ci.mjs'), comando], {
      cwd: MOBILE,
      env: { PATH: process.env.PATH, PUBLICAR_PADROES: SEM_PADROES, ...env },
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
    assert.equal(s.versao_estado, 'inexistente', 'app sem versão: o publicador cria');
    assert.ok(!saida.includes(FICHA.APPLE_DEMO_PASSWORD), 'senha da demo apareceu no log');
    assert.ok(!saida.includes('PRIVATE KEY'), 'a chave apareceu no log');
  } finally {
    fechar();
  }
});

test('preparar só com ASC_KEY_ID + ASC_KEY_P8: o resto vem do padroes.json, e a revisão diz o que ainda pede', async () => {
  const { porta, fechar } = await subirMock();
  try {
    const pasta = mkdtempSync(join(tmpdir(), 'ci-apple-padroes-'));
    const eas = join(pasta, 'eas.json');
    copyFileSync(join(MOBILE, 'eas.json'), eas);
    const github = join(pasta, 'github-output');
    const padroes = lerPadroes(PADROES_DO_REPO);
    const { codigo, saida } = await rodarPreparar({
      ASC_KEY_ID: CHAVE.ASC_KEY_ID,
      ASC_KEY_P8: P8,
      PUBLICAR_PADROES: PADROES_DO_REPO,
      ASC_BASE: `http://127.0.0.1:${porta}`,
      PASTA_SAIDA: join(pasta, 'apple'),
      EAS_JSON: eas,
      GITHUB_OUTPUT: github,
    });
    assert.equal(codigo, 0, saida);
    const s = lerSaidas(github);
    assert.equal(s.tem_chave, 'sim');
    assert.equal(s.tem_ficha, 'sim');
    assert.equal(s.faltando_ficha, '');
    assert.equal(s.faltando_revisao, 'APPLE_TELEFONE_CONTATO APPLE_DEMO_PASSWORD');
    assert.equal(s.issuer_id, padroes.issuer_id, 'o eas recebe o issuer do padrão (secrets.ASC_ISSUER_ID || isto)');
    assert.equal(s.team_id, padroes.apple_team_id);
    assert.equal(s.team_type, padroes.apple_team_type);
    assert.equal(s.app_id, 'APP1');
    const config = JSON.parse(readFileSync(s.config, 'utf8'));
    assert.equal(config.issuer_id, padroes.issuer_id);
    assert.equal(config.codigo_demo, padroes.codigo_demo);
    assert.equal(config.senha_demo, '');
    assert.match(saida, /a REVISÃO ainda pede: APPLE_TELEFONE_CONTATO, APPLE_DEMO_PASSWORD/);
    assert.ok(!saida.includes('PRIVATE KEY'), 'a chave apareceu no log');
  } finally {
    fechar();
  }
});

test('workflow: o eas recebe o issuer e o time do padroes.json quando não há Secret/Variable', () => {
  const depoisDoPreparar = WORKFLOW.slice(WORKFLOW.indexOf('run: node publicar/ci.mjs preparar'));
  assert.ok(!/ASC_ISSUER_ID: \$\{\{ secrets\.ASC_ISSUER_ID \}\}/.test(depoisDoPreparar), 'passo do eas com o issuer só do Secret');
  assert.ok(!/APPLE_TEAM_ID: \$\{\{ vars\.APPLE_TEAM_ID \}\}/.test(depoisDoPreparar), 'passo do eas com o time só da Variable');
  assert.equal((depoisDoPreparar.match(/secrets\.ASC_ISSUER_ID \|\| steps\.apple\.outputs\.issuer_id/g) ?? []).length, 4);
  assert.equal((depoisDoPreparar.match(/vars\.APPLE_TEAM_ID \|\| steps\.apple\.outputs\.team_id/g) ?? []).length, 2);
  assert.equal((depoisDoPreparar.match(/vars\.APPLE_TEAM_TYPE \|\| steps\.apple\.outputs\.team_type/g) ?? []).length, 2);
});

test('preparar diz, ANTES de compilar, que a versão do app.json já foi enviada ou publicada', async () => {
  for (const estadoNaApple of ['WAITING_FOR_REVIEW', 'READY_FOR_DISTRIBUTION']) {
    const { porta, fechar } = await subirMock({ versaoTravada: estadoNaApple, versaoDoAppJson: VERSAO });
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
      assert.equal(s.versao_estado, 'travada', estadoNaApple);
      assert.match(s.versao_mensagem, new RegExp(`versão ${VERSAO.replace(/\./g, '\\.')} já existe na Apple no estado ${estadoNaApple}`));
      assert.match(s.versao_mensagem, /suba "version"/, 'diz como sair: versão nova no app.json');
      assert.match(saida, /⚠ A versão/);
    } finally {
      fechar();
    }
  }
});

test('aparelhos: sem iPhone registrado e sem UDID, falha dizendo como resolver — e não registra nada', async () => {
  const { porta, estado, fechar } = await subirMock();
  try {
    const pasta = mkdtempSync(join(tmpdir(), 'ci-apple-'));
    const { codigo, saida } = await rodarPreparar(
      { ...CHAVE, ASC_BASE: `http://127.0.0.1:${porta}`, GITHUB_OUTPUT: join(pasta, 'saida') },
      'aparelhos',
    );
    assert.equal(codigo, 1, saida);
    assert.match(saida, /Nenhum iPhone registrado/);
    assert.match(saida, /udid_aparelho/);
    assert.match(saida, /BrowserStack reassina/);
    assert.ok(!estado.requisicoes.includes('POST /v1/devices'), 'registrou sem pedir');
    assert.ok(!saida.includes('PRIVATE KEY'));
  } finally {
    fechar();
  }
});

test('aparelhos: com o UDID, registra o iPhone UMA vez (o reenvio não duplica) e nunca mostra o UDID inteiro', async () => {
  const { porta, estado, fechar } = await subirMock();
  try {
    const pasta = mkdtempSync(join(tmpdir(), 'ci-apple-'));
    const env = {
      ...CHAVE,
      ASC_BASE: `http://127.0.0.1:${porta}`,
      UDID_APARELHO: ` ${UDID_NOVO} `,
      NOME_APARELHO: 'iPhone da Dona',
    };
    const primeira = await rodarPreparar({ ...env, GITHUB_OUTPUT: join(pasta, 'um') }, 'aparelhos');
    assert.equal(primeira.codigo, 0, primeira.saida);
    assert.match(primeira.saida, /registrado na conta da Apple \("iPhone da Dona"\)/);
    assert.equal(lerSaidas(join(pasta, 'um')).aparelhos, '1');
    assert.deepEqual(
      estado.aparelhos.map((d) => [d.udid, d.platform, d.name]),
      [[UDID_NOVO, 'IOS', 'iPhone da Dona']],
    );
    const segunda = await rodarPreparar({ ...env, GITHUB_OUTPUT: join(pasta, 'dois') }, 'aparelhos');
    assert.equal(segunda.codigo, 0, segunda.saida);
    assert.match(segunda.saida, /já estava registrado/);
    assert.equal(estado.requisicoes.filter((r) => r === 'POST /v1/devices').length, 1, 'registrou duas vezes');
    for (const { saida } of [primeira, segunda]) assert.ok(!saida.includes(UDID_NOVO), 'o UDID saiu inteiro no log');
    assert.equal(estado.recusas.length, 0, `fora da especificação: ${JSON.stringify(estado.recusas)}`);
  } finally {
    fechar();
  }
});

test('aparelhos: já registrado basta; UDID torto, desativado ou sem chave param com a frase certa', async () => {
  const UDID_ANTIGO = 'a'.repeat(40);
  const { porta, estado, fechar } = await subirMock({
    aparelhos: [
      { name: 'iPhone antigo', udid: UDID_ANTIGO },
      { name: 'iPhone parado', udid: UDID_NOVO, status: 'DISABLED' },
    ],
  });
  try {
    const base = { ...CHAVE, ASC_BASE: `http://127.0.0.1:${porta}` };
    const ok = await rodarPreparar(base, 'aparelhos');
    assert.equal(ok.codigo, 0, ok.saida);
    assert.match(ok.saida, /1 iPhone\(s\) registrado\(s\)/, 'só os ativos contam');
    // Registrar na Apple não garante o perfil: a Expo usa o cadastro DELA.
    assert.match(ok.saida, /eas-cli device:create/);
    assert.doesNotMatch(ok.saida, /pode ser assinado/);

    const torto = await rodarPreparar({ ...base, UDID_APARELHO: '1234-abcd' }, 'aparelhos');
    assert.equal(torto.codigo, 1);
    assert.match(torto.saida, /não parece um UDID de iPhone/);

    const parado = await rodarPreparar({ ...base, UDID_APARELHO: UDID_NOVO }, 'aparelhos');
    assert.equal(parado.codigo, 1);
    assert.match(parado.saida, /DESATIVADO/);
    assert.ok(!parado.saida.includes(UDID_NOVO));

    const semChave = await rodarPreparar({ ASC_BASE: base.ASC_BASE }, 'aparelhos');
    assert.equal(semChave.codigo, 1);
    assert.match(semChave.saida, /faltam os Secrets: ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_P8/);
    assert.ok(!estado.requisicoes.includes('POST /v1/devices'));
  } finally {
    fechar();
  }
});

test('UDID: os dois formatos da Apple passam; o resto não', () => {
  assert.ok(UDID.test(UDID_NOVO));
  assert.ok(UDID.test('0123456789abcdef0123456789abcdef01234567'));
  for (const torto of ['', '00008030001A2B3C4D5E802E', '00008030-001A2B3C4D5E802', 'z'.repeat(40), `${UDID_NOVO}\n`]) {
    assert.ok(!UDID.test(torto), torto);
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

// ------------------------------------------------------------ o workflow (publicar-apple.yml)

const WORKFLOW = readFileSync(join(MOBILE, '..', '.github', 'workflows', 'publicar-apple.yml'), 'utf8');

/** O `run: |` de um passo do workflow, pelo nome (sem parser de YAML: o recuo diz onde acaba). */
function scriptDoPasso(nome) {
  const linhas = WORKFLOW.split('\n');
  const inicio = linhas.findIndex((l) => l.trim() === `- name: ${nome}`);
  assert.ok(inicio >= 0, `passo "${nome}" não achado`);
  const run = linhas.findIndex((l, i) => i > inicio && /^\s+run: \|\s*$/.test(l));
  const recuo = linhas[run].search(/\S/);
  const corpo = [];
  for (const l of linhas.slice(run + 1)) {
    if (l.trim() && l.search(/\S/) <= recuo) break;
    corpo.push(l);
  }
  return corpo.join('\n');
}

/** Roda o passo "Decidir" com as caixas do formulário; devolve { codigo, saida, saidas }. */
function decidir(caixas) {
  const pasta = mkdtempSync(join(tmpdir(), 'ci-decidir-'));
  const script = join(pasta, 'decidir.sh');
  writeFileSync(script, scriptDoPasso('Decidir o que fazer e conferir a versão'));
  const github = join(pasta, 'saida');
  writeFileSync(github, '');
  const r = spawnSync('bash', [script], {
    cwd: MOBILE,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      EVENTO: 'workflow_dispatch',
      EXPO_TOKEN: 'token-de-teste',
      GITHUB_OUTPUT: github,
      COMPLETO: 'false',
      COMPILAR: 'false',
      ENVIAR: 'false',
      FICHA: 'false',
      REVISAO: 'false',
      APARELHOS: 'false',
      ...caixas,
    },
  });
  return { codigo: r.status, saida: `${r.stdout}${r.stderr}`, saidas: lerSaidas(github) };
}

test('workflow: "revisao" com "compilar" ou "enviar" fora do completo para antes de tudo (o build antigo iria)', () => {
  for (const caixas of [{ COMPILAR: 'true', REVISAO: 'true' }, { ENVIAR: 'true', REVISAO: 'true', FICHA: 'true' }]) {
    const r = decidir(caixas);
    assert.equal(r.codigo, 1, r.saida);
    assert.match(r.saida, /só no modo "completo"/);
  }
  // Os caminhos que continuam: revisão sozinha, compilar com a ficha, e o completo (que espera o build).
  assert.equal(decidir({ REVISAO: 'true' }).saidas.revisao, 'true');
  assert.equal(decidir({ COMPILAR: 'true', FICHA: 'true' }).saidas.compilar, 'true');
  const completo = decidir({ COMPLETO: 'true', COMPILAR: 'true' });
  assert.equal(completo.codigo, 0, completo.saida);
  assert.deepEqual([completo.saidas.completo, completo.saidas.revisao], ['true', 'true']);
});

test('workflow: o vídeo do link é baixado UMA vez, e a conferência e a ficha recebem o arquivo', () => {
  assert.match(WORKFLOW, /node publicar\/baixar-video\.mjs "\$VIDEO_REVISAO_URL" "\$RUNNER_TEMP\/video-revisao"/);
  assert.doesNotMatch(WORKFLOW, /--video-revisao "\$VIDEO_REVISAO_URL"/, 'um passo ainda baixa o link de novo');
  for (const passo of ['Conferir o que o modo completo precisa', 'Atualizar a ficha da loja (e enviar para a revisão, se pedido)']) {
    assert.match(scriptDoPasso(passo), /--video-revisao "\$VIDEO"/, passo);
  }
});

test('workflow: o .ipa de teste é ad hoc de verdade e monta o perfil sem modo interativo', () => {
  const eas = JSON.parse(readFileSync(join(MOBILE, 'eas.json'), 'utf8'));
  const perfil = eas.build['teste-aparelhos'];
  assert.equal(perfil.distribution, 'internal');
  // Sem isto, o eas-cli (27.x) cai em SetUpInternalProvisioningProfile e, sem credencial
  // anterior, para em "You're in non-interactive mode ... Run this command again in interactive mode".
  assert.equal(perfil.ios.enterpriseProvisioning, 'adhoc');
  const script = scriptDoPasso('Compilar o .ipa de teste para iPhones reais');
  assert.match(script, /--profile teste-aparelhos[\s\\]+--non-interactive --refresh-ad-hoc-provisioning-profile/);
  assert.match(script, /EXPO_ASC_API_KEY_PATH=/, 'o refresh do perfil precisa da chave da Apple');
});
