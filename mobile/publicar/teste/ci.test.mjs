/**
 * O preparo do GitHub Actions (publicar/ci.mjs), contra a App Store Connect de mentira.
 *
 *   node --test publicar/teste/ci.test.mjs
 *
 * O que não pode quebrar: segredo nunca aparece na saída; chave e ficha saem com
 * permissão 600 FORA do repositório; o ascAppId só vai para o perfil "ci" do eas.json;
 * faltou peça → diz QUAIS nomes faltam, sem derrubar o build; versão do app.json já enviada
 * ou publicada é dita ANTES de compilar; o .ipa de teste (ad hoc) não sai sem um iPhone
 * registrado, e o UDID nunca aparece inteiro no log; o App ID ganha Push Notifications antes
 * de compilar (o expo-notifications exige), e o que não der vira aviso, sem parar a ficha.
 */

import { spawn, spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import {
  CAPACIDADE_DO_PUSH,
  comAscAppId,
  garantirPushNoAppId,
  montar,
  normalizarP8,
  porQueNaoEhP8,
  SERVIDOR_DEMO_PADRAO,
  UDID,
} from '../ci.mjs';
import { DO_MODELO_ANTIGO, lerConfig, lerPadroes } from '../ficha.mjs';
import { subirMock } from './mock-asc.mjs';
import { frasesDaTravada, oQueFoiComATravada } from '../versoes.mjs';

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
  APPLE_TELEFONE_CONTATO: '+55 11 91234-5678',
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
  // Os jeitos tortos de colar o arquivo CERTO viram o PEM certo: linhas juntadas numa só,
  // sem as linhas BEGIN/END, entre aspas.
  const corpo = P8.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '').trim();
  assert.equal(normalizarP8(P8.replace(/\n/g, ' ')), `${P8}\n`);
  assert.equal(normalizarP8(corpo), `${P8}\n`);
  assert.equal(normalizarP8(corpo.replace(/\n/g, '')), `${P8}\n`);
  assert.equal(normalizarP8(`"${P8}"`), `${P8}\n`);
  // Chave pela metade, ou outra coisa em base64, não passa: o Node tem de aceitar como PKCS#8.
  assert.equal(normalizarP8(P8.slice(0, P8.length - 60) + '\n-----END PRIVATE KEY-----'), null);
  assert.equal(normalizarP8(Buffer.from('não é chave nenhuma, só texto em base64').toString('base64')), null);
});

test('ASC_KEY_P8 errado: diz o que parece ter sido colado, sem mostrar o que foi colado', () => {
  const casos = [
    ['ABCDE12345', /ID da chave/],
    ['e789df74-d2fd-47fe-b6f1-07e541a147b9', /Issuer ID/],
    ['AuthKey_ABCDE12345.p8', /NOME ou o caminho/],
    ['C:\\Users\\loja\\Downloads\\AuthKey_ABCDE12345.p8', /NOME ou o caminho/],
    ['-----BEGIN PRIVATE KEY-----\nMIGTAgEAMBMG\n-----END PRIVATE KEY-----', /linha BEGIN, mas a chave não está inteira/],
    ['qualquer outra coisa', /não é uma chave \.p8 \(20 caracteres/],
  ];
  for (const [colado, frase] of casos) {
    const motivo = porQueNaoEhP8(colado);
    assert.match(motivo, frase, colado);
    assert.match(motivo, /Bloco de Notas/);
    assert.ok(!motivo.includes(colado), `o motivo repetiu o que foi colado: ${colado}`);
  }
  const quebrada = montar({ ...CHAVE, ASC_KEY_P8: 'ABCDE12345' });
  assert.match(quebrada.faltandoChave.join(), /ASC_KEY_P8 \(parece o ID da chave/);
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
  // A URL de suporte também não: sem Variable, ela sai do servidor da demo (como a privacidade).
  assert.ok(!soChave.faltandoFicha.includes('APPLE_URL_SUPORTE'), soChave.faltandoFicha.join());
  assert.deepEqual(soChave.faltandoRevisao, ['APPLE_TELEFONE_CONTATO', 'APPLE_DEMO_PASSWORD']);

  const quebrada = montar({ ...CHAVE, ASC_KEY_P8: 'não é chave' });
  assert.equal(quebrada.temChave, false);
  assert.match(quebrada.faltandoChave.join(), /ASC_KEY_P8 \(não é uma chave \.p8/);

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
  // O ARQUIVO, não só o que o lerPadroes deixa passar: segredo num "_comentário" ou num valor
  // que não é texto também seria commitado.
  const cru = JSON.parse(bruto);
  for (const [chave, valor] of Object.entries(cru)) {
    assert.ok(chave === '_leia' || PERMITIDOS.has(chave), `padroes.json não guarda "${chave}"`);
    assert.equal(typeof valor, 'string', `"${chave}" no padroes.json tem de ser texto`);
  }
  assert.ok(!/PRIVATE KEY|-----BEGIN/.test(bruto), 'chave privada no padroes.json (nem no _leia)');
  const { _leia, ...semComentario } = cru;
  assert.ok(!/senha_demo|password|token|key_id|telefone/i.test(JSON.stringify(semComentario)), 'segredo no padroes.json');
  assert.ok(!('_leia' in padroes), 'comentário ("_…") não vira padrão');
  assert.match(bruto, /"_leia"/);
  assert.match(padroes.issuer_id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.match(padroes.apple_team_id, /^[A-Z0-9]{10}$/);
  assert.ok(['INDIVIDUAL', 'COMPANY_OR_ORGANIZATION'].includes(padroes.apple_team_type));
  assert.ok(ean13Valido(padroes.codigo_demo), `codigo_demo ${padroes.codigo_demo} não é um EAN-13 válido`);
  // O suporte não mora aqui: fixado num servidor, ele ficava para trás quando APPLE_SERVIDOR_DEMO
  // trocava (o link da App Store caía junto com o servidor antigo). Outra página: a Variable.
  assert.equal(padroes.url_suporte, undefined, 'url_suporte no padroes.json não segue o servidor da demo');

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

test('config.json local copiado do modelo: vazio e texto de exemplo caem no padroes.json, nunca na Apple', () => {
  const pasta = mkdtempSync(join(tmpdir(), 'config-local-'));
  writeFileSync(join(pasta, 'chave-apple.p8'), `${P8}\n`);
  const modeloNovo = JSON.parse(readFileSync(join(MOBILE, 'publicar', 'config.exemplo.json'), 'utf8'));
  const modeloAntigo = {
    ...modeloNovo,
    issuer_id: 'COLE_AQUI o Issuer ID (aparece no topo da mesma tela)',
    email_suporte: 'voce@exemplo.com',
    email_demo: 'revisao@exemplo.com',
    url_suporte: 'https://loja-tria.vercel.app',
    ...DO_MODELO_ANTIGO,
  };
  const padroes = lerPadroes(PADROES_DO_REPO);
  const antes = { config: process.env.PUBLICAR_CONFIG, padroes: process.env.PUBLICAR_PADROES };
  try {
    process.env.PUBLICAR_PADROES = PADROES_DO_REPO;
    for (const [rotulo, modelo] of [['modelo de hoje', modeloNovo], ['modelo antigo', modeloAntigo]]) {
      const caminho = join(pasta, `config-${rotulo.replace(' ', '-')}.json`);
      writeFileSync(caminho, JSON.stringify({ ...modelo, key_id: 'TESTE123' }));
      process.env.PUBLICAR_CONFIG = caminho;
      const c = lerConfig();
      for (const campo of ['issuer_id', 'nome_contato', 'titular_copyright', 'codigo_demo', 'email_demo', 'email_suporte']) {
        assert.equal(c[campo], padroes[campo], `${rotulo}: ${campo} do padroes.json`);
      }
      assert.equal(c.telefone_contato, '', `${rotulo}: telefone de exemplo não vira telefone`);
      assert.equal(c.senha_demo, '', `${rotulo}: senha de exemplo não vira senha`);
      assert.equal(c.key_id, 'TESTE123');
    }
    // O que a pessoa PREENCHE vence o padrão.
    const proprio = join(pasta, 'config-proprio.json');
    writeFileSync(proprio, JSON.stringify({ ...modeloNovo, key_id: 'TESTE123', nome_contato: 'Outra Pessoa', telefone_contato: '+55 21 99999-0000' }));
    process.env.PUBLICAR_CONFIG = proprio;
    const c = lerConfig();
    assert.equal(c.nome_contato, 'Outra Pessoa');
    assert.equal(c.telefone_contato, '+55 21 99999-0000');
  } finally {
    for (const [k, v] of [['PUBLICAR_CONFIG', antes.config], ['PUBLICAR_PADROES', antes.padroes]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('URL de suporte sem Variable: a mesma da privacidade — <servidor da demo>/privacidade, ou a APPLE_URL_PRIVACIDADE do dono', () => {
  const pasta = mkdtempSync(join(tmpdir(), 'suporte-'));
  writeFileSync(join(pasta, 'chave-apple.p8'), `${P8}\n`);
  const padroes = lerPadroes(PADROES_DO_REPO);
  const antes = { config: process.env.PUBLICAR_CONFIG, padroes: process.env.PUBLICAR_PADROES };
  // O caminho do GitHub Actions: o config.json que o ci.mjs grava, lido pelo publicar.mjs.
  const lido = (env) => {
    const r = montar({ ASC_KEY_ID: 'TESTE123', ASC_KEY_P8: P8, ...env }, padroes);
    assert.equal(r.temFicha, true, `faltando: ${r.faltandoFicha.join()}`);
    const caminho = join(pasta, 'config.json');
    writeFileSync(caminho, JSON.stringify(r.config));
    process.env.PUBLICAR_CONFIG = caminho;
    return lerConfig();
  };
  try {
    process.env.PUBLICAR_PADROES = PADROES_DO_REPO;
    // Sem Variable nenhuma (a demo da Vercel): a mesma URL que o padroes.json guardava antes.
    const vercel = lido({});
    assert.equal(vercel.url_suporte, 'https://loja-tria.vercel.app/privacidade');
    assert.equal(vercel.url_privacidade, vercel.url_suporte);
    // O que o ./demo.sh --mostrar manda levar (ADR-46): o suporte vai junto com a privacidade.
    // Antes ele ficava na Vercel, e desligá-la depois da troca derrubava o link da App Store.
    for (const servidor of ['https://loja.minhaloja.com.br/demo', 'https://loja.minhaloja.com.br/demo/']) {
      const c = lido({ APPLE_SERVIDOR_DEMO: servidor, APPLE_EMAIL_DEMO: 'dono@demo.example' });
      assert.equal(c.url_suporte, 'https://loja.minhaloja.com.br/demo/privacidade', servidor);
      assert.equal(c.url_privacidade, 'https://loja.minhaloja.com.br/demo/privacidade', servidor);
    }
    // Outra página de suporte: a Variable vence, e trocar de servidor não a mexe.
    const propria = lido({ APPLE_SERVIDOR_DEMO: 'https://loja.minhaloja.com.br/demo', APPLE_URL_SUPORTE: 'https://minhaloja.com.br/contato' });
    assert.equal(propria.url_suporte, 'https://minhaloja.com.br/contato');
    // Só a privacidade num endereço permanente do dono (APPLE_URL_PRIVACIDADE): o suporte vai
    // junto com ela — preso ao servidor da demo, cairia com ele quando fosse desligado.
    for (const env of [
      { APPLE_URL_PRIVACIDADE: 'https://outra.com/privacidade' },
      { APPLE_SERVIDOR_DEMO: 'https://loja.minhaloja.com.br/demo', APPLE_URL_PRIVACIDADE: 'https://outra.com/privacidade' },
    ]) {
      const c = lido(env);
      assert.equal(c.url_privacidade, 'https://outra.com/privacidade', JSON.stringify(env));
      assert.equal(c.url_suporte, 'https://outra.com/privacidade', JSON.stringify(env));
    }
    // Na máquina do dono: o config.json do modelo, com o suporte vazio e o servidor da loja.
    const modelo = JSON.parse(readFileSync(join(MOBILE, 'publicar', 'config.exemplo.json'), 'utf8'));
    const local = join(pasta, 'config-local.json');
    writeFileSync(local, JSON.stringify({ ...modelo, key_id: 'TESTE123', url_servidor_demo: 'https://loja.minhaloja.com.br/demo' }));
    process.env.PUBLICAR_CONFIG = local;
    assert.equal(lerConfig().url_suporte, 'https://loja.minhaloja.com.br/demo/privacidade');
    writeFileSync(local, JSON.stringify({ ...modelo, key_id: 'TESTE123', url_privacidade: 'https://outra.com/privacidade' }));
    assert.equal(lerConfig().url_suporte, 'https://outra.com/privacidade', 'config.json com a privacidade própria e o suporte vazio');
  } finally {
    for (const [k, v] of [['PUBLICAR_CONFIG', antes.config], ['PUBLICAR_PADROES', antes.padroes]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
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
    assert.match(saida, /a REVISÃO ainda pede: APPLE_TELEFONE_CONTATO \(Variable ou Secret\), APPLE_DEMO_PASSWORD \(Secret\)/);
    assert.ok(!saida.includes('PRIVATE KEY'), 'a chave apareceu no log');
  } finally {
    fechar();
  }
});

test('workflow: o eas recebe o issuer e o time do padroes.json quando não há Secret/Variable', () => {
  const marco = WORKFLOW.indexOf('run: node publicar/ci.mjs preparar');
  const preparar = WORKFLOW.slice(WORKFLOW.lastIndexOf('- name:', marco), marco);
  // O "Preparar" lê o issuer de Variable OU Secret (o README promete os dois), e o telefone
  // (dado pessoal) também — os passos do eas caem na saída dele.
  assert.match(preparar, /ASC_ISSUER_ID: \$\{\{ secrets\.ASC_ISSUER_ID \|\| vars\.ASC_ISSUER_ID \}\}/);
  assert.match(preparar, /APPLE_TELEFONE_CONTATO: \$\{\{ vars\.APPLE_TELEFONE_CONTATO \|\| secrets\.APPLE_TELEFONE_CONTATO \}\}/);
  assert.match(preparar, /APPLE_DEMO_PASSWORD: \$\{\{ secrets\.APPLE_DEMO_PASSWORD \}\}/, 'a senha da demo só de Secret');
  const depoisDoPreparar = WORKFLOW.slice(marco);
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

test('versão travada: preparar diz que build e que notas foram para a revisão, sem mostrar as notas', async () => {
  const PRIMEIRA = readFileSync(join(MOBILE, 'publicar', 'ficha', 'notas-revisao.txt'), 'utf8').trim().split('\n')[0];
  const cenarios = [
    // Enviado pelo site com o build ANTIGO e as notas de uma rodada antiga (com a senha da demo).
    {
      opcoes: { buildAntigo: true, buildDaTravada: 'B-ANTIGO', notasDaTravada: 'OLD NOTES\nPassword: senha-que-nao-sai' },
      esperado: [/⚠ Build na revisão: 6 — mas o mais novo da versão 1\.0\.0 é o 7\./, /⚠ Notas da revisão na Apple: DIFERENTES/, /Remover da revisão/],
    },
    // O build mais novo e as notas deste commit: nada a trocar.
    {
      opcoes: { buildDaTravada: 'B1', notasDaTravada: `${PRIMEIRA}\nPassword: senha-que-nao-sai` },
      esperado: [/ℹ Build na revisão: 7 \(o mais novo da versão 1\.0\.0\)\./, /ℹ Notas da revisão na Apple: as deste commit/],
      semTroca: true,
    },
  ];
  for (const { opcoes, esperado, semTroca } of cenarios) {
    const { porta, estado, fechar } = await subirMock({ versaoTravada: 'WAITING_FOR_REVIEW', versaoDoAppJson: VERSAO, ...opcoes });
    try {
      const pasta = mkdtempSync(join(tmpdir(), 'ci-apple-'));
      const eas = join(pasta, 'eas.json');
      copyFileSync(join(MOBILE, 'eas.json'), eas);
      const { codigo, saida } = await rodarPreparar({
        ...CHAVE,
        ...FICHA,
        ASC_BASE: `http://127.0.0.1:${porta}`,
        PASTA_SAIDA: join(pasta, 'apple'),
        EAS_JSON: eas,
        GITHUB_OUTPUT: join(pasta, 'github-output'),
      });
      assert.equal(codigo, 0, saida);
      for (const frase of esperado) assert.match(saida, frase);
      if (semTroca) assert.doesNotMatch(saida, /Remover da revisão/);
      assert.doesNotMatch(saida, /senha-que-nao-sai|OLD NOTES/, 'o texto das notas (com a senha da demo) nunca vai ao log');
      // Só leitura: nenhuma escrita na Apple sobre a versão travada.
      const escritas = estado.requisicoes.filter((r) => !r.startsWith('GET ') && /appStoreVersions|appStoreReviewDetails|reviewSubmissions/.test(r));
      assert.deepEqual(escritas, []);
    } finally {
      fechar();
    }
  }
});

test('versão travada: o build VALID mais novo vem filtrado da Apple, não da 1ª página de envios', async () => {
  // A Apple corta a lista em `limit`, do mais novo ao mais antigo. Aqui: o 4 está preso, o 5 é
  // o VALID mais novo, e dez envios depois dele (6 a 15) não passaram. Filtrar depois do corte
  // não veria o 5 e daria o 4 como o mais novo.
  const builds = [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15].map((n) => ({
    type: 'builds',
    id: `B${n}`,
    attributes: { version: String(n), processingState: n <= 5 ? 'VALID' : n % 2 ? 'FAILED' : 'PROCESSING', expired: false, uploadedDate: `2026-11-${10 + n}T10:00:00Z` },
  }));
  const cliente = {
    get: async (caminho) => {
      const url = new URL(caminho, 'https://api.appstoreconnect.apple.com');
      if (url.pathname.endsWith('/build')) return { data: builds[0] };
      if (url.pathname.endsWith('/appStoreReviewDetail')) return { data: { attributes: { notes: 'X' } } };
      const estado = url.searchParams.get('filter[processingState]');
      const lista = builds
        .filter((b) => !estado || b.attributes.processingState === estado)
        .sort((a, b) => b.attributes.uploadedDate.localeCompare(a.attributes.uploadedDate))
        .slice(0, Number(url.searchParams.get('limit') ?? 50));
      return { data: lista };
    },
  };
  const travada = { id: 'VER-T', attributes: { versionString: '1.0.0' } };
  const foi = await oQueFoiComATravada(cliente, 'APP', travada, 'Y');
  assert.equal(foi.build, '4');
  assert.equal(foi.maisNovo, '5');
  assert.match(frasesDaTravada('1.0.0', foi).join('\n'), /⚠ Build na revisão: 4 — mas o mais novo da versão 1\.0\.0 é o 5\./);
  // Sem build VALID listado, não afirma que o preso é o mais novo.
  const semLista = frasesDaTravada('1.0.0', { build: '4', maisNovo: null, notasDesteCommit: true }).join('\n');
  assert.match(semLista, /ℹ Build na revisão: 4 \(a Apple não listou build VALID/);
  assert.doesNotMatch(semLista, /o mais novo/);
});

// ------------------------------------------------------------ Push Notifications no App ID (ADR-47)

/** Um cliente da Apple na memória: anota cada chamada e devolve os App IDs que o teste der. */
function clienteDosAppIds(bundleIds, included) {
  const chamadas = [];
  return {
    chamadas,
    get: async (caminho) => {
      chamadas.push(['GET', caminho]);
      return { data: bundleIds, included };
    },
    post: async (caminho, corpo) => {
      chamadas.push(['POST', caminho, corpo]);
      return { data: { type: 'bundleIdCapabilities', id: 'NOVA' } };
    },
  };
}
const appIdFalso = (id, identifier, capacidades) => ({
  type: 'bundleIds',
  id,
  attributes: { identifier, platform: 'IOS' },
  relationships: { bundleIdCapabilities: { data: capacidades.map((c) => ({ type: 'bundleIdCapabilities', id: c })) } },
});
const capacidadeFalsa = (id, tipo) => ({ type: 'bundleIdCapabilities', id, attributes: { capabilityType: tipo, settings: null } });
const BUNDLE = 'com.gestaoloja.app';

test('garantirPushNoAppId: já ligado não escreve; desligado liga com o corpo certo; sem App ID não escreve nada', async () => {
  const ligado = clienteDosAppIds([appIdFalso('B1', BUNDLE, ['B1_P'])], [capacidadeFalsa('B1_P', 'PUSH_NOTIFICATIONS')]);
  assert.equal(await garantirPushNoAppId(ligado, BUNDLE), 'ligado');
  assert.deepEqual(ligado.chamadas.map(([metodo]) => metodo), ['GET'], 'já ligado: nenhuma escrita');
  assert.match(ligado.chamadas[0][1], /^\/v1\/bundleIds\?filter\[identifier\]=com\.gestaoloja\.app&include=bundleIdCapabilities/);

  // O filtro da Apple casa pelo começo: a extensão (com push) vem junto e não conta pelo app.
  const desligado = clienteDosAppIds(
    [appIdFalso('B2', `${BUNDLE}.widget`, ['B2_P']), appIdFalso('B1', BUNDLE, ['B1_IAP'])],
    [capacidadeFalsa('B2_P', 'PUSH_NOTIFICATIONS'), capacidadeFalsa('B1_IAP', 'IN_APP_PURCHASE')],
  );
  assert.equal(await garantirPushNoAppId(desligado, BUNDLE), 'ligou');
  assert.equal(desligado.chamadas.length, 2);
  const [metodo, caminho, corpo] = desligado.chamadas[1];
  assert.equal(`${metodo} ${caminho}`, 'POST /v1/bundleIdCapabilities');
  assert.deepEqual(corpo, {
    data: {
      type: 'bundleIdCapabilities',
      attributes: { capabilityType: CAPACIDADE_DO_PUSH },
      relationships: { bundleId: { data: { type: 'bundleIds', id: 'B1' } } },
    },
  });

  const semAppId = clienteDosAppIds([appIdFalso('B2', `${BUNDLE}.widget`, ['B2_P'])], [capacidadeFalsa('B2_P', 'PUSH_NOTIFICATIONS')]);
  assert.equal(await garantirPushNoAppId(semAppId, BUNDLE), 'sem-bundle');
  assert.equal(semAppId.chamadas.length, 1, 'App ID inexistente: só a leitura');
});

test('preparar liga Push Notifications no App ID antes de compilar, UMA vez, conforme a especificação', async () => {
  const { porta, estado, fechar } = await subirMock();
  try {
    const pasta = mkdtempSync(join(tmpdir(), 'ci-apple-push-'));
    const rodar = async (nome) => {
      const eas = join(pasta, `${nome}-eas.json`);
      copyFileSync(join(MOBILE, 'eas.json'), eas);
      const github = join(pasta, nome);
      const r = await rodarPreparar({
        ...CHAVE,
        ...FICHA,
        ASC_BASE: `http://127.0.0.1:${porta}`,
        PASTA_SAIDA: join(pasta, 'apple'),
        EAS_JSON: eas,
        GITHUB_OUTPUT: github,
      });
      assert.equal(r.codigo, 0, r.saida);
      return { ...r, s: lerSaidas(github) };
    };
    const primeira = await rodar('um');
    assert.equal(primeira.s.push_no_app_id, 'ligou');
    assert.match(primeira.saida, /Push Notifications ligado no App ID com\.gestaoloja\.app/);
    const segunda = await rodar('dois');
    assert.equal(segunda.s.push_no_app_id, 'ligado');
    assert.equal(segunda.s.app_id, 'APP1', 'o resto do preparar segue igual');
    assert.equal(estado.requisicoes.filter((r) => r === 'POST /v1/bundleIdCapabilities').length, 1, 'ligou duas vezes');
    const [app, extensao] = estado.bundles;
    assert.deepEqual(app.capacidades.map((c) => c.tipo), ['PUSH_NOTIFICATIONS']);
    assert.deepEqual(extensao.capacidades.map((c) => c.tipo), ['PUSH_NOTIFICATIONS'], 'mexeu no App ID errado');
    assert.equal(estado.recusas.length, 0, `fora da especificação: ${JSON.stringify(estado.recusas)}`);
    for (const { saida } of [primeira, segunda]) assert.ok(!saida.includes('PRIVATE KEY'), 'a chave apareceu no log');
  } finally {
    fechar();
  }
});

test('preparar: App ID que ainda não existe ou chave sem permissão viram aviso — a ficha e o build seguem', async () => {
  const casos = [
    [{ capacidadesDoAppId: null }, 'sem-bundle', /⚠ O App ID com\.gestaoloja\.app ainda não existe no portal/],
    [{ recusarCapacidade: true }, 'falhou', /⚠ Não deu para conferir Push Notifications no App ID com\.gestaoloja\.app \(POST \/v1\/bundleIdCapabilities -> 403/],
  ];
  for (const [opcoes, esperado, frase] of casos) {
    const { porta, estado, fechar } = await subirMock(opcoes);
    try {
      const pasta = mkdtempSync(join(tmpdir(), 'ci-apple-push-'));
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
      assert.equal(s.push_no_app_id, esperado);
      assert.equal(s.tem_ficha, 'sim', esperado);
      assert.equal(s.app_id, 'APP1', `${esperado}: o preparar parou no push`);
      assert.match(saida, frase);
      assert.match(saida, /plano B em publicar\/README\.md \("Notificações no iPhone"\)/);
      if (esperado === 'sem-bundle') {
        assert.ok(!estado.requisicoes.includes('POST /v1/bundleIdCapabilities'), 'ligou push na extensão');
      }
      assert.ok(!saida.includes('PRIVATE KEY'), 'a chave apareceu no log');
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

test('senha-demo.yml: a senha é mascarada no log ANTES de qualquer passo usá-la, e não vai para env: cedo', () => {
  const yml = readFileSync(join(MOBILE, '..', '.github', 'workflows', 'senha-demo.yml'), 'utf8');
  const passos = yml.split(/\n      - /).slice(1);
  // 1º passo: lê do arquivo do evento (sem env:, que o log imprimiria) e mascara.
  assert.match(passos[0], /jq -r '\.inputs\.senha \/\/ ""' "\$GITHUB_EVENT_PATH"/);
  assert.match(passos[0], /::add-mask::\$SENHA/);
  assert.doesNotMatch(passos[0], /env:/, 'o 1º passo não pode ter env: (o log imprime antes do mask)');
  // Só o passo que grava recebe a senha por env:, e ele roda o comando do ci.mjs.
  const comSenha = passos.filter((p) => p.includes('inputs.senha }}'));
  assert.equal(comSenha.length, 1);
  assert.match(comSenha[0], /node publicar\/ci\.mjs senha-demo/);
  assert.ok(passos.indexOf(comSenha[0]) > 0, 'a senha entra num passo depois do mask');
});

test('link-ipa.yml: só LÊ a lista de builds da Expo (sem entrada, sem compilar, sem enviar) e põe o link no resumo', () => {
  const yml = readFileSync(join(MOBILE, '..', '.github', 'workflows', 'link-ipa.yml'), 'utf8');
  assert.match(yml, /^on:\n  workflow_dispatch:\n\n/m, 'sem entradas: o formulário do outro já está no limite');
  assert.match(yml, /EXPO_TOKEN: \$\{\{ secrets\.EXPO_TOKEN \}\}/);
  assert.match(yml, /eas-cli build:list --platform ios --status finished --distribution store[\s\\]+--limit 1 --json --non-interactive/);
  assert.doesNotMatch(yml, /eas-cli (build|submit) --|ASC_KEY|publicar\.mjs/, 'o link não compila, não envia e não mexe na Apple');
  assert.match(yml, /GITHUB_STEP_SUMMARY/);
  // O formulário do "Publicar iOS" segue no limite de 10 entradas do workflow_dispatch.
  const entradas = WORKFLOW.slice(WORKFLOW.indexOf('    inputs:'), WORKFLOW.indexOf('  push:')).match(/^      [a-z_]+:$/gm) ?? [];
  assert.ok(entradas.length <= 10, `o Publicar iOS tem ${entradas.length} entradas: o GitHub recusa mais de 10`);
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
