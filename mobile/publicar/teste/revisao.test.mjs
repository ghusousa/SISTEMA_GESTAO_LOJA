/**
 * A resposta à Apple (Guideline 2.1), peça por peça — sem Apple nenhuma no meio:
 *
 *   node --test publicar/teste/revisao.test.mjs
 *
 * O que não pode quebrar: o vídeo só passa se for vídeo de verdade e no tamanho (inclusive o
 * baixado de um link, que nunca vira arquivo pela metade); a lista de aparelhos não aceita
 * linha inventada fora do formato; a ficha não cita tela que o app não tem; o guia PDF
 * commitado é o das entradas de agora; e as notas cabem nos 4000 da Apple no pior caso.
 */

import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { baixarVideo, ehVideo, guardarVideo, lerVideo, md5, MINIMO_DO_VIDEO, obterVideo, tipoDoVideo, videoAnexado } from '../anexos.mjs';
import { LIMITES, lerAparelhosTestados, lerFicha, PENDENTE, TELAS_CITADAS, telasQueFaltam } from '../ficha.mjs';
import { diferencas, impressaoAtual, IMPRESSAO, lerGuia } from '../revisao/guia.mjs';

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

const CONFIG_PIOR_CASO = {
  email_suporte: 'suporte.gestaodeloja@sistemaobras.com.br',
  url_privacidade: 'https://loja-tria.vercel.app/privacidade',
  url_servidor_demo: 'https://loja-tria.vercel.app',
  email_demo: 'revisao.apple@lojatria.com.br',
  senha_demo: 'Senha-Longa-Da-Demo-2026!$&',
  codigo_demo: '7891234567895',
  url_etiquetas_demo: 'https://loja-tria.vercel.app/legal/etiquetas-de-exemplo.html',
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
    const ficha = lerFicha(CONFIG_PIOR_CASO, { aparelhos: SETE_APARELHOS, video: 'screen-recording.mp4' });
    const notas = ficha.notasRevisao;
    assert.ok([...notas].length <= LIMITES.notasRevisao, `${[...notas].length} caracteres`);
    for (const item of ['1) SCREEN RECORDING', '2) TESTED ON', '3) PURPOSE', '4) SET UP AND ACCESS', '5) EXTERNAL SERVICES', '6) REGIONS', '7) REGULATION']) {
      assert.ok(notas.includes(item), item);
    }
    assert.ok(notas.includes('Mais > Minha conta > Excluir minha conta') && notas.includes('Mais > Usuários > (pessoa) > Excluir conta'));
    assert.ok(notas.includes('Mais > Leitor do computador > "Ler o QR do computador"'));
    assert.ok(notas.includes(`made on a physical ${SETE_APARELHOS[0]}`) && notas.includes(SETE_APARELHOS.join('; ')));
    assert.ok(notas.includes('Password: Senha-Longa-Da-Demo-2026!$&'), 'a senha com $& chegou estragada (troca por texto em vez de função)');
    assert.ok(!notas.includes(PENDENTE) && !/\{\{/.test(notas));
    assert.ok(!/sistemaobras\.com\.br\b(?!$)/.test(notas.replace(CONFIG_PIOR_CASO.email_suporte, '')), 'o revisor não é mandado ao site de outro sistema');

    // Sem lista e sem vídeo a ficha sobe, com "(pending)" — a revisão é que não sai (publicar.mjs).
    const semNada = lerFicha(CONFIG_PIOR_CASO).notasRevisao;
    assert.ok(semNada.includes(`attachment ${PENDENTE}`) && semNada.includes(`TESTED ON (physical devices): ${PENDENTE}`));
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

test('política de privacidade (a URL da ficha) e notas contam os mesmos serviços externos', () => {
  // O revisor lê o item 5 das notas e abre a política pelo link da ficha: um documento não pode
  // desmentir o outro. A política dizia "não fala com nenhum outro endereço" enquanto as notas
  // contavam a checagem de conexão do NetInfo e as fotos da demo no Vercel Blob.
  const notas = readFileSync(join(MOBILE, 'publicar', 'ficha', 'notas-revisao.txt'), 'utf8');
  const politica = readFileSync(join(MOBILE, '..', 'web', 'legal', 'privacidade.html'), 'utf8');
  for (const servico of ['generate_204', 'Vercel Blob', 'Neon']) {
    if (notas.includes(servico)) assert.ok(politica.includes(servico), `as notas citam ${servico} e a política não`);
  }
  assert.ok(!/não fala com nenhum outro endereço|única conexão que o app faz/i.test(politica), 'a política ainda nega qualquer outra conexão');
});
