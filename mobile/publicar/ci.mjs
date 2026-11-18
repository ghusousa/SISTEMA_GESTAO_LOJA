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
 * Nunca imprime valor de segredo: só quais nomes estão faltando (e o UDID, mascarado).
 * Saídas (GITHUB_OUTPUT): tem_chave, tem_ficha, faltando_ficha, chave_p8, config, app_id,
 * versao_estado (inexistente | editavel | travada) e versao_mensagem; no "aparelhos", aparelhos.
 */

import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { criarCliente } from './asc.mjs';
import { mensagemDaTravada, situacaoDaVersao } from './versoes.mjs';

const AQUI = dirname(fileURLToPath(import.meta.url));
const MOBILE = resolve(AQUI, '..');
export const SERVIDOR_DEMO_PADRAO = 'https://loja-tria.vercel.app';

/** Variável → campo do config.json do publicar.mjs. As opcionais têm padrão. */
export const CAMPOS_DA_FICHA = [
  ['APPLE_EMAIL_SUPORTE', 'email_suporte'],
  ['APPLE_URL_SUPORTE', 'url_suporte'],
  ['APPLE_NOME_CONTATO', 'nome_contato'],
  ['APPLE_TELEFONE_CONTATO', 'telefone_contato'],
  ['APPLE_COPYRIGHT', 'titular_copyright'],
  ['APPLE_EMAIL_DEMO', 'email_demo'],
  ['APPLE_DEMO_PASSWORD', 'senha_demo'],
  ['APPLE_CODIGO_DEMO', 'codigo_demo'],
];

const limpo = (v) => (typeof v === 'string' ? v.trim() : '');

/**
 * O .p8 colado no Secret às vezes chega com "\n" literal (copiado de um JSON) ou com
 * \r\n do Windows. A Apple só aceita o PEM com quebras de verdade.
 */
export function normalizarP8(bruto) {
  let texto = limpo(bruto).replace(/\r\n/g, '\n');
  if (!texto.includes('\n') && texto.includes('\\n')) texto = texto.replace(/\\n/g, '\n');
  if (!/^-----BEGIN PRIVATE KEY-----\n[\s\S]+\n-----END PRIVATE KEY-----$/.test(texto)) return null;
  return `${texto}\n`;
}

/** O que dá para montar com o ambiente que chegou. Puro: o teste chama direto. */
export function montar(env) {
  const p8 = normalizarP8(env.ASC_KEY_P8);
  const temChave = Boolean(limpo(env.ASC_KEY_ID) && limpo(env.ASC_ISSUER_ID) && p8);
  const faltandoChave = [
    !limpo(env.ASC_KEY_ID) && 'ASC_KEY_ID',
    !limpo(env.ASC_ISSUER_ID) && 'ASC_ISSUER_ID',
    !p8 && (limpo(env.ASC_KEY_P8) ? 'ASC_KEY_P8 (não parece um .p8: copie o arquivo INTEIRO, com as linhas BEGIN/END)' : 'ASC_KEY_P8'),
  ].filter(Boolean);

  const faltandoFicha = CAMPOS_DA_FICHA.filter(([variavel]) => !limpo(env[variavel])).map(([v]) => v);
  const config = {
    key_id: limpo(env.ASC_KEY_ID),
    issuer_id: limpo(env.ASC_ISSUER_ID),
    arquivo_p8: 'chave-apple.p8',
    url_etiquetas_demo: limpo(env.APPLE_URL_ETIQUETAS_DEMO),
    url_servidor_demo: limpo(env.APPLE_SERVIDOR_DEMO) || SERVIDOR_DEMO_PADRAO,
    url_privacidade: limpo(env.APPLE_URL_PRIVACIDADE),
  };
  for (const [variavel, campo] of CAMPOS_DA_FICHA) config[campo] = limpo(env[variavel]);
  return { p8, temChave, faltandoChave, temFicha: temChave && faltandoFicha.length === 0, faltandoFicha, config };
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
  const r = montar(process.env);

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
  const r = montar(process.env);
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
  process.stdout.write(`✔ ${lista.length} iPhone(s) registrado(s) na conta: o perfil ad hoc pode ser assinado.\n`);
  saida('aparelhos', lista.length);
}

const executadoDireto = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (executadoDireto) {
  const comandos = { preparar, aparelhos };
  const comando = comandos[process.argv[2]];
  if (!comando) {
    process.stderr.write('Uso: node publicar/ci.mjs preparar | aparelhos\n');
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
