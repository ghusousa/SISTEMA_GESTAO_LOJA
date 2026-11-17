/**
 * Uma App Store Connect de mentira, na memória, para testar o publicador de ponta a ponta
 * sem tocar na conta de verdade. Ela COBRA como a de verdade:
 *
 *  - toda rota tem de existir na especificação oficial (esquema-asc.mjs, gerado da 4.6);
 *  - todo parâmetro de consulta e todo corpo é conferido contra o esquema: atributo
 *    desconhecido, tipo errado, valor fora da lista ou campo obrigatório faltando voltam
 *    400/409 no formato de erro da Apple, e ficam anotados em `estado.recusas`;
 *  - captura só vira COMPLETE se os bytes chegaram inteiros, o MD5 confere e o PNG tem o
 *    tamanho do slot, sem alfa;
 *  - o envio para revisão só passa com a ficha completa (classificação etária inteira,
 *    direitos de conteúdo, disponibilidade, capturas de 6,5" processadas, conta demo, preço,
 *    build preso, "Novidades" quando é atualização) — senão, 409 com `associatedErrors`.
 *
 * `opcoes` liga os cenários (app já lançado, build que demora, upload de 6,9" que cai...).
 * Tudo o que recebeu fica em `estado` (também em GET /_estado).
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

const PADRAO = {
  appExiste: true,
  jaLancado: false, // existe a 0.9.0 à venda — e o appInfo dela, que não é mais editável
  disponibilidade: false, // a conta já tem disponibilidade definida
  semDisponibilidade: 404, // quando não tem: 404 ou 'nulo' (200 com data: null)
  idadeDesconhece: [], // atributos que esta Apple recusa como desconhecidos
  descritoresNovos: [], // perguntas novas (fora da 4.6) que ela cobra no envio
  falharUploadDoTipo: null, // ex.: 'APP_IPHONE_67' → o PUT dos bytes devolve 500
  buildValidoNaConsulta: 1, // em que consulta a /v1/builds o build da versão fica VALID
  buildNunca: false, // fica em PROCESSING para sempre
  versaoDoBuild: '1.0.0',
  revisaoEcoaSenha: false, // o POST do detalhe de revisão devolve 409 citando a senha
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

// ---------------------------------------------------------------- o servidor

export function subirMock(opcoesDoTeste = {}) {
  const o = { ...PADRAO, ...opcoesDoTeste };
  let sequencia = 0;
  const novoId = (prefixo) => `${prefixo}${++sequencia}`;
  const perguntas = Object.keys(CORPOS.AgeRatingDeclarationUpdateRequest.atributos);
  const declaracaoVazia = () => Object.fromEntries([...perguntas, ...o.descritoresNovos].map((n) => [n, null]));

  const estado = {
    app: {
      name: 'Gestão de Loja',
      bundleId: 'com.gestaoloja.app',
      sku: 'gestao-loja',
      primaryLocale: 'en-US',
      contentRightsDeclaration: null,
    },
    infos: o.jaLancado
      ? [{ id: 'INFO0', state: 'READY_FOR_DISTRIBUTION' }]
      : [{ id: 'INFO1', state: 'PREPARE_FOR_SUBMISSION' }],
    infoLocs: {}, // infoId -> atributos
    categorias: {}, // infoId -> {principal, secundaria}
    idade: {}, // infoId -> atributos da declaração
    idadeRecebida: [], // cada PATCH, como chegou
    disponibilidade: o.disponibilidade ? { availableInNewTerritories: true, territorios: ['BRA', 'USA', 'PRT'], criadaPeloTeste: true } : null,
    disponibilidadeCriada: null,
    versoes: o.jaLancado
      ? [{ id: 'VER0', platform: 'IOS', versionString: '0.9.0', appStoreState: 'READY_FOR_SALE', appVersionState: 'READY_FOR_DISTRIBUTION' }]
      : [],
    versaoLocs: {}, // id -> {versao, atributos}
    conjuntos: {}, // id -> {loc, tipo, ordem}
    capturas: {}, // id -> {conjunto, nome, esperado, partes, bytes, md5, checksum, estado, erros}
    capturasApagadas: [],
    conjuntosApagados: [],
    revisoes: {}, // versaoId -> {id, atributos}
    preco: null,
    consultasDeBuild: 0,
    buildPreso: {}, // versaoId -> buildId
    envios: [], // {id, estado, platform, itens: [versaoId], tentativas}
    recusas: [], // {rota, status, erros, simulada}
    requisicoes: [],
  };
  for (const info of estado.infos) estado.idade[info.id] = declaracaoVazia();

  const versao = (id) => estado.versoes.find((v) => v.id === id);
  const estadoDaVersao = (v) => v.appVersionState ?? v.appStoreState;
  const editavel = (v) => ['PREPARE_FOR_SUBMISSION', 'REJECTED', 'DEVELOPER_REJECTED', 'METADATA_REJECTED'].includes(v?.appStoreState);
  const jaLancado = () => estado.versoes.some((v) => JA_ESTEVE_A_VENDA.has(v.appStoreState));
  const infoEditavel = () => estado.infos.find((i) => i.state === 'PREPARE_FOR_SUBMISSION');
  const capturasDoConjunto = (id) => {
    const c = estado.conjuntos[id];
    const todas = Object.entries(estado.capturas).filter(([, x]) => x.conjunto === id).map(([i]) => i);
    if (!c.ordem) return todas;
    // A ordem gravada vale para quem está nela; captura nova entra no fim até a próxima ordem.
    const naOrdem = c.ordem.filter((i) => todas.includes(i));
    return [...naOrdem, ...todas.filter((i) => !naOrdem.includes(i))];
  };
  const builds = () => {
    const lista = [];
    if (o.jaLancado) {
      lista.push({ id: 'B0', versao: '0.9.0', attributes: { version: '3', processingState: 'VALID', expired: false, uploadedDate: '2026-01-10T10:00:00Z' } });
    }
    const n = estado.consultasDeBuild;
    let situacao = null;
    if (o.buildNunca) situacao = 'PROCESSING';
    else if (n >= o.buildValidoNaConsulta) situacao = 'VALID';
    else if (n === o.buildValidoNaConsulta - 1) situacao = 'PROCESSING';
    if (situacao) {
      lista.push({ id: 'B1', versao: o.versaoDoBuild, attributes: { version: '7', processingState: situacao, expired: false, uploadedDate: '2026-11-17T12:00:00Z' } });
    }
    return lista;
  };

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
      const loc = estado.infoLocs[info.id];
      if (!loc?.name || !loc?.privacyPolicyUrl) falta(`/v1/appInfos/${info.id}`, 'nome e URL de privacidade em pt-BR');
      if (!estado.categorias[info.id]) falta(`/v1/appInfos/${info.id}`, 'categoria principal');
      const decl = estado.idade[info.id];
      const cobradas = [...perguntas.filter((p) => !OPCIONAIS_DA_DECLARACAO.has(p) && !o.idadeDesconhece.includes(p)), ...o.descritoresNovos];
      const emBranco = cobradas.filter((p) => decl[p] === null || decl[p] === undefined);
      if (emBranco.length) {
        falta(`/v1/ageRatingDeclarations/AGE-${info.id}`, `A classificação etária (ageRatingDeclaration) exige resposta para: ${emBranco.join(', ')}`);
      }
    }
    if (!estado.disponibilidade) falta('/v1/apps/APP1/appAvailabilityV2', 'defina em quais países o app é vendido');
    const loc = Object.entries(estado.versaoLocs).find(([, l]) => l.versao === versaoId && l.atributos.locale === 'pt-BR');
    if (!loc) falta(`/v1/appStoreVersions/${versaoId}`, 'localização pt-BR');
    else {
      const a = loc[1].atributos;
      for (const campo of ['description', 'keywords', 'supportUrl']) if (!a[campo]) falta(`/v1/appStoreVersionLocalizations/${loc[0]}`, `${campo} é obrigatório`);
      if (jaLancado() && !a.whatsNew) falta(`/v1/appStoreVersionLocalizations/${loc[0]}`, 'whatsNew é obrigatório numa atualização');
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
    if (v && estadoDaVersao(v) !== 'PREPARE_FOR_SUBMISSION' && !editavel(v)) falta(`/v1/appStoreVersions/${versaoId}`, 'versão não editável', 'STATE_ERROR');
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
    'GET /v1/appInfos/{id}/appInfoLocalizations': ({ ids }) => {
      const loc = estado.infoLocs[ids[0]];
      return [200, { data: loc ? [{ type: 'appInfoLocalizations', id: `ILOC-${ids[0]}`, attributes: loc }] : [] }];
    },
    'POST /v1/appInfoLocalizations': ({ corpo }) => {
      const infoId = corpo.data.relationships.appInfo.data.id;
      if (infoEditavel()?.id !== infoId) return erro(409, 'STATE_ERROR', `appInfo ${infoId} não é editável`);
      estado.infoLocs[infoId] = { ...corpo.data.attributes };
      return [201, { data: { type: 'appInfoLocalizations', id: `ILOC-${infoId}`, attributes: estado.infoLocs[infoId] } }];
    },
    'PATCH /v1/appInfoLocalizations/{id}': ({ ids, corpo }) => {
      const infoId = ids[0].replace('ILOC-', '');
      if (infoEditavel()?.id !== infoId) return erro(409, 'STATE_ERROR', `appInfo ${infoId} não é editável`);
      Object.assign(estado.infoLocs[infoId], corpo.data.attributes);
      return [200, { data: { type: 'appInfoLocalizations', id: ids[0], attributes: estado.infoLocs[infoId] } }];
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
    'POST /v2/appAvailabilities': ({ corpo }) => {
      if (estado.disponibilidade) return erro(409, 'ENTITY_ERROR', 'a disponibilidade já existe');
      const citados = corpo.data.relationships.territoryAvailabilities.data.map((d) => d.id);
      const incluidos = corpo.included ?? [];
      if (citados.some((id) => !ID_LOCAL.test(id)) || citados.join() !== incluidos.map((i) => i.id).join()) {
        return erro(409, 'ENTITY_ERROR.RELATIONSHIP.INVALID', 'territoryAvailabilities tem de citar os ids locais ${...} de included');
      }
      const territorios = incluidos.map((i) => ({ id: i.relationships?.territory?.data?.id, available: i.attributes?.available }));
      if (territorios.some((t) => !TERRITORIOS.has(t.id))) return erro(409, 'ENTITY_ERROR.RELATIONSHIP.INVALID', 'território desconhecido');
      estado.disponibilidadeCriada = { availableInNewTerritories: corpo.data.attributes.availableInNewTerritories, territorios };
      estado.disponibilidade = { availableInNewTerritories: corpo.data.attributes.availableInNewTerritories, territorios: territorios.map((t) => t.id) };
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
        if (estado.infoLocs[anterior.id]) estado.infoLocs.INFO1 = { ...estado.infoLocs[anterior.id] };
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
      const operacoes = [];
      for (let offset = 0, parte = 0; offset < fileSize; offset += PARTE_DO_UPLOAD, parte++) {
        operacoes.push({
          method: 'PUT',
          url: `http://127.0.0.1:${porta}/_upload/${id}/${parte}`,
          offset,
          length: Math.min(PARTE_DO_UPLOAD, fileSize - offset),
          requestHeaders: [{ name: 'Content-Type', value: 'image/png' }],
        });
      }
      estado.capturas[id] = { conjunto, nome: fileName, esperado: fileSize, partes: {}, totalDePartes: operacoes.length, md5: null, checksum: null, estado: 'AWAITING_UPLOAD', erros: [] };
      return [201, { data: { type: 'appScreenshots', id, attributes: { fileName, fileSize, uploadOperations: operacoes } } }];
    },
    'PATCH /v1/appScreenshots/{id}': ({ ids, corpo }) => {
      const c = estado.capturas[ids[0]];
      if (!c) return erro(404, 'NOT_FOUND', 'captura inexistente');
      const a = corpo.data.attributes ?? {};
      c.checksum = a.sourceFileChecksum ?? c.checksum;
      if (a.uploaded === true) {
        const partes = Object.keys(c.partes).length;
        const bytes = Buffer.concat(Object.keys(c.partes).sort((x, y) => x - y).map((k) => c.partes[k]));
        c.bytes = bytes.length;
        c.md5 = createHash('md5').update(bytes).digest('hex');
        const png = lerPng(bytes);
        const tipo = estado.conjuntos[c.conjunto].tipo;
        if (partes !== c.totalDePartes || bytes.length !== c.esperado) c.erros.push({ code: 'FILE_INCOMPLETE', description: 'nem todas as partes chegaram' });
        else if (c.md5 !== c.checksum) c.erros.push({ code: 'CHECKSUM_MISMATCH', description: 'o MD5 não confere com os bytes recebidos' });
        else if (!png || !TAMANHOS_DO_SLOT[tipo].includes(png.tamanho)) c.erros.push({ code: 'IMAGE_INCORRECT_DIMENSIONS', description: `tamanho ${png?.tamanho} não serve para ${tipo}` });
        else if (png.tipoDeCor !== 2) c.erros.push({ code: 'IMAGE_ALPHA_NOT_ALLOWED', description: 'canal alfa não é aceito' });
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
      estado.revisoes[versaoId] = { id: `REV-${versaoId}`, atributos: { ...corpo.data.attributes } };
      return [201, { data: { type: 'appStoreReviewDetails', id: `REV-${versaoId}` } }];
    },
    'PATCH /v1/appStoreReviewDetails/{id}': ({ ids, corpo }) => {
      const versaoId = ids[0].replace('REV-', '');
      Object.assign(estado.revisoes[versaoId].atributos, corpo.data.attributes);
      return [200, { data: { type: 'appStoreReviewDetails', id: ids[0] } }];
    },
    'GET /v1/apps/{id}/appPricePoints': ({ url }) => [
      200,
      { data: [{ type: 'appPricePoints', id: `PP-${url.searchParams.get('filter[territory]')}-0`, attributes: { customerPrice: '0.0', proceeds: '0.0' } }] },
    ],
    'POST /v1/appPriceSchedules': ({ corpo }) => {
      const citados = corpo.data.relationships.manualPrices.data.map((d) => d.id);
      const incluidos = (corpo.included ?? []).filter((i) => i.type === 'appPrices');
      if (citados.join() !== incluidos.map((i) => i.id).join()) return erro(409, 'ENTITY_ERROR.RELATIONSHIP.INVALID', 'manualPrices tem de citar os ids de included');
      estado.preco = incluidos[0].relationships.appPricePoint.data.id;
      return [201, { data: { type: 'appPriceSchedules', id: 'PS1' } }];
    },
    'GET /v1/builds': ({ url }) => {
      estado.consultasDeBuild += 1;
      const versaoPedida = url.searchParams.get('filter[preReleaseVersion.version]');
      const lista = builds()
        .filter((b) => !versaoPedida || versaoPedida.split(',').includes(b.versao))
        .sort((a, b) => b.attributes.uploadedDate.localeCompare(a.attributes.uploadedDate));
      return [200, { data: lista.map(({ id, attributes }) => ({ type: 'builds', id, attributes })) }];
    },
    'PATCH /v1/appStoreVersions/{id}/relationships/build': ({ ids, corpo }) => {
      const b = builds().find((x) => x.id === corpo.data.id);
      const v = versao(ids[0]);
      if (!b || b.attributes.processingState !== 'VALID') return erro(409, 'STATE_ERROR', 'build não está VALID');
      if (b.versao !== v.versionString) return erro(409, 'ENTITY_ERROR.RELATIONSHIP.INVALID', `build da ${b.versao} não serve na versão ${v.versionString}`);
      estado.buildPreso[ids[0]] = b.id;
      return [204, null];
    },
    'GET /v1/reviewSubmissions': ({ url }) => {
      const estados = url.searchParams.get('filter[state]')?.split(',');
      const lista = estado.envios.filter((e) => !estados || estados.includes(e.estado));
      return [200, { data: lista.map((e) => ({ type: 'reviewSubmissions', id: e.id, attributes: { platform: e.platform, state: e.estado } })) }];
    },
    'POST /v1/reviewSubmissions': ({ corpo }) => {
      const platform = corpo.data.attributes?.platform ?? 'IOS';
      if (estado.envios.some((e) => e.platform === platform && e.estado === 'READY_FOR_REVIEW')) {
        return erro(409, 'ENTITY_ERROR', 'já existe um envio aberto para esta plataforma');
      }
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
          data: envio.itens.map((versaoId, i) => ({
            type: 'reviewSubmissionItems',
            id: `${envio.id}-I${i}`,
            attributes: { state: 'READY_FOR_REVIEW' },
            ...(incluir ? { relationships: { appStoreVersion: { data: { type: 'appStoreVersions', id: versaoId } } } } : {}),
          })),
        },
      ];
    },
    'POST /v1/reviewSubmissionItems': ({ corpo }) => {
      const envio = estado.envios.find((e) => e.id === corpo.data.relationships.reviewSubmission.data.id);
      const versaoId = corpo.data.relationships.appStoreVersion?.data?.id;
      if (!envio || envio.estado !== 'READY_FOR_REVIEW') return erro(409, 'STATE_ERROR', 'o envio não aceita itens');
      if (envio.itens.includes(versaoId)) return erro(409, 'ENTITY_ERROR', 'esta versão já está no envio');
      envio.itens.push(versaoId);
      return [201, { data: { type: 'reviewSubmissionItems', id: `${envio.id}-I${envio.itens.length - 1}` } }];
    },
    'PATCH /v1/reviewSubmissions/{id}': ({ ids, corpo, rota }) => {
      const envio = estado.envios.find((e) => e.id === ids[0]);
      if (corpo.data.attributes?.submitted !== true) return [200, { data: { type: 'reviewSubmissions', id: envio.id } }];
      envio.tentativas += 1;
      if (!envio.itens.length) return erro(409, 'STATE_ERROR', 'envio sem itens');
      const faltas = Object.assign({}, ...envio.itens.map(faltasParaEnviar));
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
      for (const versaoId of envio.itens) Object.assign(versao(versaoId), { appStoreState: 'WAITING_FOR_REVIEW', appVersionState: 'WAITING_FOR_REVIEW' });
      return [200, { data: { type: 'reviewSubmissions', id: envio.id, attributes: { state: envio.estado } } }];
    },
  };

  function erro(status, code, detail, pointer) {
    return [status, { errors: [{ status: String(status), code, title: code.split('.')[0], detail, ...(pointer ? { source: { pointer } } : {}) }] }];
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
        fechar: () => new Promise((r) => servidor.close(r)),
      }),
    );
  });
}
