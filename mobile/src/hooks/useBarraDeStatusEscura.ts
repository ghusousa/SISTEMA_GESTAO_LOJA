/**
 * Barra de status escura (hora e ícones pretos) enquanto a tela está em FOCO — para as telas
 * sem cabeçalho e de fundo claro: a entrada, o servidor e a aba Vender. O resto do app fica com
 * a clara da raiz, por cima do cabeçalho azul (ver `lib/barraDeStatus.ts`).
 *
 * Foco, e não montagem: as abas continuam montadas quando outra aba abre, e um `<StatusBar>`
 * na aba Vender deixaria a barra escura em cima do cabeçalho azul de Produtos.
 */

import { useFocusEffect } from 'expo-router';
import { useCallback } from 'react';
import { Platform, StatusBar } from 'react-native';

import { anotarNoHtml, criarPilhaDaBarra } from '@/lib/barraDeStatus';

// No navegador não há barra de status: a pilha anota o pedido no <html> para as capturas.
const pedirNoNavegador =
  Platform.OS === 'web'
    ? criarPilhaDaBarra(anotarNoHtml(typeof document === 'undefined' ? undefined : document.documentElement))
    : null;

export function useBarraDeStatusEscura(): void {
  useFocusEffect(
    useCallback(() => {
      if (pedirNoNavegador) return pedirNoNavegador('escura');
      // A mesma pilha do componente <StatusBar> da raiz: este pedido vence enquanto existir.
      const entrada = StatusBar.pushStackEntry({ barStyle: 'dark-content', animated: true });
      return () => StatusBar.popStackEntry(entrada);
    }, []),
  );
}
