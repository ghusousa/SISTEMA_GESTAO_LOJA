/**
 * Guarda dos tokens. No celular ficam no SecureStore (Keychain/Keystore), nunca no
 * AsyncStorage.
 *
 * Há um cache em memória porque o interceptor do axios roda em todo request e ler do
 * Keychain a cada chamada custa caro.
 */

import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

import type { Usuario } from './tipos';

const CHAVE_ACCESS = 'loja.access_token';
const CHAVE_REFRESH = 'loja.refresh_token';
const CHAVE_USUARIO = 'loja.usuario';

let accessEmMemoria: string | null = null;
let refreshEmMemoria: string | null = null;

/**
 * O SecureStore não existe no navegador — chamá-lo lá estoura e derruba o app no boot.
 * O alvo do produto é o celular; a versão web serve para desenvolvimento e demonstração,
 * e nela o armazenamento é o `localStorage`, que NÃO é seguro. Se um dia o app web virar
 * produto, a sessão precisa migrar para cookie httpOnly.
 */
const armazem = {
  async ler(chave: string): Promise<string | null> {
    try {
      if (Platform.OS === 'web') return globalThis.localStorage?.getItem(chave) ?? null;
      return await SecureStore.getItemAsync(chave);
    } catch {
      // Cofre indisponível ou dado corrompido: melhor pedir login de novo que travar o app.
      return null;
    }
  },
  async gravar(chave: string, valor: string): Promise<void> {
    try {
      if (Platform.OS === 'web') globalThis.localStorage?.setItem(chave, valor);
      else await SecureStore.setItemAsync(chave, valor);
    } catch {
      // Sem persistência, a sessão vale só enquanto o app estiver aberto.
    }
  },
  async apagar(chave: string): Promise<void> {
    try {
      if (Platform.OS === 'web') globalThis.localStorage?.removeItem(chave);
      else await SecureStore.deleteItemAsync(chave);
    } catch {
      // Nada a fazer: o cache em memória já foi limpo por quem chamou.
    }
  },
};

export async function salvarSessao(
  access: string,
  refresh: string,
  usuario: Usuario,
): Promise<void> {
  accessEmMemoria = access;
  refreshEmMemoria = refresh;
  await Promise.all([
    armazem.gravar(CHAVE_ACCESS, access),
    armazem.gravar(CHAVE_REFRESH, refresh),
    armazem.gravar(CHAVE_USUARIO, JSON.stringify(usuario)),
  ]);
}

export async function salvarTokens(access: string, refresh: string): Promise<void> {
  accessEmMemoria = access;
  refreshEmMemoria = refresh;
  await Promise.all([
    armazem.gravar(CHAVE_ACCESS, access),
    armazem.gravar(CHAVE_REFRESH, refresh),
  ]);
}

export async function lerAccessToken(): Promise<string | null> {
  if (accessEmMemoria) return accessEmMemoria;
  accessEmMemoria = await armazem.ler(CHAVE_ACCESS);
  return accessEmMemoria;
}

export async function lerRefreshToken(): Promise<string | null> {
  if (refreshEmMemoria) return refreshEmMemoria;
  refreshEmMemoria = await armazem.ler(CHAVE_REFRESH);
  return refreshEmMemoria;
}

export async function lerUsuarioSalvo(): Promise<Usuario | null> {
  const bruto = await armazem.ler(CHAVE_USUARIO);
  if (!bruto) return null;
  try {
    return JSON.parse(bruto) as Usuario;
  } catch {
    // Dado corrompido não pode travar o app no boot: melhor pedir login de novo.
    return null;
  }
}

export async function limparSessao(): Promise<void> {
  accessEmMemoria = null;
  refreshEmMemoria = null;
  await Promise.all([
    armazem.apagar(CHAVE_ACCESS),
    armazem.apagar(CHAVE_REFRESH),
    armazem.apagar(CHAVE_USUARIO),
  ]);
}
