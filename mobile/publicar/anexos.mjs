/**
 * O anexo da revisão (App Review Information → Attachments): a gravação de tela que a Apple
 * pediu na Guideline 2.1 ou, sem ela, o guia em PDF para o revisor. A API 4.6.1 tem a rota
 * (`/v1/appStoreReviewAttachments`, presa ao appStoreReviewDetail da versão) — o dono não
 * precisa anexar nada no site.
 *
 * A Apple aceita UM anexo por detalhe de revisão: o POST com outro já lá volta 409 STATE_ERROR
 * ("There can be max of 1 attachment, please delete the existing attachment before loading a
 * new one" — a rodada nº 8 parou nele, subindo o guia ao lado do vídeo). Por isso a rodada
 * escolhe um só (escolherAnexo), e as notas citam só ele (ficha.mjs): o vídeo novo desta
 * rodada; senão, o vídeo que já está anexado e processado — um vídeo bom nunca sai para o guia
 * entrar; senão, o guia.
 *
 * Trocar (trocarAnexo): o que já está lá IGUAL ao escolhido (mesmo nome, mesmo MD5, processado)
 * fica, e os outros saem. Senão, TODOS os que estão lá saem ANTES e o escolhido sobe: reservar
 * (nome e tamanho) → PUT dos bytes nas uploadOperations que a Apple devolve → confirmar com o
 * MD5 (a Apple compara com o que recebeu) → esperar o processamento. Entre o apagar e o subir a
 * revisão fica sem anexo; se o envio falhar, a reserva pela metade sai e a pendência diz isso —
 * a próxima rodada sobe de novo (e o `--enviar` não manda revisão sem o anexo).
 *
 * O vídeo vem de um arquivo ou de um endereço https (`--video-revisao`; no Actions, a entrada
 * "video_revisao_url"): baixado para a pasta temporária do runner, conferido (MP4/MOV de
 * verdade, pelo cabeçalho do arquivo, e no tamanho) antes de gastar uma chamada na Apple.
 */

import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** Nome do guia na Apple (e no repositório: publicar/revisao/). */
export const NOME_DO_GUIA = 'app-review-guide.pdf';
/** O vídeo sobe sempre com este nome (+ .mp4 ou .mov): o mesmo vídeo de novo é reconhecido e fica. */
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

/**
 * Baixa o vídeo do link UMA vez e o deixa em `pasta` (no Actions, $RUNNER_TEMP), já conferido,
 * com o nome que sobe para a Apple. Devolve o caminho. É o que o workflow faz no começo da
 * rodada: o link pré-assinado de uma sessão gravada (S3, BrowserStack) pode vencer em minutos,
 * e baixar de novo depois de compilar (20 a 120 min) perdia a rodada inteira. Os passos
 * seguintes recebem o CAMINHO, não o link. Download ou vídeo inválido não deixa nada na pasta.
 */
export async function guardarVideo(origem, pasta, { permitirHttp = false } = {}) {
  mkdirSync(pasta, { recursive: true });
  const baixado = await baixarVideo(origem, pasta, { permitirHttp });
  try {
    const { nome } = lerVideo(baixado);
    const destino = join(pasta, nome);
    renameSync(baixado, destino);
    return destino;
  } finally {
    rmSync(dirname(baixado), { recursive: true, force: true });
  }
}

/** Os anexos que já estão no detalhe de revisão (lista vazia se ainda não há detalhe). */
export async function lerAnexos(asc, detalheId) {
  if (!detalheId) return [];
  return (await asc.get(`/v1/appStoreReviewDetails/${detalheId}/appStoreReviewAttachments?limit=50`)).data ?? [];
}

/**
 * Anexo que uma rodada anterior deixou processando (UPLOAD_COMPLETE): espera a Apple terminar
 * ANTES da escolha — o vídeo que acabou de subir não perde o lugar para o guia só por ainda
 * estar processando. Só leitura; devolve a lista com o estado de agora.
 */
export async function esperarOsQueProcessam(asc, anexos, esperaMs) {
  const agora = [];
  for (const anexo of anexos) {
    if (estadoDoAnexo(anexo) !== 'UPLOAD_COMPLETE') {
      agora.push(anexo);
      continue;
    }
    const estado = await esperarProcessamento(asc, anexo.id, esperaMs);
    agora.push({ ...anexo, attributes: { ...anexo.attributes, assetDeliveryState: estado } });
  }
  return agora;
}

/** O vídeo já anexado e processado (o mais novo, se houver mais de um), ou null. */
export function videoAnexado(anexos) {
  return anexos.find((a) => ehVideo(a.attributes?.fileName) && estadoDoAnexo(a) === 'COMPLETE') ?? null;
}

/**
 * O ÚNICO anexo da revisão (ver o topo): o vídeo novo desta rodada; senão, o vídeo que já está
 * anexado e processado (fica como está: `existente`, sem os bytes); senão, o guia PDF.
 * Devolve { tipo: 'video' | 'guia', nome, dados?, md5?, existente? }.
 */
export function escolherAnexo({ video = null, guia, anexos = [] }) {
  if (video) return { tipo: 'video', nome: video.nome, dados: video.dados, md5: video.md5 };
  const jaAnexado = videoAnexado(anexos);
  if (jaAnexado) return { tipo: 'video', nome: jaAnexado.attributes.fileName, existente: jaAnexado };
  return { tipo: 'guia', nome: guia.nome, dados: guia.dados, md5: guia.md5 };
}

const nomeDoAnexo = (anexo) => anexo.attributes?.fileName ?? anexo.id;

/** Apaga um anexo; o que já sumiu (404, apagado no site) conta como apagado. */
async function apagarAnexo(asc, anexo) {
  try {
    await asc.del(`/v1/appStoreReviewAttachments/${anexo.id}`);
  } catch (erro) {
    if (erro.status !== 404) throw erro;
  }
}

/**
 * Deixa na revisão só o `escolhido` de escolherAnexo (a regra está no topo). Devolve { id,
 * mantido, apagados, sobras, processando } — `sobras`: outro anexo que não saiu ao lado do
 * escolhido que ficou (aviso, não pendência: o que as notas citam está lá). Lança Error com o
 * motivo; `semAnexo` quando os de antes já saíram e o escolhido não entrou.
 */
export async function trocarAnexo(asc, { detalheId, escolhido, existentes, esperaMs, relatorio }) {
  const processado = (a) => estadoDoAnexo(a) === 'COMPLETE';
  const igual = escolhido.existente
    ? existentes.find((a) => a.id === escolhido.existente.id && processado(a))
    : existentes.find(
        (a) => a.attributes?.fileName === escolhido.nome && a.attributes?.sourceFileChecksum === escolhido.md5 && processado(a),
      );
  if (igual) {
    // Fica. Os outros — o guia que o vídeo substitui, a reserva pela metade de uma rodada que
    // caiu, os dois anexos de antes da regra de um só — saem.
    let apagados = 0;
    const sobras = [];
    for (const outro of existentes.filter((a) => a !== igual)) {
      try {
        await apagarAnexo(asc, outro);
        apagados += 1;
      } catch (erro) {
        sobras.push(`${nomeDoAnexo(outro)} (${erro.message})`);
      }
    }
    return { id: igual.id, mantido: true, apagados, sobras, processando: false };
  }
  if (escolhido.existente) {
    // Sem os bytes, o vídeo que sumiu entre o começo da rodada e agora não tem como voltar daqui.
    throw new Error(`o vídeo ${escolhido.nome}, que estava anexado no começo da rodada, não está mais lá — passe a gravação de novo (--video-revisao)`);
  }

  // A Apple recusaria o novo com outro lá: TODOS saem antes. A revisão fica sem anexo até o
  // escolhido entrar — e, se ele não entrar, a próxima rodada o sobe de novo.
  let apagados = 0;
  for (const antigo of existentes) {
    try {
      await apagarAnexo(asc, antigo);
      apagados += 1;
    } catch (erro) {
      throw new Error(`o anexo ${nomeDoAnexo(antigo)}, que já estava lá, não saiu (${erro.message}) e a Apple aceita um só — ${escolhido.nome} nem subiu`);
    }
  }
  let reserva = null;
  let estado;
  try {
    reserva = (
      await asc.post('/v1/appStoreReviewAttachments', {
        data: {
          type: 'appStoreReviewAttachments',
          attributes: { fileName: escolhido.nome, fileSize: escolhido.dados.length },
          relationships: { appStoreReviewDetail: { data: { type: 'appStoreReviewDetails', id: detalheId } } },
        },
      })
    ).data;
    await asc.subirArquivo(reserva.attributes.uploadOperations, escolhido.dados);
    // A Apple confere o MD5 com os bytes que recebeu: arquivo truncado não passa calado.
    await asc.patch(`/v1/appStoreReviewAttachments/${reserva.id}`, {
      data: { type: 'appStoreReviewAttachments', id: reserva.id, attributes: { uploaded: true, sourceFileChecksum: escolhido.md5 } },
    });
    estado = await esperarProcessamento(asc, reserva.id, esperaMs);
    if (estado.state === 'FAILED') {
      const motivo = (estado.errors ?? []).map((e) => [e.code, e.description].filter(Boolean).join(': ')).join('; ');
      throw new Error(`a Apple recusou ao processar ${escolhido.nome} (${motivo || 'sem motivo'})`);
    }
  } catch (erro) {
    if (reserva) {
      try {
        await apagarAnexo(asc, reserva);
      } catch {
        relatorio?.ok(`a reserva ${reserva.id} pela metade não saiu; a próxima rodada a apaga antes de subir`);
      }
    }
    erro.semAnexo = true;
    erro.apagados = apagados;
    throw erro;
  }
  return { id: reserva.id, mantido: false, apagados, sobras: [], processando: estado.state !== 'COMPLETE' };
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
