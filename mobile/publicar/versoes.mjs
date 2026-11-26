/**
 * Em que pé está a versão do app.json na Apple — a MESMA regra para o publicador
 * (publicar.mjs, antes de mexer em qualquer coisa) e para o preparo do Actions (ci.mjs, antes
 * de gastar 20 a 40 min compilando um build que não teria para onde ir).
 */

// Estados de versão (o nome novo, appVersionState, e o antigo, appStoreState).
export const EDITAVEIS = new Set(['PREPARE_FOR_SUBMISSION', 'DEVELOPER_REJECTED', 'REJECTED', 'METADATA_REJECTED', 'INVALID_BINARY']);
export const JA_ESTEVE_A_VENDA = new Set([
  'READY_FOR_SALE',
  'READY_FOR_DISTRIBUTION',
  'REPLACED_WITH_NEW_VERSION',
  'DEVELOPER_REMOVED_FROM_SALE',
  'REMOVED_FROM_SALE',
]);
export const estadoDaVersao = (v) => v.attributes?.appVersionState ?? v.attributes?.appStoreState;

/**
 * Lê as versões iOS do app e diz: a versão editável (ou null), se o app já esteve à venda, e
 * a versão TRAVADA — a do mesmo número do app.json que já passou da edição (em revisão,
 * aprovada, à venda). Só leitura.
 */
export async function situacaoDaVersao(asc, appId, versaoDoApp) {
  const versoes = (await asc.get(`/v1/apps/${appId}/appStoreVersions?filter[platform]=IOS&limit=50`)).data;
  const editavel = versoes.find((v) => EDITAVEIS.has(estadoDaVersao(v))) ?? null;
  const jaLancado = versoes.some((v) => v !== editavel && JA_ESTEVE_A_VENDA.has(estadoDaVersao(v)));
  const travada =
    versoes.find(
      (v) => v !== editavel && v.attributes?.versionString === versaoDoApp && !EDITAVEIS.has(estadoDaVersao(v)),
    ) ?? null;
  return { editavel, jaLancado, travada };
}

/**
 * O que foi junto com a versão TRAVADA (em revisão, aprovada, à venda): o número do build preso
 * a ela, o build VALID mais novo da mesma versão e se as notas da revisão que estão na Apple
 * começam como as deste commit. Serve a quem enviou pelo site: diz, sem abrir o App Store
 * Connect, se foram o build e as notas certos. Só leitura, e o texto das notas nunca sai daqui
 * (elas levam a senha da conta de demonstração): só o "igual" ou "diferente" da 1ª linha.
 */
export async function oQueFoiComATravada(asc, appId, travada, primeiraLinhaDasNotas) {
  const ler = async (caminho) => {
    try {
      return (await asc.get(caminho))?.data ?? null;
    } catch (erro) {
      if (erro.status === 404) return null;
      throw erro;
    }
  };
  const preso = await ler(`/v1/appStoreVersions/${travada.id}/build`);
  // O VALID mais novo filtrado na PRÓPRIA consulta: cortar a página antes de filtrar deixaria
  // de fora um build VALID mais antigo que os envios em processamento ou com falha.
  const validos =
    (await ler(
      `/v1/builds?filter[app]=${appId}&filter[preReleaseVersion.version]=${encodeURIComponent(travada.attributes.versionString)}` +
        '&filter[preReleaseVersion.platform]=IOS&filter[processingState]=VALID&filter[expired]=false&sort=-uploadedDate&limit=1',
    )) ?? [];
  const maisNovo = validos[0] ?? null;
  const detalhe = await ler(`/v1/appStoreVersions/${travada.id}/appStoreReviewDetail`);
  const notas = detalhe?.attributes?.notes ?? null;
  return {
    build: preso?.attributes?.version ?? null,
    maisNovo: maisNovo?.attributes?.version ?? null,
    // null: a Apple não tem notas; true/false: a 1ª linha bate (ou não) com a do repositório.
    notasDesteCommit: notas === null ? null : notas.trim().split('\n')[0].trim() === primeiraLinhaDasNotas.trim(),
  };
}

/** As linhas do log com o que foi junto com a versão travada (veja oQueFoiComATravada). */
export function frasesDaTravada(versaoDoApp, { build, maisNovo, notasDesteCommit }) {
  const frases = [];
  const buildAntigo = Boolean(build && maisNovo && build !== maisNovo);
  if (!build) frases.push(`⚠ Nenhum build preso à versão ${versaoDoApp} na Apple.`);
  else if (buildAntigo) frases.push(`⚠ Build na revisão: ${build} — mas o mais novo da versão ${versaoDoApp} é o ${maisNovo}.`);
  else if (maisNovo) frases.push(`ℹ Build na revisão: ${build} (o mais novo da versão ${versaoDoApp}).`);
  else frases.push(`ℹ Build na revisão: ${build} (a Apple não listou build VALID da versão ${versaoDoApp} para comparar).`);
  if (notasDesteCommit === null) frases.push('⚠ Notas da revisão na Apple: nenhuma.');
  else if (notasDesteCommit) frases.push('ℹ Notas da revisão na Apple: as deste commit (a 1ª linha bate).');
  else frases.push('⚠ Notas da revisão na Apple: DIFERENTES das deste commit (de uma rodada antiga, ou editadas no site).');
  if (buildAntigo || notasDesteCommit === false) {
    frases.push(
      '⚠ Para trocar o que está na revisão: no App Store Connect, "Remover da revisão" na versão; depois rode de novo ' +
        'com "ficha" e "revisao" (o publicador prende o build mais novo e sobe as notas deste commit).',
    );
  }
  return frases;
}

/** A frase de quando a versão do app.json já não aceita build nem edição. */
export function mensagemDaTravada(versaoDoApp, travada) {
  return (
    `A versão ${versaoDoApp} já existe na Apple no estado ${estadoDaVersao(travada)} (já enviada ou publicada). ` +
    'Se está na revisão, espere a resposta da Apple (chega por e-mail); para publicar outra, suba "version" ' +
    'no mobile/app.json (ex.: 1.0.1) e rode de novo.'
  );
}
