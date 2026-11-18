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
  ['Minha conta', 'mobile/src/app/(app)/(tabs)/mais.tsx'],
  ['Excluir minha conta', 'mobile/src/app/(app)/mais/conta.tsx'],
  ['Excluir conta', 'mobile/src/app/(app)/mais/usuarios.tsx'],
  ['Conta excluída', 'mobile/src/lib/exclusaoDeConta.ts'],
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
    'url_servidor_demo',
  ];
  const faltando = obrigatorios.filter((campo) => !c[campo] || /COLE_AQUI|exemplo\./.test(String(c[campo])));
  if (faltando.length) throw new Error(`Preencha no config.json: ${faltando.join(', ')}`);
  // O revisor conecta o app NESTE endereço: sem HTTPS o iOS recusa a conexão (ATS) e a
  // revisão volta. Antes ele vinha escrito nas notas e apontava para o site de outro
  // sistema — o revisor entraria num servidor que não é o da loja.
  c.url_servidor_demo = String(c.url_servidor_demo).trim().replace(/\/+$/, '');
  if (!/^https:\/\/[^/\s]+$/i.test(c.url_servidor_demo)) {
    throw new Error(`url_servidor_demo tem de ser só https://endereço (sem caminho): ${c.url_servidor_demo}`);
  }
  c.url_privacidade = String(c.url_privacidade || `${c.url_servidor_demo}/privacidade`).trim();
  if (!/^https:\/\//i.test(c.url_privacidade)) throw new Error('url_privacidade tem de começar com https://');
  // A Apple quer uma URL de verdade no suporte; "loja.com.br" sem esquema vira https://.
  c.url_suporte = String(c.url_suporte).trim();
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
 * Lê, preenche e confere os textos. `extras`: a lista de aparelhos testados e o nome do vídeo
 * anexado — sem eles, os marcadores viram "(pending)": a ficha pode subir, a revisão não.
 */
export function lerFicha(config, { aparelhos = [], video = null } = {}) {
  const ler = (nome) => readFileSync(join(AQUI, 'ficha', nome), 'utf8').trim();
  const linhaEtiquetas = config.url_etiquetas_demo
    ? `   No label? Open ${config.url_etiquetas_demo} on another screen to scan sample barcodes.`
    : null;
  const valores = {
    EMAIL_SUPORTE: config.email_suporte,
    URL_PRIVACIDADE: config.url_privacidade,
    SERVIDOR_DEMO: config.url_servidor_demo,
    EMAIL_DEMO: config.email_demo,
    SENHA_DEMO: config.senha_demo,
    CODIGO_DEMO: config.codigo_demo,
    APARELHOS_TESTADOS: aparelhos.length ? aparelhos.join('; ') : PENDENTE,
    APARELHO_DO_VIDEO: aparelhos[0] ?? PENDENTE,
    VIDEO: video ? `"${video}"` : PENDENTE,
  };
  // Troca por função, não por texto: uma senha com "$&" ou "$1" seria lida como padrão de
  // substituição e chegaria à Apple estragada.
  const trocar = (texto) =>
    Object.entries(valores)
      .reduce((t, [marcador, valor]) => t.replaceAll(`{{${marcador}}}`, () => valor), texto)
      .split('\n')
      .flatMap((linha) =>
        linha.includes('{{LINHA_ETIQUETAS}}') ? (linhaEtiquetas ? [linhaEtiquetas] : []) : [linha],
      )
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
