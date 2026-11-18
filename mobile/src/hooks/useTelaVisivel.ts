/**
 * A tela está na frente de alguém: em foco na navegação E com o app em primeiro plano.
 *
 * Câmera e consulta periódica ligam só com isto. Tela coberta por outra (a Stack mantém a
 * de baixo montada) ou app no bolso não lê etiqueta nem gasta rede e bateria.
 */

import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { AppState } from 'react-native';

export function useTelaVisivel(): boolean {
  const [emFoco, setEmFoco] = useState(false);
  // 'unknown' na abertura conta como na frente: quem abriu a tela está olhando para ela.
  const [appNaFrente, setAppNaFrente] = useState(
    AppState.currentState !== 'background' && AppState.currentState !== 'inactive',
  );

  useFocusEffect(
    useCallback(() => {
      setEmFoco(true);
      return () => setEmFoco(false);
    }, []),
  );

  useEffect(() => {
    const assinatura = AppState.addEventListener('change', (estado) =>
      setAppNaFrente(estado === 'active'),
    );
    return () => assinatura.remove();
  }, []);

  return emFoco && appNaFrente;
}
