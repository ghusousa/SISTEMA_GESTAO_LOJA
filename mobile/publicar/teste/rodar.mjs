/**
 * Teste de ponta a ponta do publicador: sobe a App Store de mentira (que confere cada rota,
 * parâmetro e corpo contra a especificação oficial 4.6), gera uma chave descartável e
 * capturas PNG sintéticas nos dois tamanhos, roda `publicar.mjs` de verdade em cada
 * cenário e confere o que chegou.
 *
 *   node publicar/teste/rodar.mjs             todos os cenários, com capturas sintéticas
 *   node publicar/teste/rodar.mjs --reais     a primeira publicação com as capturas REAIS de
 *                                             media/app-store (rode antes de publicar)
 *   node publicar/teste/rodar.mjs --verboso   mostra a saída do publicador em todo cenário
 *
 * A saída de cada execução só aparece quando algo falha (ou com --verboso).
 */

import { spawn } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { NAO_SAO_PERGUNTAS, RESPOSTAS } from '../classificacao.mjs';
import { CORPOS, VERSAO_DA_ESPECIFICACAO } from './esquema-asc.mjs';
import { subirMock } from './mock-asc.mjs';

const AQUI = dirname(fileURLToPath(import.meta.url));
const MOBILE = resolve(AQUI, '..', '..');
const RAIZ = resolve(MOBILE, '..');
const REAIS = process.argv.includes('--reais');
const VERBOSO = process.argv.includes('--verboso');
const SENHA_DEMO = 'segredo-demo';
const lerFicha = (nome) => readFileSync(join(MOBILE, 'publicar', 'ficha', nome), 'utf8').trim();
const VERSAO = JSON.parse(readFileSync(join(MOBILE, 'app.json'), 'utf8')).expo.version;
const md5 = (dados) => createHash('md5').update(dados).digest('hex');
// Tudo o que o teste grava fica debaixo de uma pasta só, apagada no fim.
const TEMP = mkdtempSync(join(tmpdir(), 'publicar-teste-'));

// ---------------------------------------------------------------- PNG sintético

const TABELA_CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = TABELA_CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pedaco(tipo, dados) {
  const corpo = Buffer.concat([Buffer.from(tipo, 'latin1'), dados]);
  const tamanho = Buffer.alloc(4);
  tamanho.writeUInt32BE(dados.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(corpo));
  return Buffer.concat([tamanho, corpo, crc]);
}
/** PNG de verdade (RGB, ou RGBA com `alfa`), com uma faixa que muda com a `semente`. */
function gerarPng(largura, altura, { semente = 0, alfa = false } = {}) {
  const bpp = alfa ? 4 : 3;
  const largLinha = 1 + largura * bpp;
  const fundo = Buffer.alloc(largLinha);
  const faixa = Buffer.alloc(largLinha);
  for (let x = 0; x < largura; x++) {
    const i = 1 + x * bpp;
    fundo.set([30, 58, 95].concat(alfa ? [255] : []), i);
    faixa.set([(semente * 37) % 256, 200, (x * 3) % 256].concat(alfa ? [128] : []), i);
  }
  const bruto = Buffer.alloc(largLinha * altura);
  const inicio = 200 + semente * 150;
  for (let y = 0; y < altura; y++) (y >= inicio && y < inicio + 120 ? faixa : fundo).copy(bruto, y * largLinha);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(largura, 0);
  ihdr.writeUInt32BE(altura, 4);
  ihdr.set([8, alfa ? 6 : 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pedaco('IHDR', ihdr),
    pedaco('IDAT', deflateSync(bruto, { level: 1 })),
    pedaco('IEND', Buffer.alloc(0)),
  ]);
}

const TELAS = ['pdv', 'pagamento', 'financeiro', 'relatorios', 'estoque', 'produtos', 'caixa', 'crediario', 'vendas', 'entrada'];
const nomeDaTela = (i) => `${String(i + 1).padStart(2, '0')}-${TELAS[i]}.png`;
const cache = new Map();
function png(largura, altura, opcoes = {}) {
  const chave = JSON.stringify([largura, altura, opcoes]);
  if (!cache.has(chave)) cache.set(chave, gerarPng(largura, altura, opcoes));
  return cache.get(chave);
}

/** Uma pasta de capturas no formato do contrato (iphone-6.5/ e, se pedido, iphone-6.9/). */
function capturasSinteticas({ tamanho69 = [1320, 2868], com69 = true, alfaNo65 = false } = {}) {
  const base = mkdtempSync(join(TEMP, 'capturas-'));
  mkdirSync(join(base, 'iphone-6.5'));
  if (com69) mkdirSync(join(base, 'iphone-6.9'));
  for (let i = 0; i < 10; i++) {
    writeFileSync(join(base, 'iphone-6.5', nomeDaTela(i)), png(1242, 2688, { semente: i, alfa: alfaNo65 && i === 2 }));
    if (com69) writeFileSync(join(base, 'iphone-6.9', nomeDaTela(i)), png(tamanho69[0], tamanho69[1], { semente: i }));
  }
  return base;
}

// ---------------------------------------------------------------- o publicador de verdade

const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const PASTA_CONFIG = mkdtempSync(join(TEMP, 'publicar-teste-'));
writeFileSync(join(PASTA_CONFIG, 'chave-apple.p8'), privateKey.export({ type: 'pkcs8', format: 'pem' }));
writeFileSync(
  join(PASTA_CONFIG, 'config.json'),
  JSON.stringify({
    key_id: 'TESTE123',
    issuer_id: '00000000-0000-0000-0000-000000000000',
    arquivo_p8: 'chave-apple.p8',
    email_suporte: 'suporte@teste.dev',
    url_suporte: 'https://demo-da-loja.teste.dev',
    nome_contato: 'Dona Teste',
    telefone_contato: '+55 11 90000-0000',
    titular_copyright: 'Loja Teste',
    email_demo: 'revisao@teste.dev',
    senha_demo: SENHA_DEMO,
    codigo_demo: '7890000000000',
    url_etiquetas_demo: '',
    url_servidor_demo: 'https://demo-da-loja.teste.dev/',
  }),
);

/**
 * Roda publicar.mjs com o ambiente limpo (nada de GITHUB_*, PUBLICAR_* ou ASC_* herdado:
 * rodando dentro do Actions, o teste não pode escrever no resumo da execução de verdade).
 */
function publicar(args, { porta, capturas, env = {} }) {
  const limpo = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !/^(GITHUB_|PUBLICAR_|ASC_|RUNNER_)/.test(k)),
  );
  return new Promise((resolver) => {
    // spawn assíncrono, nunca spawnSync: o mock roda NESTE processo, e o síncrono congelaria
    // o loop — o publicador perguntaria e ninguém responderia.
    const filho = spawn(process.execPath, [join(MOBILE, 'publicar', 'publicar.mjs'), ...args], {
      env: {
        ...limpo,
        ASC_BASE: `http://127.0.0.1:${porta ?? 9}`,
        ASC_REPETIR_MS: '5',
        PUBLICAR_CONFIG: join(PASTA_CONFIG, 'config.json'),
        PUBLICAR_CAPTURAS: capturas,
        PUBLICAR_INTERVALO_CAPTURAS: '0.01',
        PUBLICAR_INTERVALO_BUILD: '0.05',
        ...env,
      },
    });
    let saida = '';
    filho.stdout.on('data', (p) => (saida += p));
    filho.stderr.on('data', (p) => (saida += p));
    filho.on('exit', (codigo) => resolver({ codigo, saida }));
  });
}

// ---------------------------------------------------------------- conferência

let falhas = 0;
async function cenario(titulo, corpo) {
  console.log(`\n▶ ${titulo}`);
  const saidas = [];
  let falhasAntes = falhas;
  const conferir = (condicao, rotulo) => {
    console.log(`  ${condicao ? '✔' : '✖'} ${rotulo}`);
    if (!condicao) falhas += 1;
  };
  try {
    await corpo({ conferir, guardar: (s) => saidas.push(s) });
  } catch (erro) {
    conferir(false, `o cenário quebrou: ${erro.stack}`);
  }
  if (VERBOSO || falhas > falhasAntes) {
    for (const s of saidas) console.log(`  ┌── saída do publicador\n${s.replace(/^/gm, '  │ ')}\n  └──`);
  }
  falhasAntes = falhas;
}

const contar = (estado, rota) => estado.requisicoes.filter((r) => r === rota).length;
const recusasInesperadas = (estado) => estado.recusas.filter((r) => !r.simulada);
const conjuntoDoTipo = (estado, tipo) => Object.entries(estado.conjuntos).find(([, c]) => c.tipo === tipo);
const capturasNaOrdem = (estado, conjuntoId) =>
  (estado.conjuntos[conjuntoId].ordem ?? []).map((id) => estado.capturas[id]).filter(Boolean);

/** As capturas de um conjunto batem com a pasta: mesmos nomes, mesma ordem, bytes e MD5. */
function conferirConjunto(conferir, estado, tipo, pasta) {
  const nomes = readdirSync(pasta).filter((a) => a.endsWith('.png')).sort();
  const conjunto = conjuntoDoTipo(estado, tipo);
  conferir(Boolean(conjunto), `${tipo}: o conjunto existe`);
  if (!conjunto) return;
  const naApple = capturasNaOrdem(estado, conjunto[0]);
  conferir(naApple.map((c) => c.nome).join() === nomes.join(), `${tipo}: ${naApple.length} de ${nomes.length} capturas, na ordem da pasta`);
  conferir(
    naApple.every((c) => {
      const dados = readFileSync(join(pasta, c.nome));
      return c.estado === 'COMPLETE' && c.bytes === dados.length && c.md5 === md5(dados) && c.checksum === c.md5;
    }),
    `${tipo}: bytes inteiros, MD5 conferido pela Apple e processadas (COMPLETE)`,
  );
}

// ---------------------------------------------------------------- cenários

const perguntasDaEspecificacao = Object.keys(CORPOS.AgeRatingDeclarationUpdateRequest.atributos);
console.log(`Especificação da Apple usada pela Apple de mentira: ${VERSAO_DA_ESPECIFICACAO}`);

await cenario('A classificação etária responde TODAS as perguntas da especificação', async ({ conferir }) => {
  const cobertas = new Set([...Object.keys(RESPOSTAS), ...NAO_SAO_PERGUNTAS]);
  const semResposta = perguntasDaEspecificacao.filter((p) => !cobertas.has(p));
  conferir(semResposta.length === 0, `toda pergunta da ${VERSAO_DA_ESPECIFICACAO} tem resposta${semResposta.length ? ` (faltam: ${semResposta.join(', ')})` : ''}`);
  const inventadas = [...cobertas].filter((p) => !perguntasDaEspecificacao.includes(p));
  conferir(inventadas.length === 0, `nenhuma resposta fora da especificação${inventadas.length ? ` (${inventadas.join(', ')})` : ''}`);
  const tipos = CORPOS.AgeRatingDeclarationUpdateRequest.atributos;
  conferir(
    Object.entries(RESPOSTAS).every(([p, v]) => (tipos[p].t === 'boolean' ? v === false : v === 'NONE')),
    'frequência = NONE e sim/não = false em todas',
  );
});

const baseSintetica = REAIS ? null : capturasSinteticas();
const baseDaPrimeira = REAIS ? join(RAIZ, 'media', 'app-store') : baseSintetica;

await cenario(
  `Primeira publicação, com --enviar (${REAIS ? 'capturas REAIS de media/app-store' : 'capturas sintéticas 6,5" + 6,9"'})`,
  async ({ conferir, guardar }) => {
    const mock = await subirMock();
    const resumoDoActions = join(mkdtempSync(join(TEMP, 'resumo-')), 'resumo.md');
    const { codigo, saida } = await publicar(['--enviar'], {
      porta: mock.porta,
      capturas: baseDaPrimeira,
      env: { GITHUB_STEP_SUMMARY: resumoDoActions },
    });
    guardar(saida);
    const e = mock.estado;
    await mock.fechar();
    conferir(codigo === 0, 'o publicador terminou sem erro');
    conferir(recusasInesperadas(e).length === 0, `todo corpo e parâmetro conforme a especificação ${VERSAO_DA_ESPECIFICACAO}${recusasInesperadas(e).length ? `: ${JSON.stringify(recusasInesperadas(e))}` : ''}`);
    conferir(e.app.primaryLocale === 'pt-BR', 'idioma principal virou pt-BR');
    conferir(e.app.contentRightsDeclaration === 'DOES_NOT_USE_THIRD_PARTY_CONTENT', 'direitos de conteúdo: não usa conteúdo de terceiros');
    const info = e.infoLocs.INFO1;
    conferir(info?.name === lerFicha('nome.txt') && info?.subtitle === lerFicha('subtitulo.txt'), 'nome e subtítulo da ficha');
    conferir([...(info?.subtitle ?? '')].length <= 30, 'subtítulo dentro dos 30');
    conferir(info?.privacyPolicyUrl === 'https://demo-da-loja.teste.dev/privacidade', 'URL de privacidade sai do servidor da demo');
    conferir(e.categorias.INFO1?.principal === 'BUSINESS' && e.categorias.INFO1?.secundaria === 'PRODUCTIVITY', 'categorias');
    const idade = e.idadeRecebida.at(-1) ?? {};
    conferir(Object.keys(idade).sort().join() === Object.keys(RESPOSTAS).sort().join(), `classificação: as ${Object.keys(RESPOSTAS).length} perguntas foram enviadas`);
    conferir(NAO_SAO_PERGUNTAS.every((p) => !(p in idade)), 'kidsAgeBand e os ajustes manuais de idade ficaram intocados');
    conferir(idade.userGeneratedContent === false && idade.messagingAndChat === false && idade.gunsOrOtherWeapons === 'NONE', 'perguntas novas respondidas (conteúdo de usuário, conversa, armas...)');
    conferir(
      JSON.stringify(e.disponibilidadeCriada) === JSON.stringify({ availableInNewTerritories: false, territorios: [{ id: 'BRA', available: true }] }),
      'disponibilidade criada: só Brasil, sem países novos',
    );
    const versao = e.versoes.find((v) => v.id === 'VER1');
    conferir(versao?.versionString === VERSAO && versao?.releaseType === 'AFTER_APPROVAL', `versão ${VERSAO} do app.json, liberada depois de aprovada`);
    conferir(versao?.copyright?.includes('Loja Teste'), 'copyright');
    const loc = Object.values(e.versaoLocs).find((l) => l.versao === 'VER1')?.atributos ?? {};
    conferir([...(loc.description ?? '')].length > 1000 && !loc.description.includes('{{'), 'descrição inteira, sem marcador sobrando');
    conferir(loc.description?.includes('suporte@teste.dev') && loc.description?.includes('https://demo-da-loja.teste.dev/privacidade'), 'descrição com o e-mail de suporte e a política de privacidade');
    conferir(loc.keywords === lerFicha('palavras-chave.txt') && [...loc.keywords].length <= 100, 'palavras-chave (até 100)');
    conferir(loc.promotionalText === lerFicha('texto-promocional.txt') && [...loc.promotionalText].length <= 170, 'texto promocional (até 170)');
    conferir(loc.whatsNew === undefined, 'sem "Novidades" na primeira versão');
    conferirConjunto(conferir, e, 'APP_IPHONE_65', join(baseDaPrimeira, 'iphone-6.5'));
    if (existsSync(join(baseDaPrimeira, 'iphone-6.9'))) {
      conferirConjunto(conferir, e, 'APP_IPHONE_67', join(baseDaPrimeira, 'iphone-6.9'));
    } else {
      conferir(!conjuntoDoTipo(e, 'APP_IPHONE_67') && saida.includes('Sem a pasta iphone-6.9'), 'sem a pasta 6,9": aviso, e nada subiu nesse slot');
    }
    const revisao = e.revisoes.VER1?.atributos ?? {};
    conferir(revisao.demoAccountName === 'revisao@teste.dev' && revisao.demoAccountRequired === true, 'conta demo do revisor');
    conferir(revisao.notes?.includes('7890000000000') && !revisao.notes?.includes('{{'), 'código demo nas notas, sem marcador sobrando');
    conferir(revisao.notes?.includes('https://demo-da-loja.teste.dev') && !revisao.notes?.includes('sistemaobras'), 'o revisor conecta no servidor da LOJA (não no de outro sistema)');
    conferir(e.preco === 'PP-USA-0', 'preço grátis');
    conferir(e.buildPreso.VER1 === 'B1', 'build da versão preso');
    conferir(e.envios.length === 1 && e.envios[0].estado === 'WAITING_FOR_REVIEW' && e.envios[0].itens.join() === 'VER1', 'ENVIADO para revisão');
    conferir(!saida.includes(SENHA_DEMO), 'a senha da demo não aparece na saída');
    conferir(saida.includes('RESUMO DA PUBLICAÇÃO') && saida.includes('Privacidade do App'), 'resumo final com o que a API não cobre');
    const md = existsSync(resumoDoActions) ? readFileSync(resumoDoActions, 'utf8') : '';
    conferir(md.includes('## Publicação na App Store') && md.includes('### Feito'), 'resumo também na página do Actions ($GITHUB_STEP_SUMMARY)');
  },
);

if (!REAIS) {
  await cenario('Atualização: Novidades, disponibilidade existente intocada, capturas substituídas e --aguardar-build', async ({ conferir, guardar }) => {
    const mock = await subirMock({ jaLancado: true, disponibilidade: true, buildValidoNaConsulta: 3 });
    const capturas = baseSintetica;
    const primeira = await publicar([], { porta: mock.porta, capturas });
    guardar(primeira.saida);
    const e = mock.estado;
    conferir(primeira.codigo === 0, '1ª rodada (sem --enviar) terminou sem erro');
    conferir(primeira.saida.includes(`⚠ Nenhum build da versão ${VERSAO} chegou à Apple ainda`), '1ª rodada: avisa que o build ainda não chegou, sem prender nada');
    conferir(!e.buildPreso.VER1 && e.envios.length === 0, '1ª rodada: nada preso, nada enviado');
    conferir(e.infoLocs.INFO1?.name === lerFicha('nome.txt') && e.infoLocs.INFO0 === undefined, 'nome gravado no appInfo editável da versão nova, não no que está no ar');
    const loc = Object.values(e.versaoLocs).find((l) => l.versao === 'VER1')?.atributos ?? {};
    conferir(loc.whatsNew === lerFicha('novidades.txt'), '"Novidades" vem de ficha/novidades.txt');
    const antes = Object.keys(e.capturas).length;

    const segunda = await publicar(['--enviar', '--aguardar-build', '1'], { porta: mock.porta, capturas });
    guardar(segunda.saida);
    await mock.fechar();
    conferir(segunda.codigo === 0, '2ª rodada (--enviar --aguardar-build 1) terminou sem erro');
    conferir(e.consultasDeBuild >= 3 && segunda.saida.includes('PROCESSING'), `esperou o build: ${e.consultasDeBuild} consultas, passou por PROCESSING`);
    conferir(e.buildPreso.VER1 === 'B1', 'prendeu o build da versão do app.json (não o da versão antiga)');
    conferir(contar(e, 'POST /v2/appAvailabilities') === 0 && e.disponibilidade.territorios.join() === 'BRA,USA,PRT', 'disponibilidade que já existia ficou intocada');
    conferir(e.capturasApagadas.length === antes && antes === 20, `reenvio apagou as ${antes} capturas antigas`);
    conferirConjunto(conferir, e, 'APP_IPHONE_65', join(capturas, 'iphone-6.5'));
    conferirConjunto(conferir, e, 'APP_IPHONE_67', join(capturas, 'iphone-6.9'));
    conferir(e.envios.length === 1 && e.envios[0].estado === 'WAITING_FOR_REVIEW', 'ENVIADO para revisão');
    conferir(recusasInesperadas(e).length === 0, 'todo corpo e parâmetro conforme a especificação');
  });

  await cenario('Falha no upload do 6,9" vira aviso, o 6,5" fica inteiro e a publicação termina', async ({ conferir, guardar }) => {
    const mock = await subirMock({ falharUploadDoTipo: 'APP_IPHONE_67', semDisponibilidade: 'nulo' });
    const { codigo, saida } = await publicar(['--enviar'], { porta: mock.porta, capturas: baseSintetica });
    guardar(saida);
    const e = mock.estado;
    await mock.fechar();
    conferir(codigo === 0, 'terminou sem erro');
    conferir(/⚠ Capturas iPhone 6,9" \(extra\) falharam/.test(saida), 'aviso claro do 6,9"');
    conferir(!conjuntoDoTipo(e, 'APP_IPHONE_67') && e.conjuntosApagados.length === 1, 'o conjunto 6,9" pela metade foi tirado');
    conferirConjunto(conferir, e, 'APP_IPHONE_65', join(baseSintetica, 'iphone-6.5'));
    conferir(e.disponibilidadeCriada?.territorios?.[0]?.id === 'BRA', 'disponibilidade criada também quando a Apple responde "sem dado" (200 com null)');
    conferir(e.envios[0]?.estado === 'WAITING_FOR_REVIEW', 'ENVIADO para revisão mesmo assim');
  });

  await cenario('A Apple recusa um atributo da classificação: sai só ele, tenta de novo e avisa', async ({ conferir, guardar }) => {
    const mock = await subirMock({ idadeDesconhece: ['lootBox'] });
    const { codigo, saida } = await publicar(['--enviar'], { porta: mock.porta, capturas: baseSintetica });
    guardar(saida);
    const e = mock.estado;
    await mock.fechar();
    conferir(codigo === 0, 'terminou sem erro');
    conferir(e.idadeRecebida.length === 2 && 'lootBox' in e.idadeRecebida[0] && !('lootBox' in e.idadeRecebida[1]), 'a 2ª tentativa foi sem lootBox');
    conferir(Object.keys(e.idadeRecebida[1]).length === Object.keys(RESPOSTAS).length - 1, 'e com todas as outras respostas');
    conferir(/⚠ A Apple não aceitou lootBox/.test(saida), 'aviso com o nome do atributo');
    conferir(e.envios[0]?.estado === 'WAITING_FOR_REVIEW', 'ENVIADO para revisão');
  });

  await cenario('Perguntas de idade novas (fora da 4.6) exigidas: erro claro, pendência; respondidas na tela, a 2ª rodada retoma o envio', async ({ conferir, guardar }) => {
    const novos = ['descritorNovoA', 'descritorNovoB'];
    const mock = await subirMock({ descritoresNovos: novos });
    const resumoDoActions = join(mkdtempSync(join(TEMP, 'resumo-')), 'resumo.md');
    const primeira = await publicar(['--enviar'], {
      porta: mock.porta,
      capturas: baseSintetica,
      env: { GITHUB_ACTIONS: 'true', GITHUB_STEP_SUMMARY: resumoDoActions },
    });
    guardar(primeira.saida);
    const e = mock.estado;
    conferir(primeira.codigo === 1, 'a 1ª rodada termina com erro (nada passa em silêncio)');
    conferir(primeira.saida.includes('PENDENTE: Classificação etária: a Apple tem pergunta(s) que este publicador ainda não responde (descritorNovoA, descritorNovoB)'), 'pendência com os nomes das perguntas novas');
    conferir(primeira.saida.includes('exige resposta para: descritorNovoA, descritorNovoB'), 'a mensagem da Apple aparece inteira (associatedErrors)');
    conferir(primeira.saida.includes('App Information → Age Rating'), 'diz onde responder');
    conferir(primeira.saida.includes('::error title=App Store — pendência::'), 'pendência vira anotação no Actions');
    const md = existsSync(resumoDoActions) ? readFileSync(resumoDoActions, 'utf8') : '';
    conferir(md.includes('**Parou:**') && md.includes('### Pendências'), 'resumo com a pendência na página do Actions');
    conferir(e.envios.length === 1 && e.envios[0].estado === 'READY_FOR_REVIEW', 'o envio ficou aberto na Apple');

    mock.responderNaTela({ descritorNovoA: false, descritorNovoB: 'NONE' });
    const segunda = await publicar(['--enviar'], { porta: mock.porta, capturas: baseSintetica });
    guardar(segunda.saida);
    await mock.fechar();
    conferir(segunda.codigo === 0, 'a 2ª rodada (depois de responder na tela) termina sem erro');
    conferir(contar(e, 'POST /v1/reviewSubmissions') === 1 && contar(e, 'POST /v1/reviewSubmissionItems') === 1, 'retomou o MESMO envio, sem abrir outro nem repetir o item');
    conferir(e.envios[0].estado === 'WAITING_FOR_REVIEW', 'ENVIADO para revisão');
  });

  await cenario('--aguardar-build estoura o limite: mensagem clara e saída com erro', async ({ conferir, guardar }) => {
    const mock = await subirMock({ buildNunca: true });
    const { codigo, saida } = await publicar(['--enviar', '--aguardar-build', '0.003'], { porta: mock.porta, capturas: baseSintetica });
    guardar(saida);
    const e = mock.estado;
    await mock.fechar();
    conferir(codigo === 1, 'saiu com erro');
    conferir(/Esperei 0\.003 min e não apareceu build VALID da versão/.test(saida), 'diz quanto esperou e o que não apareceu');
    conferir(e.consultasDeBuild >= 2, `consultou mais de uma vez (${e.consultasDeBuild})`);
    conferir(!e.buildPreso.VER1 && e.envios.length === 0, 'nada preso, nada enviado');
  });

  await cenario('Imagem com alfa no 6,5" para tudo antes de falar com a Apple', async ({ conferir, guardar }) => {
    const { codigo, saida } = await publicar(['--simular'], { capturas: capturasSinteticas({ alfaNo65: true }) });
    guardar(saida);
    conferir(codigo === 1, 'saiu com erro');
    conferir(/iphone-6\.5\/03-financeiro\.png é PNG RGBA \(com alfa\): a Apple recusa canal alfa/.test(saida), 'diz qual arquivo e por quê');
  });

  await cenario('6,9" com tamanho errado fica de fora com aviso; o 6,5" segue', async ({ conferir, guardar }) => {
    const { codigo, saida } = await publicar(['--simular'], { capturas: capturasSinteticas({ tamanho69: [1242, 2688] }) });
    guardar(saida);
    conferir(codigo === 0, 'terminou sem erro');
    conferir(/⚠ Capturas iPhone 6,9" \(extra\) ficam de fora: .*1242×2688/.test(saida), 'aviso com o tamanho encontrado');
    conferir(saida.includes('capturas 10 de iPhone 6,5".'), 'o 6,5" passou inteiro');
  });

  await cenario('Erro da Apple que repete a senha da demo não a mostra no log', async ({ conferir, guardar }) => {
    const mock = await subirMock({ revisaoEcoaSenha: true });
    const { codigo, saida } = await publicar(['--enviar'], { porta: mock.porta, capturas: baseSintetica });
    guardar(saida);
    await mock.fechar();
    conferir(codigo === 1, 'saiu com erro');
    conferir(!saida.includes(SENHA_DEMO) && saida.includes('demoAccountPassword \'•••\''), 'a senha virou •••');
  });

  await cenario('App que não existe na conta: para e diz como criar (a única coisa sem API)', async ({ conferir, guardar }) => {
    const mock = await subirMock({ appExiste: false });
    const { codigo, saida } = await publicar([], { porta: mock.porta, capturas: baseSintetica });
    guardar(saida);
    await mock.fechar();
    conferir(codigo === 1, 'saiu com erro');
    conferir(saida.includes('Registro do app: NÃO existe') && saida.includes('bundle com.gestaoloja.app'), 'diz o que criar no site');
  });

  await cenario('Opção inválida não passa calada', async ({ conferir, guardar }) => {
    const um = await publicar(['--aguardar-build', 'muito'], { capturas: baseSintetica });
    const dois = await publicar(['--enviar-revisao'], { capturas: baseSintetica });
    guardar(um.saida + dois.saida);
    conferir(um.codigo === 1 && um.saida.includes('--aguardar-build pede os minutos'), '--aguardar-build sem número');
    conferir(dois.codigo === 1 && dois.saida.includes('Opção desconhecida: --enviar-revisao'), 'opção com erro de digitação');
  });
}

rmSync(TEMP, { recursive: true, force: true });

if (falhas) {
  console.error(`\n✖ ${falhas} verificação(ões) falharam`);
  process.exit(1);
}
console.log(`\nTudo certo: o publicador faz a ficha inteira sozinho${REAIS ? ', com as capturas reais' : ''}.`);
