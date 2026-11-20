/**
 * A resposta à Apple (Guideline 2.1), peça por peça — sem Apple nenhuma no meio:
 *
 *   node --test publicar/teste/revisao.test.mjs
 *
 * O que não pode quebrar: o vídeo só passa se for vídeo de verdade e no tamanho (inclusive o
 * baixado de um link, que nunca vira arquivo pela metade); a revisão leva UM anexo (a Apple
 * recusa o segundo) — o vídeo antes do guia, e o que está lá sai antes de o novo subir; as
 * notas citam só o anexo que vai estar lá; a lista de aparelhos não aceita linha inventada fora
 * do formato; a ficha não cita tela que o app não tem (e o código deste commit mostra cada rótulo
 * de TELAS_CITADAS); o guia PDF commitado é o das entradas de agora; as notas cabem nos 4000 da
 * Apple no pior caso, nas duas variantes de anexo, e não prometem push (ADR-47: nasce desligado);
 * a política de privacidade e a página de exclusão dizem do registro do aparelho o que o código
 * faz; e o docs/LOJAS-DE-APP.md mostra os textos da ficha como eles estão.
 */

import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import {
  baixarVideo,
  ehVideo,
  escolherAnexo,
  guardarVideo,
  lerVideo,
  md5,
  MINIMO_DO_VIDEO,
  obterVideo,
  tipoDoVideo,
  trocarAnexo,
  videoAnexado,
} from '../anexos.mjs';
import { LIMITES, lerAparelhosTestados, lerFicha, PENDENTE, TELAS_CITADAS, telasQueFaltam } from '../ficha.mjs';
import { diferencas, impressaoAtual, IMPRESSAO, lerGuia, montarHtml } from '../revisao/guia.mjs';

const AQUI = dirname(fileURLToPath(import.meta.url));
const MOBILE = resolve(AQUI, '..', '..');
const TEMP = mkdtempSync(join(tmpdir(), 'revisao-teste-'));

/** Um "MP4" (ou MOV) com a caixa ftyp de verdade e enchimento. */
function video({ marca = 'isom', tamanho = 128 * 1024 } = {}) {
  const dados = Buffer.alloc(tamanho, 7);
  Buffer.from([0, 0, 0, 0x18]).copy(dados, 0);
  dados.write(`ftyp${marca}`, 4, 'latin1');
  return dados;
}

/** Servidor http de mentira para o download do vídeo: cada caminho, um comportamento. */
function servidorDeVideo() {
  const servidor = createServer((req, res) => {
    const corpo = video();
    if (req.url === '/video.mp4') {
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': corpo.length });
      return res.end(corpo);
    }
    if (req.url === '/pagina') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<!doctype html><title>Entrar no Drive</title>');
    }
    if (req.url === '/grande') {
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': String(600 * 1024 * 1024) });
      return res.end(); // o cliente desiste pelo cabeçalho, antes de ler
    }
    if (req.url === '/cortado') {
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': corpo.length });
      res.write(corpo.subarray(0, 1000));
      return setTimeout(() => res.destroy(), 20);
    }
    if (req.url === '/redireciona') {
      res.writeHead(302, { Location: '/video.mp4' });
      return res.end();
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{"detail":"Not Found"}');
  });
  return new Promise((r) => servidor.listen(0, '127.0.0.1', () => r({ base: `http://127.0.0.1:${servidor.address().port}`, fechar: () => new Promise((f) => servidor.close(f)) })));
}

test('vídeo: o cabeçalho decide (MP4, MOV); página, ZIP e arquivo curto não passam', () => {
  assert.equal(tipoDoVideo(video()), 'mp4');
  assert.equal(tipoDoVideo(video({ marca: 'qt  ' })), 'mov');
  assert.equal(tipoDoVideo(Buffer.from('<!doctype html><html>...</html>')), null);
  assert.equal(tipoDoVideo(Buffer.from('PK\u0003\u0004 zip zip zip zip')), null);
  assert.equal(tipoDoVideo(Buffer.alloc(8)), null);
  assert.ok(ehVideo('screen-recording.mp4') && ehVideo('a.MOV') && !ehVideo('app-review-guide.pdf') && !ehVideo(undefined));
});

test('vídeo do disco: sobe com o nome fixo (o reenvio substitui), MD5 dos bytes, e o que não é vídeo para', () => {
  const pasta = mkdtempSync(join(TEMP, 'disco-'));
  const mp4 = join(pasta, 'Gravação 18-11.mp4');
  writeFileSync(mp4, video());
  const v = lerVideo(mp4);
  assert.equal(v.nome, 'screen-recording.mp4');
  assert.equal(v.md5, md5(readFileSync(mp4)));
  assert.equal(v.tamanho, 128 * 1024);

  const mov = join(pasta, 'iphone.mov');
  writeFileSync(mov, video({ marca: 'qt  ' }));
  assert.equal(lerVideo(mov).nome, 'screen-recording.mov');

  const texto = join(pasta, 'falso.mp4');
  writeFileSync(texto, Buffer.alloc(MINIMO_DO_VIDEO, 'x'));
  assert.throws(() => lerVideo(texto), /não é um vídeo MP4 nem MOV/);
  const pequeno = join(pasta, 'pequeno.mp4');
  writeFileSync(pequeno, video({ tamanho: 1024 }));
  assert.throws(() => lerVideo(pequeno), /pequeno demais/);
  assert.throws(() => lerVideo(join(pasta, 'nao-existe.mp4')), /não achei o arquivo/);
});

test('vídeo por link: baixa para a pasta temporária, segue redirecionamento e apaga o que baixou', async () => {
  const { base, fechar } = await servidorDeVideo();
  try {
    const pasta = mkdtempSync(join(TEMP, 'runner-'));
    for (const caminho of ['/video.mp4', '/redireciona']) {
      const v = await obterVideo(`${base}${caminho}`, { pastaTemporaria: pasta, permitirHttp: true });
      assert.equal(v.nome, 'screen-recording.mp4');
      assert.equal(v.md5, md5(video()));
    }
    assert.deepEqual(readdirSync(pasta), [], 'o arquivo baixado ficou para trás');
  } finally {
    await fechar();
  }
});

test('vídeo por link: página no lugar do vídeo, 404, tamanho além do teto, download cortado e http param com a frase certa', async () => {
  const { base, fechar } = await servidorDeVideo();
  try {
    const pasta = mkdtempSync(join(TEMP, 'runner-'));
    const baixar = (caminho) => baixarVideo(`${base}${caminho}`, pasta, { permitirHttp: true });
    await assert.rejects(baixar('/pagina'), /devolveu uma página \(text\/html\)/);
    await assert.rejects(baixar('/sumiu'), /HTTP 404/);
    await assert.rejects(baixar('/grande'), /teto é/);
    await assert.rejects(baixar('/cortado'), /cortado|caiu no meio/);
    await assert.rejects(baixarVideo(`${base}/video.mp4`, pasta), /tem de ser https:\/\//, 'http sem a licença do teste');
    await assert.rejects(baixarVideo('não é endereço', pasta), /nem endereço https/);
    // Nada pela metade sobra na pasta do runner.
    assert.deepEqual(readdirSync(pasta), [], 'sobrou o download pela metade');
  } finally {
    await fechar();
  }
});

test('vídeo por link, baixado UMA vez no começo da rodada: fica na pasta, conferido, e o publicador lê o arquivo', async () => {
  // O link pré-assinado vence durante a compilação: o workflow baixa antes e passa o CAMINHO.
  const { base, fechar } = await servidorDeVideo();
  try {
    const pasta = join(mkdtempSync(join(TEMP, 'runner-')), 'video-revisao');
    const caminho = await guardarVideo(`${base}/redireciona`, pasta, { permitirHttp: true });
    assert.equal(caminho, join(pasta, 'screen-recording.mp4'));
    assert.deepEqual(readdirSync(pasta), ['screen-recording.mp4'], 'sobrou pasta temporária do download');
    const v = await obterVideo(caminho);
    assert.equal(v.md5, md5(video()));
    // Página no lugar do vídeo ou link vencido: para aqui, e nada fica para trás.
    const outra = join(mkdtempSync(join(TEMP, 'runner-')), 'video-revisao');
    await assert.rejects(guardarVideo(`${base}/pagina`, outra, { permitirHttp: true }), /devolveu uma página/);
    await assert.rejects(guardarVideo(`${base}/sumiu`, outra, { permitirHttp: true }), /HTTP 404/);
    assert.deepEqual(readdirSync(outra), []);
  } finally {
    await fechar();
  }
});

test('anexo já na Apple: só conta o vídeo processado (COMPLETE), nunca o PDF nem o que falhou', () => {
  const anexo = (fileName, state) => ({ attributes: { fileName, assetDeliveryState: { state } } });
  assert.equal(videoAnexado([anexo('app-review-guide.pdf', 'COMPLETE'), anexo('screen-recording.mp4', 'FAILED')]), null);
  assert.equal(videoAnexado([anexo('screen-recording.mov', 'COMPLETE')])?.attributes.fileName, 'screen-recording.mov');
});

/** Um anexo como a Apple lista: id, nome, MD5 e estado. */
const naApple = (id, fileName, state = 'COMPLETE', sourceFileChecksum = `md5-${id}`) => ({
  id,
  attributes: { fileName, sourceFileChecksum, assetDeliveryState: { state } },
});
const GUIA = { nome: 'app-review-guide.pdf', dados: Buffer.from('%PDF-guia'), md5: 'md5-guia' };
const VIDEO = { nome: 'screen-recording.mp4', dados: Buffer.from('video'), md5: 'md5-video' };

test('anexo da revisão: UM só — o vídeo desta rodada, senão o já anexado e processado, senão o guia', () => {
  const guiaLa = naApple('A1', 'app-review-guide.pdf');
  const videoLa = naApple('A2', 'screen-recording.mov');
  // Vídeo novo vence tudo, inclusive o vídeo que já está lá.
  assert.deepEqual(escolherAnexo({ video: VIDEO, guia: GUIA, anexos: [guiaLa, videoLa] }), { tipo: 'video', ...VIDEO });
  // Sem vídeo novo, o processado que está lá fica (sem os bytes): um vídeo bom não sai para o guia entrar.
  const fica = escolherAnexo({ guia: GUIA, anexos: [guiaLa, videoLa] });
  assert.equal(fica.tipo, 'video');
  assert.equal(fica.nome, 'screen-recording.mov');
  assert.equal(fica.existente, videoLa);
  // Vídeo que falhou ou que nunca terminou de subir não conta: o guia é o anexo.
  for (const estado of ['FAILED', 'AWAITING_UPLOAD']) {
    assert.deepEqual(escolherAnexo({ guia: GUIA, anexos: [naApple('A3', 'screen-recording.mp4', estado)] }), { tipo: 'guia', ...GUIA });
  }
  assert.deepEqual(escolherAnexo({ guia: GUIA }), { tipo: 'guia', ...GUIA });
});

/** Uma Apple mínima, só para trocarAnexo: anota as chamadas; `del` falha com o status pedido por id. */
function appleDeMentira({ falhaAoApagar = {} } = {}) {
  const chamadas = [];
  const erro = (status) => Object.assign(new Error(`HTTP ${status}`), { status });
  return {
    chamadas,
    async del(caminho) {
      chamadas.push(`DELETE ${caminho}`);
      const id = caminho.split('/').pop();
      if (falhaAoApagar[id]) throw erro(falhaAoApagar[id]);
    },
    async post(caminho) {
      chamadas.push(`POST ${caminho}`);
      return { data: { id: 'NOVO', attributes: { uploadOperations: [] } } };
    },
    async subirArquivo() {
      chamadas.push('PUT bytes');
    },
    async patch(caminho) {
      chamadas.push(`PATCH ${caminho}`);
    },
    async get(caminho) {
      chamadas.push(`GET ${caminho}`);
      return { data: { attributes: { assetDeliveryState: { state: 'COMPLETE' } } } };
    },
  };
}

test('trocar o anexo: o que está lá sai ANTES de o novo subir; o igual fica e só os outros saem', async () => {
  const asc = appleDeMentira();
  const existentes = [naApple('A1', 'app-review-guide.pdf'), naApple('A2', 'screen-recording.mp4', 'AWAITING_UPLOAD')];
  const r = await trocarAnexo(asc, { detalheId: 'REV', escolhido: { tipo: 'video', ...VIDEO }, existentes, esperaMs: 0 });
  assert.deepEqual(asc.chamadas.slice(0, 3), [
    'DELETE /v1/appStoreReviewAttachments/A1',
    'DELETE /v1/appStoreReviewAttachments/A2',
    'POST /v1/appStoreReviewAttachments',
  ]);
  assert.equal(r.mantido, false);
  assert.equal(r.apagados, 2);

  // Mesmo nome, mesmo MD5 e processado: fica, nada sobe; a sobra ao lado sai.
  const igual = appleDeMentira();
  const mantido = await trocarAnexo(igual, {
    detalheId: 'REV',
    escolhido: { tipo: 'guia', ...GUIA },
    existentes: [naApple('A1', 'app-review-guide.pdf', 'COMPLETE', 'md5-guia'), naApple('A2', 'screen-recording.mp4', 'FAILED')],
    esperaMs: 0,
  });
  assert.equal(mantido.mantido, true);
  assert.equal(mantido.id, 'A1');
  assert.deepEqual(igual.chamadas, ['DELETE /v1/appStoreReviewAttachments/A2']);
});

test('trocar o anexo: o que não sai impede a subida (a Apple recusaria), e o 404 conta como já apagado', async () => {
  const travado = appleDeMentira({ falhaAoApagar: { A1: 500 } });
  await assert.rejects(
    trocarAnexo(travado, { detalheId: 'REV', escolhido: { tipo: 'video', ...VIDEO }, existentes: [naApple('A1', 'app-review-guide.pdf')], esperaMs: 0 }),
    (erro) => /app-review-guide\.pdf, que já estava lá, não saiu \(HTTP 500\) e a Apple aceita um só/.test(erro.message) && !erro.semAnexo,
  );
  assert.ok(!travado.chamadas.some((c) => c.startsWith('POST')), 'subiu com o outro lá');

  const sumiu = appleDeMentira({ falhaAoApagar: { A1: 404 } });
  const r = await trocarAnexo(sumiu, { detalheId: 'REV', escolhido: { tipo: 'video', ...VIDEO }, existentes: [naApple('A1', 'app-review-guide.pdf')], esperaMs: 0 });
  assert.equal(r.mantido, false);
  assert.ok(sumiu.chamadas.includes('POST /v1/appStoreReviewAttachments'));

  // O vídeo que ficaria sumiu no meio da rodada: sem os bytes, pede a gravação de novo.
  const video = naApple('A9', 'screen-recording.mp4');
  await assert.rejects(
    trocarAnexo(appleDeMentira(), { detalheId: 'REV', escolhido: { tipo: 'video', nome: 'screen-recording.mp4', existente: video }, existentes: [], esperaMs: 0 }),
    /não está mais lá — passe a gravação de novo \(--video-revisao\)/,
  );
});

test('trocar o anexo: falha no envio depois de apagar diz que a revisão ficou sem anexo, e a reserva sai', async () => {
  const asc = appleDeMentira();
  asc.subirArquivo = async () => {
    asc.chamadas.push('PUT bytes');
    throw new Error('upload de arquivo falhou: HTTP 500');
  };
  await assert.rejects(
    trocarAnexo(asc, { detalheId: 'REV', escolhido: { tipo: 'video', ...VIDEO }, existentes: [naApple('A1', 'app-review-guide.pdf')], esperaMs: 0 }),
    (erro) => erro.semAnexo === true && erro.apagados === 1 && /HTTP 500/.test(erro.message),
  );
  assert.equal(asc.chamadas.at(-1), 'DELETE /v1/appStoreReviewAttachments/NOVO', 'a reserva pela metade ficou');
});

test('aparelhos testados: comentário e linha vazia não contam; linha fora do formato para, com a linha', () => {
  const arquivo = join(TEMP, 'aparelhos.txt');
  writeFileSync(arquivo, '# cabeçalho\n\niPhone 18 Pro Max — iOS 27.0.1\niPhone SE (3rd generation) - iOS 15.8 (BrowserStack)\n');
  assert.deepEqual(lerAparelhosTestados(arquivo), ['iPhone 18 Pro Max — iOS 27.0.1', 'iPhone SE (3rd generation) - iOS 15.8 (BrowserStack)']);
  writeFileSync(arquivo, 'iPhone 17 — iOS 26.1\nGalaxy S24 — Android 15\niPhone 16, iOS 18\n');
  assert.throws(() => lerAparelhosTestados(arquivo), /"Galaxy S24 — Android 15", "iPhone 16, iOS 18"/);
  assert.deepEqual(lerAparelhosTestados(join(TEMP, 'nao-existe.txt')), []);
  // O do repositório: só comentários até alguém testar de verdade (nada inventado).
  const doRepositorio = lerAparelhosTestados(join(MOBILE, 'publicar', 'ficha', 'aparelhos-testados.txt'));
  assert.ok(Array.isArray(doRepositorio));
});

/** Árvore de mentira com as telas citadas (menos as de `sem`), como no rodar.mjs. */
function telas({ sem = [], semRotulo = [] } = {}) {
  const raiz = mkdtempSync(join(TEMP, 'telas-'));
  for (const [rotulo, arquivo] of TELAS_CITADAS) {
    if (sem.includes(arquivo)) continue;
    const caminho = join(raiz, arquivo);
    mkdirSync(dirname(caminho), { recursive: true });
    const antes = existsSync(caminho) ? readFileSync(caminho, 'utf8') : '';
    writeFileSync(caminho, `${antes}${semRotulo.includes(rotulo) ? '' : `<Text>${rotulo}</Text>`}\n`);
  }
  return raiz;
}

test('telas citadas: rótulo que o app não mostra, ou tela que não existe, vira frase com o arquivo', () => {
  const textos = { 'notas-revisao.txt': 'Mais > Minha conta > Excluir minha conta; Mais > Leitor do computador' };
  assert.deepEqual(telasQueFaltam(textos, telas()), []);
  const faltas = telasQueFaltam(textos, telas({ sem: ['mobile/src/app/(app)/mais/conta.tsx'], semRotulo: ['Leitor do computador'] }));
  assert.equal(faltas.length, 2);
  assert.match(faltas.join('\n'), /"Excluir minha conta", mas mobile\/src\/app\/\(app\)\/mais\/conta\.tsx não existe/);
  assert.match(faltas.join('\n'), /"Leitor do computador", mas mobile\/src\/app\/\(app\)\/\(tabs\)\/mais\.tsx não mostra esse texto/);
  assert.deepEqual(telasQueFaltam({ 'descricao.txt': 'nada citado aqui' }, join(TEMP, 'vazio')), [], 'quem não cita não cobra');
});

test('telas citadas: cada rótulo de TELAS_CITADAS está no arquivo DESTE commit (o app e o web de verdade)', () => {
  // Os outros testes usam árvores de mentira: provam o publicador. Este olha o código de verdade
  // — rótulo trocado no app ou no web (ou tela citada que ainda não chegou à branch) quebra aqui,
  // no CI, e não na hora de publicar, quando o publicador pararia antes de falar com a Apple.
  const raiz = resolve(MOBILE, '..');
  const faltam = TELAS_CITADAS.filter(([rotulo, arquivo]) => {
    const caminho = join(raiz, arquivo);
    return !existsSync(caminho) || !readFileSync(caminho, 'utf8').includes(rotulo);
  }).map(([rotulo, arquivo]) => `"${rotulo}" em ${arquivo}`);
  assert.deepEqual(faltam, [], `rótulo citado que o código deste commit não mostra:\n${faltam.join('\n')}`);
});

// O servidor da demo que sobe com a loja tem CAMINHO (<domínio>/demo, ADR-46): num domínio
// comprido, é o endereço mais longo que as notas carregam (na linha do servidor e na das
// etiquetas) — mais que o da Vercel.
const DEMO_COMPRIDA = 'https://gestao.minhalojaderoupas.com.br/demo';
const CONFIG_PIOR_CASO = {
  email_suporte: 'suporte.gestaodeloja@sistemaobras.com.br',
  url_privacidade: `${DEMO_COMPRIDA}/privacidade`,
  url_servidor_demo: DEMO_COMPRIDA,
  email_demo: 'revisao.apple@lojatria.com.br',
  senha_demo: 'Senha-Longa-Da-Demo-2026!$&',
  codigo_demo: '7891234567895',
  url_etiquetas_demo: `${DEMO_COMPRIDA}/legal/etiquetas-de-exemplo.html`,
};
const SETE_APARELHOS = [
  'iPhone 18 Pro Max — iOS 27.0.1',
  'iPhone 17 — iOS 26.1.2',
  'iPhone 16 — iOS 18.6.2',
  'iPhone 15 — iOS 17.7.10',
  'iPhone 14 — iOS 16.7.12',
  'iPhone 13 — iOS 15.8.4',
  'iPhone SE (3rd generation) — iOS 15.8.4',
];

test('notas da revisão: em inglês, os 7 itens, os dois caminhos da exclusão e dentro dos 4000 no pior caso', () => {
  process.env.PUBLICAR_TELAS = telas();
  try {
    const ficha = lerFicha(CONFIG_PIOR_CASO, { aparelhos: SETE_APARELHOS, anexo: { tipo: 'video', nome: 'screen-recording.mov' } });
    const notas = ficha.notasRevisao;
    assert.ok([...notas].length <= LIMITES.notasRevisao, `${[...notas].length} caracteres`);
    // O outro anexo possível (o guia) também cabe — é a variante com uma linha a mais.
    const comOGuia = lerFicha(CONFIG_PIOR_CASO, { aparelhos: SETE_APARELHOS, anexo: { tipo: 'guia', nome: 'app-review-guide.pdf' } }).notasRevisao;
    assert.ok([...comOGuia].length <= LIMITES.notasRevisao, `com o guia: ${[...comOGuia].length} caracteres`);
    for (const item of ['1) SCREEN RECORDING', '2) TESTED ON', '3) PURPOSE', '4) SET UP AND ACCESS', '5) EXTERNAL SERVICES', '6) REGIONS', '7) REGULATION']) {
      assert.ok(notas.includes(item), item);
    }
    assert.ok(notas.includes('Mais > Minha conta > Excluir minha conta') && notas.includes('Mais > Usuários > (pessoa) > Excluir conta'));
    assert.ok(notas.includes('Mais > Leitor do computador > "Ler o QR do computador"'));
    // O chamado (ADR-47) vem antes do QR, com o app ABERTO: a demo nasce com o push desligado,
    // e as notas não prometem notificação — no máximo a permissão, opcional.
    assert.ok(notas.includes('"Abrir no app o leitor de código"') && notas.includes('"Abrir o leitor" in the open app'));
    assert.ok(notas.indexOf('Abrir no app o leitor de código') < notas.indexOf('Ler o QR do computador'), 'o QR é a alternativa');
    assert.ok(!/push|APNs/i.test(notas), 'as notas prometem push');
    assert.deepEqual(notas.match(/notification\w*/gi), ['notifications'], 'notificação nas notas só como permissão opcional');
    assert.ok(notas.includes('notifications (optional)'));
    assert.ok(notas.includes(`made on a physical ${SETE_APARELHOS[0]}`) && notas.includes(SETE_APARELHOS.join('; ')));
    assert.ok(notas.includes('Password: Senha-Longa-Da-Demo-2026!$&'), 'a senha com $& chegou estragada (troca por texto em vez de função)');
    assert.ok(notas.includes(`Server: ${DEMO_COMPRIDA}\n`), 'o servidor chega às notas com o caminho');
    assert.ok(!/Vercel|Neon|Blob/.test(notas), 'as notas não amarram a demo a um provedor: ela pode ser a da loja ou a da Vercel');
    assert.ok(!notas.includes(PENDENTE) && !/\{\{/.test(notas));
    assert.ok(!/sistemaobras\.com\.br\b(?!$)/.test(notas.replace(CONFIG_PIOR_CASO.email_suporte, '')), 'o revisor não é mandado ao site de outro sistema');

    // Sem lista e sem vídeo a ficha sobe, com "(pending)" — a revisão é que não sai (publicar.mjs).
    const semNada = lerFicha(CONFIG_PIOR_CASO).notasRevisao;
    assert.ok(semNada.includes(`attachment ${PENDENTE}`) && semNada.includes(`TESTED ON (physical devices): ${PENDENTE}`));
  } finally {
    delete process.env.PUBLICAR_TELAS;
  }
});

test('notas da revisão: citam só o anexo que vai estar lá (a Apple aceita um)', () => {
  process.env.PUBLICAR_TELAS = telas();
  try {
    const comVideo = lerFicha(CONFIG_PIOR_CASO, { aparelhos: SETE_APARELHOS, anexo: { tipo: 'video', nome: 'screen-recording.mp4' } }).notasRevisao;
    assert.ok(comVideo.includes('1) SCREEN RECORDING: attachment "screen-recording.mp4"'), 'o item 1 cita o vídeo');
    assert.ok(!comVideo.includes('app-review-guide.pdf') && !/attached .*guide/i.test(comVideo), 'com o vídeo anexado, as notas prometem o guia');
    assert.ok(comVideo.startsWith("B2B APP FOR SHOP STAFF; IT NEEDS THE SHOP'S SERVER. Answers to Guideline 2.1 below.\n\nDEMO SERVER"));

    const comGuia = lerFicha(CONFIG_PIOR_CASO, { aparelhos: SETE_APARELHOS, anexo: { tipo: 'guia', nome: 'app-review-guide.pdf' } }).notasRevisao;
    assert.ok(comGuia.includes('\nThe attached "app-review-guide.pdf" has them in full, with screenshots.\n'), 'com o guia anexado, a 2ª linha o cita');
    assert.ok(comGuia.includes(`1) SCREEN RECORDING: attachment ${PENDENTE}`), 'sem vídeo anexado, o item 1 fica "(pending)" (a revisão não sai)');
    assert.ok(!/\{\{/.test(comVideo) && !/\{\{/.test(comGuia), 'marcador sobrando');
  } finally {
    delete process.env.PUBLICAR_TELAS;
  }
});

test('guia PDF: o commitado é o das entradas de agora (texto, aparelhos e prints) — senão, gerar-guia.mjs', () => {
  const guia = lerGuia();
  assert.equal(guia.dados.subarray(0, 5).toString('latin1'), '%PDF-');
  assert.deepEqual(
    guia.desatualizado,
    [],
    'O guia do revisor está desatualizado: rode node publicar/revisao/gerar-guia.mjs (Playwright) e faça commit do PDF e do .entradas.json',
  );
  const gravada = JSON.parse(readFileSync(IMPRESSAO, 'utf8')).entradas;
  const atual = impressaoAtual();
  const chave = 'mobile/publicar/ficha/aparelhos-testados.txt';
  assert.ok(chave in atual, 'a lista de aparelhos é entrada do guia');
  assert.deepEqual(diferencas(gravada, { ...atual, [chave]: 'outra' }), [`${chave} mudou`]);
  const { [chave]: _, ...semALista } = atual;
  assert.deepEqual(diferencas(gravada, semALista), [`${chave} saiu`]);
  assert.deepEqual(diferencas({}, atual).length, Object.keys(atual).length);
});

test('política de privacidade (a URL da ficha), notas e guia contam os mesmos serviços externos', () => {
  // O revisor lê o item 5 das notas (ou do guia) e abre a política pelo link da ficha: um
  // documento não pode desmentir o outro. A política dizia "não fala com nenhum outro endereço"
  // enquanto as notas contavam a checagem de conexão do NetInfo e as fotos da demo no Vercel Blob.
  const notas = readFileSync(join(MOBILE, 'publicar', 'ficha', 'notas-revisao.txt'), 'utf8');
  const guia = montarHtml();
  const politica = readFileSync(join(MOBILE, '..', 'web', 'legal', 'privacidade.html'), 'utf8');
  for (const servico of ['generate_204', 'Vercel Blob', 'Neon', 'Expo', 'APNs']) {
    if (notas.includes(servico)) assert.ok(politica.includes(servico), `as notas citam ${servico} e a política não`);
    if (guia.includes(servico)) assert.ok(politica.includes(servico), `o guia cita ${servico} e a política não`);
  }
  // O push do chamado (ADR-47) é opcional — a loja liga —, e a política diz isso, não que ele sempre existe.
  assert.ok(guia.includes('Expo') && guia.includes('APNs'), 'o guia conta o push opcional');
  assert.match(politica, /quando a loja liga as notificações/);
  assert.ok(!/não fala com nenhum outro endereço|única conexão que o app faz/i.test(politica), 'a política ainda nega qualquer outra conexão');
});

test('LOJAS-DE-APP.md: as páginas legais das fichas são as do servidor da loja, nunca as do site de outro sistema', () => {
  // As duas fichas colam a privacidade e a exclusão de dados que o próprio sistema serve
  // (<servidor>/privacidade e <servidor>/exclusao-de-dados). sistemaobras.com.br é o site do
  // Sistema Obras: a ficha do Google Play mandava colar a política de lá.
  const doc = readFileSync(join(MOBILE, '..', 'docs', 'LOJAS-DE-APP.md'), 'utf8');
  const paginas = doc.match(/https?:\/\/(?:[\w-]+\.)*sistemaobras\.com\.br\/[^\s`)]+/g) ?? [];
  assert.deepEqual(paginas, [], `página do sistemaobras para colar numa ficha:\n${paginas.join('\n')}`);
});

test('notas da revisão: a linha do leitor diz qual endereço abrir no computador', () => {
  // Com o vídeo anexado, sem o guia, "in a computer browser" sozinho deixava o revisor deduzir
  // o endereço pela linha "Server:" lá de cima. A linha do leitor aponta para ela.
  process.env.PUBLICAR_TELAS = telas();
  try {
    for (const anexo of [
      { tipo: 'video', nome: 'screen-recording.mov' },
      { tipo: 'guia', nome: 'app-review-guide.pdf' },
    ]) {
      const notas = lerFicha(CONFIG_PIOR_CASO, { aparelhos: SETE_APARELHOS, anexo }).notasRevisao;
      const linha = notas.split('\n').find((l) => l.includes('"Abrir no app o leitor de código"'));
      assert.ok(linha, `${anexo.tipo}: a linha do leitor sumiu`);
      assert.match(linha, /open the server above in a computer browser/, `${anexo.tipo}: ${linha}`);
    }
  } finally {
    delete process.env.PUBLICAR_TELAS;
  }
});

test('política de privacidade e exclusão de dados: o aviso, o Android e o que sai, como o código faz (ADR-47)', () => {
  const raiz = resolve(MOBILE, '..');
  const ler = (caminho) => readFileSync(join(raiz, caminho), 'utf8');
  const politica = ler('web/legal/privacidade.html');
  const exclusao = ler('web/legal/exclusao-de-dados.html');
  const paginas = [
    ['privacidade', politica],
    ['exclusão de dados', exclusao],
  ];

  // O aviso é o que o servidor manda (o título de lá), não o rótulo da faixa do app aberto; e o
  // aviso de teste do diagnóstico do dono também usa o token.
  const servico = ler('api/app/modules/notificacoes/service.py');
  const titulo = servico.match(/^TITULO_DO_CHAMADO = "([^"]+)"/m)?.[1];
  const teste = servico.match(/^TITULO_DO_TESTE = "([^"]+)"/m)?.[1];
  assert.ok(titulo && teste, 'os títulos do push saíram de notificacoes/service.py: ajuste este teste');
  assert.ok(politica.includes(`"${titulo}"`), `a política não cita o título do aviso ("${titulo}")`);
  assert.ok(politica.includes(teste), `a política não conta o aviso de teste ("${teste}")`);
  for (const [nome, pagina] of paginas) {
    assert.doesNotMatch(pagina, /aviso "O computador está chamando"/, `${nome}: o rótulo da faixa vira o texto do aviso`);
  }

  // Nesta versão só o iPhone pede a permissão (podeReceberPush): a política não promete o pedido
  // no Android. Quando o Android ganhar FCM, este teste lembra de mudar a política.
  const notificacoes = readFileSync(join(MOBILE, 'src', 'lib', 'notificacoes.ts'), 'utf8');
  if (/plataforma\s*===\s*'ios'/.test(notificacoes)) {
    assert.match(politica, /no Android desta versão, o aplicativo não pede/);
  }

  // O registro do aparelho sai a cada sessão, com ou sem push: o "opcional" é das notificações.
  assert.doesNotMatch(politica, /Registro do aparelho[^<]*\(opcionais\)/);

  // Os 30 dias não são "sozinhos": a faxina roda no registro e no login — e só por isso a loja que
  // parou de usar o app não guarda o token para sempre.
  assert.match(
    ler('api/app/modules/auth/service.py'),
    /NotificacoesService\(self\.session\)\.faxina\(\)/,
    'o login parou de fazer a faxina dos aparelhos: ajuste a política e este teste',
  );
  for (const [nome, pagina] of paginas) {
    assert.doesNotMatch(pagina, /sozinhos? depois de 30 dias/, `${nome}: "sozinho depois de 30 dias"`);
    assert.match(pagina, /30 dias sem o app ser usado, na limpeza automática que roda sempre que alguém entra no sistema/, nome);
  }

  // O id da instalação também mora no pareamento do leitor ligado, e essa tabela entra nos
  // backups (só a dos aparelhos fica de fora): as páginas dizem quando ele sai e que entra lá.
  assert.match(ler('api/app/modules/leitor/service.py'), /p\.aparelho_instalacao = None/, '_encerrar parou de tirar o id');
  assert.match(politica, /Identificador da instalação no leitor ligado/);
  assert.match(politica, /entra nas cópias de segurança da loja como o resto do banco/);
  assert.match(exclusao, /Celular ligado como leitor:<\/strong>[^<]*entra nas cópias de segurança como o resto do banco/);
});

test('guia: o "Digitar código" do leitor ligado está no passo a passo do leitor se, e só se, a tela o tem', () => {
  const leitor = readFileSync(join(MOBILE, 'src', 'components', 'LeitorPareado.tsx'), 'utf8');
  const guia = montarHtml();
  const inicio = guia.indexOf("Phone as the computer's barcode reader");
  const secao = guia.slice(inicio, guia.indexOf('QR instead', inicio));
  assert.ok(inicio >= 0 && secao, 'a seção do leitor sumiu do guia');
  assert.equal(secao.includes('Digitar código'), leitor.includes('<CodigoManual'), 'o guia e a tela do leitor ligado não batem');
});

test('LOJAS-DE-APP.md: as notas, a descrição e as novidades do doc são os arquivos da ficha, com o tamanho no título', () => {
  // O doc mostra o texto que vai à Apple e o tamanho dele (com os marcadores): mudou o arquivo,
  // muda o doc no mesmo commit — senão quem lê o doc confere um texto que não é o publicado.
  const doc = readFileSync(join(MOBILE, '..', 'docs', 'LOJAS-DE-APP.md'), 'utf8');
  const blocos = [...doc.matchAll(/```\n([\s\S]*?)```/g)].map((m) => m[1].replace(/\n+$/, ''));
  for (const [arquivo, titulo] of [
    ['notas-revisao.txt', /^## 6\. NOTAS PARA A REVISÃO[^\n]* — ([\d.]+) caracteres com os marcadores/m],
    ['descricao.txt', /^## 3\. DESCRIÇÃO — ([\d.]+) caracteres com os marcadores/m],
    ['novidades.txt', /^## 4\. NOVIDADES DESTA VERSÃO — ([\d.]+) caracteres/m],
  ]) {
    const texto = readFileSync(join(MOBILE, 'publicar', 'ficha', arquivo), 'utf8').trim();
    assert.ok(blocos.includes(texto), `docs/LOJAS-DE-APP.md não tem o texto de ficha/${arquivo} como ele está`);
    assert.equal(doc.match(titulo)?.[1], [...texto].length.toLocaleString('pt-BR'), `o título de ficha/${arquivo} no doc diz outro tamanho`);
  }
});
