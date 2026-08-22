/**
 * Endereço do servidor da loja, escolhido no próprio celular.
 *
 * Poderia estar fixo em `EXPO_PUBLIC_API_URL`, mas isso o congelaria na hora de compilar: se
 * a loja trocasse de IP ou de provedor, seria preciso gerar um instalador novo e reinstalar
 * em todos os aparelhos. Guardando aqui, o MESMO arquivo instalado serve para qualquer
 * servidor, e a dona só passa o endereço uma vez para cada vendedor.
 *
 * `EXPO_PUBLIC_API_URL` continua valendo como sugestão inicial — útil em desenvolvimento e
 * para quem gera um instalador já apontado para a própria loja.
 */

import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import Constants from 'expo-constants';

const CHAVE = 'loja.servidor';

let emMemoria: string | null = null;

const armazem = {
  async ler(): Promise<string | null> {
    try {
      if (Platform.OS === 'web') return globalThis.localStorage?.getItem(CHAVE) ?? null;
      return await SecureStore.getItemAsync(CHAVE);
    } catch {
      return null;
    }
  },
  async gravar(valor: string): Promise<void> {
    try {
      if (Platform.OS === 'web') globalThis.localStorage?.setItem(CHAVE, valor);
      else await SecureStore.setItemAsync(CHAVE, valor);
    } catch {
      // Sem persistência o endereço vale só enquanto o app estiver aberto — melhor isso do
      // que travar quem está tentando conectar.
    }
  },
  async apagar(): Promise<void> {
    try {
      if (Platform.OS === 'web') globalThis.localStorage?.removeItem(CHAVE);
      else await SecureStore.deleteItemAsync(CHAVE);
    } catch {
      // O cache em memória já foi limpo por quem chamou.
    }
  },
};

/**
 * Arruma o que a pessoa digitou.
 *
 * O caso mais comum não é digitar o endereço "certo": é ler o que está na barra do navegador
 * do computador do balcão e repetir — algo como `http://169.58.209.199/app/#/pdv`. Sem
 * limpar, o app tentaria falar com `/app/#/pdv/api/v1/...` e daria erro sem explicação.
 * Também aceita só o IP, e completa com `http://`.
 *
 * Devolve `null` quando não dá para aproveitar nada.
 */
export function normalizarEndereco(bruto: string): string | null {
  let texto = (bruto || '').trim();
  if (!texto) return null;

  // Sem esquema, assume http:// — a loja típica roda em IP na rede local, sem certificado.
  if (!/^https?:\/\//i.test(texto)) texto = `http://${texto}`;

  let url: URL;
  try {
    url = new URL(texto);
  } catch {
    return null;
  }
  if (!url.hostname) return null;

  // Fora o host e a porta, nada mais interessa: o app monta os caminhos por conta própria.
  const porta = url.port ? `:${url.port}` : '';
  return `${url.protocol}//${url.hostname}${porta}`;
}

/** Sugestão inicial: o que veio no build, ou o host do Metro em desenvolvimento. */
export function enderecoSugerido(): string {
  const doBuild = process.env.EXPO_PUBLIC_API_URL;
  if (doBuild) return normalizarEndereco(doBuild) ?? '';

  const host = Constants.expoConfig?.hostUri?.split(':')[0];
  return host ? `http://${host}:8000` : '';
}

export async function lerServidor(): Promise<string | null> {
  if (emMemoria) return emMemoria;
  emMemoria = await armazem.ler();
  return emMemoria;
}

/** Versão sem `await`, para o interceptor do axios não pagar leitura de cofre por requisição. */
export function servidorEmCache(): string | null {
  return emMemoria;
}

export async function salvarServidor(endereco: string): Promise<void> {
  emMemoria = endereco;
  await armazem.gravar(endereco);
}

export async function esquecerServidor(): Promise<void> {
  emMemoria = null;
  await armazem.apagar();
}

export interface ResultadoDoTeste {
  ok: boolean;
  mensagem: string;
}

/**
 * Confere se há mesmo um sistema da loja naquele endereço, ANTES de guardar.
 *
 * Sem este teste, um dígito errado no IP só apareceria na tela de login, como "não foi
 * possível entrar" — e a pessoa culparia a senha.
 */
export async function testarServidor(endereco: string): Promise<ResultadoDoTeste> {
  const controle = new AbortController();
  const relogio = setTimeout(() => controle.abort(), 8000);
  try {
    const resposta = await fetch(`${endereco}/health`, { signal: controle.signal });
    if (!resposta.ok) {
      return { ok: false, mensagem: `O servidor respondeu com erro ${resposta.status}.` };
    }
    const dados = (await resposta.json()) as { status?: string };
    if (dados?.status !== 'ok') {
      return { ok: false, mensagem: 'Respondeu, mas não parece ser o sistema da loja.' };
    }
    return { ok: true, mensagem: 'Conectado.' };
  } catch (erro) {
    if ((erro as Error)?.name === 'AbortError') {
      return {
        ok: false,
        mensagem: 'O servidor não respondeu. Confira o endereço e se o celular está na mesma rede.',
      };
    }
    return {
      ok: false,
      mensagem: 'Não foi possível alcançar esse endereço. Confira os números e a internet.',
    };
  } finally {
    clearTimeout(relogio);
  }
}
