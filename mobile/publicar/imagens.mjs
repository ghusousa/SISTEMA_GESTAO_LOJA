/**
 * As capturas de tela: ler e conferir os PNG do disco, e subir cada conjunto para a Apple.
 *
 * Dois conjuntos (o contrato com o gerador em publicar/capturas/):
 *   media/app-store/iphone-6.5/NN-nome.png → APP_IPHONE_65, OBRIGATÓRIO (sem ele não há envio)
 *   media/app-store/iphone-6.9/NN-nome.png → APP_IPHONE_67 (o slot de 6,7"/6,9"), EXTRA
 * Em ago/2026 o formulário da Apple só aceitou 6,5" — por isso ele é o obrigatório. O de
 * 6,9" deixa a vitrine nítida nos iPhones grandes; se faltar ou falhar, a App Store mostra
 * o de 6,5" neles também, e a publicação segue com um aviso.
 *
 * Conferido aqui, antes de gastar uma chamada: assinatura PNG, tamanho exato do slot, PNG
 * RGB SEM canal alfa (tipo de cor 2 — a Apple recusa transparência), nome NN-nome.png e no
 * máximo 10 por conjunto. Subir = reservar → PUT dos bytes → confirmar com o MD5 (a Apple
 * compara com o que recebeu) → gravar a ordem → esperar a Apple processar.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const deitado = (tamanhos) => tamanhos.flatMap(([l, a]) => [[l, a], [a, l]]);

export const CONJUNTOS = [
  {
    pasta: 'iphone-6.5',
    tipo: 'APP_IPHONE_65',
    rotulo: 'iPhone 6,5"',
    obrigatorio: true,
    tamanhos: deitado([
      [1242, 2688],
      [1284, 2778],
    ]),
  },
  {
    pasta: 'iphone-6.9',
    tipo: 'APP_IPHONE_67',
    rotulo: 'iPhone 6,9"',
    obrigatorio: false,
    tamanhos: deitado([
      [1320, 2868],
      [1290, 2796],
      [1260, 2736],
    ]),
  },
];

export const MAXIMO_POR_CONJUNTO = 10; // limite da Apple por tamanho de tela
const ASSINATURA_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const NOME_NO_PADRAO = /^\d{2}-[A-Za-z0-9_-]+\.png$/;
const TIPOS_DE_COR = { 0: 'tons de cinza', 2: 'RGB', 3: 'paleta', 4: 'cinza COM alfa', 6: 'RGBA (com alfa)' };

/** Cabeçalho do PNG (IHDR). Lança Error com o motivo se não for um PNG. */
export function lerCabecalhoPng(dados) {
  if (dados.length < 33 || !dados.subarray(0, 8).equals(ASSINATURA_PNG)) throw new Error('não é um PNG');
  if (dados.toString('latin1', 12, 16) !== 'IHDR') throw new Error('PNG sem cabeçalho IHDR');
  return {
    largura: dados.readUInt32BE(16),
    altura: dados.readUInt32BE(20),
    profundidade: dados[24],
    tipoDeCor: dados[25],
  };
}

/**
 * Lê um conjunto do disco. Devolve { arquivos, problemas, ausente }: quem chama decide se
 * problema é erro (6,5") ou aviso (6,9").
 */
export function lerConjunto(base, conjunto) {
  const pasta = join(base, conjunto.pasta);
  if (!existsSync(pasta)) return { arquivos: [], problemas: [`não achei a pasta ${pasta}`], ausente: true };
  const nomes = readdirSync(pasta)
    .filter((a) => a.toLowerCase().endsWith('.png'))
    .sort(); // NN- na frente: a ordem do nome é a ordem da vitrine
  const problemas = [];
  if (!nomes.length) problemas.push(`a pasta ${pasta} não tem nenhum .png`);
  if (nomes.length > MAXIMO_POR_CONJUNTO) {
    problemas.push(`${nomes.length} imagens em ${conjunto.pasta}; a Apple aceita no máximo ${MAXIMO_POR_CONJUNTO}`);
  }
  const aceitos = conjunto.tamanhos.map((t) => t.join('×')).join(', ');
  const arquivos = [];
  for (const nome of nomes) {
    if (!NOME_NO_PADRAO.test(nome)) problemas.push(`${conjunto.pasta}/${nome}: o nome tem de ser NN-nome.png (ex.: 01-pdv.png)`);
    const dados = readFileSync(join(pasta, nome));
    let png;
    try {
      png = lerCabecalhoPng(dados);
    } catch (erro) {
      problemas.push(`${conjunto.pasta}/${nome}: ${erro.message}`);
      continue;
    }
    if (!conjunto.tamanhos.some(([l, a]) => l === png.largura && a === png.altura)) {
      problemas.push(`${conjunto.pasta}/${nome} tem ${png.largura}×${png.altura}; o ${conjunto.rotulo} aceita ${aceitos}`);
    }
    if (png.tipoDeCor !== 2) {
      const tipo = TIPOS_DE_COR[png.tipoDeCor] ?? `tipo de cor ${png.tipoDeCor}`;
      problemas.push(
        png.tipoDeCor === 4 || png.tipoDeCor === 6
          ? `${conjunto.pasta}/${nome} é PNG ${tipo}: a Apple recusa canal alfa — gere em RGB sem alfa (tipo de cor 2)`
          : `${conjunto.pasta}/${nome} é PNG ${tipo}; o combinado é RGB sem alfa (tipo de cor 2) — gere de novo`,
      );
    }
    arquivos.push({ nome, dados, md5: createHash('md5').update(dados).digest('hex') });
  }
  return { arquivos, problemas, ausente: false };
}

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Sobe UM conjunto na localização da versão. O reenvio substitui: apaga as capturas que já
 * estavam no conjunto (não cabem 20 num slot de 10) e sobe as da pasta, na ordem da pasta.
 * Devolve { conjuntoId, ids, falhas, processando }.
 */
export async function subirConjunto(asc, { localizacaoId, conjuntoExistente, conjunto, arquivos, esperaMs, relatorio }) {
  let conjuntoId = conjuntoExistente?.id;
  if (!conjuntoId) {
    conjuntoId = (
      await asc.post('/v1/appScreenshotSets', {
        data: {
          type: 'appScreenshotSets',
          attributes: { screenshotDisplayType: conjunto.tipo },
          relationships: {
            appStoreVersionLocalization: { data: { type: 'appStoreVersionLocalizations', id: localizacaoId } },
          },
        },
      })
    ).data.id;
  }
  try {
    return await preencher(asc, conjuntoId, { conjunto, arquivos, esperaMs, relatorio });
  } catch (erro) {
    // Quem chama precisa do id para desfazer um conjunto que ficou pela metade.
    erro.conjuntoId = conjuntoId;
    throw erro;
  }
}

async function preencher(asc, conjuntoId, { conjunto, arquivos, esperaMs, relatorio }) {
  const resultado = { conjuntoId, ids: [], falhas: [], processando: [] };

  const antigas = await asc.get(`/v1/appScreenshotSets/${conjuntoId}/appScreenshots?limit=50`);
  for (const antiga of antigas.data) await asc.del(`/v1/appScreenshots/${antiga.id}`);
  if (antigas.data.length) relatorio.ok(`${antigas.data.length} captura(s) antiga(s) apagada(s)`);

  const nomePorId = {};
  for (const arquivo of arquivos) {
    const reserva = (
      await asc.post('/v1/appScreenshots', {
        data: {
          type: 'appScreenshots',
          attributes: { fileName: arquivo.nome, fileSize: arquivo.dados.length },
          relationships: { appScreenshotSet: { data: { type: 'appScreenshotSets', id: conjuntoId } } },
        },
      })
    ).data;
    await asc.subirArquivo(reserva.attributes.uploadOperations, arquivo.dados);
    // A Apple confere o MD5 com os bytes que recebeu: arquivo truncado não passa calado.
    await asc.patch(`/v1/appScreenshots/${reserva.id}`, {
      data: {
        type: 'appScreenshots',
        id: reserva.id,
        attributes: { uploaded: true, sourceFileChecksum: arquivo.md5 },
      },
    });
    resultado.ids.push(reserva.id);
    nomePorId[reserva.id] = arquivo.nome;
    relatorio.ok(`${conjunto.rotulo} ${arquivo.nome}`);
  }
  await asc.patch(`/v1/appScreenshotSets/${conjuntoId}/relationships/appScreenshots`, {
    data: resultado.ids.map((id) => ({ type: 'appScreenshots', id })),
  });

  // A Apple processa cada imagem depois do upload (UPLOAD_COMPLETE → COMPLETE ou FAILED).
  // Esperar aqui é o que separa "subiu" de "a Apple aceitou" — e evita mandar para a
  // revisão com captura ainda processando.
  const TENTATIVAS = 60;
  let estados = {};
  for (let i = 0; i < TENTATIVAS; i++) {
    const lista = await asc.get(`/v1/appScreenshotSets/${conjuntoId}/appScreenshots?limit=50`);
    estados = Object.fromEntries(lista.data.map((c) => [c.id, c.attributes?.assetDeliveryState ?? {}]));
    const pendentes = resultado.ids.filter((id) => !['COMPLETE', 'FAILED'].includes(estados[id]?.state));
    if (!pendentes.length) break;
    if (i < TENTATIVAS - 1) await dormir(esperaMs);
  }
  for (const id of resultado.ids) {
    const estado = estados[id] ?? {};
    if (estado.state === 'FAILED') {
      const motivo = (estado.errors ?? []).map((e) => [e.code, e.description].filter(Boolean).join(': ')).join('; ');
      resultado.falhas.push(`${nomePorId[id]} (${motivo || 'a Apple não disse o motivo'})`);
    } else if (estado.state !== 'COMPLETE') {
      resultado.processando.push(nomePorId[id]);
    }
  }
  return resultado;
}
