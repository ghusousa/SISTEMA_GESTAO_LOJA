/**
 * A área segura da TELA inteira, de antes das faixas do topo.
 *
 * Com uma faixa por cima da navegação (sem conexão, loja de demonstração), as telas leem
 * `useSafeAreaInsets()` com o topo zerado: a faixa já cobriu a barra de status
 * (`components/FaixasDoTopo.tsx`). O Modal de tela cheia é o caso oposto — desenha por cima
 * de tudo, faixa inclusive, a partir do topo da tela, debaixo da barra de status e da ilha.
 * Quem desenha assim lê daqui: `useRespiroDeCima` e o leitor encostado em cima e embaixo.
 */

import { createContext, useContext } from 'react';
import { type EdgeInsets, useSafeAreaInsets } from 'react-native-safe-area-context';

/** Preenchida por `ComFaixasNoTopo`; fora dela (teste, tela solta) vale a do contexto. */
export const AreaDaJanela = createContext<EdgeInsets | null>(null);

export function useAreaDaJanela(): EdgeInsets {
  const daNavegacao = useSafeAreaInsets();
  return useContext(AreaDaJanela) ?? daNavegacao;
}
