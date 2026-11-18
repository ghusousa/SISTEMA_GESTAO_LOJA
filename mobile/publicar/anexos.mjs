/**
 * Os anexos da revisão (App Review Information → Attachments): o guia em PDF para o revisor e
 * a gravação de tela que a Apple pediu na Guideline 2.1. A API 4.6 tem a rota
 * (`/v1/appStoreReviewAttachments`, presa ao appStoreReviewDetail da versão) — o dono não
 * precisa anexar nada no site.
 *
 * Subir = reservar (nome e tamanho) → PUT dos bytes nas uploadOperations que a Apple devolve
 * → confirmar com o MD5 (a Apple compara com o que recebeu) → esperar o processamento.
 * O reenvio SUBSTITUI o anexo de mesmo nome e nunca duplica: o igual (mesmo MD5, processado)
 * fica como está; o diferente sobe primeiro e só então o antigo sai — se o novo falhar, a
 * reserva pela metade é apagada e o antigo continua lá.
 *
 * O vídeo vem de um arquivo ou de um endereço https (`--video-revisao`; no Actions, a entrada
 * "video_revisao_url"): baixado para a pasta temporária do runner, conferido (MP4/MOV de
 * verdade, pelo cabeçalho do arquivo, e no tamanho) antes de gastar uma chamada na Apple.
 */

import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** Nome do guia na Apple (e no repositório: publicar/revisao/). */
export const NOME_DO_GUIA = 'app-review-guide.pdf';
/** O vídeo sobe sempre com este nome (+ .mp4 ou .mov): é o que deixa o reenvio substituir. */
export const NOME_DO_VIDEO = 'screen-recording';
export const MAXIMO_DO_VIDEO = 500 * 1024 * 1024;
export const MINIMO_DO_VIDEO = 64 * 1024;
const ESPERA_DO_DOWNLOAD_MS = 10 * 60_000;

export const md5 = (dados) => createHash('md5').update(dados).digest('hex');
export const ehVideo = (nome) => /\.(mp4|mov|m4v)$/i.test(nome ?? '');
const estadoDoAnexo = (a) => a?.attributes?.assetDeliveryState?.state;
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;

/**
 * MP4 e MOV são caixas ISO: os bytes 4–8 dizem "ftyp" e os 8–12, a marca ("qt  " = QuickTime).
 * Devolve a extensão ou null — uma página de erro HTML ou um ZIP não passam daqui.
 */
export function tipoDoVideo(dados) {
  if (!dados || dados.length < 12 || dados.toString('latin1', 4, 8) !== 'ftyp') return null;
  return dados.toString('latin1', 8, 12) === 'qt  ' ? 'mov' : 'mp4';
}

/** Lê e confere o vídeo do disco. Devolve { nome, dados, md5, tamanho }. */
export function lerVideo(caminho) {
  if (!existsSync(caminho)) throw new Error(`--video-revisao: não achei o arquivo ${caminho}.`);
  const tamanho = statSync(caminho).size;
  if (tamanho > MAXIMO_DO_VIDEO) {
    throw new Error(`--video-revisao: ${mb(tamanho)} passa do teto de ${mb(MAXIMO_DO_VIDEO)} — corte o tempo parado e exporte de novo.`);
  }
  if (tamanho < MINIMO_DO_VIDEO) {
    throw new Error(`--video-revisao: ${tamanho} bytes é pequeno demais para uma gravação de tela — confira o arquivo.`);
  }
  const dados = readFileSync(caminho);
  const tipo = tipoDoVideo(dados);
  if (!tipo) throw new Error('--video-revisao: o arquivo não é um vídeo MP4 nem MOV (o cabeçalho não tem "ftyp").');
  return { nome: `${NOME_DO_VIDEO}.${tipo}`, dados, md5: md5(dados), tamanho };
}

/**
 * Baixa o vídeo de um endereço https para `pasta` (no Actions, $RUNNER_TEMP), com teto de
 * tamanho conferido enquanto baixa, e devolve o caminho do arquivo. `permitirHttp` só existe
 * para o teste, que serve o vídeo em http://127.0.0.1.
 */
export async function baixarVideo(endereco, pasta, { permitirHttp = false, tempoMs = ESPERA_DO_DOWNLOAD_MS } = {}) {
  let url;
  try {
    url = new URL(endereco);
  } catch {
    throw new Error(`--video-revisao: "${endereco}" não é arquivo existente nem endereço https://.`);
  }
  if (url.protocol !== 'https:' && !(permitirHttp && url.protocol === 'http:')) {
    throw new Error('--video-revisao: o endereço tem de ser https:// (o link direto do arquivo de vídeo).');
  }
  let resposta;
  try {
    resposta = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(tempoMs) });
  } catch (erro) {
    throw new Error(`--video-revisao: não deu para baixar o vídeo (${erro.cause?.code ?? erro.message}).`);
  }
  if (!resposta.ok) throw new Error(`--video-revisao: o endereço respondeu HTTP ${resposta.status} — o link expirou ou não é público?`);
  const tipo = resposta.headers.get('content-type') ?? '';
  if (/text\/html|application\/json|text\/plain/i.test(tipo)) {
    throw new Error(`--video-revisao: o endereço devolveu uma página (${tipo.split(';')[0]}), não o vídeo — use o link direto do arquivo.`);
  }
  const declarado = Number(resposta.headers.get('content-length')) || 0;
  if (declarado > MAXIMO_DO_VIDEO) {
    throw new Error(`--video-revisao: o vídeo tem ${mb(declarado)}; o teto é ${mb(MAXIMO_DO_VIDEO)}.`);
  }
  const destino = join(mkdtempSync(join(pasta, 'video-revisao-')), 'video');
  // Download que não chegou inteiro não deixa nada na pasta do runner.
  const descartar = () => rmSync(dirname(destino), { recursive: true, force: true });
  let recebidos = 0;
  const contar = async function* (fonte) {
    for await (const pedaco of fonte) {
      recebidos += pedaco.length;
      if (recebidos > MAXIMO_DO_VIDEO) throw new Error(`--video-revisao: o vídeo passou de ${mb(MAXIMO_DO_VIDEO)} — download interrompido.`);
      yield pedaco;
    }
  };
  try {
    await pipeline(Readable.fromWeb(resposta.body), contar, createWriteStream(destino));
  } catch (erro) {
    descartar();
    throw erro.message?.startsWith('--video-revisao') ? erro : new Error(`--video-revisao: o download caiu no meio (${erro.message}).`);
  }
  if (declarado && recebidos !== declarado) {
    descartar();
    throw new Error(`--video-revisao: chegaram ${recebidos} de ${declarado} bytes — o download veio cortado.`);
  }
  return destino;
}

/**
 * O vídeo pedido no `--video-revisao`: arquivo do disco ou endereço https (baixado e
 * conferido). O arquivo baixado é apagado depois de lido — os bytes ficam na memória.
 */
export async function obterVideo(origem, { pastaTemporaria, permitirHttp = false } = {}) {
  if (existsSync(origem)) return lerVideo(origem);
  if (!/^[a-z]+:\/\//i.test(origem)) throw new Error(`--video-revisao: não achei o arquivo ${origem}.`);
  const pasta = pastaTemporaria || process.env.RUNNER_TEMP || tmpdir();
  const caminho = await baixarVideo(origem, pasta, { permitirHttp });
  try {
    return lerVideo(caminho);
  } finally {
    rmSync(dirname(caminho), { recursive: true, force: true });
  }
}

/** Os anexos que já estão no detalhe de revisão (lista vazia se ainda não há detalhe). */
export async function lerAnexos(asc, detalheId) {
  if (!detalheId) return [];
  return (await asc.get(`/v1/appStoreReviewDetails/${detalheId}/appStoreReviewAttachments?limit=50`)).data ?? [];
}

/** O vídeo já anexado e processado (o mais novo, se houver mais de um), ou null. */
export function videoAnexado(anexos) {
  return anexos.find((a) => ehVideo(a.attributes?.fileName) && estadoDoAnexo(a) === 'COMPLETE') ?? null;
}

/**
 * Sobe UM anexo com a regra do reenvio (ver o topo). Devolve { id, mantido, substituidos,
 * processando }; lança Error com o motivo se a Apple recusar.
 */
export async function subirAnexo(asc, { detalheId, nome, dados, md5: soma, existentes, esperaMs, relatorio }) {
  const mesmoNome = existentes.filter((a) => a.attributes?.fileName === nome);
  const igual = mesmoNome.find((a) => a.attributes?.sourceFileChecksum === soma && estadoDoAnexo(a) === 'COMPLETE');
  if (igual) {
    // Sobra de uma rodada que caiu entre subir o novo e apagar o velho: some agora.
    for (const outro of mesmoNome) if (outro !== igual) await asc.del(`/v1/appStoreReviewAttachments/${outro.id}`);
    return { id: igual.id, mantido: true, substituidos: mesmoNome.length - 1, processando: false };
  }

  const reserva = (
    await asc.post('/v1/appStoreReviewAttachments', {
      data: {
        type: 'appStoreReviewAttachments',
        attributes: { fileName: nome, fileSize: dados.length },
        relationships: { appStoreReviewDetail: { data: { type: 'appStoreReviewDetails', id: detalheId } } },
      },
    })
  ).data;
  let estado;
  try {
    await asc.subirArquivo(reserva.attributes.uploadOperations, dados);
    // A Apple confere o MD5 com os bytes que recebeu: arquivo truncado não passa calado.
    await asc.patch(`/v1/appStoreReviewAttachments/${reserva.id}`, {
      data: { type: 'appStoreReviewAttachments', id: reserva.id, attributes: { uploaded: true, sourceFileChecksum: soma } },
    });
    estado = await esperarProcessamento(asc, reserva.id, esperaMs);
    if (estado.state === 'FAILED') {
      const motivo = (estado.errors ?? []).map((e) => [e.code, e.description].filter(Boolean).join(': ')).join('; ');
      throw new Error(`a Apple recusou ao processar ${nome} (${motivo || 'sem motivo'})`);
    }
  } catch (erro) {
    try {
      await asc.del(`/v1/appStoreReviewAttachments/${reserva.id}`);
    } catch {
      relatorio?.ok(`a reserva ${reserva.id} pela metade não saiu; a próxima rodada a substitui`);
    }
    throw erro;
  }
  // O novo entrou inteiro: agora o de mesmo nome que estava lá sai.
  for (const antigo of mesmoNome) await asc.del(`/v1/appStoreReviewAttachments/${antigo.id}`);
  return { id: reserva.id, mantido: false, substituidos: mesmoNome.length, processando: estado.state !== 'COMPLETE' };
}

/** A Apple processa o anexo depois do upload: UPLOAD_COMPLETE → COMPLETE (ou FAILED). */
async function esperarProcessamento(asc, id, esperaMs, tentativas = 60) {
  let estado = {};
  for (let i = 0; i < tentativas; i++) {
    const anexo = (await asc.get(`/v1/appStoreReviewAttachments/${id}`)).data;
    estado = anexo?.attributes?.assetDeliveryState ?? {};
    if (estado.state === 'COMPLETE' || estado.state === 'FAILED') return estado;
    if (i < tentativas - 1) await dormir(esperaMs);
  }
  return estado;
}
