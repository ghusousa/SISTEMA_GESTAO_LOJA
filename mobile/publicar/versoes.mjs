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

/** A frase de quando a versão do app.json já não aceita build nem edição. */
export function mensagemDaTravada(versaoDoApp, travada) {
  return (
    `A versão ${versaoDoApp} já existe na Apple no estado ${estadoDaVersao(travada)} (já enviada ou publicada). ` +
    'Se está na revisão, espere a resposta da Apple (chega por e-mail); para publicar outra, suba "version" ' +
    'no mobile/app.json (ex.: 1.0.1) e rode de novo.'
  );
}
