/**
 * Uma App Store Connect de mentira, na memória, para testar o publicador de ponta a ponta
 * sem tocar na conta de verdade. Ela COBRA como a de verdade:
 *
 *  - toda rota tem de existir na especificação oficial (esquema-asc.mjs, gerado da 4.6.1);
 *  - todo parâmetro de consulta e todo corpo é conferido contra o esquema: atributo
 *    desconhecido, tipo errado, valor fora da lista ou campo obrigatório faltando voltam
 *    400/409 no formato de erro da Apple, e ficam anotados em `estado.recusas`;
 *  - captura e anexo da revisão só viram COMPLETE se os bytes chegaram inteiros e o MD5
 *    confere (e a captura tem o tamanho do slot, sem alfa);
 *  - UM anexo por detalhe de revisão: o POST de outro com um já lá volta 409 STATE_ERROR,
 *    com a frase da Apple (a rodada nº 8 de verdade parou nele);
 *  - o envio para revisão só passa com a ficha completa (classificação etária inteira,
 *    direitos de conteúdo, disponibilidade, TODAS as localizações preenchidas, capturas de
 *    6,5" processadas, conta demo, preço, build preso, "Novidades" quando é atualização) —
 *    senão, 409 com `associatedErrors`;
 *  - um envio ATIVO por plataforma (READY_FOR_REVIEW, WAITING_FOR_REVIEW, IN_REVIEW ou
 *    UNRESOLVED_ISSUES): o segundo POST volta 409. O devolvido (UNRESOLVED_ISSUES) é reenviado
 *    com PATCH submitted, depois de o item recusado ser marcado como resolvido;
 *  - a localização do idioma principal não pode ser apagada.
 *
 * `opcoes` liga os cenários (app criado no site em inglês, build antigo da mesma versão,
 * preço pago na frente, upload de 6,9" que cai...). Tudo o que recebeu fica em `estado`
 * (também em GET /_estado); `rejeitar()`, `novoBuild()`, `anexosNaRevisao()` e
 * `consertarUploadDoAnexo()` fazem o papel da Apple entre rodadas.
 */

import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { CORPOS, INCLUIDOS, ROTAS } from './esquema-asc.mjs';

/** Atributos da declaração de idade que a Apple NÃO cobra (não são perguntas). */
const OPCIONAIS_DA_DECLARACAO = new Set([
  'kidsAgeBand',
  'ageRatingOverride',
  'ageRatingOverrideV2',
  'koreaAgeRatingOverride',
  'gracRatingClassificationNumber',
  'developerAgeRatingInfoUrl',
]);
const deitado = (lista) => lista.flatMap(([l, a]) => [`${l}x${a}`, `${a}x${l}`]);
const TAMANHOS_DO_SLOT = {
  APP_IPHONE_65: deitado([[1242, 2688], [1284, 2778]]),
  APP_IPHONE_67: deitado([[1320, 2868], [1290, 2796], [1260, 2736]]),
};
const PARTE_DO_UPLOAD = 16 * 1024; // a Apple divide o arquivo em partes; pequeno aqui para o teste exercitar isso
const TERRITORIOS = new Set(['BRA', 'USA', 'PRT']);
const ID_LOCAL = /^\$\{[^}]+\}$/;
const JA_ESTEVE_A_VENDA = new Set(['READY_FOR_SALE', 'REPLACED_WITH_NEW_VERSION']);
const EDITAVEIS = ['PREPARE_FOR_SUBMISSION', 'REJECTED', 'DEVELOPER_REJECTED', 'METADATA_REJECTED'];
// Envio que ainda não terminou: só pode haver UM por plataforma.
const ENVIO_ATIVO = new Set(['READY_FOR_REVIEW', 'WAITING_FOR_REVIEW', 'IN_REVIEW', 'UNRESOLVED_ISSUES']);
const PRECOS_POR_PAGINA = 3; // a Apple pagina os pontos de preço; pouco aqui para o teste seguir links.next

const PADRAO = {
  appExiste: true,
  // O app como o SITE o cria: idioma principal escolhido no formulário, a versão "1.0" em
  // preparo com a localização desse idioma VAZIA e o appInfo com só o nome. null = nada disso
  // (o registro sem versão, como os cenários antigos).
  criadoNoSite: null,
  jaLancado: false, // existe a 0.9.0 à venda — e o appInfo dela, que não é mais editável
  // A versão do app.json já passou da edição, neste estado (ex.: 'WAITING_FOR_REVIEW',
  // 'READY_FOR_SALE'): não aceita build nem ficha. null = não existe.
  versaoTravada: null,
  versaoDoAppJson: '1.0.0',
  // A conta já tem disponibilidade definida: false, true (só Brasil) ou a lista dos territórios
  // à venda (ex.: ['BRA', 'USA', 'PRT'], feita no site com "todos os países").
  disponibilidade: false,
  disponibilidadeEmNovos: false, // availableInNewTerritories da que já existe
  semDisponibilidade: 404, // quando não tem: 404 ou 'nulo' (200 com data: null)
  idadeDesconhece: [], // atributos que esta Apple recusa como desconhecidos
  descritoresNovos: [], // perguntas novas (fora da especificação) que ela cobra no envio
  falharUploadDoTipo: null, // ex.: 'APP_IPHONE_67' → o PUT dos bytes devolve 500
  falharUploadDoAnexo: null, // nome do anexo da revisão cujo PUT devolve 500 (até consertarUploadDoAnexo())
  buildValidoNaConsulta: 1, // em que consulta a /v1/builds o build da versão fica VALID
  buildNunca: false, // fica em PROCESSING para sempre
  versaoDoBuild: '1.0.0',
  buildAntigo: false, // já existe um build VALID da MESMA versão, de uma rodada anterior (o nº 6)
  revisaoEcoaSenha: false, // o POST do detalhe de revisão devolve 409 citando a senha
  // Pontos de preço do território-base: 'gratis-primeiro' (o comum), 'pago-primeiro',
  // 'gratis-na-2a-pagina', 'sem-gratis' ou 'vazio'.
  precos: 'gratis-primeiro',
  itemNaoAceitaResolved: false, // esta Apple recusa o PATCH resolved (e reenvia sem ele)
  aparelhos: [], // aparelhos já registrados na conta (GET /v1/devices)
  // O App ID do app no portal (Certificates, Identifiers & Profiles): as capacidades já ligadas
  // (ex.: ['PUSH_NOTIFICATIONS']), ou null = ainda não registrado (o app nunca compilou). Mora
  // sempre ao lado de outro de prefixo parecido (a extensão, com push ligado): o
  // filter[identifier] da Apple casa pelo começo do identificador.
  capacidadesDoAppId: [],
  recusarCapacidade: false, // chave sem permissão no portal: o POST da capacidade volta 403
};

// ---------------------------------------------------------------- validação do esquema

function conferirValor(d, v) {
  if (v === null) return d.nulo ? null : 'não aceita null';
  const tipos = { string: 'string', boolean: 'boolean', number: 'number', integer: 'number', object: 'object' };
  if (d.t === 'array') return Array.isArray(v) ? null : 'tem de ser lista';
  if (typeof v !== tipos[d.t]) return `tem de ser ${d.t}`;
  if (d.t === 'integer' && !Number.isInteger(v)) return 'tem de ser inteiro';
  if (d.enum && !d.enum.includes(v)) return `"${v}" não é um dos valores aceitos (${d.enum.join(', ')})`;
  if (d.formato === 'uri' && !/^[a-z]+:\/\/\S+$/i.test(v)) return 'tem de ser uma URL';
  if (d.formato === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(v)) return 'tem de ser AAAA-MM-DD';
  return null;
}

function validarRecurso(e, dado, base, erros) {
  const erro = (code, detail, pointer) => erros.push(erroDoCorpo(detail, pointer, code));
  if (!dado || typeof dado !== 'object' || Array.isArray(dado)) return erro('ENTITY_ERROR', 'falta o objeto', base);
  if (dado.type !== e.tipo) erro('ENTITY_ERROR.TYPE.INVALID', `type tem de ser "${e.tipo}"`, `${base}/type`);
  if (e.id === 'obrigatorio' && typeof dado.id !== 'string') erro('ENTITY_ERROR.ID.REQUIRED', 'falta o id', `${base}/id`);
  if (e.id === 'proibido' && dado.id !== undefined) erro('ENTITY_ERROR.ID.INVALID', 'criação não leva id', `${base}/id`);
  const attrs = dado.attributes;
  if (e.atributosObrigatorioNoCorpo && attrs === undefined) erro('ENTITY_ERROR.ATTRIBUTE.REQUIRED', 'falta attributes', `${base}/attributes`);
  for (const [nome, valor] of Object.entries(attrs ?? {})) {
    const d = e.atributos[nome];
    if (!d) {
      erro('ENTITY_ERROR.ATTRIBUTE.UNKNOWN', `'${nome}' is not a valid attribute for '${e.tipo}'`, `${base}/attributes/${nome}`);
      continue;
    }
    const motivo = conferirValor(d, valor);
    if (motivo) erro('ENTITY_ERROR.ATTRIBUTE.INVALID', `'${nome}': ${motivo}`, `${base}/attributes/${nome}`);
  }
  for (const nome of e.atributosObrigatorios) {
    if (attrs?.[nome] === undefined) erro('ENTITY_ERROR.ATTRIBUTE.REQUIRED', `'${nome}' é obrigatório`, `${base}/attributes/${nome}`);
  }
  const rels = dado.relationships ?? {};
  for (const [nome, valor] of Object.entries(rels)) {
    const r = e.relacoes[nome];
    if (!r) {
      erro('ENTITY_ERROR.RELATIONSHIP.UNKNOWN', `'${nome}' não é relação de '${e.tipo}'`, `${base}/relationships/${nome}`);
      continue;
    }
    const itens = r.lista ? valor?.data : [valor?.data];
    if (!Array.isArray(itens)) {
      erro('ENTITY_ERROR.RELATIONSHIP.INVALID', 'tem de ser lista', `${base}/relationships/${nome}`);
      continue;
    }
    for (const item of itens) {
      if (item?.type !== r.tipo || typeof item?.id !== 'string') {
        erro('ENTITY_ERROR.RELATIONSHIP.INVALID', `esperado {type:"${r.tipo}", id}`, `${base}/relationships/${nome}`);
      }
    }
  }
  for (const nome of e.relacoesObrigatorias) {
    if (!rels[nome]) erro('ENTITY_ERROR.RELATIONSHIP.REQUIRED', `falta a relação '${nome}'`, `${base}/relationships/${nome}`);
  }
}

/** Um erro de corpo no formato da Apple (409, com o ponteiro do campo). */
const erroDoCorpo = (detail, pointer, code = 'ENTITY_ERROR') => ({
  status: '409',
  code,
  title: 'The provided entity is invalid',
  detail,
  source: { pointer },
});

/** Erros do corpo contra o esquema da rota, no formato da Apple ([] = conforme). */
export function validarCorpo(nomeDoEsquema, corpo) {
  const e = CORPOS[nomeDoEsquema];
  if (!corpo || typeof corpo !== 'object') return [erroDoCorpo('sem JSON', '')];
  const erros = [];
  if (e.lista) {
    if (!Array.isArray(corpo.data)) return [erroDoCorpo('data tem de ser lista', '/data')];
    corpo.data.forEach((d, i) => {
      if (d?.type !== e.tipo || typeof d?.id !== 'string') erros.push(erroDoCorpo(`esperado {type:"${e.tipo}", id}`, `/data/${i}`));
    });
    return erros;
  }
  validarRecurso(e, corpo.data, '/data', erros);
  if (corpo.included === undefined) return erros;
  const INVALIDO = 'ENTITY_ERROR.INCLUDED.INVALID';
  if (!e.incluidos || !Array.isArray(corpo.included)) return [...erros, erroDoCorpo('included não cabe aqui', '/included', INVALIDO)];
  corpo.included.forEach((item, i) => {
    const nome = e.incluidos.find((n) => INCLUIDOS[n].tipo === item?.type);
    if (!nome) {
      erros.push(erroDoCorpo(`tipo ${item?.type} não cabe em included`, `/included/${i}`, INVALIDO));
      return;
    }
    validarRecurso({ ...INCLUIDOS[nome], id: 'obrigatorio' }, item, `/included/${i}`, erros);
    // Criação em linha: o item ganha um id LOCAL, ${...}, que o relacionamento cita.
    if (!ID_LOCAL.test(item.id ?? '')) erros.push(erroDoCorpo('id local tem de ser ${...}', `/included/${i}/id`, INVALIDO));
  });
  return erros;
}

function validarConsulta(rota, url) {
  const aceitos = ROTAS[rota].parametros ?? {};
  const erros = [];
  const erro = (code, detail, parameter) =>
    erros.push({ status: '400', code, title: 'A parameter has an invalid value', detail, source: { parameter } });
  for (const [nome, valor] of url.searchParams) {
    // "cursor" é o parâmetro das páginas seguintes (o links.next da própria Apple); a
    // especificação não o lista em rota nenhuma, mas toda listagem paginada o aceita.
    if (nome === 'cursor' && rota.startsWith('GET ') && aceitos.limit) continue;
    const d = aceitos[nome];
    if (!d) {
      erro('PARAMETER_ERROR.ILLEGAL', `'${nome}' não é parâmetro de ${rota}`, nome);
      continue;
    }
    if (d.enum) for (const v of valor.split(',')) if (!d.enum.includes(v)) erro('PARAMETER_ERROR.INVALID', `'${v}' fora da lista de ${nome}`, nome);
    if (d.maximo !== undefined && Number(valor) > d.maximo) erro('PARAMETER_ERROR.INVALID', `${nome} vai até ${d.maximo}`, nome);
  }
  for (const [nome, d] of Object.entries(aceitos)) {
    if (d.obrigatorio && !url.searchParams.has(nome)) erro('PARAMETER_ERROR.REQUIRED', `falta ${nome}`, nome);
  }
  return erros;
}

const ROTAS_COMPILADAS = Object.keys(ROTAS).map((rota) => {
  const [metodo, caminho] = rota.split(' ');
  return { rota, metodo, re: new RegExp(`^${caminho.replace(/\{id\}/g, '([^/]+)')}$`) };
});

function lerPng(dados) {
  if (dados.length < 33 || dados.readUInt32BE(0) !== 0x89504e47) return null;
  return { tamanho: `${dados.readUInt32BE(16)}x${dados.readUInt32BE(20)}`, tipoDeCor: dados[25] };
}

/** Os pontos de preço do território, do jeito que cada cenário pede. */
function pontosDePreco(modo, territorio) {
  const ponto = (preco, n) => ({ type: 'appPricePoints', id: `PP-${territorio}-${n}`, attributes: { customerPrice: preco, proceeds: preco } });
  const pagos = ['0.99', '1.99', '2.99', '3.99', '4.99'].map((p) => ponto(p, p.replace('.', '')));
  const gratis = ponto('0.0', 0);
  if (modo === 'vazio') return [];
  if (modo === 'sem-gratis') return pagos;
  if (modo === 'pago-primeiro') return [pagos[0], gratis, ...pagos.slice(1)];
  if (modo === 'gratis-na-2a-pagina') return [...pagos.slice(0, PRECOS_POR_PAGINA), gratis, ...pagos.slice(PRECOS_POR_PAGINA)];
  return [gratis, ...pagos];
}

// ---------------------------------------------------------------- o servidor

export function subirMock(opcoesDoTeste = {}) {
  const o = { ...PADRAO, ...opcoesDoTeste };
  let sequencia = 0;
  const novoId = (prefixo) => `${prefixo}${++sequencia}`;
  const perguntas = Object.keys(CORPOS.AgeRatingDeclarationUpdateRequest.atributos);
  const declaracaoVazia = () => Object.fromEntries([...perguntas, ...o.descritoresNovos].map((n) => [n, null]));
  const idiomaDoSite = o.criadoNoSite;

  const estado = {
    app: {
      name: 'Gestão de Loja',
      bundleId: 'com.gestaoloja.app',
      sku: 'gestao-loja',
      primaryLocale: idiomaDoSite ?? 'en-US',
      contentRightsDeclaration: null,
    },
    infos: o.jaLancado
      ? [{ id: 'INFO0', state: 'READY_FOR_DISTRIBUTION' }]
      : [{ id: 'INFO1', state: 'PREPARE_FOR_SUBMISSION' }],
    infoLocs: {}, // locId -> {info, atributos (com locale)}
    infoLocsApagadas: [],
    categorias: {}, // infoId -> {principal, secundaria}
    idade: {}, // infoId -> atributos da declaração
    idadeRecebida: [], // cada PATCH, como chegou
    disponibilidade: o.disponibilidade
      ? {
          availableInNewTerritories: o.disponibilidadeEmNovos,
          territorios: Array.isArray(o.disponibilidade) ? [...o.disponibilidade] : ['BRA'],
          criadaPeloTeste: true,
        }
      : null,
    disponibilidadeCriada: null,
    versoes: o.jaLancado
      ? [{ id: 'VER0', platform: 'IOS', versionString: '0.9.0', appStoreState: 'READY_FOR_SALE', appVersionState: 'READY_FOR_DISTRIBUTION' }]
      : [],
    versaoLocs: {}, // id -> {versao, atributos}
    versaoLocsApagadas: [],
    conjuntos: {}, // id -> {loc, tipo, ordem}
    capturas: {}, // id -> {conjunto, nome, esperado, partes, bytes, md5, checksum, estado, erros}
    capturasApagadas: [],
    conjuntosApagados: [],
    revisoes: {}, // versaoId -> {id, atributos}
    anexos: {}, // id -> {detalhe, nome, esperado, partes, totalDePartes, bytes, md5, checksum, estado, erros}
    anexosApagados: [],
    preco: null,
    consultasDeBuild: 0,
    buildPreso: {}, // versaoId -> buildId
    envios: [], // {id, estado, platform, itens: [{id, versao, estado, resolvido}], tentativas}
    aparelhos: o.aparelhos.map((a, i) => ({ id: `DEV${i + 1}`, platform: 'IOS', status: 'ENABLED', ...a })),
    // App IDs do portal: {id, identifier, name, capacidades: [{id, tipo}]}.
    bundles: [
      ...(o.capacidadesDoAppId === null
        ? []
        : [{ id: 'BID1', identifier: 'com.gestaoloja.app', name: 'Gestao de Loja', capacidades: o.capacidadesDoAppId.map((tipo) => ({ id: `BID1_${tipo}`, tipo })) }]),
      { id: 'BID2', identifier: 'com.gestaoloja.app.widget', name: 'Extensao', capacidades: [{ id: 'BID2_PUSH_NOTIFICATIONS', tipo: 'PUSH_NOTIFICATIONS' }] },
    ],
    recusas: [], // {rota, status, erros, simulada}
    requisicoes: [],
  };
  for (const info of estado.infos) estado.idade[info.id] = declaracaoVazia();

  // Os builds: {id, versao, numero, uploadedDate, aparece, valido, nunca} — "aparece" e
  // "valido" são números de consulta a /v1/builds (o build some antes de "aparece").
  const listaDeBuilds = [];
  if (o.jaLancado) listaDeBuilds.push({ id: 'B0', versao: '0.9.0', numero: '3', uploadedDate: '2026-01-10T10:00:00Z', aparece: 0, valido: 0 });
  if (o.buildAntigo) listaDeBuilds.push({ id: 'B-ANTIGO', versao: o.versaoDoBuild, numero: '6', uploadedDate: '2026-11-10T09:00:00Z', aparece: 0, valido: 0 });
  listaDeBuilds.push({
    id: 'B1',
    versao: o.versaoDoBuild,
    numero: '7',
    uploadedDate: '2026-11-17T12:00:00Z',
    aparece: o.buildValidoNaConsulta - 1,
    valido: o.buildValidoNaConsulta,
    nunca: o.buildNunca,
  });

  if (o.versaoTravada) {
    // A mesma versão do app.json já enviada (ou aprovada): o appStoreState antigo acompanha.
    const antigo = o.versaoTravada === 'READY_FOR_DISTRIBUTION' ? 'READY_FOR_SALE' : o.versaoTravada;
    estado.versoes.push({ id: 'VER-TRAVADA', platform: 'IOS', versionString: o.versaoDoAppJson, appStoreState: antigo, appVersionState: o.versaoTravada });
  }

  if (idiomaDoSite) {
    // O que o formulário "Novo app" do site deixa pronto.
    estado.versoes.push({ id: 'VER-SITE', platform: 'IOS', versionString: '1.0', appStoreState: 'PREPARE_FOR_SUBMISSION', appVersionState: 'PREPARE_FOR_SUBMISSION' });
    estado.versaoLocs[`VLOC-SITE-${idiomaDoSite}`] = { versao: 'VER-SITE', atributos: { locale: idiomaDoSite } };
    estado.infoLocs[`ILOC-INFO1-${idiomaDoSite}`] = { info: 'INFO1', atributos: { locale: idiomaDoSite, name: 'Gestão de Loja' } };
  }

  const versao = (id) => estado.versoes.find((v) => v.id === id);
  const estadoDaVersao = (v) => v.appVersionState ?? v.appStoreState;
  const editavel = (v) => EDITAVEIS.includes(v?.appStoreState);
  const jaLancado = () => estado.versoes.some((v) => JA_ESTEVE_A_VENDA.has(v.appStoreState));
  const infoEditavel = () => estado.infos.find((i) => i.state === 'PREPARE_FOR_SUBMISSION');
  const locsDoInfo = (infoId) => Object.entries(estado.infoLocs).filter(([, l]) => l.info === infoId);
  const locPtDoInfo = (infoId) => locsDoInfo(infoId).find(([, l]) => l.atributos.locale === 'pt-BR');
  const capturasDoConjunto = (id) => {
    const c = estado.conjuntos[id];
    const todas = Object.entries(estado.capturas).filter(([, x]) => x.conjunto === id).map(([i]) => i);
    if (!c.ordem) return todas;
    // A ordem gravada vale para quem está nela; captura nova entra no fim até a próxima ordem.
    const naOrdem = c.ordem.filter((i) => todas.includes(i));
    return [...naOrdem, ...todas.filter((i) => !naOrdem.includes(i))];
  };
  const builds = () => {
    const n = estado.consultasDeBuild;
    const lista = [];
    for (const b of listaDeBuilds) {
      if (n < b.aparece) continue;
      const processingState = b.nunca ? 'PROCESSING' : n >= b.valido ? 'VALID' : 'PROCESSING';
      lista.push({ id: b.id, versao: b.versao, attributes: { version: b.numero, processingState, expired: false, uploadedDate: b.uploadedDate } });
    }
    return lista;
  };
  const anexosDoDetalhe = (detalheId) => Object.entries(estado.anexos).filter(([, a]) => a.detalhe === detalheId);
  const anexoVisto = (id, a) => ({
    type: 'appStoreReviewAttachments',
    id,
    attributes: { fileName: a.nome, fileSize: a.esperado, sourceFileChecksum: a.checksum, assetDeliveryState: { state: a.estado, errors: a.erros } },
  });

  /** O que falta para a Apple aceitar o envio da versão — no formato associatedErrors. */
  function faltasParaEnviar(versaoId) {
    const faltas = {};
    const falta = (recurso, detail, code = 'ENTITY_ERROR.ATTRIBUTE.REQUIRED') =>
      (faltas[recurso] ??= []).push({ code, title: 'Missing required information', detail });
    const v = versao(versaoId);
    if (!estado.app.contentRightsDeclaration) falta('/v1/apps/APP1', 'contentRightsDeclaration é obrigatório');
    const info = infoEditavel();
    if (!info) falta('/v1/apps/APP1/appInfos', 'nenhum appInfo editável');
    else {
      if (!locPtDoInfo(info.id)) falta(`/v1/appInfos/${info.id}`, 'nome e URL de privacidade em pt-BR');
      // A Apple cobra TODA localização do appInfo, não só a do idioma principal.
      for (const [id, l] of locsDoInfo(info.id)) {
        if (!l.atributos.name || !l.atributos.privacyPolicyUrl) falta(`/v1/appInfoLocalizations/${id}`, `${l.atributos.locale}: nome e privacyPolicyUrl são obrigatórios`);
      }
      if (!estado.categorias[info.id]) falta(`/v1/appInfos/${info.id}`, 'categoria principal');
      const decl = estado.idade[info.id];
      const cobradas = [...perguntas.filter((p) => !OPCIONAIS_DA_DECLARACAO.has(p) && !o.idadeDesconhece.includes(p)), ...o.descritoresNovos];
      const emBranco = cobradas.filter((p) => decl[p] === null || decl[p] === undefined);
      if (emBranco.length) {
        falta(`/v1/ageRatingDeclarations/AGE-${info.id}`, `A classificação etária (ageRatingDeclaration) exige resposta para: ${emBranco.join(', ')}`);
      }
    }
    if (!estado.disponibilidade) falta('/v1/apps/APP1/appAvailabilityV2', 'defina em quais países o app é vendido');
    const locsDaVersao = Object.entries(estado.versaoLocs).filter(([, l]) => l.versao === versaoId);
    const loc = locsDaVersao.find(([, l]) => l.atributos.locale === 'pt-BR');
    if (!loc) falta(`/v1/appStoreVersions/${versaoId}`, 'localização pt-BR');
    for (const [id, l] of locsDaVersao) {
      const a = l.atributos;
      for (const campo of ['description', 'keywords', 'supportUrl']) if (!a[campo]) falta(`/v1/appStoreVersionLocalizations/${id}`, `${a.locale}: ${campo} é obrigatório`);
      if (jaLancado() && !a.whatsNew) falta(`/v1/appStoreVersionLocalizations/${id}`, `${a.locale}: whatsNew é obrigatório numa atualização`);
    }
    if (loc) {
      const conjuntos = Object.entries(estado.conjuntos).filter(([, c]) => c.loc === loc[0]);
      const de65 = conjuntos.find(([, c]) => c.tipo === 'APP_IPHONE_65');
      if (!de65 || !capturasDoConjunto(de65[0]).length) falta(`/v1/appStoreVersionLocalizations/${loc[0]}`, 'capturas de iPhone 6,5" são obrigatórias');
      for (const [id] of conjuntos) {
        for (const c of capturasDoConjunto(id)) {
          if (estado.capturas[c].estado !== 'COMPLETE') falta(`/v1/appScreenshots/${c}`, `screenshot ${estado.capturas[c].nome} não está COMPLETE`);
        }
      }
    }
    const rev = estado.revisoes[versaoId];
    if (!rev?.atributos.demoAccountName || !rev?.atributos.demoAccountPassword) falta(`/v1/appStoreVersions/${versaoId}`, 'conta de demonstração do revisor');
    if (!estado.preco) falta('/v1/apps/APP1', 'preço');
    if (!estado.buildPreso[versaoId]) falta(`/v1/appStoreVersions/${versaoId}`, 'build');
    if (v && !editavel(v)) falta(`/v1/appStoreVersions/${versaoId}`, 'versão não editável', 'STATE_ERROR');
    return faltas;
  }

  // -------------------------------------------------------------- rotas da "Apple"

  const H = {
    'GET /v1/apps': () => [200, { data: o.appExiste ? [{ type: 'apps', id: 'APP1', attributes: { ...estado.app } }] : [] }],
    'PATCH /v1/apps/{id}': ({ corpo }) => {
      Object.assign(estado.app, corpo.data.attributes);
      return [200, { data: { type: 'apps', id: 'APP1', attributes: { ...estado.app } } }];
    },
    'GET /v1/apps/{id}/appInfos': () => [
      200,
      { data: estado.infos.map((i) => ({ type: 'appInfos', id: i.id, attributes: { state: i.state, appStoreState: i.state === 'PREPARE_FOR_SUBMISSION' ? 'PREPARE_FOR_SUBMISSION' : 'READY_FOR_SALE' } })) },
    ],
    'GET /v1/appInfos/{id}/appInfoLocalizations': ({ ids }) => [
      200,
      { data: locsDoInfo(ids[0]).map(([id, l]) => ({ type: 'appInfoLocalizations', id, attributes: { ...l.atributos } })) },
    ],
    'POST /v1/appInfoLocalizations': ({ corpo }) => {
      const infoId = corpo.data.relationships.appInfo.data.id;
      if (infoEditavel()?.id !== infoId) return erro(409, 'STATE_ERROR', `appInfo ${infoId} não é editável`);
      const locale = corpo.data.attributes.locale;
      if (locsDoInfo(infoId).some(([, l]) => l.atributos.locale === locale)) return erro(409, 'ENTITY_ERROR', `já existe a localização ${locale}`);
      const id = `ILOC-${infoId}-${locale}`;
      estado.infoLocs[id] = { info: infoId, atributos: { ...corpo.data.attributes } };
      return [201, { data: { type: 'appInfoLocalizations', id, attributes: estado.infoLocs[id].atributos } }];
    },
    'PATCH /v1/appInfoLocalizations/{id}': ({ ids, corpo }) => {
      const loc = estado.infoLocs[ids[0]];
      if (!loc) return erro(404, 'NOT_FOUND', 'localização inexistente');
      if (infoEditavel()?.id !== loc.info) return erro(409, 'STATE_ERROR', `appInfo ${loc.info} não é editável`);
      Object.assign(loc.atributos, corpo.data.attributes);
      return [200, { data: { type: 'appInfoLocalizations', id: ids[0], attributes: loc.atributos } }];
    },
    'DELETE /v1/appInfoLocalizations/{id}': ({ ids }) => {
      const loc = estado.infoLocs[ids[0]];
      if (!loc) return erro(404, 'NOT_FOUND', 'localização inexistente');
      if (loc.atributos.locale === estado.app.primaryLocale) return erro(409, 'STATE_ERROR', 'a localização do idioma principal não pode ser apagada');
      delete estado.infoLocs[ids[0]];
      estado.infoLocsApagadas.push(ids[0]);
      return [204, null];
    },
    'PATCH /v1/appInfos/{id}': ({ ids, corpo }) => {
      if (infoEditavel()?.id !== ids[0]) return erro(409, 'STATE_ERROR', `appInfo ${ids[0]} não é editável`);
      const r = corpo.data.relationships;
      estado.categorias[ids[0]] = { principal: r.primaryCategory?.data?.id, secundaria: r.secondaryCategory?.data?.id };
      return [200, { data: { type: 'appInfos', id: ids[0] } }];
    },
    'GET /v1/appInfos/{id}/ageRatingDeclaration': ({ ids }) => [
      200,
      { data: { type: 'ageRatingDeclarations', id: `AGE-${ids[0]}`, attributes: { ...estado.idade[ids[0]] } } },
    ],
    'PATCH /v1/ageRatingDeclarations/{id}': ({ ids, corpo, rota }) => {
      const infoId = ids[0].replace('AGE-', '');
      if (infoEditavel()?.id !== infoId) return erro(409, 'STATE_ERROR', `a declaração de ${infoId} não é editável`);
      const atributos = corpo.data.attributes ?? {};
      estado.idadeRecebida.push({ ...atributos });
      const desconhecidos = Object.keys(atributos).filter((n) => o.idadeDesconhece.includes(n));
      if (desconhecidos.length) {
        const erros = desconhecidos.map((n) => ({
          status: '409',
          code: 'ENTITY_ERROR.ATTRIBUTE.UNKNOWN',
          title: 'The provided entity includes an unknown attribute',
          detail: `'${n}' is not a valid attribute for 'ageRatingDeclarations'`,
          source: { pointer: `/data/attributes/${n}` },
        }));
        estado.recusas.push({ rota, status: 409, erros, simulada: true });
        return [409, { errors: erros }];
      }
      Object.assign(estado.idade[infoId], atributos);
      return [200, { data: { type: 'ageRatingDeclarations', id: ids[0], attributes: { ...estado.idade[infoId] } } }];
    },
    'GET /v1/apps/{id}/appAvailabilityV2': () => {
      if (estado.disponibilidade) {
        return [200, { data: { type: 'appAvailabilities', id: 'AV1', attributes: { availableInNewTerritories: estado.disponibilidade.availableInNewTerritories } } }];
      }
      return o.semDisponibilidade === 'nulo' ? [200, { data: null }] : erro(404, 'NOT_FOUND', 'a disponibilidade deste app ainda não existe');
    },
    'GET /v2/appAvailabilities/{id}/territoryAvailabilities': ({ ids }) => {
      if (!estado.disponibilidade || ids[0] !== 'AV1') return erro(404, 'NOT_FOUND', 'disponibilidade inexistente');
      return [
        200,
        {
          data: [...TERRITORIOS].map((t) => ({
            type: 'territoryAvailabilities',
            id: `TA-${t}`,
            attributes: { available: estado.disponibilidade.territorios.includes(t) },
            relationships: { territory: { data: { type: 'territories', id: t } } },
          })),
        },
      ];
    },
    // Duas por página, de propósito: o publicador tem de seguir o links.next (a Apple de verdade
    // pagina em 200, e são uns 175 — um dia passa).
    'GET /v1/territories': ({ url }) => {
      const todos = [...TERRITORIOS];
      const de = Number(url.searchParams.get('cursor') ?? 0);
      const pagina = todos.slice(de, de + 2);
      const proximo = de + 2 < todos.length ? `${url.origin}/v1/territories?cursor=${de + 2}&limit=200` : undefined;
      return [200, { data: pagina.map((id) => ({ type: 'territories', id })), links: { self: url.href, ...(proximo ? { next: proximo } : {}) } }];
    },
    'POST /v2/appAvailabilities': ({ corpo }) => {
      if (estado.disponibilidade) return erro(409, 'ENTITY_ERROR', 'a disponibilidade já existe');
      const citados = corpo.data.relationships.territoryAvailabilities.data.map((d) => d.id);
      const incluidos = corpo.included ?? [];
      if (citados.some((id) => !ID_LOCAL.test(id)) || citados.join() !== incluidos.map((i) => i.id).join()) {
        return erro(409, 'ENTITY_ERROR.RELATIONSHIP.INVALID', 'territoryAvailabilities tem de citar os ids locais ${...} de included');
      }
      const territorios = incluidos.map((i) => ({ id: i.relationships?.territory?.data?.id, available: i.attributes?.available }));
      if (territorios.some((t) => !TERRITORIOS.has(t.id))) return erro(409, 'ENTITY_ERROR.RELATIONSHIP.INVALID', 'território desconhecido');
      // Como a Apple de verdade: a criação leva TODOS os territórios (available true/false);
      // faltou um, 409 — a primeira rodada real mandava só o Brasil e parou aqui.
      const faltou = [...TERRITORIOS].find((id) => !territorios.some((t) => t.id === id));
      if (faltou) {
        return erro(
          409,
          'ENTITY_ERROR.RELATIONSHIP.INVALID',
          `The relationship 'territoryAvailabilities.territory' expects an included resource with type 'territories' and id '${faltou}' but no matching resource was included.`,
        );
      }
      estado.disponibilidadeCriada = { availableInNewTerritories: corpo.data.attributes.availableInNewTerritories, territorios };
      estado.disponibilidade = {
        availableInNewTerritories: corpo.data.attributes.availableInNewTerritories,
        territorios: territorios.filter((t) => t.available === true).map((t) => t.id),
      };
      return [201, { data: { type: 'appAvailabilities', id: 'AV1', attributes: { availableInNewTerritories: estado.disponibilidade.availableInNewTerritories } } }];
    },
    'GET /v1/apps/{id}/appStoreVersions': ({ url }) => {
      const plataforma = url.searchParams.get('filter[platform]');
      const lista = estado.versoes.filter((v) => !plataforma || plataforma.split(',').includes(v.platform));
      return [200, { data: lista.map(({ id, ...attributes }) => ({ type: 'appStoreVersions', id, attributes })) }];
    },
    'POST /v1/appStoreVersions': ({ corpo }) => {
      const a = corpo.data.attributes;
      if (estado.versoes.some((v) => v.versionString === a.versionString)) return erro(409, 'ENTITY_ERROR.ATTRIBUTE.INVALID', `a versão ${a.versionString} já existe`);
      if (estado.versoes.some(editavel)) return erro(409, 'STATE_ERROR', 'já existe uma versão em preparo');
      const nova = { id: novoId('VER'), ...a, appStoreState: 'PREPARE_FOR_SUBMISSION', appVersionState: 'PREPARE_FOR_SUBMISSION' };
      estado.versoes.push(nova);
      // Numa atualização, a Apple abre um appInfo editável copiando o que está no ar.
      if (!infoEditavel()) {
        const anterior = estado.infos[0];
        estado.infos.push({ id: 'INFO1', state: 'PREPARE_FOR_SUBMISSION' });
        estado.idade.INFO1 = { ...estado.idade[anterior.id] };
        for (const [, l] of locsDoInfo(anterior.id)) {
          estado.infoLocs[`ILOC-INFO1-${l.atributos.locale}`] = { info: 'INFO1', atributos: { ...l.atributos } };
        }
      }
      const { id, ...attributes } = nova;
      return [201, { data: { type: 'appStoreVersions', id, attributes } }];
    },
    'PATCH /v1/appStoreVersions/{id}': ({ ids, corpo }) => {
      const v = versao(ids[0]);
      if (!editavel(v)) return erro(409, 'STATE_ERROR', 'a versão não é editável');
      const a = corpo.data.attributes ?? {};
      if (a.versionString && estado.versoes.some((x) => x !== v && x.versionString === a.versionString)) {
        return erro(409, 'ENTITY_ERROR.ATTRIBUTE.INVALID', `a versão ${a.versionString} já existe`);
      }
      Object.assign(v, a);
      return [200, { data: { type: 'appStoreVersions', id: v.id } }];
    },
    'GET /v1/appStoreVersions/{id}/appStoreVersionLocalizations': ({ ids }) => [
      200,
      {
        data: Object.entries(estado.versaoLocs)
          .filter(([, l]) => l.versao === ids[0])
          .map(([id, l]) => ({ type: 'appStoreVersionLocalizations', id, attributes: l.atributos })),
      },
    ],
    'POST /v1/appStoreVersionLocalizations': ({ corpo }) => {
      const versaoId = corpo.data.relationships.appStoreVersion.data.id;
      if (!jaLancado() && corpo.data.attributes.whatsNew != null) {
        return erro(409, 'ENTITY_ERROR.ATTRIBUTE.INVALID', "whatsNew can not be edited for the first version of an app", '/data/attributes/whatsNew');
      }
      const locale = corpo.data.attributes.locale;
      if (Object.values(estado.versaoLocs).some((l) => l.versao === versaoId && l.atributos.locale === locale)) {
        return erro(409, 'ENTITY_ERROR', `a versão já tem a localização ${locale}`);
      }
      const id = novoId('VLOC');
      estado.versaoLocs[id] = { versao: versaoId, atributos: { ...corpo.data.attributes } };
      return [201, { data: { type: 'appStoreVersionLocalizations', id, attributes: estado.versaoLocs[id].atributos } }];
    },
    'PATCH /v1/appStoreVersionLocalizations/{id}': ({ ids, corpo }) => {
      if (!jaLancado() && corpo.data.attributes?.whatsNew != null) {
        return erro(409, 'ENTITY_ERROR.ATTRIBUTE.INVALID', "whatsNew can not be edited for the first version of an app", '/data/attributes/whatsNew');
      }
      Object.assign(estado.versaoLocs[ids[0]].atributos, corpo.data.attributes);
      return [200, { data: { type: 'appStoreVersionLocalizations', id: ids[0] } }];
    },
    'DELETE /v1/appStoreVersionLocalizations/{id}': ({ ids }) => {
      const loc = estado.versaoLocs[ids[0]];
      if (!loc) return erro(404, 'NOT_FOUND', 'localização inexistente');
      if (loc.atributos.locale === estado.app.primaryLocale) return erro(409, 'STATE_ERROR', 'a localização do idioma principal não pode ser apagada');
      for (const [id, c] of Object.entries(estado.conjuntos)) if (c.loc === ids[0]) delete estado.conjuntos[id];
      delete estado.versaoLocs[ids[0]];
      estado.versaoLocsApagadas.push(ids[0]);
      return [204, null];
    },
    'GET /v1/appStoreVersionLocalizations/{id}/appScreenshotSets': ({ ids }) => [
      200,
      {
        data: Object.entries(estado.conjuntos)
          .filter(([, c]) => c.loc === ids[0])
          .map(([id, c]) => ({ type: 'appScreenshotSets', id, attributes: { screenshotDisplayType: c.tipo } })),
      },
    ],
    'POST /v1/appScreenshotSets': ({ corpo }) => {
      const loc = corpo.data.relationships.appStoreVersionLocalization.data.id;
      const tipo = corpo.data.attributes.screenshotDisplayType;
      if (Object.values(estado.conjuntos).some((c) => c.loc === loc && c.tipo === tipo)) return erro(409, 'ENTITY_ERROR', `já existe conjunto ${tipo}`);
      const id = novoId('SET');
      estado.conjuntos[id] = { loc, tipo, ordem: null };
      return [201, { data: { type: 'appScreenshotSets', id, attributes: { screenshotDisplayType: tipo } } }];
    },
    'DELETE /v1/appScreenshotSets/{id}': ({ ids }) => {
      if (!estado.conjuntos[ids[0]]) return erro(404, 'NOT_FOUND', 'conjunto inexistente');
      for (const c of capturasDoConjunto(ids[0])) delete estado.capturas[c];
      delete estado.conjuntos[ids[0]];
      estado.conjuntosApagados.push(ids[0]);
      return [204, null];
    },
    'GET /v1/appScreenshotSets/{id}/appScreenshots': ({ ids }) => {
      if (!estado.conjuntos[ids[0]]) return erro(404, 'NOT_FOUND', 'conjunto inexistente');
      const lista = capturasDoConjunto(ids[0]).map((id) => {
        const c = estado.capturas[id];
        const visto = { type: 'appScreenshots', id, attributes: { fileName: c.nome, fileSize: c.esperado, sourceFileChecksum: c.checksum, assetDeliveryState: { state: c.estado, errors: c.erros } } };
        if (c.estado === 'UPLOAD_COMPLETE') c.estado = 'COMPLETE'; // processa "em segundo plano"
        return visto;
      });
      return [200, { data: lista }];
    },
    'PATCH /v1/appScreenshotSets/{id}/relationships/appScreenshots': ({ ids, corpo }) => {
      const nossas = capturasDoConjunto(ids[0]);
      const pedidas = corpo.data.map((d) => d.id);
      if (pedidas.length !== nossas.length || pedidas.some((p) => !nossas.includes(p))) return erro(409, 'ENTITY_ERROR.RELATIONSHIP.INVALID', 'a ordem tem de citar exatamente as capturas do conjunto');
      estado.conjuntos[ids[0]].ordem = pedidas;
      return [204, null];
    },
    'POST /v1/appScreenshots': ({ corpo, porta }) => {
      const conjunto = corpo.data.relationships.appScreenshotSet.data.id;
      if (!estado.conjuntos[conjunto]) return erro(404, 'NOT_FOUND', 'conjunto inexistente');
      if (capturasDoConjunto(conjunto).length >= 10) return erro(409, 'ENTITY_ERROR', 'no máximo 10 capturas por conjunto');
      const id = novoId('SHOT');
      const { fileName, fileSize } = corpo.data.attributes;
      const operacoes = operacoesDeUpload(porta, 'upload', id, fileSize, 'image/png');
      estado.capturas[id] = { conjunto, nome: fileName, esperado: fileSize, partes: {}, totalDePartes: operacoes.length, md5: null, checksum: null, estado: 'AWAITING_UPLOAD', erros: [] };
      return [201, { data: { type: 'appScreenshots', id, attributes: { fileName, fileSize, uploadOperations: operacoes } } }];
    },
    'PATCH /v1/appScreenshots/{id}': ({ ids, corpo }) => {
      const c = estado.capturas[ids[0]];
      if (!c) return erro(404, 'NOT_FOUND', 'captura inexistente');
      const a = corpo.data.attributes ?? {};
      c.checksum = a.sourceFileChecksum ?? c.checksum;
      if (a.uploaded === true) {
        const bytes = juntarPartes(c);
        const png = lerPng(bytes);
        const tipo = estado.conjuntos[c.conjunto].tipo;
        if (!c.erros.length && (!png || !TAMANHOS_DO_SLOT[tipo].includes(png.tamanho))) c.erros.push({ code: 'IMAGE_INCORRECT_DIMENSIONS', description: `tamanho ${png?.tamanho} não serve para ${tipo}` });
        else if (!c.erros.length && png.tipoDeCor !== 2) c.erros.push({ code: 'IMAGE_ALPHA_NOT_ALLOWED', description: 'canal alfa não é aceito' });
        c.estado = c.erros.length ? 'FAILED' : 'UPLOAD_COMPLETE';
      }
      return [200, { data: { type: 'appScreenshots', id: ids[0] } }];
    },
    'DELETE /v1/appScreenshots/{id}': ({ ids }) => {
      if (!estado.capturas[ids[0]]) return erro(404, 'NOT_FOUND', 'captura inexistente');
      delete estado.capturas[ids[0]];
      estado.capturasApagadas.push(ids[0]);
      return [204, null];
    },
    'GET /v1/appStoreVersions/{id}/appStoreReviewDetail': ({ ids }) => {
      const r = estado.revisoes[ids[0]];
      return r ? [200, { data: { type: 'appStoreReviewDetails', id: r.id, attributes: r.atributos } }] : erro(404, 'NOT_FOUND', 'ainda não existe');
    },
    'POST /v1/appStoreReviewDetails': ({ corpo }) => {
      const versaoId = corpo.data.relationships.appStoreVersion.data.id;
      if (o.revisaoEcoaSenha) {
        return erro(409, 'ENTITY_ERROR.ATTRIBUTE.INVALID', `demoAccountPassword '${corpo.data.attributes.demoAccountPassword}' não pôde ser validada`);
      }
      if (estado.revisoes[versaoId]) return erro(409, 'ENTITY_ERROR', 'a versão já tem o detalhe de revisão');
      estado.revisoes[versaoId] = { id: `REV-${versaoId}`, atributos: { ...corpo.data.attributes } };
      return [201, { data: { type: 'appStoreReviewDetails', id: `REV-${versaoId}` } }];
    },
    'PATCH /v1/appStoreReviewDetails/{id}': ({ ids, corpo }) => {
      const versaoId = ids[0].replace('REV-', '');
      Object.assign(estado.revisoes[versaoId].atributos, corpo.data.attributes);
      return [200, { data: { type: 'appStoreReviewDetails', id: ids[0] } }];
    },
    // ------------------------------------------------ anexos da revisão
    'GET /v1/appStoreReviewDetails/{id}/appStoreReviewAttachments': ({ ids }) => {
      if (!Object.values(estado.revisoes).some((r) => r.id === ids[0])) return erro(404, 'NOT_FOUND', 'detalhe inexistente');
      return [200, { data: anexosDoDetalhe(ids[0]).map(([id, a]) => anexoVisto(id, a)) }];
    },
    'POST /v1/appStoreReviewAttachments': ({ corpo, porta }) => {
      const detalhe = corpo.data.relationships.appStoreReviewDetail.data.id;
      if (!Object.values(estado.revisoes).some((r) => r.id === detalhe)) return erro(404, 'NOT_FOUND', 'detalhe inexistente');
      // A regra que parou a rodada nº 8: um anexo por detalhe, e a frase é a da Apple.
      if (anexosDoDetalhe(detalhe).length) {
        return erro(409, 'STATE_ERROR', 'There can be max of 1 attachment, please delete the existing attachment before loading a new one');
      }
      const id = novoId('ATT');
      const { fileName, fileSize } = corpo.data.attributes;
      const tipo = fileName.endsWith('.pdf') ? 'application/pdf' : 'video/mp4';
      const operacoes = operacoesDeUpload(porta, 'upload-anexo', id, fileSize, tipo);
      estado.anexos[id] = { detalhe, nome: fileName, esperado: fileSize, partes: {}, totalDePartes: operacoes.length, md5: null, checksum: null, estado: 'AWAITING_UPLOAD', erros: [] };
      return [201, { data: { ...anexoVisto(id, estado.anexos[id]), attributes: { fileName, fileSize, uploadOperations: operacoes } } }];
    },
    'GET /v1/appStoreReviewAttachments/{id}': ({ ids }) => {
      const a = estado.anexos[ids[0]];
      if (!a) return erro(404, 'NOT_FOUND', 'anexo inexistente');
      const visto = anexoVisto(ids[0], a);
      if (a.estado === 'UPLOAD_COMPLETE') a.estado = 'COMPLETE'; // processa "em segundo plano"
      return [200, { data: visto }];
    },
    'PATCH /v1/appStoreReviewAttachments/{id}': ({ ids, corpo }) => {
      const a = estado.anexos[ids[0]];
      if (!a) return erro(404, 'NOT_FOUND', 'anexo inexistente');
      const at = corpo.data.attributes ?? {};
      a.checksum = at.sourceFileChecksum ?? a.checksum;
      if (at.uploaded === true) {
        juntarPartes(a);
        a.estado = a.erros.length ? 'FAILED' : 'UPLOAD_COMPLETE';
      }
      return [200, { data: anexoVisto(ids[0], a) }];
    },
    'DELETE /v1/appStoreReviewAttachments/{id}': ({ ids }) => {
      if (!estado.anexos[ids[0]]) return erro(404, 'NOT_FOUND', 'anexo inexistente');
      delete estado.anexos[ids[0]];
      estado.anexosApagados.push(ids[0]);
      return [204, null];
    },
    // ------------------------------------------------ preço
    'GET /v1/apps/{id}/appPricePoints': ({ url, porta }) => {
      const territorio = url.searchParams.get('filter[territory]');
      const todos = pontosDePreco(o.precos, territorio);
      const limite = Math.min(Number(url.searchParams.get('limit') ?? 50), PRECOS_POR_PAGINA);
      const inicio = Number(url.searchParams.get('cursor') ?? 0);
      const pagina = todos.slice(inicio, inicio + limite);
      const links = { self: url.href };
      if (inicio + limite < todos.length) {
        const proxima = new URL(`http://127.0.0.1:${porta}${url.pathname}`);
        for (const [k, v] of url.searchParams) if (k !== 'cursor') proxima.searchParams.set(k, v);
        proxima.searchParams.set('cursor', String(inicio + limite));
        links.next = proxima.href;
      }
      return [200, { data: pagina, links }];
    },
    'POST /v1/appPriceSchedules': ({ corpo }) => {
      const citados = corpo.data.relationships.manualPrices.data.map((d) => d.id);
      const incluidos = (corpo.included ?? []).filter((i) => i.type === 'appPrices');
      if (citados.join() !== incluidos.map((i) => i.id).join()) return erro(409, 'ENTITY_ERROR.RELATIONSHIP.INVALID', 'manualPrices tem de citar os ids de included');
      estado.preco = incluidos[0].relationships.appPricePoint.data.id;
      return [201, { data: { type: 'appPriceSchedules', id: 'PS1' } }];
    },
    // ------------------------------------------------ builds
    'GET /v1/builds': ({ url }) => {
      estado.consultasDeBuild += 1;
      const versaoPedida = url.searchParams.get('filter[preReleaseVersion.version]');
      const numeroPedido = url.searchParams.get('filter[version]');
      const lista = builds()
        .filter((b) => !versaoPedida || versaoPedida.split(',').includes(b.versao))
        .filter((b) => !numeroPedido || numeroPedido.split(',').includes(b.attributes.version))
        .sort((a, b) => b.attributes.uploadedDate.localeCompare(a.attributes.uploadedDate));
      return [200, { data: lista.map(({ id, attributes }) => ({ type: 'builds', id, attributes })) }];
    },
    'GET /v1/appStoreVersions/{id}/build': ({ ids }) => {
      const b = builds().find((x) => x.id === estado.buildPreso[ids[0]]);
      return [200, { data: b ? { type: 'builds', id: b.id, attributes: b.attributes } : null }];
    },
    'PATCH /v1/appStoreVersions/{id}/relationships/build': ({ ids, corpo }) => {
      const b = builds().find((x) => x.id === corpo.data.id);
      const v = versao(ids[0]);
      if (!b || b.attributes.processingState !== 'VALID') return erro(409, 'STATE_ERROR', 'build não está VALID');
      if (b.versao !== v.versionString) return erro(409, 'ENTITY_ERROR.RELATIONSHIP.INVALID', `build da ${b.versao} não serve na versão ${v.versionString}`);
      estado.buildPreso[ids[0]] = b.id;
      return [204, null];
    },
    // ------------------------------------------------ envio para revisão
    'GET /v1/reviewSubmissions': ({ url }) => {
      const estados = url.searchParams.get('filter[state]')?.split(',');
      const lista = estado.envios.filter((e) => !estados || estados.includes(e.estado));
      return [200, { data: lista.map((e) => ({ type: 'reviewSubmissions', id: e.id, attributes: { platform: e.platform, state: e.estado } })) }];
    },
    'POST /v1/reviewSubmissions': ({ corpo }) => {
      const platform = corpo.data.attributes?.platform ?? 'IOS';
      const ativo = estado.envios.find((e) => e.platform === platform && ENVIO_ATIVO.has(e.estado));
      if (ativo) return erro(409, 'ENTITY_ERROR', `já existe um envio ativo para esta plataforma (${ativo.id}, ${ativo.estado})`);
      const novo = { id: novoId('RS'), platform, estado: 'READY_FOR_REVIEW', itens: [], tentativas: 0 };
      estado.envios.push(novo);
      return [201, { data: { type: 'reviewSubmissions', id: novo.id, attributes: { platform, state: novo.estado } } }];
    },
    'GET /v1/reviewSubmissions/{id}/items': ({ ids, url }) => {
      const envio = estado.envios.find((e) => e.id === ids[0]);
      const incluir = url.searchParams.get('include')?.split(',').includes('appStoreVersion');
      return [
        200,
        {
          data: envio.itens.map((item) => ({
            type: 'reviewSubmissionItems',
            id: item.id,
            attributes: { state: item.estado },
            ...(incluir ? { relationships: { appStoreVersion: { data: { type: 'appStoreVersions', id: item.versao } } } } : {}),
          })),
        },
      ];
    },
    'POST /v1/reviewSubmissionItems': ({ corpo }) => {
      const envio = estado.envios.find((e) => e.id === corpo.data.relationships.reviewSubmission.data.id);
      const versaoId = corpo.data.relationships.appStoreVersion?.data?.id;
      if (!envio || !['READY_FOR_REVIEW', 'UNRESOLVED_ISSUES'].includes(envio.estado)) return erro(409, 'STATE_ERROR', 'o envio não aceita itens');
      if (envio.itens.some((i) => i.versao === versaoId && i.estado !== 'REMOVED')) return erro(409, 'ENTITY_ERROR', 'esta versão já está no envio');
      const item = { id: `${envio.id}-I${envio.itens.length}`, versao: versaoId, estado: 'READY_FOR_REVIEW', resolvido: false };
      envio.itens.push(item);
      return [201, { data: { type: 'reviewSubmissionItems', id: item.id } }];
    },
    'PATCH /v1/reviewSubmissionItems/{id}': ({ ids, corpo }) => {
      const envio = estado.envios.find((e) => e.itens.some((i) => i.id === ids[0]));
      const item = envio?.itens.find((i) => i.id === ids[0]);
      if (!item) return erro(404, 'NOT_FOUND', 'item inexistente');
      const a = corpo.data.attributes ?? {};
      if (a.resolved === true) {
        if (o.itemNaoAceitaResolved) return erro(409, 'ENTITY_ERROR.ATTRIBUTE.INVALID', "'resolved' cannot be set for this item");
        if (item.estado !== 'REJECTED') return erro(409, 'STATE_ERROR', 'só item recusado pode ser marcado como resolvido');
        item.resolvido = true;
      }
      if (a.removed === true) item.estado = 'REMOVED';
      return [200, { data: { type: 'reviewSubmissionItems', id: item.id, attributes: { state: item.estado } } }];
    },
    'PATCH /v1/reviewSubmissions/{id}': ({ ids, corpo, rota }) => {
      const envio = estado.envios.find((e) => e.id === ids[0]);
      if (corpo.data.attributes?.submitted !== true) return [200, { data: { type: 'reviewSubmissions', id: envio.id } }];
      envio.tentativas += 1;
      if (!['READY_FOR_REVIEW', 'UNRESOLVED_ISSUES'].includes(envio.estado)) return erro(409, 'STATE_ERROR', `o envio está ${envio.estado}`);
      const vivos = envio.itens.filter((i) => i.estado !== 'REMOVED');
      if (!vivos.length) return erro(409, 'STATE_ERROR', 'envio sem itens');
      const faltas = Object.assign({}, ...vivos.map((i) => faltasParaEnviar(i.versao)));
      // O devolvido só sai de novo com o item recusado marcado como resolvido (nesta Apple;
      // a que recusa a marca, `itemNaoAceitaResolved`, também não a cobra).
      for (const i of vivos) {
        if (i.estado === 'REJECTED' && !i.resolvido && !o.itemNaoAceitaResolved) {
          (faltas[`/v1/reviewSubmissionItems/${i.id}`] ??= []).push({ code: 'STATE_ERROR', title: 'Unresolved', detail: 'the item still has unresolved issues' });
        }
      }
      if (Object.keys(faltas).length) {
        const erros = [
          {
            status: '409',
            code: 'STATE_ERROR.ENTITY_STATE_INVALID',
            title: 'The submission cannot be submitted',
            detail: 'Some of the items in this submission need attention before they can be submitted for review.',
            meta: { associatedErrors: faltas },
          },
        ];
        estado.recusas.push({ rota, status: 409, erros, simulada: true });
        return [409, { errors: erros }];
      }
      envio.estado = 'WAITING_FOR_REVIEW';
      for (const i of vivos) {
        i.estado = 'READY_FOR_REVIEW';
        i.resolvido = false;
        Object.assign(versao(i.versao), { appStoreState: 'WAITING_FOR_REVIEW', appVersionState: 'WAITING_FOR_REVIEW' });
      }
      return [200, { data: { type: 'reviewSubmissions', id: envio.id, attributes: { state: envio.estado } } }];
    },
    // ------------------------------------------------ aparelhos (perfil ad hoc)
    'GET /v1/devices': ({ url }) => {
      const p = (n) => url.searchParams.get(n)?.split(',');
      const [plataformas, situacoes, udids] = [p('filter[platform]'), p('filter[status]'), p('filter[udid]')];
      const lista = estado.aparelhos
        .filter((d) => !plataformas || plataformas.includes(d.platform))
        .filter((d) => !situacoes || situacoes.includes(d.status))
        .filter((d) => !udids || udids.map((u) => u.toLowerCase()).includes(d.udid.toLowerCase()));
      return [200, { data: lista.map(({ id, ...attributes }) => ({ type: 'devices', id, attributes })) }];
    },
    'POST /v1/devices': ({ corpo }) => {
      const a = corpo.data.attributes;
      if (estado.aparelhos.some((d) => d.udid.toLowerCase() === a.udid.toLowerCase())) return erro(409, 'ENTITY_ERROR.ATTRIBUTE.INVALID', 'este UDID já está registrado');
      if (!/^([0-9A-Fa-f]{8}-[0-9A-Fa-f]{16}|[0-9A-Fa-f]{40})$/.test(a.udid)) return erro(409, 'ENTITY_ERROR.ATTRIBUTE.INVALID', 'UDID inválido', '/data/attributes/udid');
      const novo = { id: novoId('DEV'), name: a.name, udid: a.udid, platform: a.platform, status: 'ENABLED' };
      estado.aparelhos.push(novo);
      const { id, ...attributes } = novo;
      return [201, { data: { type: 'devices', id, attributes } }];
    },
    // ------------------------------------------------ App ID (capacidades: o push do ADR-47)
    'GET /v1/bundleIds': ({ url }) => {
      const prefixo = url.searchParams.get('filter[identifier]');
      // Como a Apple: o filtro casa pelo começo (a extensão vem junto com o app).
      const lista = estado.bundles.filter((b) => !prefixo || b.identifier.startsWith(prefixo));
      const incluir = (url.searchParams.get('include') ?? '').split(',').includes('bundleIdCapabilities');
      const capacidade = (c) => ({ type: 'bundleIdCapabilities', id: c.id, attributes: { capabilityType: c.tipo, settings: null } });
      const resposta = {
        data: lista.map((b) => ({
          type: 'bundleIds',
          id: b.id,
          attributes: { name: b.name, identifier: b.identifier, platform: 'IOS', seedId: '7C4RPFMC9G' },
          relationships: {
            bundleIdCapabilities: incluir ? { data: b.capacidades.map(({ id }) => ({ type: 'bundleIdCapabilities', id })) } : {},
          },
        })),
      };
      if (incluir) resposta.included = lista.flatMap((b) => b.capacidades.map(capacidade));
      return [200, resposta];
    },
    'POST /v1/bundleIdCapabilities': ({ corpo }) => {
      if (o.recusarCapacidade) return erro(403, 'FORBIDDEN_ERROR', 'The API key in use does not allow this request');
      const tipo = corpo.data.attributes.capabilityType;
      const b = estado.bundles.find((x) => x.id === corpo.data.relationships.bundleId.data.id);
      if (!b) return erro(404, 'NOT_FOUND', 'App ID inexistente', '/data/relationships/bundleId');
      if (b.capacidades.some((c) => c.tipo === tipo)) return erro(409, 'ENTITY_ERROR.ATTRIBUTE.INVALID', `${tipo} já está ligado neste App ID`, '/data/attributes/capabilityType');
      const nova = { id: `${b.id}_${tipo}`, tipo };
      b.capacidades.push(nova);
      return [201, { data: { type: 'bundleIdCapabilities', id: nova.id, attributes: { capabilityType: tipo, settings: null } } }];
    },
  };

  function erro(status, code, detail, pointer) {
    return [status, { errors: [{ status: String(status), code, title: code.split('.')[0], detail, ...(pointer ? { source: { pointer } } : {}) }] }];
  }

  /** As uploadOperations que a Apple devolve: o arquivo em partes, um PUT por parte. */
  function operacoesDeUpload(porta, rota, id, tamanho, tipo) {
    const operacoes = [];
    for (let offset = 0, parte = 0; offset < tamanho; offset += PARTE_DO_UPLOAD, parte++) {
      operacoes.push({
        method: 'PUT',
        url: `http://127.0.0.1:${porta}/_${rota}/${id}/${parte}`,
        offset,
        length: Math.min(PARTE_DO_UPLOAD, tamanho - offset),
        requestHeaders: [{ name: 'Content-Type', value: tipo }],
      });
    }
    return operacoes;
  }

  /** Junta as partes recebidas, confere inteireza e MD5 e anota o erro (captura ou anexo). */
  function juntarPartes(x) {
    const partes = Object.keys(x.partes).length;
    const bytes = Buffer.concat(Object.keys(x.partes).sort((a, b) => a - b).map((k) => x.partes[k]));
    x.bytes = bytes.length;
    x.md5 = createHash('md5').update(bytes).digest('hex');
    if (partes !== x.totalDePartes || bytes.length !== x.esperado) x.erros.push({ code: 'FILE_INCOMPLETE', description: 'nem todas as partes chegaram' });
    else if (x.md5 !== x.checksum) x.erros.push({ code: 'CHECKSUM_MISMATCH', description: 'o MD5 não confere com os bytes recebidos' });
    return bytes;
  }

  const servidor = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const pedacos = [];
    req.on('data', (p) => pedacos.push(p));
    req.on('end', () => {
      const bruto = Buffer.concat(pedacos);
      const responder = (codigo, dado) => {
        if (codigo === 204) {
          res.writeHead(204);
          return res.end();
        }
        res.writeHead(codigo, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(dado));
      };

      if (req.method === 'GET' && url.pathname === '/_estado') return responder(200, estado);
      const upload = /^\/_upload\/([^/]+)\/(\d+)$/.exec(url.pathname);
      if (req.method === 'PUT' && upload) {
        const c = estado.capturas[upload[1]];
        if (!c) return responder(404, {});
        if (o.falharUploadDoTipo && estado.conjuntos[c.conjunto]?.tipo === o.falharUploadDoTipo) return responder(500, {});
        c.partes[upload[2]] = bruto;
        return responder(200, {});
      }
      const uploadAnexo = /^\/_upload-anexo\/([^/]+)\/(\d+)$/.exec(url.pathname);
      if (req.method === 'PUT' && uploadAnexo) {
        const a = estado.anexos[uploadAnexo[1]];
        if (!a) return responder(404, {});
        if (o.falharUploadDoAnexo && a.nome === o.falharUploadDoAnexo) return responder(500, {});
        a.partes[uploadAnexo[2]] = bruto;
        return responder(200, {});
      }

      if (!/^Bearer ey/.test(req.headers.authorization ?? '')) return responder(401, { errors: [{ status: '401', code: 'NOT_AUTHORIZED', title: 'sem JWT', detail: 'sem JWT' }] });

      let alvo = null;
      for (const r of ROTAS_COMPILADAS) {
        const m = r.metodo === req.method && r.re.exec(url.pathname);
        if (m) {
          alvo = { rota: r.rota, ids: m.slice(1) };
          break;
        }
      }
      const rotaPedida = `${req.method} ${url.pathname}`;
      estado.requisicoes.push(alvo?.rota ?? rotaPedida);
      if (!alvo) {
        const erros = [{ status: '404', code: 'NOT_FOUND', title: 'rota fora da especificação', detail: rotaPedida }];
        estado.recusas.push({ rota: rotaPedida, status: 404, erros });
        return responder(404, { errors: erros });
      }
      const errosDaConsulta = validarConsulta(alvo.rota, url);
      if (errosDaConsulta.length) {
        estado.recusas.push({ rota: alvo.rota, status: 400, erros: errosDaConsulta });
        return responder(400, { errors: errosDaConsulta });
      }
      let corpo = null;
      if (bruto.length) {
        try {
          corpo = JSON.parse(bruto.toString());
        } catch {
          return responder(400, { errors: [{ status: '400', code: 'PARAMETER_ERROR', title: 'JSON inválido', detail: 'JSON inválido' }] });
        }
      }
      const esquema = ROTAS[alvo.rota].corpo;
      if (esquema) {
        const erros = validarCorpo(esquema, corpo);
        if (erros.length) {
          estado.recusas.push({ rota: alvo.rota, status: 409, erros });
          return responder(409, { errors: erros });
        }
      }
      const tratar = H[alvo.rota];
      if (!tratar) return responder(500, { errors: [{ status: '500', code: 'MOCK', title: 'sem implementação no mock', detail: alvo.rota }] });
      const [codigo, dado] = tratar({ ...alvo, corpo, url, porta: servidor.address().port });
      // GET com 404 é resposta normal ("ainda não existe"), não recusa.
      const naoExiste = req.method === 'GET' && codigo === 404;
      if (codigo >= 400 && !naoExiste && !estado.recusas.some((r) => r.erros === dado.errors)) {
        estado.recusas.push({ rota: alvo.rota, status: codigo, erros: dado.errors, regra: true });
      }
      return responder(codigo, dado);
    });
  });

  return new Promise((resolver) => {
    servidor.listen(0, '127.0.0.1', () =>
      resolver({
        porta: servidor.address().port,
        estado,
        /** O dono respondeu na tela o que a API não alcança (ex.: as perguntas novas de idade). */
        responderNaTela(atributos) {
          const info = infoEditavel();
          Object.assign(estado.idade[info.id], atributos);
        },
        /**
         * A Apple devolve o envio que está na fila: o envio vira UNRESOLVED_ISSUES, os itens,
         * REJECTED, e a versão, `estadoDaVersao` (REJECTED na recusa; METADATA_REJECTED quando
         * só a ficha precisa de mudança, como num pedido de informação).
         */
        rejeitar({ estadoDaVersao: novo = 'REJECTED' } = {}) {
          const envio = [...estado.envios].reverse().find((e) => e.estado === 'WAITING_FOR_REVIEW');
          if (!envio) throw new Error('não há envio esperando revisão para rejeitar');
          envio.estado = 'UNRESOLVED_ISSUES';
          for (const i of envio.itens) {
            if (i.estado === 'REMOVED') continue;
            i.estado = 'REJECTED';
            Object.assign(versao(i.versao), { appStoreState: novo, appVersionState: novo });
          }
          return envio.id;
        },
        /** Um build novo da versão: aparece na próxima consulta e fica VALID em `validoEm` consultas. */
        novoBuild({ id, numero, versao: versaoDoBuild = o.versaoDoBuild, validoEm = 1 }) {
          const n = estado.consultasDeBuild;
          listaDeBuilds.push({ id, versao: versaoDoBuild, numero, uploadedDate: new Date(Date.UTC(2026, 10, 18, 12, listaDeBuilds.length)).toISOString(), aparece: n + 1, valido: n + validoEm });
        },
        /**
         * Os anexos da revisão da versão passam a ser estes — o que outra rodada, o site ou o
         * publicador de antes da regra de um só deixou lá (dois anexos, um guia velho, uma
         * reserva pela metade). Não passa pelo POST, então não esbarra na regra. Devolve os ids.
         * `estado`: 'COMPLETE' (padrão), 'UPLOAD_COMPLETE' (processando), 'AWAITING_UPLOAD' ou 'FAILED'.
         */
        anexosNaRevisao(lista, versaoId = 'VER1') {
          const detalhe = estado.revisoes[versaoId]?.id;
          if (!detalhe) throw new Error(`a versão ${versaoId} ainda não tem detalhe de revisão`);
          for (const [id, a] of Object.entries(estado.anexos)) if (a.detalhe === detalhe) delete estado.anexos[id];
          return lista.map(({ nome, dados, estado: situacao = 'COMPLETE' }) => {
            const id = novoId('ATT');
            const soma = createHash('md5').update(dados).digest('hex');
            const erros = situacao === 'FAILED' ? [{ code: 'FILE_INCOMPLETE', description: 'nem todas as partes chegaram' }] : [];
            estado.anexos[id] = { detalhe, nome, esperado: dados.length, partes: {}, totalDePartes: 0, bytes: dados.length, md5: soma, checksum: soma, estado: situacao, erros };
            return id;
          });
        },
        /** O upload dos anexos volta a funcionar (fim do `falharUploadDoAnexo`). */
        consertarUploadDoAnexo() {
          o.falharUploadDoAnexo = null;
        },
        estadoDaVersao: (id) => estadoDaVersao(versao(id)),
        fechar: () => new Promise((r) => servidor.close(r)),
      }),
    );
  });
}
