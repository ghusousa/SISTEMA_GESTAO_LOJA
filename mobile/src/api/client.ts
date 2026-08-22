/**
 * Cliente HTTP.
 *
 * O ponto delicado é o 401: se cinco telas pedirem dados ao mesmo tempo com o access token
 * vencido, um refresh por requisição rotacionaria o token cinco vezes e a API — que revoga a
 * família inteira ao ver reuso — derrubaria a sessão. Por isso o refresh acontece sob um
 * mutex: o primeiro renova, os outros esperam a mesma promessa e refazem a requisição.
 */

import axios, { AxiosError, type AxiosInstance, type InternalAxiosRequestConfig } from 'axios';

import { lerAccessToken, lerRefreshToken, limparSessao, salvarTokens } from './sessao';
import { enderecoSugerido, servidorEmCache } from './servidor';
import type { ErroApi, Tokens } from './tipos';

/**
 * O endereço do servidor é escolhido no celular (api/servidor.ts) e pode mudar sem
 * recompilar, então NÃO dá para congelá-lo aqui: cada requisição pergunta qual é o atual.
 */
export function baseAtual(): string {
  return servidorEmCache() ?? enderecoSugerido();
}

export const api: AxiosInstance = axios.create({
  timeout: 15000,
  headers: { 'Content-Type': 'application/json' },
});

type Pendente = InternalAxiosRequestConfig & { _jaTentouRefresh?: boolean };

let refreshEmAndamento: Promise<string | null> | null = null;
let aoPerderSessao: (() => void) | null = null;

/** Chamado quando o refresh falha: a camada de navegação leva o usuário ao login. */
export function registrarPerdaDeSessao(callback: () => void): void {
  aoPerderSessao = callback;
}

api.interceptors.request.use(async (config) => {
  // A base vem daqui, e não do `create`, porque o servidor pode ser trocado com o app
  // aberto — em "Mais → Servidor". Fixá-la na criação deixaria o app falando com o
  // endereço antigo até alguém fechar e abrir de novo.
  config.baseURL = `${baseAtual()}/api/v1`;
  const token = await lerAccessToken();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

async function renovarSessao(): Promise<string | null> {
  const refresh = await lerRefreshToken();
  if (!refresh) return null;
  try {
    // Cliente separado: passar pelo `api` cairia no interceptor e viraria recursão.
    const { data } = await axios.post<Tokens>(
      `${baseAtual()}/api/v1/auth/refresh`,
      { refresh_token: refresh },
      { timeout: 15000 },
    );
    await salvarTokens(data.access_token, data.refresh_token);
    return data.access_token;
  } catch {
    return null;
  }
}

api.interceptors.response.use(
  (resposta) => resposta,
  async (erro: AxiosError<ErroApi>) => {
    const original = erro.config as Pendente | undefined;
    const ehLoginOuRefresh =
      original?.url?.includes('/auth/login') || original?.url?.includes('/auth/refresh');

    if (erro.response?.status !== 401 || !original || original._jaTentouRefresh || ehLoginOuRefresh) {
      return Promise.reject(erro);
    }

    original._jaTentouRefresh = true;
    refreshEmAndamento = refreshEmAndamento ?? renovarSessao();
    const novoToken = await refreshEmAndamento;
    refreshEmAndamento = null;

    if (!novoToken) {
      await limparSessao();
      aoPerderSessao?.();
      return Promise.reject(erro);
    }

    original.headers.Authorization = `Bearer ${novoToken}`;
    return api(original);
  },
);

/** Extrai a mensagem que o usuário deve ler. A API sempre manda `message` em português. */
export function mensagemDoErro(erro: unknown, padrao = 'Não foi possível concluir.'): string {
  if (axios.isAxiosError<ErroApi>(erro)) {
    if (erro.response?.data?.message) return erro.response.data.message;
    if (erro.code === 'ECONNABORTED') return 'A conexão demorou demais. Tente de novo.';
    if (!erro.response) return 'Sem conexão com o servidor da loja.';
  }
  return padrao;
}

export function codigoDoErro(erro: unknown): string | null {
  return axios.isAxiosError<ErroApi>(erro) ? (erro.response?.data?.code ?? null) : null;
}

export function detalheDoErro(erro: unknown): Record<string, unknown> | null {
  return axios.isAxiosError<ErroApi>(erro) ? (erro.response?.data?.detail ?? null) : null;
}

/**
 * A API grava a foto como caminho relativo ("/media/produtos/x.jpg") de propósito: montar a
 * URL a partir do header Host deixaria um atacante gravar o próprio domínio no banco.
 * Quem exibe a imagem completa o endereço aqui.
 */
export function urlDaFoto(caminho: string | null | undefined): string | null {
  if (!caminho) return null;
  return caminho.startsWith("http") ? caminho : `${baseAtual()}${caminho}`;
}
