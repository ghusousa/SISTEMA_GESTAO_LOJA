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
 *
 * O endereço guardado é a BASE, com caminho quando houver (`https://loja.x.com.br/demo`, a
 * demonstração da ADR-46). Como arrumar o que foi digitado e como juntar a base com cada
 * rota mora em `lib/enderecoDoServidor.ts`, com teste.
 */

import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import Constants from 'expo-constants';

import { mensagemDoTesteRecusado, normalizarEndereco, urlDeSaude } from '../lib/enderecoDoServidor';

export { normalizarEndereco };

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
    const resposta = await fetch(urlDeSaude(endereco), { signal: controle.signal });
    if (!resposta.ok) {
      const corpo: unknown = await resposta.json().catch(() => null);
      return { ok: false, mensagem: mensagemDoTesteRecusado(resposta.status, corpo) };
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
