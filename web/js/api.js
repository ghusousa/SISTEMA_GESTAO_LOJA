/**
 * Cliente HTTP da API.
 *
 * Duas decisões que valem a leitura:
 *
 * 1. O access token vive só em memória (esta variável). O refresh vive num cookie httpOnly
 *    que o servidor grava e o JavaScript não enxerga — por isso não há nada de sessão em
 *    localStorage. Recarregar a página perde o access token, e a sessão volta sozinha
 *    chamando /auth/refresh com o cookie.
 *
 * 2. Um 401 dispara uma renovação e refaz a requisição. Se três telas levarem 401 juntas,
 *    todas esperam a MESMA renovação (`renovacaoEmCurso`): duas rotações simultâneas com o
 *    mesmo refresh derrubariam a família de tokens inteira por suspeita de roubo.
 */

import { sessao } from './store.js';

const BASE = '/api/v1';

let accessToken = null;
let renovacaoEmCurso = null;
let aoPerderSessao = () => {};

/**
 * O access token de agora, para o canal de tempo real se identificar.
 *
 * Continua só na memória — ler daqui não é o mesmo que guardar em `localStorage`, que é
 * onde ele viraria alvo de qualquer script que entre na página.
 */
export const acessoAtual = () => accessToken;

export function definirTratadorDeSessaoPerdida(fn) {
  aoPerderSessao = fn;
}

/** Erro de API já traduzido: `code` e `message` vêm do handler global do servidor. */
export class ErroApi extends Error {
  constructor(status, code, message, detail) {
    super(message);
    this.name = 'ErroApi';
    this.status = status;
    this.code = code;
    this.detail = detail || {};
  }

  /** Mensagem pronta para o usuário, já com os campos inválidos quando houver. */
  get textoAmigavel() {
    const campos = this.detail?.campos;
    if (this.code === 'VALIDACAO' && campos && typeof campos === 'object') {
      const linhas = Object.entries(campos).map(([campo, erro]) => `${campo}: ${erro}`);
      if (linhas.length) return `${this.message}\n${linhas.join('\n')}`;
    }
    return this.message;
  }
}

const SEM_REDE = 'Sem conexão com o servidor. Verifique a rede e tente de novo.';

async function bruto(metodo, caminho, { corpo, formData, semAuth = false } = {}) {
  const headers = {};
  if (accessToken && !semAuth) headers.Authorization = `Bearer ${accessToken}`;
  if (corpo !== undefined) headers['Content-Type'] = 'application/json';

  let resposta;
  try {
    resposta = await fetch(BASE + caminho, {
      method: metodo,
      headers,
      body: formData ?? (corpo !== undefined ? JSON.stringify(corpo) : undefined),
      credentials: 'same-origin',
    });
  } catch {
    throw new ErroApi(0, 'SEM_REDE', SEM_REDE);
  }

  if (resposta.status === 204) return null;

  const texto = await resposta.text();
  let dados = null;
  if (texto) {
    try {
      dados = JSON.parse(texto);
    } catch {
      dados = null;
    }
  }

  if (!resposta.ok) {
    throw new ErroApi(
      resposta.status,
      dados?.code || 'ERRO',
      dados?.message || `Falha na operação (${resposta.status}).`,
      dados?.detail,
    );
  }
  return dados;
}

async function renovar() {
  // Sem corpo: o refresh viaja no cookie httpOnly.
  renovacaoEmCurso ??= bruto('POST', '/auth/refresh', { semAuth: true })
    .then((dados) => {
      accessToken = dados.access_token;
      sessao.set({ usuario: dados.usuario, carregando: false });
      return dados;
    })
    .finally(() => {
      renovacaoEmCurso = null;
    });
  return renovacaoEmCurso;
}

async function pedir(metodo, caminho, opcoes = {}) {
  try {
    return await bruto(metodo, caminho, opcoes);
  } catch (erro) {
    const podeRenovar =
      erro instanceof ErroApi &&
      erro.status === 401 &&
      !opcoes.semAuth &&
      !caminho.startsWith('/auth/refresh') &&
      !caminho.startsWith('/auth/login');
    if (!podeRenovar) throw erro;

    try {
      await renovar();
    } catch {
      accessToken = null;
      sessao.set({ usuario: null, carregando: false });
      aoPerderSessao();
      throw erro;
    }
    return bruto(metodo, caminho, opcoes);
  }
}

const qs = (params) => {
  if (!params) return '';
  const busca = new URLSearchParams();
  for (const [chave, valor] of Object.entries(params)) {
    if (valor === undefined || valor === null || valor === '') continue;
    busca.set(chave, String(valor));
  }
  const texto = busca.toString();
  return texto ? `?${texto}` : '';
};

export const api = {
  get: (caminho, params) => pedir('GET', caminho + qs(params)),
  post: (caminho, corpo) => pedir('POST', caminho, { corpo }),
  patch: (caminho, corpo) => pedir('PATCH', caminho, { corpo }),
  put: (caminho, corpo) => pedir('PUT', caminho, { corpo }),
  delete: (caminho) => pedir('DELETE', caminho),
  upload: (caminho, formData) => pedir('PUT', caminho, { formData }),
};

export async function entrar(email, senha) {
  const dados = await bruto('POST', '/auth/login', {
    corpo: { email, senha },
    semAuth: true,
  });
  accessToken = dados.access_token;
  sessao.set({ usuario: dados.usuario, carregando: false });
  return dados.usuario;
}

export async function sair() {
  try {
    await pedir('POST', '/auth/logout');
  } catch {
    // Servidor fora do ar não pode prender ninguém dentro do sistema: cai a sessão local.
  }
  accessToken = null;
  sessao.set({ usuario: null, carregando: false });
}

/**
 * Tenta reerguer a sessão ao abrir a página, usando só o cookie.
 * Retorna o usuário ou `null` — nunca lança, porque "não estou logado" é o caso normal.
 */
export async function restaurarSessao() {
  try {
    const dados = await renovar();
    return dados.usuario;
  } catch {
    sessao.set({ usuario: null, carregando: false });
    return null;
  }
}
