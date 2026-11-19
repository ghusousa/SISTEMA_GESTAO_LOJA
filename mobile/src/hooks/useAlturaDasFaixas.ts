/**
 * A altura do bloco de faixas por cima da navegação — o aviso de sem conexão e a faixa da
 * loja de demonstração (`components/FaixasDoTopo.tsx`) —, medida na tela: 0 sem faixa.
 *
 * Medida, não calculada: com o Texto Maior do iOS a frase quebra em duas linhas e a faixa
 * cresce. Quem precisa dela é o `KeyboardAvoidingView` de tela debaixo das faixas (a entrada),
 * pelo `deslocamentoDoTeclado` (`lib/areaSegura.ts`). A tela "Conectar à loja" não: no iOS ela
 * é uma folha modal nativa, apresentada fora do bloco das faixas, e o `<Modal>` de tela cheia
 * desenha a partir do topo da janela — somar a faixa ali seria acolchoar sem motivo.
 */

import { createContext, useContext } from 'react';

/** Preenchida por `ComFaixasNoTopo`; fora dela (teste, tela solta) não há faixa: 0. */
export const AlturaDasFaixas = createContext(0);

export function useAlturaDasFaixas(): number {
  return useContext(AlturaDasFaixas);
}
