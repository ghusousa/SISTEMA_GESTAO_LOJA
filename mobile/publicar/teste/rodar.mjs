/**
 * Teste de ponta a ponta do publicador: sobe a App Store de mentira (que confere cada rota,
 * parâmetro e corpo contra a especificação oficial 4.6) e um servidor de demonstração de
 * mentira, gera uma chave descartável, capturas PNG sintéticas nos dois tamanhos, uma lista
 * de aparelhos, um vídeo e uma árvore de telas do app, roda `publicar.mjs` de verdade em cada
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
import { TELAS_CITADAS, telasQueFaltam } from '../ficha.mjs';
import { subirDemoFalso } from './demo-falso.mjs';
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
const GUIA = readFileSync(join(MOBILE, 'publicar', 'revisao', 'app-review-guide.pdf'));
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

// ---------------------------------------------------------------- vídeo, aparelhos e telas

/** Um "MP4" de mentira: a caixa ftyp de verdade e bytes de enchimento que mudam com a semente. */
function videoSintetico(semente = 1, tamanho = 200 * 1024) {
  const dados = Buffer.alloc(tamanho, semente);
  Buffer.from([0, 0, 0, 0x18]).copy(dados, 0);
  dados.write('ftypisom', 4, 'latin1');
  const caminho = join(mkdtempSync(join(TEMP, 'video-')), `gravacao-${semente}.mp4`);
  writeFileSync(caminho, dados);
  return caminho;
}
const VIDEO = videoSintetico(1);
const COM_VIDEO = ['--video-revisao', VIDEO];

const APARELHOS = ['iPhone 18 Pro Max — iOS 27.0', 'iPhone 13 — iOS 15.8'];
const ARQUIVO_DE_APARELHOS = join(TEMP, 'aparelhos.txt');
writeFileSync(ARQUIVO_DE_APARELHOS, `# teste\n${APARELHOS.join('\n')}\n`);
const SEM_APARELHOS = join(TEMP, 'sem-aparelhos.txt');
writeFileSync(SEM_APARELHOS, '');

/**
 * Uma árvore com as telas que a ficha cita. Os cenários usam ela, e não o app deste commit:
 * eles provam o publicador, não o app — quem confere o app de verdade é o próprio publicador,
 * que para antes de falar com a Apple se a ficha citar tela que o build não tem.
 */
function telasDeMentira({ sem = [] } = {}) {
  const raiz = mkdtempSync(join(TEMP, 'telas-'));
  for (const [rotulo, arquivo] of TELAS_CITADAS) {
    if (sem.includes(arquivo)) continue;
    const caminho = join(raiz, arquivo);
    mkdirSync(dirname(caminho), { recursive: true });
    const antes = existsSync(caminho) ? readFileSync(caminho, 'utf8') : '';
    writeFileSync(caminho, `${antes}<Text>${rotulo}</Text>\n`);
  }
  return raiz;
}
const TELAS_DO_APP = telasDeMentira();
{
  // Só um aviso (não reprova): o app DESTE commit já tem tudo o que a ficha cita? Numa branch
  // que ainda não recebeu uma tela citada, a publicação de verdade pararia — e diria qual.
  const textos = Object.fromEntries(
    readdirSync(join(MOBILE, 'publicar', 'ficha'))
      .filter((n) => n.endsWith('.txt'))
      .map((n) => [n, lerFicha(n)]),
  );
  const faltam = telasQueFaltam(textos, RAIZ);
  if (faltam.length) {
    console.log(`ℹ O app deste commit ainda não tem tudo o que a ficha cita (a publicação de verdade pararia):\n  - ${faltam.join('\n  - ')}`);
  }
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
    telefone_contato: '+55 11 91234-5678',
    titular_copyright: 'Loja Teste',
    email_demo: 'revisao@teste.dev',
    senha_demo: SENHA_DEMO,
    codigo_demo: '7890000000000',
    url_etiquetas_demo: '',
    url_servidor_demo: 'https://demo-da-loja.teste.dev/',
  }),
);

const DEMO = await subirDemoFalso();

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
        PUBLICAR_APARELHOS: ARQUIVO_DE_APARELHOS,
        PUBLICAR_TELAS: TELAS_DO_APP,
        PUBLICAR_DEMO_BASE: DEMO.base,
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
  const falhasAntes = falhas;
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
}

const contar = (estado, rota) => estado.requisicoes.filter((r) => r === rota).length;
const escritas = (estado) => estado.requisicoes.filter((r) => !r.startsWith('GET '));
const recusasInesperadas = (estado) => estado.recusas.filter((r) => !r.simulada);
const conjuntoDoTipo = (estado, tipo) => Object.entries(estado.conjuntos).find(([, c]) => c.tipo === tipo);
const capturasNaOrdem = (estado, conjuntoId) =>
  (estado.conjuntos[conjuntoId].ordem ?? []).map((id) => estado.capturas[id]).filter(Boolean);
/** Os atributos da localização pt-BR de um appInfo. */
const infoPt = (estado, infoId) =>
  Object.values(estado.infoLocs).find((l) => l.info === infoId && l.atributos.locale === 'pt-BR')?.atributos;
const itensDoEnvio = (envio) => envio.itens.filter((i) => i.estado !== 'REMOVED').map((i) => i.versao).join();
const anexosPorNome = (estado, nome) => Object.values(estado.anexos).filter((a) => a.nome === nome);
const chamadasDaDemo = (desde = 0) => DEMO.chamadas.slice(desde).map((c) => `${c.metodo} ${c.caminho}`);

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

/** O anexo chegou inteiro: um só com esse nome, COMPLETE, bytes e MD5 do arquivo. */
function conferirAnexo(conferir, estado, nome, dados) {
  const lista = anexosPorNome(estado, nome);
  const a = lista[0];
  conferir(
    lista.length === 1 && a.estado === 'COMPLETE' && a.bytes === dados.length && a.md5 === md5(dados) && a.checksum === a.md5,
    `anexo ${nome}: um só, inteiro, MD5 conferido pela Apple e processado`,
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
  `Primeira publicação, com --enviar (${REAIS ? 'capturas REAIS de media/app-store' : 'capturas sintéticas 6,5" + 6,9"'}), guia e vídeo anexados`,
  async ({ conferir, guardar }) => {
    const mock = await subirMock();
    const resumoDoActions = join(mkdtempSync(join(TEMP, 'resumo-')), 'resumo.md');
    const antesDaDemo = DEMO.chamadas.length;
    const { codigo, saida } = await publicar(['--enviar', ...COM_VIDEO], {
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
    const info = infoPt(e, 'INFO1');
    conferir(info?.name === lerFicha('nome.txt') && info?.subtitle === lerFicha('subtitulo.txt'), 'nome e subtítulo da ficha');
    conferir([...(info?.subtitle ?? '')].length <= 30, 'subtítulo dentro dos 30');
    conferir(info?.privacyPolicyUrl === 'https://demo-da-loja.teste.dev/privacidade', 'URL de privacidade sai do servidor da demo');
    conferir(e.categorias.INFO1?.principal === 'BUSINESS' && e.categorias.INFO1?.secundaria === 'PRODUCTIVITY', 'categorias');
    const idade = e.idadeRecebida.at(-1) ?? {};
    conferir(Object.keys(idade).sort().join() === Object.keys(RESPOSTAS).sort().join(), `classificação: as ${Object.keys(RESPOSTAS).length} perguntas foram enviadas`);
    conferir(NAO_SAO_PERGUNTAS.every((p) => !(p in idade)), 'kidsAgeBand e os ajustes manuais de idade ficaram intocados');
    conferir(idade.userGeneratedContent === false && idade.messagingAndChat === false && idade.gunsOrOtherWeapons === 'NONE', 'perguntas novas respondidas (conteúdo de usuário, conversa, armas...)');
    conferir(
      e.disponibilidadeCriada?.availableInNewTerritories === false &&
        e.disponibilidadeCriada.territorios.length === 3 &&
        e.disponibilidadeCriada.territorios.every((t) => t.available === (t.id === 'BRA')),
      'disponibilidade criada com TODOS os territórios (seguindo a paginação): só o Brasil à venda, sem países novos',
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
    const notas = revisao.notes ?? '';
    conferir(notas.includes('7890000000000') && !notas.includes('{{'), 'código demo nas notas, sem marcador sobrando');
    conferir(notas.includes('https://demo-da-loja.teste.dev') && !notas.includes('sistemaobras'), 'o revisor conecta no servidor da LOJA (não no de outro sistema)');
    conferir(/SCREEN RECORDING/.test(notas) && /EXTERNAL SERVICES/.test(notas) && /REGIONS/.test(notas) && /REGULATION/.test(notas), 'notas em inglês, com os 7 itens da Apple');
    conferir(notas.includes(APARELHOS.join('; ')) && notas.includes(`made on a physical ${APARELHOS[0]}`), 'notas com a lista de aparelhos testados e o aparelho da gravação');
    conferir(notas.includes('"screen-recording.mp4"') && !notas.includes('(pending)'), 'notas citam o vídeo anexado, nada pendente');
    conferir(notas.includes('Mais > Minha conta > Excluir minha conta') && notas.includes('Mais > Usuários > (pessoa) > Excluir conta'), 'notas com os dois caminhos da exclusão de conta');
    conferir([...notas].length <= 4000, `notas dentro dos 4000 (${[...notas].length})`);
    conferirAnexo(conferir, e, 'app-review-guide.pdf', GUIA);
    conferirAnexo(conferir, e, 'screen-recording.mp4', readFileSync(VIDEO));
    const demo = chamadasDaDemo(antesDaDemo);
    conferir(
      ['GET /health', 'POST /api/v1/auth/login', 'GET /api/v1/variantes/codigo-barras/7890000000000', 'GET /api/v1/leitor/pareamentos/0', 'DELETE /api/v1/usuarios/me', 'POST /api/v1/auth/logout', 'GET /privacidade'].every((c) => demo.includes(c)),
      'servidor de demonstração conferido: no ar, login de dono, código, leitor, exclusão, privacidade (e a sessão encerrada)',
    );
    const exclusoes = DEMO.chamadas.slice(antesDaDemo).filter((c) => c.metodo === 'DELETE' && c.caminho === '/api/v1/usuarios/me');
    conferir(
      exclusoes.some((c) => typeof c.corpo?.senha === 'string') && saida.includes('é protegida lá'),
      'a conta demo é conferida como protegida (a recusa da demo, com uma senha que nunca confere)',
    );
    conferir(
      !DEMO.chamadas.some((c) => c.metodo === 'EXCLUIU A CONTA' || (c.caminho === '/api/v1/usuarios/me' && c.corpo?.senha === SENHA_DEMO)),
      'a conferência da exclusão nunca manda a senha da demo (não exclui nada)',
    );
    conferir(e.preco === 'PP-USA-0', 'preço grátis');
    conferir(e.buildPreso.VER1 === 'B1', 'build da versão preso');
    conferir(e.envios.length === 1 && e.envios[0].estado === 'WAITING_FOR_REVIEW' && itensDoEnvio(e.envios[0]) === 'VER1', 'ENVIADO para revisão');
    conferir(!saida.includes(SENHA_DEMO), 'a senha da demo não aparece na saída');
    conferir(saida.includes('RESUMO DA PUBLICAÇÃO') && saida.includes('Privacidade do App') && saida.includes('Central de Resolução'), 'resumo final com o que a API não cobre');
    const md = existsSync(resumoDoActions) ? readFileSync(resumoDoActions, 'utf8') : '';
    conferir(md.includes('## Publicação na App Store') && md.includes('### Feito'), 'resumo também na página do Actions ($GITHUB_STEP_SUMMARY)');
  },
);

if (!REAIS) {
  await cenario('Atualização: Novidades, disponibilidade existente intocada, capturas substituídas e --aguardar-build', async ({ conferir, guardar }) => {
    const mock = await subirMock({ jaLancado: true, disponibilidade: true, buildValidoNaConsulta: 3 });
    const capturas = baseSintetica;
    const primeira = await publicar([...COM_VIDEO], { porta: mock.porta, capturas });
    guardar(primeira.saida);
    const e = mock.estado;
    conferir(primeira.codigo === 0, '1ª rodada (sem --enviar) terminou sem erro');
    conferir(primeira.saida.includes(`⚠ Nenhum build da versão ${VERSAO} chegou à Apple ainda`), '1ª rodada: avisa que o build ainda não chegou, sem prender nada');
    conferir(!e.buildPreso.VER1 && e.envios.length === 0, '1ª rodada: nada preso, nada enviado');
    conferir(infoPt(e, 'INFO1')?.name === lerFicha('nome.txt') && !infoPt(e, 'INFO0'), 'nome gravado no appInfo editável da versão nova, não no que está no ar');
    const loc = Object.values(e.versaoLocs).find((l) => l.versao === 'VER1')?.atributos ?? {};
    conferir(loc.whatsNew === lerFicha('novidades.txt'), '"Novidades" vem de ficha/novidades.txt');
    const antes = Object.keys(e.capturas).length;

    const segunda = await publicar(['--enviar', '--aguardar-build', '1'], { porta: mock.porta, capturas });
    guardar(segunda.saida);
    await mock.fechar();
    conferir(segunda.codigo === 0, '2ª rodada (--enviar --aguardar-build 1, o vídeo já anexado) terminou sem erro');
    conferir(e.consultasDeBuild >= 3 && segunda.saida.includes('PROCESSING'), `esperou o build: ${e.consultasDeBuild} consultas, passou por PROCESSING`);
    conferir(e.buildPreso.VER1 === 'B1', 'prendeu o build da versão do app.json (não o da versão antiga)');
    conferir(contar(e, 'POST /v2/appAvailabilities') === 0 && e.disponibilidade.territorios.join() === 'BRA', 'disponibilidade que já existia (só Brasil) ficou intocada');
    conferir(e.capturasApagadas.length === antes && antes === 20, `reenvio apagou as ${antes} capturas antigas`);
    conferirConjunto(conferir, e, 'APP_IPHONE_65', join(capturas, 'iphone-6.5'));
    conferirConjunto(conferir, e, 'APP_IPHONE_67', join(capturas, 'iphone-6.9'));
    conferir(contar(e, 'POST /v1/appStoreReviewAttachments') === 2 && anexosPorNome(e, 'screen-recording.mp4').length === 1, 'os anexos iguais não subiram de novo na 2ª rodada');
    conferir(e.envios.length === 1 && e.envios[0].estado === 'WAITING_FOR_REVIEW', 'ENVIADO para revisão');
    conferir(recusasInesperadas(e).length === 0, 'todo corpo e parâmetro conforme a especificação');
  });

  await cenario('Modo completo prende o build DESTA rodada, nunca um VALID mais antigo da mesma versão', async ({ conferir, guardar }) => {
    // Build 6 da 1.0.0 já VALID (de um commit anterior); o 7, recém-compilado, só aparece na 2ª consulta.
    const mock = await subirMock({ buildAntigo: true, buildValidoNaConsulta: 3 });
    const { codigo, saida } = await publicar(['--enviar', '--aguardar-build', '1', '--build', '7', ...COM_VIDEO], { porta: mock.porta, capturas: baseSintetica });
    guardar(saida);
    const e = mock.estado;
    await mock.fechar();
    conferir(codigo === 0, 'terminou sem erro');
    conferir(e.consultasDeBuild >= 3, `esperou o build 7 aparecer e ficar VALID (${e.consultasDeBuild} consultas), sem pegar o 6`);
    conferir(e.buildPreso.VER1 === 'B1', 'preso: o build 7 (B1), não o B-ANTIGO');
    conferir(saida.includes('Build 7 preso') && saida.includes('o desta rodada'), 'o log diz qual build e que é o desta rodada');
    conferir(e.envios[0]?.estado === 'WAITING_FOR_REVIEW', 'ENVIADO para revisão');
  });

  await cenario('Recusada → corrige → reenvia: o envio UNRESOLVED_ISSUES é retomado, com o build novo', async ({ conferir, guardar }) => {
    const mock = await subirMock();
    const primeira = await publicar(['--enviar', ...COM_VIDEO], { porta: mock.porta, capturas: baseSintetica });
    guardar(primeira.saida);
    const e = mock.estado;
    conferir(primeira.codigo === 0 && e.envios[0]?.estado === 'WAITING_FOR_REVIEW', '1ª rodada enviada');
    const envio = mock.rejeitar({ estadoDaVersao: 'REJECTED' });
    mock.novoBuild({ id: 'B2', numero: '8', validoEm: 2 });
    const segunda = await publicar(['--enviar', '--aguardar-build', '1', '--build', '8'], { porta: mock.porta, capturas: baseSintetica });
    guardar(segunda.saida);
    await mock.fechar();
    conferir(segunda.codigo === 0, 'a 2ª rodada (depois da recusa) terminou sem erro');
    conferir(contar(e, 'POST /v1/reviewSubmissions') === 1, 'nenhum envio novo: a Apple recusaria um segundo envio ativo');
    conferir(contar(e, 'PATCH /v1/reviewSubmissionItems/{id}') === 1 && contar(e, 'POST /v1/reviewSubmissionItems') === 1, 'o item recusado foi marcado como resolvido, sem repetir o item');
    conferir(e.envios.length === 1 && e.envios[0].id === envio && e.envios[0].estado === 'WAITING_FOR_REVIEW', `o MESMO envio (${envio}) voltou para a fila`);
    conferir(e.buildPreso.VER1 === 'B2', 'o build novo (8) foi preso no lugar do recusado');
    conferir(segunda.saida.includes('REENVIADO para a revisão'), 'o resumo diz que foi um REENVIO');
    conferir(recusasInesperadas(e).length === 0, 'todo corpo e parâmetro conforme a especificação');
  });

  await cenario('Pedido de informação (2.1) sem build novo: o reenvio com o build que voltou é RECUSADO, sem mexer na Apple', async ({ conferir, guardar }) => {
    // A caixa "revisao" fora do completo não leva --build: o build mais novo da versão ainda é
    // o da 1ª submissão (o novo nem chegou à Apple). Antes, ele era preso e o envio, "REENVIADO".
    const mock = await subirMock();
    const primeira = await publicar(['--enviar', ...COM_VIDEO], { porta: mock.porta, capturas: baseSintetica });
    guardar(primeira.saida);
    const e = mock.estado;
    mock.rejeitar({ estadoDaVersao: 'REJECTED' });
    const escritasAntes = escritas(e).length;
    const segunda = await publicar(['--enviar', '--video-revisao', videoSintetico(2)], { porta: mock.porta, capturas: baseSintetica });
    guardar(segunda.saida);
    await mock.fechar();
    conferir(segunda.codigo === 1 && segunda.saida.includes('--enviar recusado'), 'recusado');
    conferir(segunda.saida.includes('é o MESMO que já estava nele') && segunda.saida.includes('--mesmo-build'), 'diz por quê e as duas saídas (build novo ou --mesmo-build)');
    conferir(escritas(e).length === escritasAntes, 'nada mexido na Apple');
    conferir(e.envios[0].estado === 'UNRESOLVED_ISSUES', 'o envio devolvido continua esperando');
  });

  await cenario('Pedido de informação (2.1) com --mesmo-build: notas e vídeo novos, o MESMO build e o mesmo envio reenviado', async ({ conferir, guardar }) => {
    const mock = await subirMock();
    const primeira = await publicar(['--enviar', ...COM_VIDEO], { porta: mock.porta, capturas: baseSintetica });
    guardar(primeira.saida);
    const e = mock.estado;
    mock.rejeitar({ estadoDaVersao: 'METADATA_REJECTED' });
    const videoAntigo = Object.entries(e.anexos).find(([, a]) => a.nome === 'screen-recording.mp4')?.[0];
    const guiaAntigo = Object.entries(e.anexos).find(([, a]) => a.nome === 'app-review-guide.pdf')?.[0];
    const anexosAntes = contar(e, 'POST /v1/appStoreReviewAttachments');
    const novoVideo = videoSintetico(2);
    const segunda = await publicar(['--enviar', '--mesmo-build', '--video-revisao', novoVideo], { porta: mock.porta, capturas: baseSintetica });
    guardar(segunda.saida);
    await mock.fechar();
    conferir(segunda.codigo === 0, 'reenviou sem erro');
    conferir(contar(e, 'POST /v1/appStoreReviewAttachments') - anexosAntes === 1, 'só o vídeo novo subiu (o guia igual ficou)');
    conferir(e.anexosApagados.includes(videoAntigo) && !e.anexosApagados.includes(guiaAntigo), 'o vídeo antigo saiu depois de o novo entrar; o guia ficou');
    conferirAnexo(conferir, e, 'screen-recording.mp4', readFileSync(novoVideo));
    conferir(segunda.saida.includes('o mesmo que já estava preso'), 'o log diz que é o mesmo build, de propósito');
    conferir(e.buildPreso.VER1 === 'B1' && e.envios.length === 1 && e.envios[0].estado === 'WAITING_FOR_REVIEW', 'mesmo build, mesmo envio, de volta à fila');
  });

  await cenario('Devolvido e com um build novo processado: a caixa "revisao" (sem --build) prende o novo', async ({ conferir, guardar }) => {
    const mock = await subirMock();
    const primeira = await publicar(['--enviar', ...COM_VIDEO], { porta: mock.porta, capturas: baseSintetica });
    guardar(primeira.saida);
    const e = mock.estado;
    mock.rejeitar({ estadoDaVersao: 'REJECTED' });
    mock.novoBuild({ id: 'B2', numero: '8', validoEm: 1 });
    const segunda = await publicar(['--enviar'], { porta: mock.porta, capturas: baseSintetica });
    guardar(segunda.saida);
    await mock.fechar();
    conferir(segunda.codigo === 0 && segunda.saida.includes('REENVIADO'), 'reenviou sem erro');
    conferir(e.buildPreso.VER1 === 'B2', 'o build novo (8) foi preso no lugar do que voltou');
  });

  await cenario('Apple que não aceita a marca de "resolvido": o reenvio segue assim mesmo', async ({ conferir, guardar }) => {
    const mock = await subirMock({ itemNaoAceitaResolved: true });
    const primeira = await publicar(['--enviar', ...COM_VIDEO], { porta: mock.porta, capturas: baseSintetica });
    guardar(primeira.saida);
    const e = mock.estado;
    mock.rejeitar();
    const segunda = await publicar(['--enviar', '--mesmo-build'], { porta: mock.porta, capturas: baseSintetica });
    guardar(segunda.saida);
    await mock.fechar();
    conferir(segunda.codigo === 0 && e.envios.length === 1 && e.envios[0].estado === 'WAITING_FOR_REVIEW', 'reenviou o mesmo envio');
    conferir(segunda.saida.includes('não aceitou marcar o item'), 'o log diz que a marca foi recusada e o reenvio seguiu');
  });

  await cenario('App criado no site com outro idioma principal: pt-BR vira o principal e o inglês vazio sai', async ({ conferir, guardar }) => {
    const mock = await subirMock({ criadoNoSite: 'en-US' });
    const { codigo, saida } = await publicar(['--enviar', ...COM_VIDEO], { porta: mock.porta, capturas: baseSintetica });
    guardar(saida);
    const e = mock.estado;
    await mock.fechar();
    conferir(codigo === 0, 'terminou sem erro');
    conferir(e.app.primaryLocale === 'pt-BR', 'idioma principal: pt-BR');
    conferir(e.versaoLocsApagadas.includes('VLOC-SITE-en-US') && e.infoLocsApagadas.includes('ILOC-INFO1-en-US'), 'as localizações en-US (da versão e do appInfo) foram apagadas');
    conferir(e.versoes.find((v) => v.id === 'VER-SITE')?.versionString === VERSAO, `a versão "1.0" do site virou ${VERSAO}`);
    conferir(e.envios[0]?.estado === 'WAITING_FOR_REVIEW', 'ENVIADO para revisão (nada em inglês incompleto travou)');
    conferir(recusasInesperadas(e).length === 0, 'todo corpo e parâmetro conforme a especificação');
  });

  await cenario('Disponibilidade feita no site com outros países: as notas dizem "Brazil only" — --enviar recusado', async ({ conferir, guardar }) => {
    const mock = await subirMock({ disponibilidade: ['BRA', 'USA', 'PRT'], disponibilidadeEmNovos: true });
    const enviar = await publicar(['--enviar', ...COM_VIDEO], { porta: mock.porta, capturas: baseSintetica });
    guardar(enviar.saida);
    const e = mock.estado;
    conferir(enviar.codigo === 1 && enviar.saida.includes('2 território(s) além do Brasil (USA, PRT') && enviar.saida.includes('Brazil only'), 'recusado, com os territórios a mais');
    conferir(escritas(e).length === 0, 'nada mexido na Apple');
    const ficha = await publicar([], { porta: mock.porta, capturas: baseSintetica });
    guardar(ficha.saida);
    await mock.fechar();
    conferir(ficha.codigo === 0 && ficha.saida.includes('PENDENTE: Disponibilidade: o app está à venda em 2 território(s)'), 'só a ficha: sobe, com a pendência');
    conferir(e.disponibilidade.territorios.join() === 'BRA,USA,PRT' && contar(e, 'POST /v2/appAvailabilities') === 0, 'a disponibilidade do site não é mexida pelo publicador');
    conferir(recusasInesperadas(e).length === 0, 'todo corpo e parâmetro conforme a especificação');
  });

  await cenario('Rodada sem a pasta 6,9": o conjunto 6,9" que estava na versão é apagado', async ({ conferir, guardar }) => {
    const mock = await subirMock();
    const primeira = await publicar([], { porta: mock.porta, capturas: baseSintetica });
    guardar(primeira.saida);
    const e = mock.estado;
    const de69 = conjuntoDoTipo(e, 'APP_IPHONE_67')?.[0];
    const segunda = await publicar([], { porta: mock.porta, capturas: capturasSinteticas({ com69: false }) });
    guardar(segunda.saida);
    await mock.fechar();
    conferir(primeira.codigo === 0 && segunda.codigo === 0, 'as duas rodadas terminaram sem erro');
    conferir(Boolean(de69) && e.conjuntosApagados.includes(de69) && !conjuntoDoTipo(e, 'APP_IPHONE_67'), 'o conjunto 6,9" da 1ª rodada saiu');
    conferir(/Capturas iPhone 6,9": o conjunto que já estava na versão foi apagado/.test(segunda.saida), 'o aviso diz que ele foi apagado');
    conferirConjunto(conferir, e, 'APP_IPHONE_65', join(baseSintetica, 'iphone-6.5'));
  });

  await cenario('Preço: só o ponto 0,00 da lista inteira — nunca o primeiro da lista', async ({ conferir, guardar }) => {
    for (const [precos, esperado, rotulo] of [
      ['pago-primeiro', 'PP-USA-0', 'o 0,99 vem primeiro: grava o grátis, não ele'],
      ['gratis-na-2a-pagina', 'PP-USA-0', 'o grátis só na 2ª página: segue links.next até ele'],
      ['sem-gratis', null, 'nenhum grátis: nada gravado'],
      ['vazio', null, 'lista vazia: nada gravado'],
    ]) {
      const mock = await subirMock({ precos });
      const { codigo, saida } = await publicar([], { porta: mock.porta, capturas: baseSintetica });
      guardar(saida);
      const e = mock.estado;
      await mock.fechar();
      conferir(codigo === 0 && e.preco === esperado, rotulo);
      if (precos === 'gratis-na-2a-pagina') conferir(contar(e, 'GET /v1/apps/{id}/appPricePoints') === 2, 'leu duas páginas');
      if (precos === 'sem-gratis') conferir(saida.includes('nenhum é grátis') && saida.includes('NÃO virou pago') && !saida.includes('✔ Preço: grátis'), 'pendência clara, sem dizer "grátis"');
      if (precos === 'vazio') conferir(saida.includes('nenhum ponto de preço'), 'pendência própria para a lista vazia');
      conferir(recusasInesperadas(e).length === 0, `${precos}: tudo conforme a especificação (inclusive o cursor das páginas)`);
    }
  });

  await cenario('--enviar é recusado sem lista de aparelhos e sem vídeo — e nada é mexido na Apple', async ({ conferir, guardar }) => {
    const mock = await subirMock();
    const { codigo, saida } = await publicar(['--enviar'], { porta: mock.porta, capturas: baseSintetica, env: { PUBLICAR_APARELHOS: SEM_APARELHOS } });
    guardar(saida);
    const e = mock.estado;
    await mock.fechar();
    conferir(codigo === 1, 'saiu com erro');
    conferir(saida.includes('--enviar recusado') && saida.includes('Nada foi mexido na Apple'), 'diz que recusou e que nada foi mexido');
    conferir(saida.includes('aparelhos-testados.txt') && saida.includes('--video-revisao'), 'pendências com a lista de aparelhos e o vídeo, e como resolver');
    conferir(escritas(e).length === 0, `nenhuma escrita na Apple (${escritas(e).join(', ') || 'só leituras'})`);
  });

  await cenario('Só a ficha sobe sem aparelhos e sem vídeo (e as notas dizem "pending")', async ({ conferir, guardar }) => {
    const mock = await subirMock();
    const { codigo, saida } = await publicar([], { porta: mock.porta, capturas: baseSintetica, env: { PUBLICAR_APARELHOS: SEM_APARELHOS } });
    guardar(saida);
    const e = mock.estado;
    await mock.fechar();
    conferir(codigo === 0, 'terminou sem erro');
    conferir((e.revisoes.VER1?.atributos.notes ?? '').includes('(pending)'), 'as notas marcam o que falta como "(pending)"');
    conferirAnexo(conferir, e, 'app-review-guide.pdf', GUIA);
    conferir(e.envios.length === 0, 'nada enviado para revisão');
  });

  await cenario('Servidor de demonstração fora do combinado: --enviar recusado, com cada problema', async ({ conferir, guardar }) => {
    const casos = [
      [{ papel: 'GERENTE', codigos: [], semLeitor: true, semExclusao: true, privacidade: 404 }, ['não de dono', 'não existe no servidor de demonstração', 'não tem o leitor pelo celular', 'não tem a exclusão da própria conta', 'política de privacidade da ficha não abre'], 'conta não-dono, código, leitor, exclusão e privacidade'],
      [{ senha: 'outra-senha' }, ['não entra no servidor de demonstração', 'APPLE_DEMO_PASSWORD', 'Redeploy da demo a recria'], 'senha da demo errada (ou conta excluída lá)'],
      [{ protegida: false }, ['não está protegida no servidor de demonstração', 'DEMO_ADMIN_EMAIL'], 'conta demo sem a proteção'],
      [{ saldo: 2 }, ['tem 2 peça(s) em estoque', 'Reponha pela Entrada'], 'código demo quase sem estoque'],
      [{ fora: true }, ['não respondeu ao /health'], 'servidor fora do ar'],
    ];
    for (const [opcoes, frases, rotulo] of casos) {
      const demo = await subirDemoFalso(opcoes);
      const mock = await subirMock();
      const { codigo, saida } = await publicar(['--enviar', ...COM_VIDEO], { porta: mock.porta, capturas: baseSintetica, env: { PUBLICAR_DEMO_BASE: demo.base } });
      guardar(saida);
      const e = mock.estado;
      await mock.fechar();
      await demo.fechar();
      conferir(codigo === 1 && frases.every((f) => saida.includes(f)), `${rotulo}: recusado, com a frase de cada problema`);
      conferir(escritas(e).length === 0, `${rotulo}: nada mexido na Apple`);
      conferir(!saida.includes(SENHA_DEMO), `${rotulo}: a senha não aparece`);
      conferir(!demo.chamadas.some((c) => c.metodo === 'EXCLUIU A CONTA'), `${rotulo}: nenhuma conta excluída na demo`);
    }
  });

  await cenario('Só a chave no GitHub (o resto do padroes.json): a ficha sobe sem senha da demo nem telefone; o --enviar pede os dois', async ({ conferir, guardar }) => {
    // O config.json que o ci.mjs grava quando o GitHub só tem ASC_KEY_ID + ASC_KEY_P8.
    const soChave = join(PASTA_CONFIG, 'config-so-chave.json');
    writeFileSync(
      soChave,
      JSON.stringify({ key_id: 'TESTE123', issuer_id: '', arquivo_p8: 'chave-apple.p8', senha_demo: '', telefone_contato: '', url_privacidade: '' }),
    );
    const padroes = JSON.parse(readFileSync(join(MOBILE, 'publicar', 'padroes.json'), 'utf8'));
    const mock = await subirMock();
    const antesDaDemo = DEMO.chamadas.length;
    const ficha = await publicar([], { porta: mock.porta, capturas: baseSintetica, env: { PUBLICAR_CONFIG: soChave } });
    guardar(ficha.saida);
    const rev = mock.estado.revisoes.VER1?.atributos ?? {};
    const versao = mock.estado.versoes.find((v) => v.id === 'VER1');
    conferir(ficha.codigo === 0, 'a ficha subiu só com a chave');
    conferir((rev.notes ?? '').includes('Password: (pending)'), 'as notas marcam a senha da demo como "(pending)"');
    conferir(!('demoAccountPassword' in rev) && !('contactPhone' in rev), 'senha e telefone vazios não vão à Apple (ela guarda o que tinha)');
    conferir(rev.demoAccountName === padroes.email_demo && rev.contactEmail === padroes.email_suporte, 'conta demo e e-mail de contato do padroes.json');
    conferir(versao?.copyright?.includes(padroes.titular_copyright), 'copyright do padroes.json');
    conferir(mock.estado.envios.length === 0, 'nada enviado para revisão');

    const envio = await publicar(['--enviar', ...COM_VIDEO], { porta: mock.porta, capturas: baseSintetica, env: { PUBLICAR_CONFIG: soChave } });
    guardar(envio.saida);
    conferir(envio.codigo === 1 && envio.saida.includes('--enviar recusado'), '--enviar recusado');
    conferir(envio.saida.includes('APPLE_DEMO_PASSWORD') && envio.saida.includes('DEMO_ADMIN_SENHA'), 'pede a senha da demo e diz onde ela está');
    conferir(envio.saida.includes('APPLE_TELEFONE_CONTATO'), 'pede o telefone de contato');
    conferir(!chamadasDaDemo(antesDaDemo).includes('POST /api/v1/auth/login'), 'sem a senha, nem tenta entrar na demo');
    conferir(mock.estado.envios.length === 0, 'continua sem envio para revisão');

    // O telefone que a Apple já tem (de um envio anterior) basta: só a senha falta.
    mock.estado.revisoes.VER1.atributos.contactPhone = '+55 11 98888-7777';
    const comTelefone = await publicar(['--enviar', ...COM_VIDEO], { porta: mock.porta, capturas: baseSintetica, env: { PUBLICAR_CONFIG: soChave } });
    guardar(comTelefone.saida);
    conferir(comTelefone.codigo === 1 && !comTelefone.saida.includes('APPLE_TELEFONE_CONTATO'), 'telefone já na Apple: não é pedido de novo');
    conferir(comTelefone.saida.includes('APPLE_DEMO_PASSWORD'), 'a senha da demo continua pedida');
    await mock.fechar();
  });

  await cenario('--conferir-envio (o modo completo, antes de compilar): confere tudo e não escreve nada na Apple', async ({ conferir, guardar }) => {
    const mock = await subirMock();
    const antesDaDemo = DEMO.chamadas.length;
    const ok = await publicar(['--conferir-envio', ...COM_VIDEO], { porta: mock.porta, capturas: baseSintetica });
    guardar(ok.saida);
    conferir(ok.codigo === 0, 'tudo em ordem: código 0');
    conferir(escritas(mock.estado).length === 0, `nenhuma escrita na Apple (${escritas(mock.estado).join(', ') || 'só leituras'})`);
    conferir(chamadasDaDemo(antesDaDemo).includes('POST /api/v1/auth/login'), 'conferiu o servidor de demonstração');
    conferir(ok.saida.includes('só conferiu') && ok.saida.includes('ainda não existe'), 'diz que só conferiu, e em que pé está a versão');

    const semNada = await publicar(['--conferir-envio'], { porta: mock.porta, capturas: baseSintetica, env: { PUBLICAR_APARELHOS: SEM_APARELHOS } });
    guardar(semNada.saida);
    conferir(semNada.codigo === 1 && semNada.saida.includes('A revisão não sairia') && semNada.saida.includes('nada foi compilado'), 'sem aparelhos e sem vídeo: para com a frase do modo completo');
    conferir(semNada.saida.includes('aparelhos-testados.txt') && semNada.saida.includes('video_revisao_url'), 'e diz o que falta, com o nome da entrada do GitHub');
    conferir(escritas(mock.estado).length === 0, 'continua sem nenhuma escrita na Apple');
    await mock.fechar();

    const juntos = await publicar(['--conferir-envio', '--enviar'], { capturas: baseSintetica });
    guardar(juntos.saida);
    conferir(juntos.codigo === 1 && juntos.saida.includes('Use um dos dois'), '--conferir-envio com --enviar é recusado');
  });

  await cenario('Versão do app.json já enviada (WAITING_FOR_REVIEW): para antes de escrever, e --conferir-envio também', async ({ conferir, guardar }) => {
    const mock = await subirMock({ versaoTravada: 'WAITING_FOR_REVIEW', versaoDoAppJson: VERSAO });
    for (const args of [['--enviar', ...COM_VIDEO], ['--conferir-envio', ...COM_VIDEO], []]) {
      const { codigo, saida } = await publicar(args, { porta: mock.porta, capturas: baseSintetica });
      guardar(saida);
      conferir(
        codigo === 1 && saida.includes(`A versão ${VERSAO} já existe na Apple no estado WAITING_FOR_REVIEW`) && saida.includes('suba "version"'),
        `${args[0] ?? '(só a ficha)'}: para com a frase da versão travada e o caminho`,
      );
    }
    conferir(escritas(mock.estado).length === 0, 'nada mexido na Apple');
    await mock.fechar();
  });

  await cenario('Falha no upload do vídeo: pendência, a reserva pela metade sai, e a revisão não é enviada', async ({ conferir, guardar }) => {
    const mock = await subirMock({ falharUploadDoAnexo: 'screen-recording.mp4' });
    const { codigo, saida } = await publicar(['--enviar', ...COM_VIDEO], { porta: mock.porta, capturas: baseSintetica });
    guardar(saida);
    const e = mock.estado;
    await mock.fechar();
    conferir(codigo === 1, 'saiu com erro');
    conferir(saida.includes('Gravação de tela screen-recording.mp4 não foi anexado'), 'pendência com o nome do anexo');
    conferir(anexosPorNome(e, 'screen-recording.mp4').length === 0 && e.anexosApagados.length === 1, 'a reserva pela metade foi apagada');
    conferir(e.envios.length === 0, 'nada enviado para revisão');
  });

  await cenario('Falha no upload do 6,9" vira aviso, o 6,5" fica inteiro e a publicação termina', async ({ conferir, guardar }) => {
    const mock = await subirMock({ falharUploadDoTipo: 'APP_IPHONE_67', semDisponibilidade: 'nulo' });
    const { codigo, saida } = await publicar(['--enviar', ...COM_VIDEO], { porta: mock.porta, capturas: baseSintetica });
    guardar(saida);
    const e = mock.estado;
    await mock.fechar();
    conferir(codigo === 0, 'terminou sem erro');
    conferir(/⚠ Capturas iPhone 6,9" \(extra\) falharam/.test(saida), 'aviso claro do 6,9"');
    conferir(!conjuntoDoTipo(e, 'APP_IPHONE_67') && e.conjuntosApagados.length === 1, 'o conjunto 6,9" pela metade foi tirado');
    conferirConjunto(conferir, e, 'APP_IPHONE_65', join(baseSintetica, 'iphone-6.5'));
    conferir(e.disponibilidadeCriada?.territorios?.find((t) => t.id === 'BRA')?.available === true, 'disponibilidade criada também quando a Apple responde "sem dado" (200 com null)');
    conferir(e.envios[0]?.estado === 'WAITING_FOR_REVIEW', 'ENVIADO para revisão mesmo assim');
  });

  await cenario('A Apple recusa um atributo da classificação: sai só ele, tenta de novo e avisa', async ({ conferir, guardar }) => {
    const mock = await subirMock({ idadeDesconhece: ['lootBox'] });
    const { codigo, saida } = await publicar(['--enviar', ...COM_VIDEO], { porta: mock.porta, capturas: baseSintetica });
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
    const primeira = await publicar(['--enviar', ...COM_VIDEO], {
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
    const { codigo, saida } = await publicar(['--enviar', '--aguardar-build', '0.003', ...COM_VIDEO], { porta: mock.porta, capturas: baseSintetica });
    guardar(saida);
    const e = mock.estado;
    await mock.fechar();
    conferir(codigo === 1, 'saiu com erro');
    conferir(/Esperei 0\.003 min e não apareceu build VALID da versão/.test(saida), 'diz quanto esperou e o que não apareceu');
    conferir(e.consultasDeBuild >= 2, `consultou mais de uma vez (${e.consultasDeBuild})`);
    conferir(!e.buildPreso.VER1 && e.envios.length === 0, 'nada preso, nada enviado');
  });

  await cenario('Ficha que cita tela que o app deste commit não tem: para antes de falar com a Apple', async ({ conferir, guardar }) => {
    const telas = telasDeMentira({ sem: ['mobile/src/app/(app)/mais/conta.tsx'] });
    const { codigo, saida } = await publicar(['--simular'], { capturas: baseSintetica, env: { PUBLICAR_TELAS: telas } });
    guardar(saida);
    conferir(codigo === 1, 'saiu com erro');
    conferir(saida.includes('"Excluir minha conta"') && saida.includes('mobile/src/app/(app)/mais/conta.tsx não existe neste commit'), 'diz qual rótulo e qual tela faltam');
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
    conferir(saida.includes('capturas 10 de iPhone 6,5",'), 'o 6,5" passou inteiro');
  });

  await cenario('Erro da Apple que repete a senha da demo não a mostra no log', async ({ conferir, guardar }) => {
    const mock = await subirMock({ revisaoEcoaSenha: true });
    const { codigo, saida } = await publicar(['--enviar', ...COM_VIDEO], { porta: mock.porta, capturas: baseSintetica });
    guardar(saida);
    await mock.fechar();
    conferir(codigo === 1, 'saiu com erro');
    conferir(!saida.includes(SENHA_DEMO) && saida.includes('demoAccountPassword \'•••\''), 'a senha virou •••');
  });

  await cenario('App que não existe na conta: para e diz como criar (a única coisa sem API), com o idioma certo', async ({ conferir, guardar }) => {
    const mock = await subirMock({ appExiste: false });
    const { codigo, saida } = await publicar([], { porta: mock.porta, capturas: baseSintetica });
    guardar(saida);
    await mock.fechar();
    conferir(codigo === 1, 'saiu com erro');
    conferir(saida.includes('Registro do app: NÃO existe') && saida.includes('bundle com.gestaoloja.app'), 'diz o que criar no site');
    conferir(saida.includes('Idioma principal "Português (Brasil)"'), 'manda escolher Português (Brasil) no formulário');
  });

  await cenario('Opção inválida não passa calada', async ({ conferir, guardar }) => {
    const um = await publicar(['--aguardar-build', 'muito'], { capturas: baseSintetica });
    const dois = await publicar(['--enviar-revisao'], { capturas: baseSintetica });
    const tres = await publicar(['--build', 'sete'], { capturas: baseSintetica });
    const quatro = await publicar(['--simular', '--video-revisao', join(TEMP, 'nao-existe.mp4')], { capturas: baseSintetica });
    const textoFalso = join(TEMP, 'video.mp4');
    writeFileSync(textoFalso, Buffer.alloc(100 * 1024, 'x'));
    const cinco = await publicar(['--simular', '--video-revisao', textoFalso], { capturas: baseSintetica });
    const seis = await publicar(['--simular', '--video-revisao', 'http://exemplo.dev/video.mp4'], { capturas: baseSintetica });
    const sete = await publicar(['--enviar', '--mesmo-build', '--build', '7'], { capturas: baseSintetica });
    guardar([um, dois, tres, quatro, cinco, seis, sete].map((r) => r.saida).join('\n'));
    conferir(sete.codigo === 1 && sete.saida.includes('Use um ou outro'), '--mesmo-build com --build');
    conferir(um.codigo === 1 && um.saida.includes('--aguardar-build pede os minutos'), '--aguardar-build sem número');
    conferir(dois.codigo === 1 && dois.saida.includes('Opção desconhecida: --enviar-revisao'), 'opção com erro de digitação');
    conferir(tres.codigo === 1 && tres.saida.includes('--build pede o número do build'), '--build sem número');
    conferir(quatro.codigo === 1 && quatro.saida.includes('não achei o arquivo'), '--video-revisao com arquivo que não existe');
    conferir(cinco.codigo === 1 && cinco.saida.includes('não é um vídeo MP4 nem MOV'), '--video-revisao com arquivo que não é vídeo');
    conferir(seis.codigo === 1 && seis.saida.includes('tem de ser https://'), '--video-revisao com endereço http');
  });
}

await DEMO.fechar();
rmSync(TEMP, { recursive: true, force: true });

if (falhas) {
  console.error(`\n✖ ${falhas} verificação(ões) falharam`);
  process.exit(1);
}
console.log(`\nTudo certo: o publicador faz a ficha inteira sozinho${REAIS ? ', com as capturas reais' : ''}.`);
