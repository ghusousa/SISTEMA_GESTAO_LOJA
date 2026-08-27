#!/usr/bin/env node
/**
 * Publica a ficha COMPLETA do app na App Store Connect, sem clique nenhum:
 * nome, subtítulo, descrição, palavras-chave, capturas, categoria, classificação
 * etária, preço grátis, dados de revisão (conta demo + notas) e o build mais novo.
 *
 *   npm run publicar            prepara tudo e PARA antes de enviar para revisão
 *   npm run publicar -- --enviar  faz tudo E envia para a revisão da Apple
 *   npm run publicar:simular    só confere arquivos e textos, sem falar com a Apple
 *
 * O que este script NÃO cobre — e é limite da Apple, não nosso:
 *   • a ficha de Privacidade do App (sem API pública; preencher uma vez na tela,
 *     seguindo docs/LOJAS-DE-APP.md item 5);
 *   • criar a conta e aceitar contratos.
 *
 * Ordem de uso na primeira publicação:
 *   1. eas build --platform ios --profile production
 *   2. eas submit --platform ios --latest      (cria o registro do app e sobe o build)
 *   3. npm run publicar -- --enviar
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { criarCliente } from './asc.mjs';

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = resolve(AQUI, '..', '..');
const PASTA_CAPTURAS = join(RAIZ, 'media', 'app-store', 'iphone-6.5');
const BUNDLE = 'com.gestaoloja.app';
const IDIOMA = 'pt-BR';
// Tamanhos que a Apple aceita no slot de iPhone 6,5" (o nosso é o primeiro).
const TAMANHOS_65 = [
  [1242, 2688],
  [2688, 1242],
  [1284, 2778],
  [2778, 1284],
];

const simular = process.argv.includes('--simular');
const enviarParaRevisao = process.argv.includes('--enviar');
const avisos = [];

const passo = (texto) => process.stdout.write(`\n• ${texto}\n`);
const ok = (texto) => process.stdout.write(`  ✔ ${texto}\n`);
const avisar = (texto) => {
  avisos.push(texto);
  process.stdout.write(`  ⚠ ${texto}\n`);
};
const falhar = (texto) => {
  process.stderr.write(`\n✖ ${texto}\n`);
  process.exit(1);
};

// ---------- configuração e textos ----------

function lerConfig() {
  const caminho = process.env.PUBLICAR_CONFIG || join(AQUI, 'config.json');
  if (!existsSync(caminho)) {
    falhar(
      `Não achei ${caminho}.\n` +
        `  Copie config.exemplo.json para config.json (na pasta mobile/publicar), preencha, e\n` +
        `  ponha ao lado o arquivo .p8 baixado do App Store Connect.`,
    );
  }
  const c = JSON.parse(readFileSync(caminho, 'utf8'));
  const obrigatorios = [
    'key_id',
    'issuer_id',
    'arquivo_p8',
    'email_suporte',
    'url_suporte',
    'nome_contato',
    'telefone_contato',
    'email_demo',
    'senha_demo',
    'codigo_demo',
    'titular_copyright',
  ];
  const faltando = obrigatorios.filter((campo) => !c[campo] || /COLE_AQUI|exemplo\./.test(String(c[campo])));
  if (faltando.length) falhar(`Preencha no config.json: ${faltando.join(', ')}`);
  const p8Caminho = resolve(dirname(caminho), c.arquivo_p8);
  if (!existsSync(p8Caminho)) falhar(`Não achei a chave ${p8Caminho}. Baixe o .p8 no App Store Connect e ponha aí.`);
  c.p8 = readFileSync(p8Caminho, 'utf8');
  return c;
}

function lerFicha(config) {
  const ler = (nome) => readFileSync(join(AQUI, 'ficha', nome), 'utf8').trim();
  const linhaEtiquetas = config.url_etiquetas_demo
    ? `      Se não tiver uma etiqueta à mão, abra ${config.url_etiquetas_demo} em outra tela/monitor: é uma folha de códigos de exemplo, feita para ser bipada.`
    : null;
  const trocar = (texto) =>
    texto
      .replaceAll('{{EMAIL_SUPORTE}}', config.email_suporte)
      .replaceAll('{{EMAIL_DEMO}}', config.email_demo)
      .replaceAll('{{SENHA_DEMO}}', config.senha_demo)
      .replaceAll('{{CODIGO_DEMO}}', config.codigo_demo)
      .split('\n')
      .flatMap((linha) =>
        linha.includes('{{LINHA_ETIQUETAS}}') ? (linhaEtiquetas ? [linhaEtiquetas] : []) : [linha],
      )
      .join('\n');

  const ficha = {
    nome: ler('nome.txt'),
    subtitulo: ler('subtitulo.txt'),
    palavrasChave: ler('palavras-chave.txt'),
    descricao: trocar(ler('descricao.txt')),
    notasRevisao: trocar(ler('notas-revisao.txt')),
  };

  const limites = [
    ['nome', ficha.nome, 30],
    ['subtítulo', ficha.subtitulo, 30],
    ['palavras-chave', ficha.palavrasChave, 100],
    ['descrição', ficha.descricao, 4000],
    ['notas de revisão', ficha.notasRevisao, 4000],
  ];
  for (const [rotulo, texto, maximo] of limites) {
    const n = [...texto].length; // a Apple conta caracteres, não bytes
    if (n > maximo) falhar(`O texto de ${rotulo} tem ${n} caracteres; o máximo é ${maximo}.`);
  }
  return ficha;
}

function lerCapturas() {
  if (!existsSync(PASTA_CAPTURAS)) falhar(`Não achei a pasta de capturas ${PASTA_CAPTURAS}.`);
  const arquivos = readdirSync(PASTA_CAPTURAS)
    .filter((a) => a.endsWith('.png'))
    .sort(); // os nomes começam com o número da ordem de exibição
  if (!arquivos.length) falhar('A pasta de capturas está vazia.');
  return arquivos.map((nome) => {
    const dados = readFileSync(join(PASTA_CAPTURAS, nome));
    if (dados.readUInt32BE(12) !== 0x49484452) falhar(`${nome} não parece um PNG válido.`);
    const largura = dados.readUInt32BE(16);
    const altura = dados.readUInt32BE(20);
    if (!TAMANHOS_65.some(([l, a]) => l === largura && a === altura)) {
      falhar(`${nome} tem ${largura}x${altura}; a Apple aceita ${TAMANHOS_65.map((t) => t.join('x')).join(', ')}.`);
    }
    return { nome, dados };
  });
}

// ---------- conversa com a Apple ----------

async function principal() {
  const config = lerConfig();
  const ficha = lerFicha(config);
  const capturas = lerCapturas();
  const versaoDoApp = JSON.parse(readFileSync(join(RAIZ, 'mobile', 'app.json'), 'utf8')).expo.version;

  process.stdout.write(`Ficha conferida: ${capturas.length} capturas, versão ${versaoDoApp}.\n`);
  if (simular) {
    process.stdout.write('\n--simular: nada foi enviado. Tudo pronto para publicar de verdade.\n');
    return;
  }

  const asc = criarCliente({ keyId: config.key_id, issuerId: config.issuer_id, p8: config.p8 });

  passo('Procurando o app na sua conta');
  const apps = await asc.get(`/v1/apps?filter[bundleId]=${BUNDLE}`);
  const app = apps.data[0];
  if (!app) {
    falhar(
      `Nenhum app com o bundle ${BUNDLE} na conta.\n` +
        `  Rode primeiro: eas submit --platform ios --latest (ele cria o registro e sobe o build).`,
    );
  }
  ok(`${app.attributes.name} (${app.id})`);

  if (app.attributes.primaryLocale !== IDIOMA) {
    try {
      await asc.patch(`/v1/apps/${app.id}`, {
        data: { type: 'apps', id: app.id, attributes: { primaryLocale: IDIOMA } },
      });
      ok(`Idioma principal ajustado para ${IDIOMA}`);
    } catch {
      avisar(`Não deu para trocar o idioma principal para ${IDIOMA} — confira na tela.`);
    }
  }

  passo('Nome, subtítulo e URL de privacidade');
  const infos = await asc.get(`/v1/apps/${app.id}/appInfos`);
  const info =
    infos.data.find((i) => i.attributes.appStoreState === 'PREPARE_FOR_SUBMISSION') ?? infos.data[0];
  const infoLocs = await asc.get(`/v1/appInfos/${info.id}/appInfoLocalizations`);
  let infoLoc = infoLocs.data.find((l) => l.attributes.locale === IDIOMA);
  const atributosInfo = {
    name: ficha.nome,
    subtitle: ficha.subtitulo,
    privacyPolicyUrl: 'https://sistemaobras.com.br/privacidade',
  };
  if (infoLoc) {
    await asc.patch(`/v1/appInfoLocalizations/${infoLoc.id}`, {
      data: { type: 'appInfoLocalizations', id: infoLoc.id, attributes: atributosInfo },
    });
  } else {
    infoLoc = (
      await asc.post('/v1/appInfoLocalizations', {
        data: {
          type: 'appInfoLocalizations',
          attributes: { locale: IDIOMA, ...atributosInfo },
          relationships: { appInfo: { data: { type: 'appInfos', id: info.id } } },
        },
      })
    ).data;
  }
  ok(`"${ficha.nome}" — ${ficha.subtitulo}`);

  passo('Categoria: Business + Productivity');
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
  ok('feito');

  passo('Classificação etária (tudo "não" -> 4+)');
  try {
    const decl = await asc.get(`/v1/appInfos/${info.id}/ageRatingDeclaration`);
    await asc.patch(`/v1/ageRatingDeclarations/${decl.data.id}`, {
      data: {
        type: 'ageRatingDeclarations',
        id: decl.data.id,
        attributes: {
          alcoholTobaccoOrDrugUseOrReferences: 'NONE',
          contests: 'NONE',
          gamblingSimulated: 'NONE',
          horrorOrFearThemes: 'NONE',
          matureOrSuggestiveThemes: 'NONE',
          medicalOrTreatmentInformation: 'NONE',
          profanityOrCrudeHumor: 'NONE',
          sexualContentGraphicAndNudity: 'NONE',
          sexualContentOrNudity: 'NONE',
          violenceCartoonOrFantasy: 'NONE',
          violenceRealistic: 'NONE',
          violenceRealisticProlongedGraphicOrSadistic: 'NONE',
          gambling: false,
          unrestrictedWebAccess: false,
        },
      },
    });
    ok('feito');
  } catch (erro) {
    avisar(`Classificação etária falhou (${erro.message}). Responda "não" em tudo na tela — leva 2 min.`);
  }

  passo(`Versão ${versaoDoApp} para publicar`);
  const editaveis = ['PREPARE_FOR_SUBMISSION', 'DEVELOPER_REJECTED', 'REJECTED', 'METADATA_REJECTED'];
  const versoes = await asc.get(`/v1/apps/${app.id}/appStoreVersions?limit=20`);
  let versao = versoes.data.find((v) => editaveis.includes(v.attributes.appStoreState));
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
    ok('versão criada');
  } else {
    ok(`versão já existia (${versao.attributes.versionString})`);
  }
  await asc.patch(`/v1/appStoreVersions/${versao.id}`, {
    data: {
      type: 'appStoreVersions',
      id: versao.id,
      attributes: {
        copyright: `© ${new Date().getFullYear()} ${config.titular_copyright}`,
        releaseType: 'AFTER_APPROVAL',
      },
    },
  });

  passo('Descrição, palavras-chave e URLs');
  const jaLancado = versoes.data.some((v) => v.attributes.appStoreState === 'READY_FOR_SALE');
  const locs = await asc.get(`/v1/appStoreVersions/${versao.id}/appStoreVersionLocalizations`);
  let loc = locs.data.find((l) => l.attributes.locale === IDIOMA);
  const atributosLoc = {
    description: ficha.descricao,
    keywords: ficha.palavrasChave,
    supportUrl: config.url_suporte,
    // Na primeira versão a Apple recusa "Novidades" — só existe o que estrear.
    ...(jaLancado ? { whatsNew: 'Correções e melhorias desta versão.' } : {}),
  };
  if (loc) {
    await asc.patch(`/v1/appStoreVersionLocalizations/${loc.id}`, {
      data: { type: 'appStoreVersionLocalizations', id: loc.id, attributes: atributosLoc },
    });
  } else {
    loc = (
      await asc.post('/v1/appStoreVersionLocalizations', {
        data: {
          type: 'appStoreVersionLocalizations',
          attributes: { locale: IDIOMA, ...atributosLoc },
          relationships: { appStoreVersion: { data: { type: 'appStoreVersions', id: versao.id } } },
        },
      })
    ).data;
  }
  ok('feito');

  passo(`Capturas de tela (${capturas.length})`);
  const conjuntos = await asc.get(`/v1/appStoreVersionLocalizations/${loc.id}/appScreenshotSets`);
  let conjunto = conjuntos.data.find((c) => c.attributes.screenshotDisplayType === 'APP_IPHONE_65');
  if (!conjunto) {
    conjunto = (
      await asc.post('/v1/appScreenshotSets', {
        data: {
          type: 'appScreenshotSets',
          attributes: { screenshotDisplayType: 'APP_IPHONE_65' },
          relationships: {
            appStoreVersionLocalization: {
              data: { type: 'appStoreVersionLocalizations', id: loc.id },
            },
          },
        },
      })
    ).data;
  }
  // Recomeça do zero para o resultado ser sempre a pasta, na ordem da pasta.
  const existentes = await asc.get(`/v1/appScreenshotSets/${conjunto.id}/appScreenshots?limit=50`);
  for (const antiga of existentes.data) await asc.del(`/v1/appScreenshots/${antiga.id}`);

  const enviadas = [];
  for (const captura of capturas) {
    const reserva = (
      await asc.post('/v1/appScreenshots', {
        data: {
          type: 'appScreenshots',
          attributes: { fileName: captura.nome, fileSize: captura.dados.length },
          relationships: { appScreenshotSet: { data: { type: 'appScreenshotSets', id: conjunto.id } } },
        },
      })
    ).data;
    await asc.subirArquivo(reserva.attributes.uploadOperations, captura.dados);
    await asc.patch(`/v1/appScreenshots/${reserva.id}`, {
      data: {
        type: 'appScreenshots',
        id: reserva.id,
        attributes: {
          uploaded: true,
          sourceFileChecksum: createHash('md5').update(captura.dados).digest('hex'),
        },
      },
    });
    enviadas.push(reserva.id);
    ok(captura.nome);
  }
  await asc.patch(`/v1/appScreenshotSets/${conjunto.id}/relationships/appScreenshots`, {
    data: enviadas.map((id) => ({ type: 'appScreenshots', id })),
  });

  passo('Conta de demonstração e notas para o revisor');
  const [nome, ...sobrenomes] = config.nome_contato.trim().split(/\s+/);
  const atributosRevisao = {
    contactFirstName: nome,
    contactLastName: sobrenomes.join(' ') || nome,
    contactPhone: config.telefone_contato,
    contactEmail: config.email_suporte,
    demoAccountName: config.email_demo,
    demoAccountPassword: config.senha_demo,
    demoAccountRequired: true,
    notes: ficha.notasRevisao,
  };
  let detalheRevisao = null;
  try {
    detalheRevisao = (await asc.get(`/v1/appStoreVersions/${versao.id}/appStoreReviewDetail`)).data;
  } catch (erro) {
    if (erro.status !== 404) throw erro;
  }
  if (detalheRevisao) {
    await asc.patch(`/v1/appStoreReviewDetails/${detalheRevisao.id}`, {
      data: { type: 'appStoreReviewDetails', id: detalheRevisao.id, attributes: atributosRevisao },
    });
  } else {
    await asc.post('/v1/appStoreReviewDetails', {
      data: {
        type: 'appStoreReviewDetails',
        attributes: atributosRevisao,
        relationships: { appStoreVersion: { data: { type: 'appStoreVersions', id: versao.id } } },
      },
    });
  }
  ok('feito');

  passo('Preço: Grátis, em todos os países');
  try {
    const pontos = await asc.get(
      `/v1/apps/${app.id}/appPricePoints?filter[territory]=USA&limit=1`,
    );
    const gratis = pontos.data.find((p) => Number(p.attributes.customerPrice) === 0) ?? pontos.data[0];
    await asc.post('/v1/appPriceSchedules', {
      data: {
        type: 'appPriceSchedules',
        relationships: {
          app: { data: { type: 'apps', id: app.id } },
          baseTerritory: { data: { type: 'territories', id: 'USA' } },
          manualPrices: { data: [{ type: 'appPrices', id: 'preco-novo' }] },
        },
      },
      included: [
        {
          type: 'appPrices',
          id: 'preco-novo',
          attributes: { startDate: null },
          relationships: { appPricePoint: { data: { type: 'appPricePoints', id: gratis.id } } },
        },
      ],
    });
    ok('feito');
  } catch (erro) {
    avisar(`Preço não foi definido pela API (${erro.message}). Na tela: Pricing > Grátis — 1 clique.`);
  }

  passo('Prendendo o build mais novo na versão');
  const builds = await asc.get(`/v1/builds?filter[app]=${app.id}&sort=-uploadedDate&limit=1`);
  const build = builds.data[0];
  if (!build) {
    avisar('Nenhum build na conta ainda. Rode: eas build ... e depois eas submit --platform ios --latest.');
  } else if (build.attributes.processingState !== 'VALID') {
    avisar(`O build mais novo ainda está "${build.attributes.processingState}". Espere e rode de novo.`);
  } else {
    await asc.patch(`/v1/appStoreVersions/${versao.id}/relationships/build`, {
      data: { type: 'builds', id: build.id },
    });
    ok(`build ${build.attributes.version} preso à versão`);
  }

  if (enviarParaRevisao) {
    passo('Enviando para a revisão da Apple');
    if (!build || build.attributes.processingState !== 'VALID') {
      falhar('Sem build válido não há o que enviar. Resolva o aviso acima e rode de novo com --enviar.');
    }
    const envio = (
      await asc.post('/v1/reviewSubmissions', {
        data: {
          type: 'reviewSubmissions',
          attributes: { platform: 'IOS' },
          relationships: { app: { data: { type: 'apps', id: app.id } } },
        },
      })
    ).data;
    await asc.post('/v1/reviewSubmissionItems', {
      data: {
        type: 'reviewSubmissionItems',
        relationships: {
          reviewSubmission: { data: { type: 'reviewSubmissions', id: envio.id } },
          appStoreVersion: { data: { type: 'appStoreVersions', id: versao.id } },
        },
      },
    });
    await asc.patch(`/v1/reviewSubmissions/${envio.id}`, {
      data: { type: 'reviewSubmissions', id: envio.id, attributes: { submitted: true } },
    });
    ok('ENVIADO. A Apple costuma responder em 1 a 3 dias.');
  }

  process.stdout.write('\n———\n');
  if (avisos.length) {
    process.stdout.write(`Terminou com ${avisos.length} aviso(s) acima — o resto está feito.\n`);
  } else {
    process.stdout.write('Tudo feito, sem avisos.\n');
  }
  if (!enviarParaRevisao) {
    process.stdout.write('Nada foi enviado para revisão. Quando quiser: npm run publicar -- --enviar\n');
  }
  process.stdout.write(
    'Lembrete (manual por limite da Apple): a ficha de Privacidade do App — docs/LOJAS-DE-APP.md item 5.\n',
  );
}

principal().catch((erro) => falhar(erro.message));
