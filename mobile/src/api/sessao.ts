/**
 * Guarda dos tokens. Ficam no SecureStore (Keychain/Keystore), nunca no AsyncStorage.
 *
 * Há um cache em memória porque o interceptor do axios roda em todo request e ler do
 * Keychain a cada chamada custa caro.
 */

import * as SecureStore from 'expo-secure-store';

import type { Usuario } from './tipos';

const CHAVE_ACCESS = 'loja.access_token';
const CHAVE_REFRESH = 'loja.refresh_token';
const CHAVE_USUARIO = 'loja.usuario';

let accessEmMemoria: string | null = null;
let refreshEmMemoria: string | null = null;

export async function salvarSessao(
  access: string,
  refresh: string,
  usuario: Usuario,
): Promise<void> {
  accessEmMemoria = access;
  refreshEmMemoria = refresh;
  await Promise.all([
    SecureStore.setItemAsync(CHAVE_ACCESS, access),
    SecureStore.setItemAsync(CHAVE_REFRESH, refresh),
    SecureStore.setItemAsync(CHAVE_USUARIO, JSON.stringify(usuario)),
  ]);
}

export async function salvarTokens(access: string, refresh: string): Promise<void> {
  accessEmMemoria = access;
  refreshEmMemoria = refresh;
  await Promise.all([
    SecureStore.setItemAsync(CHAVE_ACCESS, access),
    SecureStore.setItemAsync(CHAVE_REFRESH, refresh),
  ]);
}

export async function lerAccessToken(): Promise<string | null> {
  if (accessEmMemoria) return accessEmMemoria;
  accessEmMemoria = await SecureStore.getItemAsync(CHAVE_ACCESS);
  return accessEmMemoria;
}

export async function lerRefreshToken(): Promise<string | null> {
  if (refreshEmMemoria) return refreshEmMemoria;
  refreshEmMemoria = await SecureStore.getItemAsync(CHAVE_REFRESH);
  return refreshEmMemoria;
}

export async function lerUsuarioSalvo(): Promise<Usuario | null> {
  const bruto = await SecureStore.getItemAsync(CHAVE_USUARIO);
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
    SecureStore.deleteItemAsync(CHAVE_ACCESS),
    SecureStore.deleteItemAsync(CHAVE_REFRESH),
    SecureStore.deleteItemAsync(CHAVE_USUARIO),
  ]);
}
