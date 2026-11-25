/**
 * A configuração (chave + contatos + conta demo) e os textos da ficha, conferidos ANTES de
 * falar com a Apple: limite de caracteres contado como a Apple conta ([...texto].length,
 * caractere e não byte), marcador {{...}} sem valor, menção a outra plataforma (diretriz
 * 2.3.10) e tela citada que o app deste commit não tem (diretriz 2.3: metadados fiéis ao
 * build) param aqui, com o nome do arquivo — e não lá, na revisão.
 *
 * As notas da revisão são em INGLÊS (o revisor lê inglês), com os rótulos das telas entre
 * aspas em português, como aparecem no app. A lista de aparelhos testados mora em
 * ficha/aparelhos-testados.txt — uma linha por aparelho, a primeira é o da gravação de tela.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = resolve(AQUI, '..', '..');

/** Limites da Apple, em caracteres. */
export const LIMITES = {
  nome: 30,
  subtitulo: 30,
  palavrasChave: 100,
  textoPromocional: 170,
  descricao: 4000,
  novidades: 4000,
  notasRevisao: 4000,
};

/** Diretriz 2.3.10: a ficha do iOS não cita outra plataforma móvel nem outra loja. */
const OUTRA_PLATAFORMA = /\b(android|google\s*play|play\s*store|apk|galaxy\s*store|app\s*gallery)\b/i;

/** O que vai no lugar de um dado que ainda não existe (a ficha sobe; a revisão, não). */
export const PENDENTE = '(pending)';

/**
 * Onde o revisor conecta o app quando ninguém disser outro endereço: hoje, a demo da Vercel
 * (ADR-42). A que sobe com a loja (ADR-46) mora em <domínio>/demo e entra pela Variable
 * APPLE_SERVIDOR_DEMO — trocar o padrão aqui troca o servidor de toda revisão.
 */
export const SERVIDOR_DEMO_PADRAO = 'https://loja-tria.vercel.app';

/**
 * O endereço do servidor de demonstração do jeito que o revisor digita no app: https://, o
 * host (com a porta, se houver) e, se houver, o CAMINHO — a demonstração que sobe com a loja
 * mora em <domínio>/demo (ADR-46). Sai sem a barra do fim. Recusa o que não é base: sem
 * HTTPS o iOS não conecta (ATS) e a revisão volta; consulta (?), âncora (#), credencial (@),
 * espaço e trecho vazio (//) viram pedaço de toda rota, porque quem junta (o app, a
 * conferência, a privacidade) junta por TEXTO; e /app ou /api é a página ou a API, não o
 * servidor — o app cortaria esse pedaço, e a conferência bateria em <página>/health.
 */
export function servidorDemo(texto) {
  const base = String(texto ?? '').trim().replace(/\/+$/, '');
  if (!/^https:\/\/[^/\s?#@]+(\/[^/\s?#@]+)*$/i.test(base)) {
    throw new Error(
      `url_servidor_demo tem de ser https://endereço, com o caminho se houver (ex.: https://loja.seudominio.com.br/demo), ` +
        `sem ?, # nem espaço: ${base}`,
    );
  }
  const caminho = base.replace(/^https:\/\/[^/]+/i, '');
  if (/(^|\/)(app|api)(\/|$)/i.test(caminho)) {
    throw new Error(
      `url_servidor_demo é a BASE do servidor (ex.: https://loja.seudominio.com.br/demo), não a página do sistema ` +
        `(/app) nem a API (/api): ${base}`,
    );
  }
  return base;
}

/**
 * Os padrões desta loja (publicar/padroes.json): issuer da chave, time da Apple, contato,
 * conta e código de barras da demo — nada secreto. Quem configura (config.json na máquina do
 * dono, Secrets/Variables no GitHub) vence; o que ficou vazio cai aqui. Chave começada por
 * "_" é comentário. PUBLICAR_PADROES aponta outro arquivo (os testes usam).
 */
export function lerPadroes(caminho = process.env.PUBLICAR_PADROES || join(AQUI, 'padroes.json')) {
  if (!existsSync(caminho)) return {};
  const bruto = JSON.parse(readFileSync(caminho, 'utf8'));
  return Object.fromEntries(
    Object.entries(bruto).filter(([chave, valor]) => !chave.startsWith('_') && typeof valor === 'string' && valor.trim()),
  );
}

/**
 * Só a revisão precisa deles: sem eles a ficha sobe (as notas dizem "(pending)") e o
 * --enviar para dizendo o que falta. O telefone pode já estar na Apple (envio anterior).
 */
export const SO_DA_REVISAO = ['telefone_contato', 'senha_demo'];

/**
 * Os textos de exemplo do config.exemplo.json ANTIGO (antes do padroes.json): um config.json
 * copiado dele e não editado não pode mandar "Nome Sobrenome" ou um telefone de mentira à
 * Apple por cima do padrão. Campo a campo — url_suporte/url_servidor_demo de lá eram reais.
 */
export const DO_MODELO_ANTIGO = {
  nome_contato: 'Nome Sobrenome',
  telefone_contato: '+55 11 90000-0000',
  titular_copyright: 'Seu nome ou o da sua empresa',
  senha_demo: 'senha-da-conta-demo',
  codigo_demo: 'um código de barras que exista no servidor de demonstração',
};

/** Vazio, "COLE_AQUI", e-mail @exemplo e o texto de exemplo daquele campo valem o mesmo que vazio. */
const naoPreenchido = (valor, campo) =>
  !valor || /COLE_AQUI|exemplo\./.test(String(valor)) || (campo in DO_MODELO_ANTIGO && DO_MODELO_ANTIGO[campo] === String(valor).trim());

/**
 * Rótulo citado na ficha → o arquivo (da raiz do repositório) onde o app o mostra. Se a ficha
 * cita o rótulo, o arquivo tem de existir e mostrá-lo: notas que mandam o revisor a uma tela
 * que o build não tem voltam por 2.1/2.3 — foi o que quase aconteceu com o leitor pelo
 * celular e com a exclusão de conta. Rótulo novo nas notas → uma linha aqui.
 */
export const TELAS_CITADAS = [
  ['Conectar à loja', 'mobile/src/app/(auth)/servidor.tsx'],
  ['Endereço do servidor', 'mobile/src/app/(auth)/servidor.tsx'],
  ['Entrar', 'mobile/src/app/(auth)/login.tsx'],
  ['Ler código de barras', 'mobile/src/app/(app)/(tabs)/index.tsx'],
  ['Digitar código', 'mobile/src/components/CodigoManual.tsx'],
  ['Buscar', 'mobile/src/app/(app)/(tabs)/index.tsx'],
  ['Cobrar', 'mobile/src/app/(app)/(tabs)/index.tsx'],
  ['Dinheiro', 'mobile/src/app/(app)/venda/pagamento.tsx'],
  ['Confirmar venda', 'mobile/src/app/(app)/venda/pagamento.tsx'],
  ['Recibo para a cliente', 'mobile/src/app/(app)/venda/[id].tsx'],
  ['Usuários', 'mobile/src/app/(app)/(tabs)/mais.tsx'],
  ['Leitor do computador', 'mobile/src/app/(app)/(tabs)/mais.tsx'],
  ['Ler o QR do computador', 'mobile/src/app/(app)/mais/leitor.tsx'],
  ['Celular como leitor', 'web/js/main.js'],
  // O chamado do leitor (ADR-47): o botão das telas do computador que leem código e o link do
  // QR ao lado dele (os rótulos moram em ROTULOS_DO_CHAMADO), e a faixa que desce no app aberto.
  ['Abrir no app o leitor de código', 'web/js/leitor-remoto.js'],
  ['Ler o QR', 'web/js/leitor-remoto.js'],
  ['O computador está chamando', 'mobile/src/components/FaixaDoChamado.tsx'],
  ['Abrir o leitor', 'mobile/src/components/FaixaDoChamado.tsx'],
  ['Minha conta', 'mobile/src/app/(app)/(tabs)/mais.tsx'],
  ['Excluir minha conta', 'mobile/src/app/(app)/mais/conta.tsx'],
  ['Excluir conta', 'mobile/src/app/(app)/mais/usuarios.tsx'],
  ['Conta excluída', 'mobile/src/lib/exclusaoDeConta.ts'],
  // O link da tela "Conectar à loja" para o guia de instalação do servidor aberto (Apple 3.2).
  ['Ainda não tem o sistema na loja?', 'mobile/src/lib/instalacaoDoServidor.ts'],
];

/** "iPhone 17 — iOS 26.1" (o travessão pode ser hífen; depois da versão, um comentário livre). */
const LINHA_DE_APARELHO = /^iPhone\s.+\s[—–-]\s+iOS\s+\d+(\.\d+){0,2}(\s.*)?$/;

export function lerConfig() {
  const caminho = process.env.PUBLICAR_CONFIG || join(AQUI, 'config.json');
  if (!existsSync(caminho)) {
    throw new Error(
      `Não achei ${caminho}.\n` +
        `  Copie config.exemplo.json para config.json (na pasta mobile/publicar), preencha, e\n` +
        `  ponha ao lado o arquivo .p8 baixado do App Store Connect.`,
    );
  }
  // Padrões da loja embaixo; o que o config.json PREENCHE vence (vazio e "COLE_AQUI", não).
  const c = { url_servidor_demo: SERVIDOR_DEMO_PADRAO, ...lerPadroes() };
  for (const [campo, valor] of Object.entries(JSON.parse(readFileSync(caminho, 'utf8')))) {
    if (!naoPreenchido(valor, campo)) c[campo] = valor;
  }
  for (const campo of SO_DA_REVISAO) if (naoPreenchido(c[campo], campo)) c[campo] = '';
  const obrigatorios = [
    'key_id',
    'issuer_id',
    'arquivo_p8',
    'email_suporte',
    'nome_contato',
    'email_demo',
    'codigo_demo',
    'titular_copyright',
    'url_servidor_demo',
  ];
  const faltando = obrigatorios.filter((campo) => naoPreenchido(c[campo], campo));
  if (faltando.length) throw new Error(`Preencha no config.json: ${faltando.join(', ')}`);
  // O revisor conecta o app NESTE endereço (com o caminho: <domínio>/demo é a demonstração,
  // <domínio> é a loja de verdade). Antes ele vinha escrito nas notas e apontava para o site
  // de outro sistema — o revisor entraria num servidor que não é o da loja.
  c.url_servidor_demo = servidorDemo(c.url_servidor_demo);
  // Por texto, nunca new URL('/privacidade', base): a barra do começo apagaria o /demo e a
  // ficha publicaria a política da LOJA no lugar da página da demonstração.
  c.url_privacidade = String(c.url_privacidade || `${c.url_servidor_demo}/privacidade`).trim();
  if (!/^https:\/\//i.test(c.url_privacidade)) throw new Error('url_privacidade tem de começar com https://');
  // Sem outra página (APPLE_URL_SUPORTE), o suporte É a privacidade da ficha: a do servidor da
  // demo, que troca junto com ele (fixo no padroes.json, ficava na Vercel depois da troca para
  // <domínio>/demo, e desligá-la derrubava o link de suporte da App Store), ou a que o dono pôs
  // em APPLE_URL_PRIVACIDADE — o endereço permanente dele vale para as duas, em vez de deixar
  // o suporte preso a um servidor que pode ser desligado. Na Vercel e na /demo dá o mesmo.
  c.url_suporte = String(c.url_suporte || c.url_privacidade).trim();
  // Os códigos para a câmera (Apple 2.1(a): o build 7 voltou pedindo "um QR de demonstração ou
  // uma imagem"): sem APPLE_URL_ETIQUETAS_DEMO, a página que o servidor da demo serve. Por texto,
  // como a privacidade: a barra do começo apagaria o /demo.
  c.url_etiquetas_demo = String(c.url_etiquetas_demo || `${c.url_servidor_demo}/codigos-para-teste`).trim();
  if (!/^https:\/\//i.test(c.url_etiquetas_demo)) throw new Error('url_etiquetas_demo tem de começar com https://');
  // A Apple quer uma URL de verdade no suporte; "loja.com.br" sem esquema vira https://.
  if (!/^[a-z]+:\/\//i.test(c.url_suporte)) c.url_suporte = `https://${c.url_suporte}`;
  if (!/^https:\/\/[^\s]+$/i.test(c.url_suporte)) throw new Error(`url_suporte tem de ser https://...: ${c.url_suporte}`);
  const p8Caminho = resolve(dirname(caminho), c.arquivo_p8);
  if (!existsSync(p8Caminho)) throw new Error(`Não achei a chave ${p8Caminho}. Baixe o .p8 no App Store Connect e ponha aí.`);
  c.p8 = readFileSync(p8Caminho, 'utf8');
  return c;
}

/**
 * Os aparelhos em que o app foi testado (ficha/aparelhos-testados.txt, ou PUBLICAR_APARELHOS):
 * uma linha por aparelho, "iPhone 17 — iOS 26.1"; linha vazia e "# comentário" não contam.
 * A PRIMEIRA linha é o aparelho da gravação de tela (o iOS mais novo). Vazio = a revisão não sai.
 */
export function lerAparelhosTestados(caminho = process.env.PUBLICAR_APARELHOS || join(AQUI, 'ficha', 'aparelhos-testados.txt')) {
  if (!existsSync(caminho)) return [];
  const linhas = readFileSync(caminho, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  const fora = linhas.filter((l) => !LINHA_DE_APARELHO.test(l));
  if (fora.length) {
    throw new Error(
      `ficha/aparelhos-testados.txt: linha fora do formato "iPhone 17 — iOS 26.1": ${fora.map((l) => `"${l}"`).join(', ')}. ` +
        'Uma linha por aparelho, com o modelo e a versão do iOS em que o teste rodou de verdade.',
    );
  }
  return linhas;
}

/**
 * Cada rótulo de TELAS_CITADAS que algum texto da ficha cita tem de estar no arquivo do app.
 * Devolve as frases do que falta ([] = tudo certo). `raiz` = a raiz do repositório (o teste
 * aponta PUBLICAR_TELAS para uma árvore de mentira).
 */
export function telasQueFaltam(textos, raiz = process.env.PUBLICAR_TELAS || RAIZ) {
  const faltas = [];
  for (const [rotulo, arquivo] of TELAS_CITADAS) {
    const citado = Object.entries(textos).find(([, texto]) => texto.includes(rotulo));
    if (!citado) continue;
    const caminho = join(raiz, arquivo);
    const existe = existsSync(caminho);
    if (existe && readFileSync(caminho, 'utf8').includes(rotulo)) continue;
    faltas.push(
      `ficha/${citado[0]} cita "${rotulo}", mas ${arquivo} ${existe ? 'não mostra esse texto' : 'não existe'} neste commit`,
    );
  }
  return faltas;
}

/**
 * Lê, preenche e confere os textos. `extras`: a lista de aparelhos testados e o anexo da revisão
 * — `{ tipo: 'video' | 'guia', nome }`, o ÚNICO que a Apple aceita (escolherAnexo, em
 * anexos.mjs). As notas citam só o que vai estar lá: o vídeo no item 1 ou, com o guia anexado,
 * a linha que começa com {{SE_GUIA_ANEXADO}} (sem ele, a linha sai inteira). Sem lista ou sem
 * vídeo, os marcadores viram "(pending)": a ficha pode subir, a revisão não.
 */
export function lerFicha(config, { aparelhos = [], anexo = null } = {}) {
  const ler = (nome) => readFileSync(join(AQUI, 'ficha', nome), 'utf8').trim();
  const video = anexo?.tipo === 'video' ? anexo.nome : null;
  const guia = anexo?.tipo === 'guia' ? anexo.nome : null;
  // Linha que começa com um destes marcadores só fica (sem ele) quando a condição vale.
  const condicionais = { '{{SE_GUIA_ANEXADO}}': Boolean(guia) };
  const valores = {
    EMAIL_SUPORTE: config.email_suporte || PENDENTE,
    URL_PRIVACIDADE: config.url_privacidade,
    SERVIDOR_DEMO: config.url_servidor_demo,
    EMAIL_DEMO: config.email_demo,
    // Sem a senha (Secret APPLE_DEMO_PASSWORD) a ficha sobe; a revisão, não (--enviar confere).
    SENHA_DEMO: config.senha_demo || PENDENTE,
    CODIGO_DEMO: config.codigo_demo,
    URL_CODIGOS: config.url_etiquetas_demo,
    APARELHOS_TESTADOS: aparelhos.length ? aparelhos.join('; ') : PENDENTE,
    APARELHO_DO_VIDEO: aparelhos[0] ?? PENDENTE,
    VIDEO: video ? `"${video}"` : PENDENTE,
    GUIA: guia ? `"${guia}"` : PENDENTE,
  };
  // Troca por função, não por texto: uma senha com "$&" ou "$1" seria lida como padrão de
  // substituição e chegaria à Apple estragada.
  const trocar = (texto) =>
    Object.entries(valores)
      .reduce((t, [marcador, valor]) => t.replaceAll(`{{${marcador}}}`, () => valor), texto)
      .split('\n')
      .flatMap((linha) => {
        const condicao = Object.keys(condicionais).find((marcador) => linha.startsWith(marcador));
        if (condicao) return condicionais[condicao] ? [linha.slice(condicao.length)] : [];
        return [linha];
      })
      .join('\n');

  const textos = [
    // [chave, arquivo, rótulo]
    ['nome', 'nome.txt', 'nome'],
    ['subtitulo', 'subtitulo.txt', 'subtítulo'],
    ['palavrasChave', 'palavras-chave.txt', 'palavras-chave'],
    ['textoPromocional', 'texto-promocional.txt', 'texto promocional'],
    ['descricao', 'descricao.txt', 'descrição'],
    ['novidades', 'novidades.txt', 'novidades desta versão'],
    ['notasRevisao', 'notas-revisao.txt', 'notas para a revisão'],
  ];
  const ficha = {};
  const porArquivo = {};
  for (const [chave, arquivo, rotulo] of textos) {
    const texto = trocar(ler(arquivo));
    const sobrou = texto.match(/\{\{[A-Z_]+\}\}/);
    if (sobrou) throw new Error(`ficha/${arquivo}: o marcador ${sobrou[0]} não tem valor.`);
    if (!texto) throw new Error(`ficha/${arquivo} está vazio.`);
    const n = [...texto].length; // a Apple conta caracteres, não bytes
    if (n > LIMITES[chave]) throw new Error(`O texto de ${rotulo} (ficha/${arquivo}) tem ${n} caracteres; o máximo é ${LIMITES[chave]}.`);
    if (OUTRA_PLATAFORMA.test(texto)) {
      throw new Error(
        `ficha/${arquivo} cita outra plataforma ("${texto.match(OUTRA_PLATAFORMA)[0]}"): a diretriz 2.3.10 da Apple recusa.`,
      );
    }
    ficha[chave] = texto;
    porArquivo[arquivo] = texto;
  }
  if (/,\s/.test(ficha.palavrasChave)) {
    throw new Error('ficha/palavras-chave.txt: sem espaço depois da vírgula — a Apple conta o espaço nos 100.');
  }
  const faltas = telasQueFaltam(porArquivo);
  if (faltas.length) {
    throw new Error(
      `A ficha cita tela que o app deste commit não tem — o revisor procuraria e não acharia (diretriz 2.3):\n    - ${faltas.join(
        '\n    - ',
      )}\n  Publique de um commit que tenha a tela (e o servidor de demonstração na mesma versão), ou tire a menção.`,
    );
  }
  return ficha;
}
