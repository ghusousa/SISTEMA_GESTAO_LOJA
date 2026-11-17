/**
 * A configuração (chave + contatos + conta demo) e os textos da ficha, conferidos ANTES de
 * falar com a Apple: limite de caracteres contado como a Apple conta ([...texto].length,
 * caractere e não byte), marcador {{...}} sem valor e menção a outra plataforma
 * (diretriz 2.3.10) param aqui, com o nome do arquivo — e não lá, na revisão.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = dirname(fileURLToPath(import.meta.url));

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

export function lerFicha(config) {
  const ler = (nome) => readFileSync(join(AQUI, 'ficha', nome), 'utf8').trim();
  const linhaEtiquetas = config.url_etiquetas_demo
    ? `      Se não tiver uma etiqueta à mão, abra ${config.url_etiquetas_demo} em outra tela/monitor: ` +
      'é uma folha de códigos de exemplo, feita para ser bipada.'
    : null;
  const trocar = (texto) =>
    texto
      .replaceAll('{{EMAIL_SUPORTE}}', config.email_suporte)
      .replaceAll('{{URL_PRIVACIDADE}}', config.url_privacidade)
      .replaceAll('{{SERVIDOR_DEMO}}', config.url_servidor_demo)
      .replaceAll('{{EMAIL_DEMO}}', config.email_demo)
      .replaceAll('{{SENHA_DEMO}}', config.senha_demo)
      .replaceAll('{{CODIGO_DEMO}}', config.codigo_demo)
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
  }
  if (/,\s/.test(ficha.palavrasChave)) {
    throw new Error('ficha/palavras-chave.txt: sem espaço depois da vírgula — a Apple conta o espaço nos 100.');
  }
  return ficha;
}
