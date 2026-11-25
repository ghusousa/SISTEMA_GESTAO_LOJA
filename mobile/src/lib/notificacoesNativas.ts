/**
 * A porta única para o `expo-notifications` (ADR-47). Ninguém mais o importa: o módulo só é
 * carregado no app nativo de verdade, e só na primeira vez que alguém precisa dele.
 *
 * Por quê, conferido no pacote 0.32:
 * - no export web (a bancada das capturas), `getLastNotificationResponse` LANÇA
 *   `UnavailabilityError` — o emissor de lá só tem `addListener`;
 * - no Expo Go, o próprio import escreve um `console.warn` (push não existe lá), e no Android
 *   o `addPushTokenListener` escreve um `console.error`.
 * O `require` dentro da função continua no bundle (o Metro o resolve ao empacotar), mas o
 * código do módulo só roda quando a função é chamada — e aqui ela devolve `null` antes, no web
 * e no Expo Go.
 */

import { isRunningInExpoGo } from 'expo';
import { Platform } from 'react-native';

export type ModuloDeNotificacoes = typeof import('expo-notifications');

let carregado: ModuloDeNotificacoes | null | undefined;

/** Rodando dentro do Expo Go (o teste por QR)? Lá o push deste app não existe. */
export function ehExpoGo(): boolean {
  try {
    return isRunningInExpoGo();
  } catch {
    return false;
  }
}

/** O módulo nativo de notificações, ou `null` no web e no Expo Go (e se não carregar). */
export function modulo(): ModuloDeNotificacoes | null {
  if (carregado !== undefined) return carregado;
  if (Platform.OS === 'web' || ehExpoGo()) {
    carregado = null;
    return carregado;
  }
  try {
    carregado = require('expo-notifications') as ModuloDeNotificacoes;
  } catch {
    // Build sem o módulo nativo (não deveria existir): o chamado segue pela faixa, sem push.
    carregado = null;
  }
  return carregado;
}
