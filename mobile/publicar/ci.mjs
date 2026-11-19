#!/usr/bin/env node
/**
 * Prepara a publicação no GitHub Actions (.github/workflows/publicar-apple.yml).
 *
 *   node publicar/ci.mjs preparar
 *
 * Na máquina do dono, a chave e a ficha moram em publicar/config.json + chave-apple.p8
 * (fora do git). No Actions elas vêm dos Secrets/Variables do repositório; este script
 * monta os MESMOS arquivos numa pasta temporária do runner (PASTA_SAIDA, fora do
 * repositório, permissão 600), para o publicar.mjs e o eas rodarem sem mudar nada.
 *
 * Também acha o app no App Store Connect pelo bundle do app.json e grava o ascAppId no
 * perfil de envio "ci" do eas.json — só na cópia do runner. Sem ascAppId o eas não envia
 * nada em modo não interativo; e o app NÃO pode ser criado pela API da Apple (só no site),
 * então app inexistente vira um aviso com o passo a passo, não um erro escondido. E diz em
 * que pé está a versão do app.json na Apple (a mesma regra do publicador, versoes.mjs):
 * versão já enviada ou publicada não aceita build novo, e o workflow para ANTES de gastar
 * 20 a 40 min compilando.
 *
 *   node publicar/ci.mjs aparelhos
 *
 * O teste em iPhones reais (perfil "teste-aparelhos" do eas.json, .ipa ad hoc) só é assinado
 * com pelo menos um iPhone registrado na conta da Apple: lista os registrados e, com
 * UDID_APARELHO (a entrada "udid_aparelho" do botão), registra esse. Sem nenhum, falha
 * dizendo como resolver. Experimental até a primeira rodada real.
 *
 * Nunca imprime valor de segredo: só quais nomes estão faltando (e o UDID, mascarado). O que
 * não é segredo (issuer da chave, time da Apple, contato, conta e código da demo) tem padrão
 * em publicar/padroes.json: com ele, o GitHub só precisa de EXPO_TOKEN, ASC_KEY_ID e
 * ASC_KEY_P8 para subir a ficha.
 * Saídas (GITHUB_OUTPUT): issuer_id, team_id, team_type, faltando_revisao, tem_chave,
 * tem_ficha, faltando_ficha, chave_p8, config, app_id, versao_estado (inexistente | editavel |
 * travada) e versao_mensagem; no "aparelhos", aparelhos.
 */

import { createPrivateKey } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { criarCliente } from './asc.mjs';
import { SERVIDOR_DEMO_PADRAO, SO_DA_REVISAO, lerPadroes } from './ficha.mjs';
import { mensagemDaTravada, situacaoDaVersao } from './versoes.mjs';

const AQUI = dirname(fileURLToPath(import.meta.url));
const MOBILE = resolve(AQUI, '..');
export { SERVIDOR_DEMO_PADRAO };

/**
 * Variável → campo do config.json do publicar.mjs. Vazia, vale o publicar/padroes.json (nada
 * secreto); os de SO_DA_REVISAO (senha da demo, telefone) só a revisão exige.
 */
export const CAMPOS_DA_FICHA = [
  ['APPLE_EMAIL_SUPORTE', 'email_suporte'],
  ['APPLE_NOME_CONTATO', 'nome_contato'],
  ['APPLE_TELEFONE_CONTATO', 'telefone_contato'],
  ['APPLE_COPYRIGHT', 'titular_copyright'],
  ['APPLE_EMAIL_DEMO', 'email_demo'],
  ['APPLE_DEMO_PASSWORD', 'senha_demo'],
  ['APPLE_CODIGO_DEMO', 'codigo_demo'],
];

const limpo = (v) => (typeof v === 'string' ? v.trim() : '');

/** Onde cada peça só da revisão mora no GitHub (o workflow lê a senha só de Secret). */
const ondeVai = (nome) =>
  nome === 'APPLE_DEMO_PASSWORD' ? `${nome} (Secret)` : nome === 'APPLE_TELEFONE_CONTATO' ? `${nome} (Variable ou Secret)` : nome;

/**
 * O .p8 colado no Secret chega de muitos jeitos: com "\n" literal (copiado de um JSON), com
 * \r\n do Windows, numa linha só (quem colou juntou as linhas), sem as linhas BEGIN/END ou
 * entre aspas. Vale o CORPO: base64 que o Node aceita como chave PKCS#8 — e sai o PEM que a
 * Apple quer (linhas de 64, BEGIN/END). Qualquer outra coisa → null.
 */
export function normalizarP8(bruto) {
  const corpo = limpo(bruto)
    .replace(/\\n/g, '\n')
    .replace(/^["']+|["']+$/g, '')
    .replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '')
    .replace(/\s+/g, '');
  if (!corpo || !/^[A-Za-z0-9+/]+={0,2}$/.test(corpo)) return null;
  try {
    createPrivateKey({ key: Buffer.from(corpo, 'base64'), format: 'der', type: 'pkcs8' });
  } catch {
    return null;
  }
  return `-----BEGIN PRIVATE KEY-----\n${corpo.match(/.{1,64}/g).join('\n')}\n-----END PRIVATE KEY-----\n`;
}

/**
 * Por que o ASC_KEY_P8 não serviu, sem mostrar NADA do que foi colado: só a forma (o tamanho
 * e se parece o ID da chave, o Issuer ID ou o nome do arquivo). É o erro mais comum de quem
 * cola o Secret pela primeira vez.
 */
export function porQueNaoEhP8(bruto) {
  const texto = limpo(bruto);
  const comoFazer = 'abra o arquivo AuthKey_….p8 no Bloco de Notas, Ctrl+A, Ctrl+C e cole o texto INTEIRO, com as linhas BEGIN/END';
  if (/^[A-Z0-9]{10}$/.test(texto)) return `parece o ID da chave (10 letras e números), não o arquivo: ${comoFazer}`;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(texto)) return `parece o Issuer ID, não o arquivo: ${comoFazer}`;
  if ((/AuthKey_|\.p8\b/i.test(texto) || texto.includes('\\')) && texto.length < 300 && !/BEGIN/.test(texto)) {
    return `parece o NOME ou o caminho do arquivo, não o conteúdo: ${comoFazer}`;
  }
  if (/BEGIN/.test(texto)) return `tem a linha BEGIN, mas a chave não está inteira ou está estragada (${texto.length} caracteres): ${comoFazer}`;
  return `não é uma chave .p8 (${texto.length} caracteres; o arquivo tem uns 250): ${comoFazer}`;
}

/**
 * O que dá para montar com o ambiente que chegou, sobre os `padroes` da loja (padroes.json:
 * issuer, time, contato, demo). Puro: o teste chama direto — sem `padroes`, só o ambiente.
 * `faltandoFicha` impede a ficha; `faltandoRevisao` (senha da demo, telefone) só a revisão.
 */
export function montar(env, padroes = {}) {
  const valor = (variavel, campo) => limpo(env[variavel]) || limpo(padroes[campo]);
  const p8 = normalizarP8(env.ASC_KEY_P8);
  const issuer = valor('ASC_ISSUER_ID', 'issuer_id');
  const temChave = Boolean(limpo(env.ASC_KEY_ID) && issuer && p8);
  const faltandoChave = [
    !limpo(env.ASC_KEY_ID) && 'ASC_KEY_ID',
    !issuer && 'ASC_ISSUER_ID',
    !p8 && (limpo(env.ASC_KEY_P8) ? `ASC_KEY_P8 (${porQueNaoEhP8(env.ASC_KEY_P8)})` : 'ASC_KEY_P8'),
  ].filter(Boolean);

  const faltam = (soDaRevisao) =>
    CAMPOS_DA_FICHA.filter(([v, campo]) => SO_DA_REVISAO.includes(campo) === soDaRevisao && !valor(v, campo)).map(([v]) => v);
  const faltandoFicha = faltam(false);
  const config = {
    key_id: limpo(env.ASC_KEY_ID),
    issuer_id: issuer,
    arquivo_p8: 'chave-apple.p8',
    url_etiquetas_demo: valor('APPLE_URL_ETIQUETAS_DEMO', 'url_etiquetas_demo'),
    url_servidor_demo: valor('APPLE_SERVIDOR_DEMO', 'url_servidor_demo') || SERVIDOR_DEMO_PADRAO,
    // Vazia, a privacidade vira <servidor>/privacidade no lerConfig (ficha.mjs, na hora de
    // publicar), depois de o endereço do servidor ser conferido — e troca junto com
    // APPLE_SERVIDOR_DEMO. O suporte vazio segue a privacidade: a preenchida em
    // APPLE_URL_PRIVACIDADE, se houver (o endereço permanente do dono), ou essa do servidor.
    url_privacidade: valor('APPLE_URL_PRIVACIDADE', 'url_privacidade'),
    url_suporte: valor('APPLE_URL_SUPORTE', 'url_suporte'),
  };
  for (const [variavel, campo] of CAMPOS_DA_FICHA) config[campo] = valor(variavel, campo);
  // O time da Apple (para a Expo montar certificado e perfil sozinha): nada secreto.
  const time = { id: valor('APPLE_TEAM_ID', 'apple_team_id'), tipo: valor('APPLE_TEAM_TYPE', 'apple_team_type') || 'INDIVIDUAL' };
  return {
    p8,
    temChave,
    faltandoChave,
    temFicha: temChave && faltandoFicha.length === 0,
    faltandoFicha,
    faltandoRevisao: faltam(true),
    config,
    time,
  };
}

/** Grava o ascAppId no perfil de envio "ci" (que herda do production). Devolve o JSON novo. */
export function comAscAppId(easJson, ascAppId) {
  const eas = JSON.parse(JSON.stringify(easJson));
  const perfil = eas.submit?.ci;
  if (!perfil) throw new Error('eas.json sem o perfil de envio "ci".');
  perfil.ios = { ...(perfil.ios ?? {}), ascAppId: String(ascAppId) };
  return eas;
}

export async function acharApp(cliente, bundle) {
  const apps = await cliente.get(`/v1/apps?filter[bundleId]=${encodeURIComponent(bundle)}`);
  return apps.data?.[0]?.id ?? null;
}

/**
 * A versão do app.json na Apple: "inexistente" (o publicador cria), "editavel" (aceita build
 * e ficha) ou "travada" (já enviada, em revisão, aprovada ou à venda — build novo com esse
 * número não tem para onde ir). Só leitura. Devolve { estado, mensagem }.
 */
export async function estadoDaVersaoNaApple(cliente, appId, versaoDoApp) {
  const s = await situacaoDaVersao(cliente, appId, versaoDoApp);
  if (s.travada) return { estado: 'travada', mensagem: mensagemDaTravada(versaoDoApp, s.travada) };
  return { estado: s.editavel ? 'editavel' : 'inexistente', mensagem: '' };
}

/** UDID de iPhone: 8 hex, hífen e 16 hex (iPhone XS em diante) ou 40 hex (os anteriores). */
export const UDID = /^([0-9A-Fa-f]{8}-[0-9A-Fa-f]{16}|[0-9A-Fa-f]{40})$/;
/** O UDID nunca sai inteiro no log: identifica um aparelho de alguém. */
export const mascararUdid = (udid) => `${String(udid).slice(0, 8)}…`;

const COMO_ACHAR_O_UDID =
  'Achar o UDID sem Mac: no Windows, iTunes → o iPhone conectado → clique no "Número de série" até aparecer o UDID; ' +
  'ou, num computador com o eas-cli, "npx eas-cli device:create" gera um link que registra o iPhone (na Expo e na Apple).';

/**
 * O perfil ad hoc ("teste-aparelhos") só é assinado com pelo menos UM iPhone registrado na
 * conta da Apple — qualquer um serve: o BrowserStack reassina o .ipa para os aparelhos dele.
 * Lista os registrados (iOS, ativos) e, com `udid`, registra esse antes, se ainda não estiver.
 * Devolve { aparelhos, registrado: null | {novo, nome} }; sem nenhum, lança Error com o passo a passo.
 */
export async function garantirAparelho(cliente, { udid = '', nome = '' } = {}) {
  const pedido = limpo(udid);
  let registrado = null;
  if (pedido) {
    if (!UDID.test(pedido)) {
      throw new Error(
        `"udid_aparelho" não parece um UDID de iPhone (${pedido.length} caracteres; o UDID tem 25, ` +
          `"00008030-001A2B3C4D5E802E", ou 40 nos iPhones antigos). ${COMO_ACHAR_O_UDID}`,
      );
    }
    const mesmo = (
      await cliente.get(`/v1/devices?filter[udid]=${encodeURIComponent(pedido)}&limit=10`)
    ).data?.find((d) => d.attributes?.udid?.toLowerCase() === pedido.toLowerCase());
    if (mesmo?.attributes?.status === 'DISABLED') {
      throw new Error(
        `O iPhone ${mascararUdid(pedido)} está registrado, mas DESATIVADO na conta da Apple ` +
          '(developer.apple.com → Certificates, Identifiers & Profiles → Devices): reative-o lá, ou passe o UDID de outro iPhone.',
      );
    }
    if (mesmo) registrado = { novo: false, nome: mesmo.attributes.name };
    else {
      const novo = (
        await cliente.post('/v1/devices', {
          data: {
            type: 'devices',
            attributes: { name: limpo(nome) || 'iPhone de teste da loja', platform: 'IOS', udid: pedido },
          },
        })
      ).data;
      registrado = { novo: true, nome: novo?.attributes?.name ?? limpo(nome) };
    }
  }
  const aparelhos = (await cliente.get('/v1/devices?filter[platform]=IOS&filter[status]=ENABLED&limit=200')).data ?? [];
  if (!aparelhos.length) {
    throw new Error(
      'Nenhum iPhone registrado na conta da Apple: o .ipa de teste (perfil ad hoc "teste-aparelhos") só é assinado com ' +
        'pelo menos um. Rode de novo com a entrada "udid_aparelho" preenchida com o UDID de um iPhone — qualquer um da loja ' +
        `serve: o BrowserStack reassina o app para os aparelhos dele. ${COMO_ACHAR_O_UDID}`,
    );
  }
  return { aparelhos, registrado };
}

function saida(nome, valor) {
  const arquivo = process.env.GITHUB_OUTPUT;
  const linha = `${nome}=${String(valor).replace(/[\r\n]+/g, ' ')}\n`;
  if (arquivo) appendFileSync(arquivo, linha);
  else process.stdout.write(linha);
}

async function preparar() {
  const pasta = resolve(process.env.PASTA_SAIDA || join(process.env.RUNNER_TEMP || '/tmp', 'apple'));
  mkdirSync(pasta, { recursive: true, mode: 0o700 });
  const r = montar(process.env, lerPadroes());

  // Nada secreto: o issuer e o time vêm do padroes.json quando não há Secret/Variable, e os
  // passos do eas leem daqui (secrets.X || steps.apple.outputs.x no workflow).
  saida('issuer_id', r.config.issuer_id);
  saida('team_id', r.time.id);
  saida('team_type', r.time.tipo);
  saida('faltando_revisao', r.faltandoRevisao.join(' '));
  saida('tem_chave', r.temChave ? 'sim' : 'nao');
  if (!r.temChave) {
    process.stdout.write(`⚠ Chave da Apple incompleta — faltam os Secrets: ${r.faltandoChave.join(', ')}.\n`);
    saida('tem_ficha', 'nao');
    saida('faltando_ficha', r.faltandoChave.join(' '));
    saida('app_id', '');
    return;
  }

  const caminhoP8 = join(pasta, 'chave-apple.p8');
  writeFileSync(caminhoP8, r.p8, { mode: 0o600 });
  chmodSync(caminhoP8, 0o600);
  saida('chave_p8', caminhoP8);

  saida('tem_ficha', r.temFicha ? 'sim' : 'nao');
  saida('faltando_ficha', r.faltandoFicha.join(' '));
  if (r.temFicha) {
    const caminhoConfig = join(pasta, 'config.json');
    writeFileSync(caminhoConfig, JSON.stringify(r.config, null, 2), { mode: 0o600 });
    chmodSync(caminhoConfig, 0o600);
    saida('config', caminhoConfig);
    if (r.faltandoRevisao.length) {
      process.stdout.write(
        `ℹ A ficha sobe; a REVISÃO ainda pede: ${r.faltandoRevisao.map(ondeVai).join(', ')}. ` +
          'O telefone pode já estar na Apple, de um envio anterior — o publicador confere antes de enviar.\n',
      );
    }
  } else {
    process.stdout.write(`⚠ Ficha da loja não será enviada — faltam: ${r.faltandoFicha.join(', ')}.\n`);
  }

  const appJson = JSON.parse(readFileSync(join(MOBILE, 'app.json'), 'utf8'));
  const bundle = appJson.expo?.ios?.bundleIdentifier;
  const versaoDoApp = appJson.expo?.version;
  if (!bundle) throw new Error('app.json sem expo.ios.bundleIdentifier.');
  const cliente = criarCliente({ keyId: r.config.key_id, issuerId: r.config.issuer_id, p8: r.p8 });
  const appId = await acharApp(cliente, bundle);
  saida('app_id', appId ?? '');
  if (!appId) {
    saida('versao_estado', 'inexistente');
    saida('versao_mensagem', '');
    process.stdout.write(
      `⚠ O app ${bundle} ainda não existe no App Store Connect. A Apple só deixa criá-lo pelo site:\n` +
        `  appstoreconnect.apple.com → Apps → + → Novo app → iOS, nome "Gestão de Loja", Idioma principal\n` +
        `  "Português (Brasil)", bundle ${bundle}, SKU gestao-loja.\n` +
        `  O build sai assim mesmo (fica na Expo); depois de criar o app, rode de novo com "Enviar o último build".\n`,
    );
    return;
  }
  const versao = await estadoDaVersaoNaApple(cliente, appId, versaoDoApp);
  saida('versao_estado', versao.estado);
  saida('versao_mensagem', versao.mensagem);
  if (versao.estado === 'travada') process.stdout.write(`⚠ ${versao.mensagem}\n`);
  else process.stdout.write(`✔ Versão ${versaoDoApp} na Apple: ${versao.estado === 'editavel' ? 'em preparo (aceita build e ficha)' : 'ainda não existe (o publicador cria)'}.\n`);
  const caminhoEas = process.env.EAS_JSON || join(MOBILE, 'eas.json');
  const eas = comAscAppId(JSON.parse(readFileSync(caminhoEas, 'utf8')), appId);
  writeFileSync(caminhoEas, `${JSON.stringify(eas, null, 2)}\n`);
  process.stdout.write(`✔ App achado no App Store Connect (${bundle}); envio automático ligado.\n`);
}

/** O comando "aparelhos": antes de compilar o .ipa de teste (ad hoc) para iPhones reais. */
async function aparelhos() {
  const r = montar(process.env, lerPadroes());
  if (!r.temChave) {
    throw new Error(`Chave da Apple incompleta — faltam os Secrets: ${r.faltandoChave.join(', ')}. Sem ela não há como consultar os aparelhos.`);
  }
  const cliente = criarCliente({ keyId: r.config.key_id, issuerId: r.config.issuer_id, p8: r.p8 });
  const { aparelhos: lista, registrado } = await garantirAparelho(cliente, {
    udid: process.env.UDID_APARELHO,
    nome: process.env.NOME_APARELHO,
  });
  if (registrado?.novo) {
    process.stdout.write(`✔ iPhone ${mascararUdid(limpo(process.env.UDID_APARELHO))} registrado na conta da Apple ("${registrado.nome}").\n`);
  } else if (registrado) {
    process.stdout.write(`✔ O iPhone ${mascararUdid(limpo(process.env.UDID_APARELHO))} já estava registrado ("${registrado.nome}").\n`);
  }
  // Registrar na Apple é a metade: a Expo monta o perfil ad hoc com os iPhones que ELA conhece
  // (o cadastro dela, não o da Apple), e a 1ª credencial ad hoc o eas-cli só monta no modo
  // interativo ("Credentials are not set up", "No devices are registered for this Apple team").
  process.stdout.write(
    `✔ ${lista.length} iPhone(s) registrado(s) na conta da Apple. Isso não basta para o perfil ad hoc: a Expo usa o ` +
      'cadastro DELA, e a 1ª credencial ad hoc só sai no modo interativo. Na 1ª vez, num computador (dentro de mobile/): ' +
      '"npx eas-cli build --platform ios --profile teste-aparelhos" — registra o iPhone na Expo (ou "npx eas-cli ' +
      'device:create" antes) e monta a credencial; depois, a caixa "aparelhos" roda sozinha.\n',
  );
  saida('aparelhos', lista.length);
}

/**
 * O comando "senha-demo": grava a senha da conta de demonstração no campo "Senha" da revisão da
 * versão em edição na Apple (com o e-mail da conta demo e "login obrigatório"). A senha chega por
 * SENHA_DEMO (a entrada do workflow "Senha da conta demo na Apple", já mascarada no log) e nunca é
 * impressa. Dali em diante o publicador usa a que está na Apple quando não há o Secret
 * APPLE_DEMO_PASSWORD.
 */
export async function gravarSenhaDemo(cliente, { appId, versaoDoApp, email, senha }) {
  const s = await situacaoDaVersao(cliente, appId, versaoDoApp);
  if (!s.editavel) {
    throw new Error(`A versão ${versaoDoApp} não está em edição na Apple: rode a ficha antes (ela cria/abre a versão).`);
  }
  let detalhe = null;
  try {
    detalhe = (await cliente.get(`/v1/appStoreVersions/${s.editavel.id}/appStoreReviewDetail`)).data ?? null;
  } catch (erro) {
    if (erro.status !== 404) throw erro;
  }
  const attributes = { demoAccountName: email, demoAccountPassword: senha, demoAccountRequired: true };
  if (detalhe) {
    await cliente.patch(`/v1/appStoreReviewDetails/${detalhe.id}`, { data: { type: 'appStoreReviewDetails', id: detalhe.id, attributes } });
  } else {
    await cliente.post('/v1/appStoreReviewDetails', {
      data: {
        type: 'appStoreReviewDetails',
        attributes,
        relationships: { appStoreVersion: { data: { type: 'appStoreVersions', id: s.editavel.id } } },
      },
    });
  }
  return { versaoId: s.editavel.id, criado: !detalhe };
}

async function senhaDemo() {
  const senha = limpo(process.env.SENHA_DEMO);
  if (!senha) {
    throw new Error(
      'Senha vazia: preencha a entrada "senha" do workflow com a senha da conta demo (na demo que sobe com a loja, ' +
        './demo.sh --mostrar, na máquina dela; na Vercel, a DEMO_ADMIN_SENHA).',
    );
  }
  const r = montar(process.env, lerPadroes());
  if (!r.temChave) throw new Error(`Chave da Apple incompleta — faltam os Secrets: ${r.faltandoChave.join(', ')}.`);
  const appJson = JSON.parse(readFileSync(join(MOBILE, 'app.json'), 'utf8'));
  const bundle = appJson.expo?.ios?.bundleIdentifier;
  const versaoDoApp = appJson.expo?.version;
  const cliente = criarCliente({ keyId: r.config.key_id, issuerId: r.config.issuer_id, p8: r.p8 });
  const appId = await acharApp(cliente, bundle);
  if (!appId) throw new Error(`O app ${bundle} não existe no App Store Connect.`);
  const g = await gravarSenhaDemo(cliente, { appId, versaoDoApp, email: r.config.email_demo, senha });
  process.stdout.write(
    `✔ Senha da conta demo (${r.config.email_demo}) gravada no campo "Senha" da revisão da versão ${versaoDoApp}` +
      `${g.criado ? ' (detalhe da revisão criado)' : ''}. As próximas rodadas usam ela sem o Secret.\n`,
  );
}

const executadoDireto = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (executadoDireto) {
  const comandos = { preparar, aparelhos, 'senha-demo': senhaDemo };
  const comando = comandos[process.argv[2]];
  if (!comando) {
    process.stderr.write('Uso: node publicar/ci.mjs preparar | aparelhos | senha-demo\n');
    process.exit(2);
  }
  if (!existsSync(join(MOBILE, 'app.json'))) {
    process.stderr.write('Rode de dentro de mobile/.\n');
    process.exit(2);
  }
  comando().catch((erro) => {
    // A mensagem do asc.mjs traz o status e o corpo da Apple, nunca a chave.
    process.stderr.write(`✖ ${erro.message}\n`);
    process.exit(1);
  });
}
