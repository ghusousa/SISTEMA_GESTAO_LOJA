#!/usr/bin/env node
/**
 * Publica a ficha COMPLETA do app na App Store Connect, sem clique nenhum: nome, subtítulo,
 * descrição, texto promocional, palavras-chave, novidades (só em atualização), as capturas
 * de 6,5" (obrigatórias) e de 6,9" (extra), categoria, classificação etária completa,
 * direitos de conteúdo, disponibilidade (só Brasil, se ainda não houver), preço grátis,
 * dados de revisão (conta demo + notas), o build da versão do app.json e o envio.
 *
 *   npm run publicar                          prepara tudo e PARA antes de enviar para revisão
 *   npm run publicar -- --enviar              faz tudo E envia para a revisão da Apple
 *   npm run publicar -- --enviar --aguardar-build 60
 *                                             antes de prender o build, espera até 60 min o
 *                                             build da versão do app.json ficar VALID na Apple
 *   npm run publicar:simular                  só confere arquivos e textos, sem falar com a Apple
 *
 * O que NENHUM programa faz — a API 4.6 da Apple não tem rota para isso:
 *   • criar o registro do app (só no site, uma vez);
 *   • a ficha "Privacidade do App" (uma vez na tela; respostas em docs/LOJAS-DE-APP.md §5).
 * O resumo do fim diz o que ficou feito, os avisos e o que ainda precisa de alguém.
 *
 * Variáveis: PUBLICAR_CONFIG (o config.json), PUBLICAR_CAPTURAS (pasta com iphone-6.5/ e
 * iphone-6.9/; padrão media/app-store), PUBLICAR_INTERVALO_BUILD (segundos entre consultas
 * do build; padrão 60), PUBLICAR_INTERVALO_CAPTURAS (segundos entre consultas do
 * processamento das capturas; padrão 5); ASC_BASE e ASC_REPETIR_MS são do asc.mjs.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { criarCliente } from './asc.mjs';
import { RESPOSTAS, responderClassificacao } from './classificacao.mjs';
import { lerConfig, lerFicha } from './ficha.mjs';
import { CONJUNTOS, lerConjunto, subirConjunto } from './imagens.mjs';
import { criarRelatorio } from './relatorio.mjs';

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = resolve(AQUI, '..', '..');
const IDIOMA = 'pt-BR';
const TERRITORIO = 'BRA'; // app em pt-BR, com PIX e NFC-e: serve a loja brasileira

// Estados de versão (o nome novo, appVersionState, e o antigo, appStoreState).
const EDITAVEIS = new Set(['PREPARE_FOR_SUBMISSION', 'DEVELOPER_REJECTED', 'REJECTED', 'METADATA_REJECTED', 'INVALID_BINARY']);
const JA_ESTEVE_A_VENDA = new Set([
  'READY_FOR_SALE',
  'READY_FOR_DISTRIBUTION',
  'REPLACED_WITH_NEW_VERSION',
  'DEVELOPER_REMOVED_FROM_SALE',
  'REMOVED_FROM_SALE',
]);
const INFO_EDITAVEL = new Set(['PREPARE_FOR_SUBMISSION', 'DEVELOPER_REJECTED', 'REJECTED', 'METADATA_REJECTED']);
const estadoDaVersao = (v) => v.attributes?.appVersionState ?? v.attributes?.appStoreState;
const estadoDoInfo = (i) => i.attributes?.state ?? i.attributes?.appStoreState;
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const hora = () => new Date().toISOString().slice(11, 16);

let relatorio = null;
let appExiste = null;

// ---------- argumentos e ambiente ----------

function lerArgumentos(argv) {
  const args = { simular: false, enviar: false, aguardarMinutos: 0 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--simular') args.simular = true;
    else if (a === '--enviar') args.enviar = true;
    else if (a === '--aguardar-build' || a.startsWith('--aguardar-build=')) {
      const valor = a.includes('=') ? a.slice(a.indexOf('=') + 1) : argv[++i];
      const minutos = Number(valor);
      if (!(minutos > 0)) throw new Error(`--aguardar-build pede os minutos (ex.: --aguardar-build 60), não "${valor ?? ''}".`);
      args.aguardarMinutos = minutos;
    } else {
      throw new Error(`Opção desconhecida: ${a}. Use --simular, --enviar e/ou --aguardar-build <minutos>.`);
    }
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
        `Sem a pasta ${conjunto.pasta}: as capturas ${conjunto.rotulo} (extra) não sobem; ` +
          'a App Store mostra as de 6,5" também nos iPhones maiores.',
      );
    } else if (problemas.length) {
      relatorio.avisar(`Capturas ${conjunto.rotulo} (extra) ficam de fora: ${problemas.join('; ')}.`);
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

// ---------- passos na Apple ----------

async function acharOuCriarVersao(asc, app, versaoDoApp) {
  const versoes = (await asc.get(`/v1/apps/${app.id}/appStoreVersions?filter[platform]=IOS&limit=50`)).data;
  let versao = versoes.find((v) => EDITAVEIS.has(estadoDaVersao(v)));
  const jaLancado = versoes.some((v) => v !== versao && JA_ESTEVE_A_VENDA.has(estadoDaVersao(v)));
  // A mesma versão do app.json já passou da edição (em revisão, aprovada, à venda): não há
  // o que publicar com esse número — a Apple recusaria criar outra igual.
  const travada = versoes.find(
    (v) => v !== versao && v.attributes?.versionString === versaoDoApp && !EDITAVEIS.has(estadoDaVersao(v)),
  );
  if (travada) {
    throw new Error(
      `A versão ${versaoDoApp} já existe na Apple no estado ${estadoDaVersao(travada)} (já enviada ou publicada). ` +
        'Se está na revisão, espere a resposta da Apple (chega por e-mail); para publicar outra, suba "version" ' +
        'no mobile/app.json (ex.: 1.0.1) e rode de novo.',
    );
  }
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
  return { versao, jaLancado };
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

async function disponibilidade(asc, app) {
  relatorio.passo('Disponibilidade (onde o app é vendido)');
  let atual = null;
  try {
    atual = (await asc.get(`/v1/apps/${app.id}/appAvailabilityV2`))?.data ?? null;
  } catch (erro) {
    if (erro.status !== 404) {
      relatorio.pendente(
        `Não deu para ler a disponibilidade (${erro.message}). Na tela: Pricing and Availability → só Brasil.`,
        'disponibilidade',
      );
      return;
    }
  }
  if (atual) {
    relatorio.feito('Disponibilidade: já definida na conta — mantida como está');
    return;
  }
  try {
    // Criação em linha: o território vai em "included" com um id local ${...}, que o
    // relacionamento cita — o formato da API para criar as duas coisas de uma vez.
    const local = `\${${TERRITORIO}}`;
    await asc.post('/v2/appAvailabilities', {
      data: {
        type: 'appAvailabilities',
        attributes: { availableInNewTerritories: false },
        relationships: {
          app: { data: { type: 'apps', id: app.id } },
          territoryAvailabilities: { data: [{ type: 'territoryAvailabilities', id: local }] },
        },
      },
      included: [
        {
          type: 'territoryAvailabilities',
          id: local,
          attributes: { available: true },
          relationships: { territory: { data: { type: 'territories', id: TERRITORIO } } },
        },
      ],
    });
    relatorio.feito('Disponibilidade: só no Brasil, sem entrar sozinho em países novos');
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
  if (loc) {
    await asc.patch(`/v1/appStoreVersionLocalizations/${loc.id}`, {
      data: { type: 'appStoreVersionLocalizations', id: loc.id, attributes: atributos },
    });
    return loc;
  }
  return (
    await asc.post('/v1/appStoreVersionLocalizations', {
      data: {
        type: 'appStoreVersionLocalizations',
        attributes: { locale: IDIOMA, ...atributos },
        relationships: { appStoreVersion: { data: { type: 'appStoreVersions', id: versao.id } } },
      },
    })
  ).data;
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
}

async function dadosDaRevisao(asc, versao, ficha, config) {
  const [nome, ...sobrenomes] = config.nome_contato.trim().split(/\s+/);
  const atributos = {
    contactFirstName: nome,
    contactLastName: sobrenomes.join(' ') || nome,
    contactPhone: config.telefone_contato,
    contactEmail: config.email_suporte,
    demoAccountName: config.email_demo,
    demoAccountPassword: config.senha_demo,
    demoAccountRequired: true,
    notes: ficha.notasRevisao,
  };
  let detalhe = null;
  try {
    detalhe = (await asc.get(`/v1/appStoreVersions/${versao.id}/appStoreReviewDetail`)).data;
  } catch (erro) {
    if (erro.status !== 404) throw erro;
  }
  if (detalhe) {
    await asc.patch(`/v1/appStoreReviewDetails/${detalhe.id}`, {
      data: { type: 'appStoreReviewDetails', id: detalhe.id, attributes: atributos },
    });
  } else {
    await asc.post('/v1/appStoreReviewDetails', {
      data: {
        type: 'appStoreReviewDetails',
        attributes: atributos,
        relationships: { appStoreVersion: { data: { type: 'appStoreVersions', id: versao.id } } },
      },
    });
  }
}

async function precoGratis(asc, app) {
  relatorio.passo('Preço: grátis');
  try {
    const pontos = await asc.get(`/v1/apps/${app.id}/appPricePoints?filter[territory]=USA&limit=1`);
    const gratis = pontos.data.find((p) => Number(p.attributes.customerPrice) === 0) ?? pontos.data[0];
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

/** O build mais novo (não vencido) da versão do app.json, ou null. */
async function acharBuild(asc, app, versaoDoApp) {
  const r = await asc.get(
    `/v1/builds?filter[app]=${app.id}&filter[preReleaseVersion.version]=${encodeURIComponent(versaoDoApp)}` +
      `&filter[preReleaseVersion.platform]=IOS&sort=-uploadedDate&limit=10`,
  );
  return r.data.find((b) => b.attributes?.expired !== true) ?? null;
}

const QUEBRADO = new Set(['INVALID', 'FAILED']);

async function esperarBuild(asc, app, versaoDoApp, minutos, intervaloMs) {
  const limite = Date.now() + minutos * 60_000;
  let ultimo = null;
  for (;;) {
    let build = null;
    let estado;
    try {
      build = await acharBuild(asc, app, versaoDoApp);
      estado = build ? `build ${build.attributes.version} ${build.attributes.processingState}` : 'ainda não chegou à Apple';
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
        `Esperei ${minutos} min e não apareceu build VALID da versão ${versaoDoApp} na Apple (último estado: ${estado}). ` +
          'Confira em expo.dev se o build terminou e se o envio para a Apple (submit) saiu; quando aparecer ' +
          'processado (chega e-mail da Apple), rode de novo — o que já subiu fica.',
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
  if (!dicas.length) dicas.push(['envio', 'Corrija o que a Apple listou e rode de novo: o que já subiu fica, e a nova rodada substitui.']);
  return dicas;
}

async function enviarParaRevisao(asc, app, versao) {
  relatorio.passo('Enviando para a revisão da Apple');
  try {
    // Envio que ficou aberto numa rodada que caiu no meio: retoma em vez de abrir outro
    // (a Apple só deixa um rascunho por plataforma).
    const rascunhos = await asc.get(
      `/v1/reviewSubmissions?filter[app]=${app.id}&filter[platform]=IOS&filter[state]=READY_FOR_REVIEW&limit=10`,
    );
    let envio = rascunhos.data[0];
    let temAVersao = false;
    if (envio) {
      const itens = await asc.get(`/v1/reviewSubmissions/${envio.id}/items?include=appStoreVersion&limit=50`);
      temAVersao = itens.data.some((i) => i.relationships?.appStoreVersion?.data?.id === versao.id);
      relatorio.ok(`retomando o envio que tinha ficado aberto (${envio.id})`);
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
  relatorio.feito('ENVIADO para a revisão da Apple (a resposta costuma vir em 1 a 3 dias, por e-mail)');
}

// ---------- a execução ----------

function foraDaApi() {
  const itens = [];
  if (appExiste === false) {
    itens.push(
      'Registro do app: NÃO existe na conta. Criar é só pelo site, uma vez: appstoreconnect.apple.com → Apps → + → ' +
        'Novo app → iOS, nome "Gestão de Loja", bundle com.gestaoloja.app, SKU gestao-loja. Depois, rode de novo.',
    );
  } else if (appExiste) {
    itens.push('Registro do app: já existe (criar só se faz pelo site — feito).');
  }
  itens.push(
    'Privacidade do App (App Privacy): a API da Apple não tem rota para ela. Se ainda não foi respondida, ' +
      'responda UMA vez na tela — respostas prontas em docs/LOJAS-DE-APP.md §5; depois vale para as próximas versões.',
  );
  return itens;
}

async function publicar() {
  const args = lerArgumentos(process.argv.slice(2));
  const intervaloBuildMs = segundosDoAmbiente('PUBLICAR_INTERVALO_BUILD', 60);
  const intervaloCapturasMs = segundosDoAmbiente('PUBLICAR_INTERVALO_CAPTURAS', 5);
  const config = lerConfig();
  relatorio = criarRelatorio({ segredos: [config.senha_demo] });
  const ficha = lerFicha(config);
  const expo = JSON.parse(readFileSync(join(RAIZ, 'mobile', 'app.json'), 'utf8')).expo;
  const versaoDoApp = expo.version;
  const bundle = expo.ios?.bundleIdentifier;
  if (!bundle) throw new Error('mobile/app.json sem expo.ios.bundleIdentifier.');
  const lidos = lerCapturas(resolve(process.env.PUBLICAR_CAPTURAS || join(RAIZ, 'media', 'app-store')));
  const quantas = lidos.map(({ conjunto, arquivos }) => `${arquivos.length} de ${conjunto.rotulo}`).join(' + ');
  relatorio.linha(`Ficha conferida: versão ${versaoDoApp}, capturas ${quantas}.`);

  if (args.simular) {
    relatorio.feito('Textos dentro dos limites da Apple, sem marcador sobrando e sem citar outra plataforma');
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

  if (app.attributes.primaryLocale !== IDIOMA) {
    try {
      await asc.patch(`/v1/apps/${app.id}`, { data: { type: 'apps', id: app.id, attributes: { primaryLocale: IDIOMA } } });
      relatorio.feito(`Idioma principal: ${IDIOMA}`);
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
  const { versao, jaLancado } = await acharOuCriarVersao(asc, app, versaoDoApp);
  await asc.patch(`/v1/appStoreVersions/${versao.id}`, {
    data: {
      type: 'appStoreVersions',
      id: versao.id,
      attributes: {
        // Versão editável com outro número (ex.: 1.0.0 recusada e o app.json já em 1.0.1):
        // o número acompanha o app.json, senão o build não casa com ela.
        ...(versao.attributes.versionString !== versaoDoApp ? { versionString: versaoDoApp } : {}),
        copyright: `© ${new Date().getFullYear()} ${config.titular_copyright}`,
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

  relatorio.passo('Conta de demonstração e notas para o revisor');
  await dadosDaRevisao(asc, versao, ficha, config);
  relatorio.feito(`Conta demo (${config.email_demo}) e notas para o revisor`);

  await precoGratis(asc, app);

  relatorio.passo(`Build da versão ${versaoDoApp}`);
  let build;
  if (args.aguardarMinutos) {
    relatorio.ok(`esperando até ${args.aguardarMinutos} min, consultando a cada ${intervaloBuildMs / 1000} s`);
    build = await esperarBuild(asc, app, versaoDoApp, args.aguardarMinutos, intervaloBuildMs);
  } else {
    build = await acharBuild(asc, app, versaoDoApp);
  }
  if (build?.attributes.processingState === 'VALID') {
    await asc.patch(`/v1/appStoreVersions/${versao.id}/relationships/build`, {
      data: { type: 'builds', id: build.id },
    });
    relatorio.feito(`Build ${build.attributes.version} preso à versão ${versaoDoApp}`);
  } else {
    const situacao = build
      ? `o build mais novo da versão ${versaoDoApp} está "${build.attributes.processingState}"`
      : `nenhum build da versão ${versaoDoApp} chegou à Apple ainda`;
    if (args.enviar) {
      throw new Error(`Sem build pronto não há o que enviar: ${situacao}. Rode com --aguardar-build <minutos> ou espere o e-mail da Apple.`);
    }
    relatorio.avisar(`${situacao[0].toUpperCase()}${situacao.slice(1)} — rode de novo quando ele aparecer processado.`);
  }

  const depois = [];
  if (args.enviar) {
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
