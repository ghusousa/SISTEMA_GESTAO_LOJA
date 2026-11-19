#!/usr/bin/env node
/**
 * Gera `esquema-asc.mjs`: o recorte da especificação OFICIAL da App Store Connect API que o
 * publicador usa — as rotas, os parâmetros de consulta e o formato de cada corpo de
 * requisição. A Apple de mentira (mock-asc.mjs) confere TUDO o que o publicador manda
 * contra este recorte: atributo com nome errado, tipo errado, valor fora da lista ou rota
 * que não existe quebram o teste aqui, e não a publicação lá.
 *
 *   node publicar/teste/gerar-esquema.mjs caminho/openapi.oas.json
 *
 * O JSON é o que a Apple publica em developer.apple.com (App Store Connect API → "OpenAPI
 * specification"). Saiu versão nova? Baixe, rode de novo e leia o diff do esquema-asc.mjs:
 * pergunta nova na classificação etária, por exemplo, aparece como atributo novo em
 * AgeRatingDeclarationUpdateRequest — e o teste avisa que o publicador ainda não a responde.
 *
 * Rota nova no publicador? Ponha em ROTAS abaixo e rode: se ela não existir na especificação,
 * este script para e diz qual.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = dirname(fileURLToPath(import.meta.url));

/** Toda rota que publicar.mjs e ci.mjs chamam, como "MÉTODO /caminho/{id}". */
const ROTAS = [
  'GET /v1/apps',
  'PATCH /v1/apps/{id}',
  'GET /v1/apps/{id}/appInfos',
  'GET /v1/appInfos/{id}/appInfoLocalizations',
  'POST /v1/appInfoLocalizations',
  'PATCH /v1/appInfoLocalizations/{id}',
  'DELETE /v1/appInfoLocalizations/{id}',
  'PATCH /v1/appInfos/{id}',
  'GET /v1/appInfos/{id}/ageRatingDeclaration',
  'PATCH /v1/ageRatingDeclarations/{id}',
  'GET /v1/apps/{id}/appAvailabilityV2',
  // Os territórios de uma disponibilidade que já existe: as notas dizem "Brazil only".
  'GET /v2/appAvailabilities/{id}/territoryAvailabilities',
  // Todos os territórios: a criação da disponibilidade exige a lista inteira (available true/false).
  'GET /v1/territories',
  'POST /v2/appAvailabilities',
  'GET /v1/apps/{id}/appStoreVersions',
  'POST /v1/appStoreVersions',
  'PATCH /v1/appStoreVersions/{id}',
  'GET /v1/appStoreVersions/{id}/appStoreVersionLocalizations',
  'POST /v1/appStoreVersionLocalizations',
  'PATCH /v1/appStoreVersionLocalizations/{id}',
  'DELETE /v1/appStoreVersionLocalizations/{id}',
  'GET /v1/appStoreVersionLocalizations/{id}/appScreenshotSets',
  'POST /v1/appScreenshotSets',
  'DELETE /v1/appScreenshotSets/{id}',
  'GET /v1/appScreenshotSets/{id}/appScreenshots',
  'PATCH /v1/appScreenshotSets/{id}/relationships/appScreenshots',
  'POST /v1/appScreenshots',
  'PATCH /v1/appScreenshots/{id}',
  'DELETE /v1/appScreenshots/{id}',
  'GET /v1/appStoreVersions/{id}/appStoreReviewDetail',
  'POST /v1/appStoreReviewDetails',
  'PATCH /v1/appStoreReviewDetails/{id}',
  // Anexos da revisão (o guia PDF e o vídeo): reservar → PUT dos bytes → confirmar com o MD5.
  'GET /v1/appStoreReviewDetails/{id}/appStoreReviewAttachments',
  'POST /v1/appStoreReviewAttachments',
  'GET /v1/appStoreReviewAttachments/{id}',
  'PATCH /v1/appStoreReviewAttachments/{id}',
  'DELETE /v1/appStoreReviewAttachments/{id}',
  'GET /v1/apps/{id}/appPricePoints',
  'POST /v1/appPriceSchedules',
  'GET /v1/builds',
  // O build que a versão já tem preso (o da submissão que a Apple devolveu).
  'GET /v1/appStoreVersions/{id}/build',
  'PATCH /v1/appStoreVersions/{id}/relationships/build',
  'GET /v1/reviewSubmissions',
  'POST /v1/reviewSubmissions',
  'PATCH /v1/reviewSubmissions/{id}',
  'GET /v1/reviewSubmissions/{id}/items',
  'POST /v1/reviewSubmissionItems',
  'PATCH /v1/reviewSubmissionItems/{id}',
  // ci.mjs aparelhos: o perfil ad hoc do teste em iPhones reais pede um aparelho registrado.
  'GET /v1/devices',
  'POST /v1/devices',
];

const caminhoSpec = process.argv[2];
if (!caminhoSpec) {
  process.stderr.write('Uso: node publicar/teste/gerar-esquema.mjs caminho/openapi.oas.json\n');
  process.exit(2);
}
const spec = JSON.parse(readFileSync(caminhoSpec, 'utf8'));
const esquemas = spec.components.schemas;
const nomeDoRef = (ref) => ref.replace('#/components/schemas/', '');

/** Segue $ref até o esquema de verdade (ex.: ScreenshotDisplayType → string com enum). */
function resolver(no) {
  let atual = no;
  const vistos = new Set();
  while (atual?.$ref) {
    const nome = nomeDoRef(atual.$ref);
    if (vistos.has(nome)) throw new Error(`$ref circular em ${nome}`);
    vistos.add(nome);
    atual = { ...esquemas[nome], nullable: atual.nullable ?? esquemas[nome].nullable };
  }
  return atual;
}

/** Atributo → { t, nulo?, enum?, formato? } (só o que a validação usa). */
function descreverAtributo(no) {
  const r = resolver(no);
  const d = { t: r.type ?? 'object' };
  if (no.nullable || r.nullable) d.nulo = true;
  if (r.enum) d.enum = r.enum;
  if (r.format) d.formato = r.format;
  if (r.type === 'array') d.itens = descreverAtributo(r.items ?? {});
  return d;
}

/** {type, id} de um relacionamento: o tipo aceito e se é lista. */
function descreverRelacao(no) {
  const dado = resolver(no).properties?.data;
  if (!dado) return null;
  const lista = dado.type === 'array';
  const item = lista ? dado.items : dado;
  return { tipo: item.properties?.type?.enum?.[0] ?? null, lista };
}

/** Recurso JSON:API (o `data` de um corpo, ou um item de `included`). */
function descreverRecurso(no) {
  const r = resolver(no);
  const p = r.properties ?? {};
  const attrs = resolver(p.attributes ?? {});
  const rels = resolver(p.relationships ?? {});
  const atributos = {};
  for (const [nome, desc] of Object.entries(attrs.properties ?? {})) atributos[nome] = descreverAtributo(desc);
  const relacoes = {};
  for (const [nome, desc] of Object.entries(rels.properties ?? {})) {
    const rel = descreverRelacao(desc);
    if (rel) relacoes[nome] = rel;
  }
  return {
    tipo: p.type?.enum?.[0] ?? null,
    id: (r.required ?? []).includes('id') ? 'obrigatorio' : p.id ? 'opcional' : 'proibido',
    atributos,
    atributosObrigatorios: attrs.required ?? [],
    atributosObrigatorioNoCorpo: (r.required ?? []).includes('attributes'),
    relacoes,
    relacoesObrigatorias: rels.required ?? [],
  };
}

const CORPOS = {};
const INCLUIDOS = {};

function descreverCorpo(nome) {
  if (CORPOS[nome]) return;
  const e = esquemas[nome];
  if (!e) throw new Error(`esquema ${nome} não existe na especificação`);
  const dado = e.properties.data;
  const corpo = {};
  if (dado.type === 'array') {
    corpo.lista = true;
    corpo.tipo = dado.items.properties.type.enum[0];
  } else {
    Object.assign(corpo, descreverRecurso(dado));
  }
  const incluidos = e.properties.included?.items;
  if (incluidos) {
    const refs = incluidos.oneOf ? incluidos.oneOf.map((o) => o.$ref) : [incluidos.$ref];
    corpo.incluidos = refs.map((ref) => {
      const n = nomeDoRef(ref);
      INCLUIDOS[n] ??= descreverRecurso({ $ref: ref });
      return n;
    });
  }
  CORPOS[nome] = corpo;
}

const SAIDA_ROTAS = {};
for (const rota of ROTAS) {
  const [metodo, caminho] = rota.split(' ');
  const op = spec.paths[caminho]?.[metodo.toLowerCase()];
  if (!op) throw new Error(`A rota ${rota} NÃO existe na especificação ${spec.info?.version}.`);
  const saida = {};
  const parametros = [...(spec.paths[caminho].parameters ?? []), ...(op.parameters ?? [])].filter(
    (p) => p.in === 'query',
  );
  if (parametros.length) {
    saida.parametros = {};
    for (const p of parametros) {
      const s = p.schema ?? {};
      const d = {};
      // fields[...] só escolhe colunas da resposta e o publicador não usa: basta o nome.
      const lista = p.name.startsWith('fields[') ? null : (s.items?.enum ?? s.enum);
      if (lista) d.enum = lista;
      if (s.maximum !== undefined) d.maximo = s.maximum;
      if (p.required) d.obrigatorio = true;
      saida.parametros[p.name] = d;
    }
  }
  const ref = op.requestBody?.content?.['application/json']?.schema?.$ref;
  if (ref) {
    saida.corpo = nomeDoRef(ref);
    descreverCorpo(saida.corpo);
  }
  SAIDA_ROTAS[rota] = saida;
}

const ordenar = (obj) => Object.fromEntries(Object.keys(obj).sort().map((k) => [k, obj[k]]));
const texto =
  `// GERADO por publicar/teste/gerar-esquema.mjs a partir da especificação oficial da\n` +
  `// App Store Connect API ${spec.info.version} (JSON OpenAPI publicado pela Apple). Não edite à mão:\n` +
  `// baixe a especificação nova e rode o gerador.\n\n` +
  `export const VERSAO_DA_ESPECIFICACAO = ${JSON.stringify(spec.info.version)};\n\n` +
  `/** "MÉTODO /caminho/{id}" → parâmetros de consulta aceitos e o esquema do corpo. */\n` +
  `export const ROTAS = ${JSON.stringify(SAIDA_ROTAS, null, 2)};\n\n` +
  `/** Esquema → formato do corpo (data.type, id, atributos com tipo/enum/nulo, relações, included). */\n` +
  `export const CORPOS = ${JSON.stringify(ordenar(CORPOS), null, 2)};\n\n` +
  `/** Esquemas dos itens de \`included\` (criação em linha, como o preço e o território). */\n` +
  `export const INCLUIDOS = ${JSON.stringify(ordenar(INCLUIDOS), null, 2)};\n`;
const destino = join(AQUI, 'esquema-asc.mjs');
writeFileSync(destino, texto);
process.stdout.write(
  `✔ ${destino}: ${Object.keys(SAIDA_ROTAS).length} rotas, ${Object.keys(CORPOS).length} corpos, ` +
    `${Object.keys(INCLUIDOS).length} itens de included (especificação ${spec.info.version}).\n`,
);
