/**
 * Cliente HTTP.
 *
 * O ponto delicado é o 401: se cinco telas pedirem dados ao mesmo tempo com o access token
 * vencido, um refresh por requisição rotacionaria o token cinco vezes e a API — que revoga a
 * família inteira ao ver reuso — derrubaria a sessão. Por isso o refresh acontece sob um
 * mutex: o primeiro renova, os outros esperam a mesma promessa e refazem a requisição.
 *
 * E só o servidor recusando o token derruba a sessão (`refreshRecusado`). Refresh que cai
 * na rede rejeita a requisição com o erro de rede e deixa token e carrinho onde estavam.
 */

import axios, { AxiosError, type AxiosInstance, type InternalAxiosRequestConfig } from 'axios';

import { montarUrlDaFoto } from '../lib/enderecoDaFoto';
import { refreshRecusado } from '../lib/renovacao';
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

/**
 * O token novo, ou `null` quando a sessão acabou de verdade (sem refresh no cofre, ou o
 * servidor o recusou). Falha de rede, timeout e 5xx REJEITAM: não são resposta sobre o
 * token, e tratá-las como `null` apagava um refresh válido e esvaziava o carrinho do PDV a
 * cada oscilação do Wi-Fi da loja.
 */
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
  } catch (erro) {
    if (axios.isAxiosError(erro) && refreshRecusado(erro.response?.status)) return null;
    throw erro;
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
    // A promessa se solta sozinha ao terminar (bem ou mal): agora ela também pode rejeitar,
    // e quem esperava não pode deixar o mutex preso numa renovação que já falhou.
    refreshEmAndamento ??= renovarSessao().finally(() => {
      refreshEmAndamento = null;
    });
    let novoToken: string | null;
    try {
      novoToken = await refreshEmAndamento;
    } catch (erroDoRefresh) {
      // Rede caiu no meio da renovação: a requisição falha como falha de rede (é isso que
      // `mensagemDoErro` e o BannerConexao mostram) e a sessão fica. A próxima tenta de novo.
      return Promise.reject(erroDoRefresh);
    }

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
 * Foto do disco da loja vem relativa ("/media/produtos/x.jpg") e ganha o servidor do aparelho;
 * foto no Vercel Blob vem com URL absoluta e passa como está (`lib/enderecoDaFoto.ts`, ADR-42).
 */
export function urlDaFoto(caminho: string | null | undefined): string | null {
  return montarUrlDaFoto(caminho, baseAtual());
}
