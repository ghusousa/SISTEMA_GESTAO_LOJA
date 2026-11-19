/**
 * Classificação etária COMPLETA (AgeRatingDeclaration da API 4.6.1): as respostas de um app
 * de gestão de loja, e o envio que aguenta a Apple mexer no questionário.
 *
 * Toda pergunta da 4.6.1 tem resposta aqui — frequência = NONE, sim/não = false. O teste
 * (teste/rodar.mjs) cruza esta lista com a especificação oficial gerada em
 * teste/esquema-asc.mjs: pergunta nova numa versão nova da API quebra o teste até ganhar
 * resposta. Não são perguntas, e ficam como o dono deixou: a faixa da Kids Category, os
 * ajustes manuais de idade (overrides), o número da GRAC coreana e a página opcional sobre
 * a classificação.
 *
 * Duas mudanças da Apple, dois caminhos:
 *  - a Apple RECUSA um atributo (409/422 que o nomeia — saiu da API, por exemplo): sai só
 *    ele, tenta de novo, e vira AVISO;
 *  - a Apple tem pergunta que a especificação daqui ainda não tem: ela volta em branco
 *    (null) na declaração — vira PENDÊNCIA com os nomes, e o envio para a revisão mostra a
 *    mensagem da Apple se ela exigir. Foi o que houve com as duas de 16/11/2026
 *    (datingAndRelationships e sharedLocation): pararam a revisão até a 4.6.1 publicá-las, e
 *    desde então têm resposta abaixo.
 */

const NENHUM = 'NONE';

/** Pergunta da Apple → resposta. Nada disso existe num app de estoque, venda e caixa. */
export const RESPOSTAS = {
  // Com que frequência aparece? Nunca.
  alcoholTobaccoOrDrugUseOrReferences: NENHUM,
  contests: NENHUM,
  gamblingSimulated: NENHUM,
  gunsOrOtherWeapons: NENHUM,
  horrorOrFearThemes: NENHUM,
  matureOrSuggestiveThemes: NENHUM,
  medicalOrTreatmentInformation: NENHUM,
  profanityOrCrudeHumor: NENHUM,
  sexualContentGraphicAndNudity: NENHUM,
  sexualContentOrNudity: NENHUM,
  violenceCartoonOrFantasy: NENHUM,
  violenceRealistic: NENHUM,
  violenceRealisticProlongedGraphicOrSadistic: NENHUM,
  // Sim ou não? Não.
  advertising: false, // sem anúncio, sem SDK de publicidade
  ageAssurance: false, // não verifica a idade de ninguém
  datingAndRelationships: false, // sem namoro nem relacionamento: é estoque, venda e caixa
  gambling: false, // sem aposta
  healthOrWellnessTopics: false, // não trata de saúde
  lootBox: false, // sem caixa de recompensa paga
  messagingAndChat: false, // sem conversa entre usuários
  parentalControls: false, // sem controle parental
  sharedLocation: false, // não pede nem compartilha a localização de ninguém (sem GPS)
  socialMedia: false, // não é rede social
  socialMediaAgeRestricted: false,
  unrestrictedWebAccess: false, // sem navegador nem WebView: só a API da loja
  userGeneratedContent: false, // foto e texto ficam com a equipe de UMA loja, sem nada público
};

/** Atributos da declaração que não são perguntas — o publicador não toca. */
export const NAO_SAO_PERGUNTAS = [
  'kidsAgeBand',
  'ageRatingOverride',
  'ageRatingOverrideV2',
  'koreaAgeRatingOverride',
  'gracRatingClassificationNumber',
  'developerAgeRatingInfoUrl',
];

/** Os atributos que um erro da Apple nomeia — pelo ponteiro ou pelo nome no texto. */
export function atributosNomeados(erro, candidatos) {
  const nomes = new Set();
  for (const e of erro?.corpo?.errors ?? []) {
    const ponteiro = /^\/data\/attributes\/([A-Za-z0-9_]+)$/.exec(e?.source?.pointer ?? '');
    if (ponteiro && candidatos.includes(ponteiro[1])) nomes.add(ponteiro[1]);
    const texto = `${e?.title ?? ''} ${e?.detail ?? ''}`;
    for (const c of candidatos) {
      // Palavra inteira: "gambling" não pode casar dentro de "gamblingSimulated".
      if (new RegExp(`(^|[^A-Za-z0-9_])${c}([^A-Za-z0-9_]|$)`).test(texto)) nomes.add(c);
    }
  }
  return [...nomes];
}

/** Perguntas que a declaração devolveu em branco (as novas da Apple caem aqui). */
export function perguntasEmBranco(atributos) {
  return Object.entries(atributos ?? {})
    .filter(([nome, valor]) => valor === null && !NAO_SAO_PERGUNTAS.includes(nome))
    .map(([nome]) => nome);
}

/**
 * Responde a declaração do appInfo. Devolve { enviadas, recusadas, emBranco }; erro que
 * não nomeia atributo sobe para quem chamou (que o transforma em pendência).
 */
export async function responderClassificacao(asc, appInfoId) {
  const declaracao = (await asc.get(`/v1/appInfos/${appInfoId}/ageRatingDeclaration`)).data;
  const atributos = { ...RESPOSTAS };
  const recusadas = [];
  for (;;) {
    try {
      const resposta = await asc.patch(`/v1/ageRatingDeclarations/${declaracao.id}`, {
        data: { type: 'ageRatingDeclarations', id: declaracao.id, attributes: atributos },
      });
      const final = resposta?.data?.attributes ?? { ...declaracao.attributes, ...atributos };
      return { enviadas: Object.keys(atributos), recusadas, emBranco: perguntasEmBranco(final) };
    } catch (erro) {
      const nomes = [409, 422].includes(erro.status) ? atributosNomeados(erro, Object.keys(atributos)) : [];
      if (!nomes.length) throw erro;
      for (const nome of nomes) delete atributos[nome];
      recusadas.push(...nomes);
      if (!Object.keys(atributos).length) throw erro;
    }
  }
}
