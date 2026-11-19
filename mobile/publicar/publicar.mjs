#!/usr/bin/env node
/**
 * Publica a ficha COMPLETA do app na App Store Connect, sem clique nenhum: nome, subtítulo,
 * descrição, texto promocional, palavras-chave, novidades (só em atualização), as capturas
 * de 6,5" (obrigatórias) e de 6,9" (extra), categoria, classificação etária completa,
 * direitos de conteúdo, disponibilidade (só Brasil, se ainda não houver), preço grátis,
 * dados de revisão (conta demo + notas em inglês), os anexos da revisão (o guia PDF e a
 * gravação de tela), o build e o envio — inclusive o REENVIO depois de uma recusa ou de um
 * pedido de informação da Apple (o envio que voltou "UNRESOLVED_ISSUES" é retomado).
 *
 *   npm run publicar                          prepara tudo e PARA antes de enviar para revisão
 *   npm run publicar -- --enviar              faz tudo E envia (ou reenvia) para a revisão
 *   npm run publicar -- --enviar --aguardar-build 60 --build 42
 *                                             espera até 60 min o build 42 (o que esta rodada
 *                                             compilou) ficar VALID na Apple e prende ELE
 *   npm run publicar -- --enviar --mesmo-build
 *                                             reenvia um envio que a Apple devolveu com o MESMO
 *                                             build que já estava preso (resposta que não pede
 *                                             app novo). Sem ela e sem --build, o reenvio com o
 *                                             build antigo é RECUSADO: as notas citam telas que
 *                                             ele pode não ter
 *   npm run publicar -- --video-revisao gravacao.mp4   (ou um endereço https://...)
 *                                             anexa a gravação de tela à revisão
 *   npm run publicar -- --conferir-envio      só confere o que a revisão precisa (abaixo) e a
 *                                             versão na Apple, sem escrever nada — o modo
 *                                             completo do Actions roda isto ANTES de compilar
 *   npm run publicar:simular                  só confere arquivos e textos, sem falar com a Apple
 *
 * --enviar é RECUSADO, antes de mexer em qualquer coisa na Apple, sem a lista de aparelhos
 * testados (ficha/aparelhos-testados.txt), sem a gravação de tela (--video-revisao ou um
 * vídeo já anexado), com o guia PDF desatualizado, com o servidor de demonstração fora do
 * jeito que as notas descrevem, com o app à venda fora do Brasil (as notas dizem "Brazil only")
 * ou reenviando, sem --build nem --mesmo-build, o mesmo build que a Apple devolveu. Só a ficha
 * pode subir sem eles.
 *
 * O que NENHUM programa faz — a API 4.6 da Apple não tem rota para isso:
 *   • criar o registro do app (só no site, uma vez);
 *   • a ficha "Privacidade do App" (uma vez na tela; respostas em docs/LOJAS-DE-APP.md §5);
 *   • escrever na Central de Resolução (a mensagem do App Review) — o reenvio pela API leva
 *     as notas e os anexos novos, e é isso que responde à Apple.
 * O resumo do fim diz o que ficou feito, os avisos e o que ainda precisa de alguém.
 *
 * Variáveis: PUBLICAR_CONFIG (o config.json), PUBLICAR_CAPTURAS (pasta com iphone-6.5/ e
 * iphone-6.9/; padrão media/app-store), PUBLICAR_INTERVALO_BUILD (segundos entre consultas
 * do build; padrão 60), PUBLICAR_INTERVALO_CAPTURAS (segundos entre consultas do
 * processamento das capturas e dos anexos; padrão 5); ASC_BASE e ASC_REPETIR_MS são do
 * asc.mjs. Só para o teste: PUBLICAR_APARELHOS (outra lista de aparelhos), PUBLICAR_TELAS
 * (outra raiz onde procurar as telas citadas) e PUBLICAR_DEMO_BASE (para onde vão as
 * conferências do servidor de demonstração; com o caminho, se ele tiver — <servidor>/demo).
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lerAnexos, NOME_DO_VIDEO, obterVideo, subirAnexo, videoAnexado } from './anexos.mjs';
import { criarCliente } from './asc.mjs';
import { RESPOSTAS, responderClassificacao } from './classificacao.mjs';
import { DO_MODELO_ANTIGO, lerAparelhosTestados, lerConfig, lerFicha } from './ficha.mjs';
import { CONJUNTOS, lerConjunto, subirConjunto } from './imagens.mjs';
import { criarRelatorio } from './relatorio.mjs';
import { lerGuia } from './revisao/guia.mjs';
import { conferirServidorDemo, trocarBase } from './servidor-demo.mjs';
import { estadoDaVersao, mensagemDaTravada, situacaoDaVersao } from './versoes.mjs';

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = resolve(AQUI, '..', '..');
const IDIOMA = 'pt-BR';
const TERRITORIO = 'BRA'; // app em pt-BR, com PIX e NFC-e: serve a loja brasileira

const INFO_EDITAVEL = new Set(['PREPARE_FOR_SUBMISSION', 'DEVELOPER_REJECTED', 'REJECTED', 'METADATA_REJECTED']);
const estadoDoInfo = (i) => i.attributes?.state ?? i.attributes?.appStoreState;
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const hora = () => new Date().toISOString().slice(11, 16);
const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
/** "0.0" (a Apple manda texto) é grátis; vazio ou ausente não é. */
const ehZero = (v) => (typeof v === 'string' ? v.trim() !== '' && Number(v) === 0 : v === 0);
/** A página seguinte de uma listagem da Apple (links.next é um endereço inteiro). */
const proximaPagina = (resposta) => {
  const proxima = resposta?.links?.next;
  if (!proxima) return null;
  const url = new URL(proxima);
  return `${url.pathname}${url.search}`;
};

let relatorio = null;
let appExiste = null;

// ---------- argumentos e ambiente ----------

function lerArgumentos(argv) {
  const args = { simular: false, enviar: false, conferirEnvio: false, aguardarMinutos: 0, build: null, mesmoBuild: false, video: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const valor = () => (a.includes('=') ? a.slice(a.indexOf('=') + 1) : argv[++i]);
    if (a === '--simular') args.simular = true;
    else if (a === '--enviar') args.enviar = true;
    else if (a === '--conferir-envio') args.conferirEnvio = true;
    else if (a === '--mesmo-build') args.mesmoBuild = true;
    else if (a === '--aguardar-build' || a.startsWith('--aguardar-build=')) {
      const bruto = valor();
      const minutos = Number(bruto);
      if (!(minutos > 0)) throw new Error(`--aguardar-build pede os minutos (ex.: --aguardar-build 60), não "${bruto ?? ''}".`);
      args.aguardarMinutos = minutos;
    } else if (a === '--build' || a.startsWith('--build=')) {
      const bruto = valor();
      if (!/^\d+(\.\d+){0,2}$/.test(bruto ?? '')) {
        throw new Error(`--build pede o número do build (o CFBundleVersion que o eas devolveu, ex.: --build 42), não "${bruto ?? ''}".`);
      }
      args.build = bruto;
    } else if (a === '--video-revisao' || a.startsWith('--video-revisao=')) {
      const bruto = valor();
      if (!bruto) throw new Error('--video-revisao pede o arquivo do vídeo ou o endereço https:// dele.');
      args.video = bruto;
    } else {
      throw new Error(
        `Opção desconhecida: ${a}. Use --simular, --enviar, --conferir-envio, --aguardar-build <minutos>, --build <número>, ` +
          '--mesmo-build e/ou --video-revisao <arquivo|https://...>.',
      );
    }
  }
  if (args.mesmoBuild && (args.build || args.aguardarMinutos)) {
    throw new Error('--mesmo-build reenvia o build que a versão já tem preso; --build e --aguardar-build escolhem outro. Use um ou outro.');
  }
  if (args.conferirEnvio && args.enviar) {
    throw new Error('--conferir-envio só confere (não escreve nada na Apple); --enviar faz a mesma conferência antes de enviar. Use um dos dois.');
  }
  return args;
}

function segundosDoAmbiente(variavel, padrao) {
  const bruto = process.env[variavel];
  if (bruto === undefined || bruto === '') return padrao * 1000;
  const n = Number(bruto);
  if (!(n > 0)) throw new Error(`${variavel} tem de ser um número de segundos maior que zero (veio "${bruto}").`);
  return n * 1000;
}

/** Os conjuntos de capturas do disco: 6,5" com problema PARA; 6,9" com problema vira aviso. */
function lerCapturas(base) {
  const lidos = [];
  for (const conjunto of CONJUNTOS) {
    const { arquivos, problemas, ausente } = lerConjunto(base, conjunto);
    if (conjunto.obrigatorio) {
      if (problemas.length) {
        throw new Error(`Capturas ${conjunto.rotulo} (obrigatórias) com problema:\n    - ${problemas.join('\n    - ')}`);
      }
      lidos.push({ conjunto, arquivos });
    } else if (ausente) {
      relatorio.avisar(
        `Sem a pasta ${conjunto.pasta}: as capturas ${conjunto.rotulo} (extra) não sobem, e um conjunto ${conjunto.rotulo} ` +
          'que já esteja na versão é apagado — a App Store mostra as de 6,5" também nos iPhones maiores.',
      );
    } else if (problemas.length) {
      relatorio.avisar(
        `Capturas ${conjunto.rotulo} (extra) ficam de fora: ${problemas.join('; ')}. Um conjunto ${conjunto.rotulo} que já ` +
          'esteja na versão é apagado, para não mostrar telas velhas.',
      );
    } else {
      lidos.push({ conjunto, arquivos });
    }
  }
  const [principalDoDisco, ...extras] = lidos;
  for (const extra of extras) {
    const nomes = (c) => c.arquivos.map((a) => a.nome).join(',');
    if (nomes(extra) !== nomes(principalDoDisco)) {
      relatorio.avisar(
        `As capturas ${extra.conjunto.rotulo} não têm os mesmos nomes e ordem das ` +
          `${principalDoDisco.conjunto.rotulo} — sobem assim mesmo, na ordem da pasta.`,
      );
    }
  }
  return lidos;
}

// ---------- antes de mexer em qualquer coisa ----------

/** O detalhe de revisão da versão e os anexos dele — só leitura. */
async function lerRevisaoNaApple(asc, versaoId) {
  let detalhe = null;
  try {
    detalhe = (await asc.get(`/v1/appStoreVersions/${versaoId}/appStoreReviewDetail`)).data ?? null;
  } catch (erro) {
    if (erro.status !== 404) throw erro;
  }
  return { detalhe, anexos: await lerAnexos(asc, detalhe?.id) };
}

/**
 * A disponibilidade que já existe na conta: { id, territorios (os à venda), emNovos } ou null
 * (ainda não há). Só leitura. ~175 territórios cabem numa página de 200.
 */
async function lerDisponibilidade(asc, app) {
  let atual = null;
  try {
    atual = (await asc.get(`/v1/apps/${app.id}/appAvailabilityV2`))?.data ?? null;
  } catch (erro) {
    if (erro.status !== 404) throw erro;
  }
  if (!atual) return null;
  const r = await asc.get(`/v2/appAvailabilities/${atual.id}/territoryAvailabilities?include=territory&limit=200`);
  const territorios = (r.data ?? [])
    .filter((t) => t.attributes?.available === true)
    .map((t) => t.relationships?.territory?.data?.id)
    .filter(Boolean);
  return { id: atual.id, territorios, emNovos: atual.attributes?.availableInNewTerritories === true };
}

/** O build que a versão já tem preso, ou null. */
async function buildPreso(asc, versaoId) {
  try {
    return (await asc.get(`/v1/appStoreVersions/${versaoId}/build`))?.data ?? null;
  } catch (erro) {
    if (erro.status === 404) return null;
    throw erro;
  }
}

/** O envio que a Apple devolveu (recusa ou pedido de informação), ou null. */
async function envioDevolvido(asc, app) {
  const r = await asc.get(`/v1/reviewSubmissions?filter[app]=${app.id}&filter[platform]=IOS&filter[state]=UNRESOLVED_ISSUES&limit=10`);
  return r.data?.[0] ?? null;
}

/**
 * --enviar só sai com tudo o que a Apple pediu: a lista de aparelhos, a gravação de tela, o
 * guia em dia e o servidor de demonstração do jeito que as notas descrevem. Confere TUDO antes
 * de escrever qualquer coisa na Apple e lista todas as faltas de uma vez.
 */
async function conferirAntesDeEnviar({ asc, app, versaoDoApp, situacao, args, aparelhos, video, guia, revisaoNaApple, config, soConferir = false }) {
  relatorio.passo(
    `${soConferir ? 'O que a revisão vai precisar' : 'Antes de enviar'}: aparelhos testados, gravação de tela, guia PDF, ` +
      'regiões, build e servidor de demonstração',
  );
  const faltas = [];

  // Item 6 das notas: "Brazil only". Disponibilidade feita no site com outros países desmente.
  let disponivel = null;
  try {
    disponivel = await lerDisponibilidade(asc, app);
  } catch (erro) {
    relatorio.avisar(`Não deu para ler a disponibilidade (${erro.message}): confira na tela que o app é vendido só no Brasil.`);
  }
  const fora = (disponivel?.territorios ?? []).filter((t) => t !== TERRITORIO);
  if (fora.length) {
    faltas.push([
      'regioes',
      `O app está à venda em ${fora.length} território(s) além do Brasil (${fora.slice(0, 8).join(', ')}${fora.length > 8 ? '…' : ''}), ` +
        'e as notas respondem "Brazil only" (item 6) — o revisor veria a outra coisa. Deixe só o Brasil em Pricing and ' +
        'Availability, ou mude o item 6 de ficha/notas-revisao.txt e o guia (revisao/guia.mjs), e rode de novo.',
    ]);
  } else if (disponivel) {
    relatorio.ok(`disponibilidade: só ${TERRITORIO}, como as notas dizem`);
  }
  if (disponivel?.emNovos) {
    relatorio.avisar('A disponibilidade entra sozinha nos países que a Apple abrir (availableInNewTerritories); as notas dizem só Brasil.');
  }

  // Reenvio (a Apple devolveu) sem --build: o build mais novo da versão é o MESMO que voltou?
  // Então o app desta rodada não chegou à Apple, e as notas citariam telas que ele não tem.
  if (!soConferir && !args.build && !args.mesmoBuild && situacao.editavel && (await envioDevolvido(asc, app))) {
    const preso = await buildPreso(asc, situacao.editavel.id);
    const maisNovo = await acharBuild(asc, app, versaoDoApp, null);
    if (preso && maisNovo && maisNovo.id === preso.id) {
      faltas.push([
        'build',
        `A Apple devolveu o envio, e o build mais novo da versão ${versaoDoApp} (${preso.attributes?.version ?? preso.id}) é o MESMO ` +
          'que já estava nele: o build com o código desta rodada não chegou à Apple. Compile (caixa "compilar"), espere o e-mail ' +
          'de build processado e rode "revisao" de novo — ou passe --build <número>. Se a resposta à Apple não pede app novo, ' +
          'reenvie o mesmo build com --mesmo-build (caixa "mesmo_build").',
      ]);
    }
  }

  if (!aparelhos.length) {
    faltas.push([
      'aparelhos',
      'Lista de aparelhos testados vazia (mobile/publicar/ficha/aparelhos-testados.txt): a Apple pediu os modelos e as ' +
        'versões do iOS em que o app foi testado. Uma linha por aparelho em que o teste rodou de verdade, ' +
        '"iPhone 17 — iOS 26.1"; a primeira é o da gravação de tela.',
    ]);
  }
  const jaAnexado = videoAnexado(revisaoNaApple.anexos);
  if (video) {
    relatorio.ok(`gravação de tela: ${video.nome} (${mb(video.tamanho)}), ${soConferir ? 'conferida — sobe na rodada de envio' : 'sobe nesta rodada'}`);
  }
  else if (jaAnexado) relatorio.ok(`gravação de tela já anexada na Apple: ${jaAnexado.attributes.fileName}`);
  else {
    faltas.push([
      'video',
      'Sem a gravação de tela que a Apple pediu (aparelho físico, iOS mais novo, desde a abertura do app): passe ' +
        '--video-revisao <arquivo ou https://...> — no GitHub, a entrada "video_revisao_url". Ela sobe como anexo da ' +
        'revisão e fica lá para as próximas rodadas.',
    ]);
  }
  if (guia.desatualizado.length) {
    faltas.push([
      'guia',
      `O guia PDF (publicar/revisao/${guia.nome}) está desatualizado: ${guia.desatualizado.join('; ')}. ` +
        'Rode node publicar/revisao/gerar-guia.mjs (precisa do Playwright) e faça commit.',
    ]);
  }
  // A ficha sobe sem eles (padroes.json não guarda segredo nem telefone); a revisão, não: a
  // senha vai nas notas e no campo da conta demo, e a Apple exige um telefone de contato.
  // O da Apple vale — menos o telefone de mentira do config.exemplo.json antigo, que uma
  // rodada local com o modelo sem editar pode ter gravado lá.
  const naApple = revisaoNaApple.detalhe?.attributes?.contactPhone;
  const telefone = config.telefone_contato || (naApple && naApple.trim() !== DO_MODELO_ANTIGO.telefone_contato ? naApple : '');
  if (!telefone) {
    faltas.push([
      'telefone',
      'Falta o telefone de contato para a revisão (a Apple exige): Variable (ou Secret) APPLE_TELEFONE_CONTATO do repositório, ' +
        'com +55 e DDD — ex.: +55 11 91234-5678 (ou "telefone_contato" no config.json).',
    ]);
  } else if (!config.telefone_contato) {
    relatorio.ok('telefone de contato: o que já estava na Apple');
  }
  if (!config.senha_demo) {
    faltas.push([
      'senha-demo',
      'Falta a senha da conta de demonstração: Secret APPLE_DEMO_PASSWORD do repositório (ou o workflow "Senha da ' +
        'conta demo na Apple", que a deixa guardada lá). É a senha da conta no servidor de demonstração: na demo que ' +
        'sobe com a loja, ./demo.sh --mostrar, na máquina dela; na Vercel, a DEMO_ADMIN_SENHA (projeto da demo → ' +
        'Settings → Environment Variables). Sem ela o revisor não entra, e o servidor de demonstração não foi conferido.',
    ]);
  } else {
    // A base guarda o caminho (<domínio>/demo, ADR-46): a privacidade e o suporte que moram
    // debaixo do servidor vão juntos para a base da conferência, e os de outro lugar (outra
    // URL na ficha) são conferidos onde estão.
    const base = (process.env.PUBLICAR_DEMO_BASE || config.url_servidor_demo).replace(/\/+$/, '');
    const privacidade = trocarBase(config.url_privacidade, config.url_servidor_demo, base);
    const demo = await conferirServidorDemo({
      base,
      servidor: config.url_servidor_demo,
      email: config.email_demo,
      senha: config.senha_demo,
      codigo: config.codigo_demo,
      urlPrivacidade: privacidade,
      urlSuporte: trocarBase(config.url_suporte, config.url_servidor_demo, base),
    });
    for (const c of demo.conferidos) relatorio.ok(c);
    // A página de suporte de fora do servidor da demo que não abriu daqui: aviso, não falta.
    for (const a of demo.avisos) relatorio.avisar(a);
    demo.problemas.forEach((p, i) => faltas.push([`demo-${i}`, p]));
  }
  if (faltas.length) {
    for (const [assunto, texto] of faltas) relatorio.pendente(texto, assunto);
    throw new Error(
      soConferir
        ? `A revisão não sairia: ${faltas.length} coisa(s) faltando (as pendências abaixo). Nada foi mexido na Apple — e, no ` +
            'modo completo do GitHub, nada foi compilado: resolva e rode de novo.'
        : `--enviar recusado: ${faltas.length} coisa(s) faltando para a revisão (as pendências abaixo). Nada foi mexido na Apple. ` +
            'Para subir só a ficha, rode sem --enviar (no GitHub, desmarque "revisão").',
    );
  }
  relatorio.feito(
    'Pronto para a revisão: aparelhos testados, gravação de tela, guia em dia, só Brasil, e servidor de demonstração ' +
      'conferido (no ar, conta de dono e protegida, código de barras com estoque, privacidade e suporte, leitor e exclusão de conta)',
  );
}

// ---------- passos na Apple ----------

async function prepararVersao(asc, app, versaoDoApp, situacao) {
  let versao = situacao.editavel;
  if (!versao) {
    versao = (
      await asc.post('/v1/appStoreVersions', {
        data: {
          type: 'appStoreVersions',
          attributes: { platform: 'IOS', versionString: versaoDoApp, releaseType: 'AFTER_APPROVAL' },
          relationships: { app: { data: { type: 'apps', id: app.id } } },
        },
      })
    ).data;
    relatorio.ok(`versão ${versaoDoApp} criada`);
  } else {
    relatorio.ok(`versão editável já existia (${versao.attributes.versionString}, ${estadoDaVersao(versao)})`);
  }
  return versao;
}

/**
 * Localizações em outro idioma (as que o site cria junto com o app, no "Idioma principal"
 * escolhido no formulário) ficam vazias e travam o envio: a Apple cobra os campos de cada uma.
 * O app é só pt-BR — com o pt-BR já principal, elas saem.
 */
async function apagarOutrosIdiomas(asc, lista, rota, onde) {
  for (const loc of lista.filter((l) => l.attributes?.locale && l.attributes.locale !== IDIOMA)) {
    try {
      await asc.del(`${rota}/${loc.id}`);
      relatorio.avisar(`${onde}: a localização ${loc.attributes.locale} foi apagada — o app é só ${IDIOMA}, e ela travaria o envio vazia.`);
    } catch (erro) {
      relatorio.pendente(
        `${onde}: a localização ${loc.attributes.locale} não saiu (${erro.message}). A Apple cobra os campos dela no envio: ` +
          `apague-a na tela ou confira se o idioma principal é Português (Brasil).`,
        `idioma-${onde}`,
      );
    }
  }
}

async function nomeSubtituloEPrivacidade(asc, info, ficha, config) {
  const infoLocs = await asc.get(`/v1/appInfos/${info.id}/appInfoLocalizations`);
  const infoLoc = infoLocs.data.find((l) => l.attributes.locale === IDIOMA);
  const atributos = { name: ficha.nome, subtitle: ficha.subtitulo, privacyPolicyUrl: config.url_privacidade };
  if (infoLoc) {
    await asc.patch(`/v1/appInfoLocalizations/${infoLoc.id}`, {
      data: { type: 'appInfoLocalizations', id: infoLoc.id, attributes: atributos },
    });
  } else {
    await asc.post('/v1/appInfoLocalizations', {
      data: {
        type: 'appInfoLocalizations',
        attributes: { locale: IDIOMA, ...atributos },
        relationships: { appInfo: { data: { type: 'appInfos', id: info.id } } },
      },
    });
  }
  await apagarOutrosIdiomas(asc, infoLocs.data, '/v1/appInfoLocalizations', 'Nome e privacidade');
}

async function classificacaoEtaria(asc, info) {
  relatorio.passo('Classificação etária (todas as perguntas da API 4.6: "Não/Nenhum" → 4+)');
  try {
    const r = await responderClassificacao(asc, info.id);
    if (r.recusadas.length) {
      relatorio.avisar(
        `A Apple não aceitou ${r.recusadas.join(', ')} na classificação etária — a declaração foi enviada ` +
          `sem ${r.recusadas.length > 1 ? 'eles' : 'ele'}, com as outras ${r.enviadas.length} respostas.`,
      );
    }
    relatorio.feito(`Classificação etária: ${r.enviadas.length} de ${Object.keys(RESPOSTAS).length} respostas gravadas`);
    if (r.emBranco.length) {
      relatorio.pendente(
        `Classificação etária: a Apple tem pergunta(s) que este publicador ainda não responde (${r.emBranco.join(', ')}). ` +
          'Responda na tela (App Information → Age Rating; para este app é "Não/Nenhum") — as outras já estão gravadas.',
        'idade',
      );
    }
  } catch (erro) {
    relatorio.pendente(
      `Classificação etária não foi gravada pela API (${erro.message}). ` +
        'Na tela: App Information → Age Rating → "Não/Nenhum" em tudo (docs/LOJAS-DE-APP.md §7).',
      'idade',
    );
  }
}

/**
 * Todos os territórios da Apple (uns 175: uma página de 200; segue o links.next se um dia
 * passar disso). O links.next vem com o endereço inteiro; o cliente quer só o caminho.
 */
async function todosOsTerritorios(asc) {
  const ids = [];
  let caminho = '/v1/territories?limit=200';
  while (caminho) {
    const r = await asc.get(caminho);
    ids.push(...(r.data ?? []).map((d) => d.id));
    caminho = r.links?.next ? r.links.next.replace(/^https?:\/\/[^/]+/, '') : null;
  }
  return ids;
}

async function disponibilidade(asc, app) {
  relatorio.passo('Disponibilidade (onde o app é vendido)');
  let atual = null;
  try {
    atual = await lerDisponibilidade(asc, app);
  } catch (erro) {
    relatorio.pendente(
      `Não deu para ler a disponibilidade (${erro.message}). Na tela: Pricing and Availability → só Brasil.`,
      'disponibilidade',
    );
    return;
  }
  if (atual) {
    // Mantida como está (mexer em país de app à venda é decisão de negócio), mas conferida:
    // as notas respondem "Brazil only".
    const fora = atual.territorios.filter((t) => t !== TERRITORIO);
    if (fora.length) {
      relatorio.pendente(
        `Disponibilidade: o app está à venda em ${fora.length} território(s) além do Brasil (${fora.slice(0, 8).join(', ')}` +
          `${fora.length > 8 ? '…' : ''}), e as notas dizem "Brazil only". Deixe só o Brasil em Pricing and Availability ` +
          '(o --enviar recusa enquanto isso).',
        'regioes',
      );
    } else {
      relatorio.feito('Disponibilidade: já definida na conta, só no Brasil — mantida');
    }
    return;
  }
  try {
    // Criação em linha: cada território vai em "included" com um id local ${...}, que o
    // relacionamento cita. A Apple exige TODOS os territórios na criação — cada um com
    // available true/false —, não só os que vão ficar à venda: com só o Brasil, ela devolve
    // 409 "expects an included resource ... id 'ARG'" para cada um que faltou.
    const territorios = await todosOsTerritorios(asc);
    if (!territorios.includes(TERRITORIO)) throw new Error(`a Apple não listou o território ${TERRITORIO}`);
    const local = (id) => `\${${id}}`;
    await asc.post('/v2/appAvailabilities', {
      data: {
        type: 'appAvailabilities',
        attributes: { availableInNewTerritories: false },
        relationships: {
          app: { data: { type: 'apps', id: app.id } },
          territoryAvailabilities: { data: territorios.map((id) => ({ type: 'territoryAvailabilities', id: local(id) })) },
        },
      },
      included: territorios.map((id) => ({
        type: 'territoryAvailabilities',
        id: local(id),
        attributes: { available: id === TERRITORIO },
        relationships: { territory: { data: { type: 'territories', id } } },
      })),
    });
    relatorio.feito(
      `Disponibilidade: só no Brasil (os outros ${territorios.length - 1} territórios desligados), sem entrar sozinho em países novos`,
    );
  } catch (erro) {
    relatorio.pendente(`Disponibilidade não foi criada (${erro.message}). Na tela: Pricing and Availability → só Brasil.`, 'disponibilidade');
  }
}

async function textosDaVersao(asc, versao, ficha, config, jaLancado) {
  const locs = await asc.get(`/v1/appStoreVersions/${versao.id}/appStoreVersionLocalizations`);
  const loc = locs.data.find((l) => l.attributes.locale === IDIOMA);
  const atributos = {
    description: ficha.descricao,
    keywords: ficha.palavrasChave,
    promotionalText: ficha.textoPromocional,
    supportUrl: config.url_suporte,
    // Na primeira versão a Apple recusa "Novidades" — só existe o que estrear.
    ...(jaLancado ? { whatsNew: ficha.novidades } : {}),
  };
  let resultado;
  if (loc) {
    await asc.patch(`/v1/appStoreVersionLocalizations/${loc.id}`, {
      data: { type: 'appStoreVersionLocalizations', id: loc.id, attributes: atributos },
    });
    resultado = loc;
  } else {
    resultado = (
      await asc.post('/v1/appStoreVersionLocalizations', {
        data: {
          type: 'appStoreVersionLocalizations',
          attributes: { locale: IDIOMA, ...atributos },
          relationships: { appStoreVersion: { data: { type: 'appStoreVersions', id: versao.id } } },
        },
      })
    ).data;
  }
  await apagarOutrosIdiomas(asc, locs.data, '/v1/appStoreVersionLocalizations', 'Textos da versão');
  return resultado;
}

async function capturas(asc, loc, lidos, intervaloMs) {
  const naApple = (await asc.get(`/v1/appStoreVersionLocalizations/${loc.id}/appScreenshotSets`)).data;
  for (const { conjunto, arquivos } of lidos) {
    relatorio.passo(`Capturas ${conjunto.rotulo} (${arquivos.length}, ${conjunto.obrigatorio ? 'obrigatórias' : 'extra'})`);
    const existente = naApple.find((c) => c.attributes?.screenshotDisplayType === conjunto.tipo);
    try {
      const r = await subirConjunto(asc, {
        localizacaoId: loc.id,
        conjuntoExistente: existente,
        conjunto,
        arquivos,
        esperaMs: intervaloMs,
        relatorio,
      });
      if (r.falhas.length) {
        const erro = new Error(`a Apple recusou ao processar: ${r.falhas.join(', ')}`);
        erro.conjuntoId = r.conjuntoId;
        throw erro;
      }
      if (r.processando.length) {
        relatorio.avisar(
          `${conjunto.rotulo}: ${r.processando.join(', ')} ainda processando na Apple — ela termina sozinha; ` +
            'se alguma falhar, aparece na tela da versão.',
        );
      }
      relatorio.feito(`Capturas ${conjunto.rotulo}: ${r.ids.length}, na ordem da pasta (as antigas foram substituídas)`);
    } catch (erro) {
      if (conjunto.obrigatorio) throw new Error(`Capturas ${conjunto.rotulo} (obrigatórias) falharam: ${erro.message}`);
      // Extra pela metade é pior que nenhum: sem o conjunto, a vitrine usa o de 6,5" inteiro.
      const id = erro.conjuntoId ?? existente?.id;
      let desfecho = 'nada ficou pela metade';
      if (id) {
        try {
          await asc.del(`/v1/appScreenshotSets/${id}`);
          desfecho = 'o conjunto foi tirado';
        } catch {
          desfecho = null;
        }
      }
      relatorio.avisar(
        `Capturas ${conjunto.rotulo} (extra) falharam (${erro.message})` +
          (desfecho ? ` — ${desfecho}, e a App Store usa as de 6,5" nos iPhones maiores.` : '.'),
      );
      if (!desfecho) {
        relatorio.pendente(`O conjunto ${conjunto.rotulo} pode ter ficado pela metade: rode de novo ou apague-o na tela da versão.`);
      }
    }
  }
  // Extra que ficou de fora nesta rodada (pasta ausente, imagem fora do padrão): o conjunto
  // que já estava na versão — de uma rodada anterior, ou copiado pela Apple da versão no ar —
  // mostraria telas velhas nos iPhones grandes. Sai.
  for (const conjunto of CONJUNTOS.filter((c) => !c.obrigatorio && !lidos.some((l) => l.conjunto === c))) {
    const velho = naApple.find((c) => c.attributes?.screenshotDisplayType === conjunto.tipo);
    if (!velho) continue;
    try {
      await asc.del(`/v1/appScreenshotSets/${velho.id}`);
      relatorio.avisar(
        `Capturas ${conjunto.rotulo}: o conjunto que já estava na versão foi apagado (não havia imagens novas em ordem para ` +
          'ele) — a App Store usa as de 6,5" nos iPhones maiores.',
      );
    } catch (erro) {
      relatorio.pendente(
        `Capturas ${conjunto.rotulo}: o conjunto antigo continua na versão (${erro.message}) e mostraria telas velhas nos ` +
          'iPhones grandes — apague-o na tela da versão ou rode de novo.',
        'capturas-velhas',
      );
    }
  }
}

/**
 * Conta demo, notas (em inglês) e os anexos da revisão. Devolve true se tudo o que a revisão
 * precisa ficou lá — guia e, se pedido, o vídeo.
 */
async function revisaoEAnexos(asc, versao, ficha, config, { guia, video, revisaoNaApple, esperaMs }) {
  relatorio.passo('Conta de demonstração, notas e anexos para o revisor');
  const [nome, ...sobrenomes] = String(config.nome_contato ?? '').trim().split(/\s+/).filter(Boolean);
  // Campo sem valor NÃO vai: a Apple guarda o que já tinha (o telefone de um envio anterior,
  // a senha da demo de uma rodada com o Secret). O --enviar confere que nada falta.
  const seTiver = (campo, valor) => (valor ? { [campo]: valor } : {});
  const atributos = {
    ...(nome ? { contactFirstName: nome, contactLastName: sobrenomes.join(' ') || nome } : {}),
    ...seTiver('contactPhone', config.telefone_contato),
    ...seTiver('contactEmail', config.email_suporte),
    demoAccountName: config.email_demo,
    ...seTiver('demoAccountPassword', config.senha_demo),
    demoAccountRequired: true,
    notes: ficha.notasRevisao,
  };
  let detalhe = revisaoNaApple.versaoId === versao.id ? revisaoNaApple.detalhe : null;
  if (detalhe) {
    await asc.patch(`/v1/appStoreReviewDetails/${detalhe.id}`, {
      data: { type: 'appStoreReviewDetails', id: detalhe.id, attributes: atributos },
    });
  } else {
    detalhe = (
      await asc.post('/v1/appStoreReviewDetails', {
        data: {
          type: 'appStoreReviewDetails',
          attributes: atributos,
          relationships: { appStoreVersion: { data: { type: 'appStoreVersions', id: versao.id } } },
        },
      })
    ).data;
  }
  relatorio.feito(`Conta demo (${config.email_demo}) e notas para o revisor, em inglês (${[...ficha.notasRevisao].length} de 4000 caracteres)`);

  let tudo = true;
  const existentes = await lerAnexos(asc, detalhe.id);
  const subir = async (arquivo, rotulo, assunto) => {
    try {
      const r = await subirAnexo(asc, {
        detalheId: detalhe.id,
        nome: arquivo.nome,
        dados: arquivo.dados,
        md5: arquivo.md5,
        existentes,
        esperaMs,
        relatorio,
      });
      if (r.mantido) relatorio.feito(`${rotulo} ${arquivo.nome}: já estava anexado, igual (mesmo MD5) — nada subiu de novo`);
      else {
        relatorio.feito(
          `${rotulo} ${arquivo.nome} (${mb(arquivo.dados.length)}) anexado à revisão, MD5 conferido pela Apple` +
            (r.substituidos ? ' — o anterior de mesmo nome saiu' : ''),
        );
      }
      if (r.processando) relatorio.avisar(`${rotulo} ${arquivo.nome}: a Apple ainda está processando — ela termina sozinha.`);
      return true;
    } catch (erro) {
      relatorio.pendente(`${rotulo} ${arquivo.nome} não foi anexado (${erro.message}) — rode de novo; o que já estava lá ficou.`, assunto);
      tudo = false;
      return false;
    }
  };
  await subir(guia, 'Guia PDF', 'anexo-guia');
  if (video && (await subir(video, 'Gravação de tela', 'anexo-video'))) {
    // Vídeo de outro tipo de antes (screen-recording.mov, agora .mp4): sai, para não ficarem dois.
    for (const outro of existentes.filter((a) => a.attributes?.fileName?.startsWith(`${NOME_DO_VIDEO}.`) && a.attributes.fileName !== video.nome)) {
      try {
        await asc.del(`/v1/appStoreReviewAttachments/${outro.id}`);
      } catch {
        relatorio.avisar(`O vídeo antigo ${outro.attributes.fileName} continua anexado — apague-o na tela, se quiser.`);
      }
    }
  }
  return tudo;
}

async function precoGratis(asc, app) {
  relatorio.passo('Preço: grátis');
  try {
    // A lista inteira (paginada), e só o ponto de preço 0: o primeiro da lista NUNCA é
    // tomado como grátis — preço pago gravado aqui valeria na hora, no app inteiro.
    let gratis = null;
    let vistos = 0;
    let caminho = `/v1/apps/${app.id}/appPricePoints?filter[territory]=USA&limit=200`;
    for (let pagina = 0; caminho && !gratis && pagina < 50; pagina++) {
      const r = await asc.get(caminho);
      vistos += r.data?.length ?? 0;
      gratis = (r.data ?? []).find((p) => ehZero(p.attributes?.customerPrice)) ?? null;
      caminho = proximaPagina(r);
    }
    if (!vistos) {
      relatorio.pendente(
        'Preço não foi definido: a Apple não devolveu nenhum ponto de preço para o território-base (EUA). ' +
          'Na tela: Pricing and Availability → Grátis.',
        'preco',
      );
      return;
    }
    if (!gratis) {
      relatorio.pendente(
        `Preço não foi definido: entre os ${vistos} pontos de preço que a Apple devolveu, nenhum é grátis (0,00) — nada ` +
          'foi gravado, e o app NÃO virou pago. Na tela: Pricing and Availability → Grátis.',
        'preco',
      );
      return;
    }
    const local = '${preco-gratis}'; // id local da criação em linha (ver disponibilidade)
    await asc.post('/v1/appPriceSchedules', {
      data: {
        type: 'appPriceSchedules',
        relationships: {
          app: { data: { type: 'apps', id: app.id } },
          baseTerritory: { data: { type: 'territories', id: 'USA' } },
          manualPrices: { data: [{ type: 'appPrices', id: local }] },
        },
      },
      included: [
        {
          type: 'appPrices',
          id: local,
          attributes: { startDate: null },
          relationships: { appPricePoint: { data: { type: 'appPricePoints', id: gratis.id } } },
        },
      ],
    });
    relatorio.feito('Preço: grátis');
  } catch (erro) {
    relatorio.pendente(`Preço não foi definido pela API (${erro.message}). Na tela: Pricing and Availability → Grátis.`, 'preco');
  }
}

/**
 * O build da versão do app.json. Com `numero` (o --build), SÓ esse — o que esta rodada
 * compilou; sem ele, o mais novo (não vencido). Ou null.
 */
async function acharBuild(asc, app, versaoDoApp, numero) {
  const r = await asc.get(
    `/v1/builds?filter[app]=${app.id}&filter[preReleaseVersion.version]=${encodeURIComponent(versaoDoApp)}` +
      `&filter[preReleaseVersion.platform]=IOS${numero ? `&filter[version]=${encodeURIComponent(numero)}` : ''}` +
      '&sort=-uploadedDate&limit=10',
  );
  const vivos = r.data.filter((b) => b.attributes?.expired !== true);
  return (numero ? vivos.find((b) => b.attributes?.version === numero) : vivos[0]) ?? null;
}

const QUEBRADO = new Set(['INVALID', 'FAILED']);

async function esperarBuild(asc, app, versaoDoApp, numero, minutos, intervaloMs) {
  const limite = Date.now() + minutos * 60_000;
  const qual = numero ? `o build ${numero} (desta rodada)` : 'o build';
  let ultimo = null;
  for (;;) {
    let build = null;
    let estado;
    try {
      build = await acharBuild(asc, app, versaoDoApp, numero);
      estado = build ? `build ${build.attributes.version} ${build.attributes.processingState}` : `${qual} ainda não chegou à Apple`;
    } catch (erro) {
      // O asc.mjs já repetiu a leitura; numa espera longa, uma consulta perdida não derruba nada.
      estado = `consulta falhou (${erro.message})`;
    }
    if (build?.attributes.processingState === 'VALID') return build;
    if (build && QUEBRADO.has(build.attributes.processingState)) {
      throw new Error(
        `O build ${build.attributes.version} da versão ${versaoDoApp} ficou ${build.attributes.processingState} na Apple. ` +
          'O e-mail da Apple diz o motivo; corrija, compile de novo e rode outra vez.',
      );
    }
    if (estado !== ultimo) {
      relatorio.ok(`${hora()} ${estado}`);
      ultimo = estado;
    }
    if (Date.now() + intervaloMs > limite) {
      throw new Error(
        `Esperei ${minutos} min e não apareceu ${numero ? `o build ${numero}` : 'build'} VALID da versão ${versaoDoApp} na Apple ` +
          `(último estado: ${estado}). Confira em expo.dev se o build terminou e se o envio para a Apple (submit) saiu; ` +
          'quando aparecer processado (chega e-mail da Apple), rode de novo — o que já subiu fica.',
      );
    }
    await dormir(intervaloMs);
  }
}

/** [assunto, frase de ação] para cada assunto que a Apple costuma citar ao recusar um envio. */
function dicasDaRecusa(texto) {
  const dicas = [];
  if (/age ?rating|ageRating|classifica/i.test(texto)) {
    dicas.push([
      'idade',
      'Classificação etária: a Apple pede resposta que a API 4.6 não tem (ou que não foi gravada). Responda na tela — ' +
        'App Information → Age Rating, "Não/Nenhum" para este app — e rode de novo.',
    ]);
  }
  if (/app ?privacy|privacy (practices|details|nutrition)|data ?collection|dataUsage|privacidade do app/i.test(texto)) {
    dicas.push(['privacidade', 'Privacidade do App: responda na tela (respostas em docs/LOJAS-DE-APP.md §5) e rode de novo.']);
  }
  if (/screenshot|captura/i.test(texto)) dicas.push(['capturas', 'Capturas: confira as imagens de media/app-store e rode de novo.']);
  if (/contentRights|content rights/i.test(texto)) dicas.push(['direitos', 'Direitos de conteúdo: App Information → Content Rights → "Não".']);
  if (/availability|territor/i.test(texto)) dicas.push(['disponibilidade', 'Disponibilidade: Pricing and Availability → só Brasil.']);
  const outrosIdiomas = [...new Set(texto.match(/\b[a-z]{2,3}-[A-Z][A-Za-z]{1,3}\b/g) ?? [])].filter((l) => l !== IDIOMA);
  if (outrosIdiomas.length) {
    dicas.push([
      'idioma',
      `Idioma: a Apple cobra a localização ${outrosIdiomas.join(', ')} — confira na tela se o idioma principal é ` +
        'Português (Brasil) e apague a outra; depois, rode de novo.',
    ]);
  }
  if (!dicas.length) dicas.push(['envio', 'Corrija o que a Apple listou e rode de novo: o que já subiu fica, e a nova rodada substitui.']);
  return dicas;
}

// Estados de um envio que ainda não terminou: só pode haver UM por plataforma.
const ENVIO_ATIVO = ['READY_FOR_REVIEW', 'UNRESOLVED_ISSUES', 'WAITING_FOR_REVIEW', 'IN_REVIEW', 'CANCELING', 'COMPLETING'];

async function enviarParaRevisao(asc, app, versao) {
  relatorio.passo('Enviando para a revisão da Apple');
  const ativos = (
    await asc.get(`/v1/reviewSubmissions?filter[app]=${app.id}&filter[platform]=IOS&filter[state]=${ENVIO_ATIVO.join(',')}&limit=10`)
  ).data;
  // Depois de uma recusa ou de um pedido de informação, a Apple deixa o envio em
  // UNRESOLVED_ISSUES, com a versão dentro: reenviar é ESTE envio (PATCH submitted), não um
  // novo — a Apple recusa um segundo envio ativo para a mesma plataforma.
  const devolvido = ativos.find((e) => e.attributes?.state === 'UNRESOLVED_ISSUES');
  const rascunho = ativos.find((e) => e.attributes?.state === 'READY_FOR_REVIEW');
  const andando = ativos.find((e) => !['UNRESOLVED_ISSUES', 'READY_FOR_REVIEW'].includes(e.attributes?.state));
  let envio = devolvido ?? rascunho ?? null;
  if (!envio && andando) {
    throw new Error(
      `Já existe um envio deste app em andamento na Apple (${andando.id}, ${andando.attributes.state}). ` +
        'Espere a resposta (chega por e-mail) — ou, para trocar o que foi enviado, cancele esse envio no site e rode de novo.',
    );
  }
  try {
    let temAVersao = false;
    if (envio) {
      const itens = (await asc.get(`/v1/reviewSubmissions/${envio.id}/items?include=appStoreVersion&limit=50`)).data;
      const daVersao = itens.filter(
        (i) => i.relationships?.appStoreVersion?.data?.id === versao.id && i.attributes?.state !== 'REMOVED',
      );
      temAVersao = daVersao.length > 0;
      if (envio === devolvido) {
        relatorio.ok(`retomando o envio que a Apple devolveu (${envio.id}, UNRESOLVED_ISSUES): o reenvio é nele`);
        // O item que a Apple recusou é marcado como resolvido antes do reenvio. Se ela não
        // aceitar a marca, o reenvio segue: a resposta dele é a que vale.
        for (const item of daVersao.filter((i) => i.attributes?.state === 'REJECTED')) {
          try {
            await asc.patch(`/v1/reviewSubmissionItems/${item.id}`, {
              data: { type: 'reviewSubmissionItems', id: item.id, attributes: { resolved: true } },
            });
            relatorio.ok(`item ${item.id} (a versão) marcado como resolvido`);
          } catch (erro) {
            relatorio.ok(`a Apple não aceitou marcar o item ${item.id} como resolvido (${erro.message}); o reenvio segue`);
          }
        }
      } else {
        relatorio.ok(`retomando o envio que tinha ficado aberto (${envio.id})`);
      }
    } else {
      envio = (
        await asc.post('/v1/reviewSubmissions', {
          data: {
            type: 'reviewSubmissions',
            attributes: { platform: 'IOS' },
            relationships: { app: { data: { type: 'apps', id: app.id } } },
          },
        })
      ).data;
    }
    if (!temAVersao) {
      await asc.post('/v1/reviewSubmissionItems', {
        data: {
          type: 'reviewSubmissionItems',
          relationships: {
            reviewSubmission: { data: { type: 'reviewSubmissions', id: envio.id } },
            appStoreVersion: { data: { type: 'appStoreVersions', id: versao.id } },
          },
        },
      });
    }
    await asc.patch(`/v1/reviewSubmissions/${envio.id}`, {
      data: { type: 'reviewSubmissions', id: envio.id, attributes: { submitted: true } },
    });
  } catch (erro) {
    const linhas = erro.mensagens?.length ? erro.mensagens : [erro.message];
    for (const [assunto, dica] of dicasDaRecusa(linhas.join(' '))) relatorio.pendente(dica, assunto);
    throw new Error(
      `A Apple recusou o envio para a revisão (HTTP ${erro.status ?? '?'}). O que ela disse:\n` +
        linhas.map((l) => `    ${l}`).join('\n'),
    );
  }
  relatorio.feito(
    envio === devolvido
      ? 'REENVIADO para a revisão da Apple — o mesmo envio que tinha voltado, agora com as notas e os anexos novos ' +
          '(a resposta costuma vir em 1 a 3 dias, por e-mail)'
      : 'ENVIADO para a revisão da Apple (a resposta costuma vir em 1 a 3 dias, por e-mail)',
  );
}

// ---------- a execução ----------

function foraDaApi() {
  const itens = [];
  if (appExiste === false) {
    itens.push(
      'Registro do app: NÃO existe na conta. Criar é só pelo site, uma vez: appstoreconnect.apple.com → Apps → + → ' +
        'Novo app → iOS, nome "Gestão de Loja", Idioma principal "Português (Brasil)", bundle com.gestaoloja.app, ' +
        'SKU gestao-loja. Depois, rode de novo.',
    );
  } else if (appExiste) {
    itens.push('Registro do app: já existe (criar só se faz pelo site — feito).');
  }
  itens.push(
    'Privacidade do App (App Privacy): a API da Apple não tem rota para ela. Se ainda não foi respondida, ' +
      'responda UMA vez na tela — respostas prontas em docs/LOJAS-DE-APP.md §5; depois vale para as próximas versões.',
  );
  itens.push(
    'Mensagem na Central de Resolução (App Review): a API não escreve nela. Não precisa: o reenvio leva as notas e os ' +
      'anexos novos. Se quiser responder também, o texto está em mobile/publicar/revisao/resposta-ao-app-review.txt.',
  );
  return itens;
}

async function publicar() {
  const args = lerArgumentos(process.argv.slice(2));
  const intervaloBuildMs = segundosDoAmbiente('PUBLICAR_INTERVALO_BUILD', 60);
  const intervaloCapturasMs = segundosDoAmbiente('PUBLICAR_INTERVALO_CAPTURAS', 5);
  const config = lerConfig();
  relatorio = criarRelatorio({ segredos: [config.senha_demo] });
  const aparelhos = lerAparelhosTestados();
  const guia = lerGuia();
  let video = null;
  if (args.video) {
    relatorio.passo('Gravação de tela para a revisão');
    video = await obterVideo(args.video);
    relatorio.ok(`${video.nome}: ${mb(video.tamanho)}, vídeo de verdade (cabeçalho ${video.nome.endsWith('.mov') ? 'QuickTime' : 'MP4'})`);
  }
  let ficha = lerFicha(config, { aparelhos, video: video?.nome ?? null });
  const expo = JSON.parse(readFileSync(join(RAIZ, 'mobile', 'app.json'), 'utf8')).expo;
  const versaoDoApp = expo.version;
  const bundle = expo.ios?.bundleIdentifier;
  if (!bundle) throw new Error('mobile/app.json sem expo.ios.bundleIdentifier.');
  const lidos = lerCapturas(resolve(process.env.PUBLICAR_CAPTURAS || join(RAIZ, 'media', 'app-store')));
  const quantas = lidos.map(({ conjunto, arquivos }) => `${arquivos.length} de ${conjunto.rotulo}`).join(' + ');
  relatorio.linha(
    `Ficha conferida: versão ${versaoDoApp}, capturas ${quantas}, ${aparelhos.length} aparelho(s) testado(s), ` +
      `guia ${guia.nome}${video ? `, vídeo ${video.nome}` : ''}.`,
  );
  if (guia.desatualizado.length && !args.enviar && !args.conferirEnvio) {
    relatorio.avisar(`O guia PDF está desatualizado (${guia.desatualizado.join('; ')}): rode node publicar/revisao/gerar-guia.mjs.`);
  }

  if (args.simular) {
    relatorio.feito('Textos dentro dos limites da Apple, sem marcador sobrando, sem citar outra plataforma e sem citar tela que o app não tem');
    relatorio.feito(`Capturas no tamanho e no formato certos: ${quantas}`);
    relatorio.resumo({ depois: ['--simular: nada foi enviado à Apple. Tudo pronto para publicar de verdade.'] });
    return 0;
  }

  const asc = criarCliente({ keyId: config.key_id, issuerId: config.issuer_id, p8: config.p8 });

  relatorio.passo('Procurando o app na sua conta');
  const app = (await asc.get(`/v1/apps?filter[bundleId]=${encodeURIComponent(bundle)}`)).data[0];
  appExiste = Boolean(app);
  if (!app) throw new Error(`Nenhum app com o bundle ${bundle} na conta da Apple — veja "Registro do app" abaixo.`);
  relatorio.feito(`App achado: ${app.attributes.name} (${app.id})`);

  // Só leitura até aqui: a versão do app.json, e o que já está anexado à revisão dela.
  const situacao = await situacaoDaVersao(asc, app.id, versaoDoApp);
  // A mesma versão do app.json já passou da edição (em revisão, aprovada, à venda): não há
  // o que publicar com esse número — a Apple recusaria criar outra igual.
  if (situacao.travada) throw new Error(mensagemDaTravada(versaoDoApp, situacao.travada));
  const revisaoNaApple = situacao.editavel
    ? { versaoId: situacao.editavel.id, ...(await lerRevisaoNaApple(asc, situacao.editavel.id)) }
    : { versaoId: null, detalhe: null, anexos: [] };
  // Sem o Secret APPLE_DEMO_PASSWORD, vale a senha que já está no campo "Senha" da revisão na
  // Apple (gravada pelo workflow "Senha da conta demo na Apple", ou à mão no site): as notas e a
  // conferência da demo usam ela, e ela some do log como o Secret sumiria.
  const senhaNaApple = revisaoNaApple.detalhe?.attributes?.demoAccountPassword;
  const usarSenhaDaApple = !config.senha_demo && typeof senhaNaApple === 'string' && senhaNaApple.trim() !== '';
  if (usarSenhaDaApple) {
    config.senha_demo = senhaNaApple;
    relatorio.ocultar(senhaNaApple);
    relatorio.ok('senha da conta demo: a que já está na revisão da Apple');
  }
  const jaAnexado = video ? null : videoAnexado(revisaoNaApple.anexos);
  if (usarSenhaDaApple || jaAnexado) {
    ficha = lerFicha(config, { aparelhos, video: video?.nome ?? jaAnexado?.attributes?.fileName ?? null });
  }
  if (args.enviar || args.conferirEnvio) {
    await conferirAntesDeEnviar({
      asc,
      app,
      versaoDoApp,
      situacao,
      args,
      aparelhos,
      video,
      guia,
      revisaoNaApple,
      config,
      soConferir: args.conferirEnvio,
    });
  }
  if (args.conferirEnvio) {
    relatorio.feito(
      `Versão ${versaoDoApp} na Apple: ${situacao.editavel ? `em preparo (${estadoDaVersao(situacao.editavel)})` : 'ainda não existe (a rodada de verdade cria)'} — aceita build e ficha`,
    );
    relatorio.resumo({
      foraDaApi: foraDaApi(),
      depois: ['--conferir-envio: só conferiu. Nada foi mexido na Apple; a revisão pode sair (--enviar).'],
    });
    return 0;
  }

  if (app.attributes.primaryLocale !== IDIOMA) {
    try {
      await asc.patch(`/v1/apps/${app.id}`, { data: { type: 'apps', id: app.id, attributes: { primaryLocale: IDIOMA } } });
      relatorio.feito(`Idioma principal: ${IDIOMA} (era ${app.attributes.primaryLocale}; o app é só em português)`);
    } catch (erro) {
      relatorio.avisar(`Não deu para trocar o idioma principal para ${IDIOMA} (${erro.message}) — confira na tela.`);
    }
  }

  relatorio.passo('Direitos de conteúdo');
  if (app.attributes.contentRightsDeclaration === 'DOES_NOT_USE_THIRD_PARTY_CONTENT') {
    relatorio.feito('Direitos de conteúdo: "não usa conteúdo de terceiros" (já estava)');
  } else {
    try {
      await asc.patch(`/v1/apps/${app.id}`, {
        data: { type: 'apps', id: app.id, attributes: { contentRightsDeclaration: 'DOES_NOT_USE_THIRD_PARTY_CONTENT' } },
      });
      relatorio.feito('Direitos de conteúdo: "não usa conteúdo de terceiros"');
    } catch (erro) {
      relatorio.pendente(
        `Direitos de conteúdo não foram gravados (${erro.message}). Na tela: App Information → Content Rights → "Não".`,
        'direitos',
      );
    }
  }

  // A versão vem ANTES do appInfo: numa atualização, a Apple só abre o appInfo editável
  // (nome, categoria, idade) depois que a versão nova existe.
  relatorio.passo(`Versão ${versaoDoApp}`);
  const versao = await prepararVersao(asc, app, versaoDoApp, situacao);
  const jaLancado = situacao.jaLancado;
  await asc.patch(`/v1/appStoreVersions/${versao.id}`, {
    data: {
      type: 'appStoreVersions',
      id: versao.id,
      attributes: {
        // Versão editável com outro número (ex.: 1.0.0 recusada e o app.json já em 1.0.1):
        // o número acompanha o app.json, senão o build não casa com ela.
        ...(versao.attributes.versionString !== versaoDoApp ? { versionString: versaoDoApp } : {}),
        ...(config.titular_copyright ? { copyright: `© ${new Date().getFullYear()} ${config.titular_copyright}` } : {}),
        releaseType: 'AFTER_APPROVAL',
      },
    },
  });
  const tipoDeVersao = jaLancado ? 'atualização' : 'primeira versão';
  relatorio.feito(`Versão ${versaoDoApp} pronta para editar (${tipoDeVersao}; libera sozinha depois de aprovada)`);

  relatorio.passo('Nome, subtítulo e URL de privacidade');
  const infos = (await asc.get(`/v1/apps/${app.id}/appInfos`)).data;
  const info = infos.find((i) => INFO_EDITAVEL.has(estadoDoInfo(i))) ?? infos[0];
  await nomeSubtituloEPrivacidade(asc, info, ficha, config);
  relatorio.feito(`Nome "${ficha.nome}", subtítulo "${ficha.subtitulo}" e URL de privacidade`);

  relatorio.passo('Categorias');
  await asc.patch(`/v1/appInfos/${info.id}`, {
    data: {
      type: 'appInfos',
      id: info.id,
      relationships: {
        primaryCategory: { data: { type: 'appCategories', id: 'BUSINESS' } },
        secondaryCategory: { data: { type: 'appCategories', id: 'PRODUCTIVITY' } },
      },
    },
  });
  relatorio.feito('Categorias: Negócios (principal) e Produtividade');

  await classificacaoEtaria(asc, info);
  await disponibilidade(asc, app);

  relatorio.passo('Descrição, texto promocional, palavras-chave e URL de suporte' + (jaLancado ? ' + novidades' : ''));
  const loc = await textosDaVersao(asc, versao, ficha, config, jaLancado);
  relatorio.feito(
    jaLancado
      ? 'Textos da versão, com "Novidades" (ficha/novidades.txt)'
      : 'Textos da versão (sem "Novidades": a Apple não aceita na primeira versão)',
  );

  await capturas(asc, loc, lidos, intervaloCapturasMs);

  const anexosOk = await revisaoEAnexos(asc, versao, ficha, config, { guia, video, revisaoNaApple, esperaMs: intervaloCapturasMs });

  await precoGratis(asc, app);

  relatorio.passo(
    `Build da versão ${versaoDoApp}${args.build ? ` — o ${args.build}, compilado nesta rodada` : args.mesmoBuild ? ' — o mesmo que já estava preso' : ''}`,
  );
  let build;
  if (args.mesmoBuild) {
    build = await buildPreso(asc, versao.id);
    if (!build) throw new Error(`--mesmo-build: a versão ${versaoDoApp} não tem build preso para reenviar. Rode sem ela.`);
  } else if (args.aguardarMinutos) {
    relatorio.ok(`esperando até ${args.aguardarMinutos} min, consultando a cada ${intervaloBuildMs / 1000} s`);
    build = await esperarBuild(asc, app, versaoDoApp, args.build, args.aguardarMinutos, intervaloBuildMs);
  } else {
    build = await acharBuild(asc, app, versaoDoApp, args.build);
  }
  if (build?.attributes.processingState === 'VALID') {
    await asc.patch(`/v1/appStoreVersions/${versao.id}/relationships/build`, {
      data: { type: 'builds', id: build.id },
    });
    relatorio.feito(`Build ${build.attributes.version} preso à versão ${versaoDoApp}${args.build ? ' (o desta rodada)' : ''}`);
  } else {
    const qual = args.build ? `o build ${args.build} (o desta rodada)` : `o build mais novo da versão ${versaoDoApp}`;
    const situacaoDoBuild = build
      ? `${qual} está "${build.attributes.processingState}"`
      : args.build
        ? `${qual} ainda não chegou à Apple`
        : `nenhum build da versão ${versaoDoApp} chegou à Apple ainda`;
    if (args.enviar) {
      throw new Error(
        `Sem build pronto não há o que enviar: ${situacaoDoBuild}. Rode com --aguardar-build <minutos> ou espere o e-mail da Apple.`,
      );
    }
    relatorio.avisar(`${situacaoDoBuild[0].toUpperCase()}${situacaoDoBuild.slice(1)} — rode de novo quando ele aparecer processado.`);
  }

  const depois = [];
  if (args.enviar) {
    if (!anexosOk) {
      throw new Error('Os anexos da revisão não subiram inteiros (pendências acima): sem eles a revisão não sai. Rode de novo.');
    }
    await enviarParaRevisao(asc, app, versao);
  } else {
    depois.push('Nada foi enviado para revisão. Quando quiser: npm run publicar -- --enviar (ou a caixa "revisão" no GitHub).');
  }
  relatorio.resumo({ foraDaApi: foraDaApi(), depois });
  return 0;
}

// exitCode, e não process.exit(): no Actions a saída é um pipe, que no Linux é assíncrono —
// sair na marra cortaria o fim do resumo.
publicar().then(
  (codigo) => {
    process.exitCode = codigo;
  },
  (erro) => {
    if (!relatorio) {
      process.stderr.write(`\n✖ ${erro.message}\n`);
    } else {
      relatorio.resumo({ fatal: erro.message, foraDaApi: foraDaApi() });
    }
    process.exitCode = 1;
  },
);
