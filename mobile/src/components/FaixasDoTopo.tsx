/**
 * O que fica por cima de TODA a navegação: o aviso de sem conexão (`BannerConexao`) e a
 * faixa da loja de demonstração (ADR-46).
 *
 * A faixa da demonstração é fixa e aparece em toda tela — entrada, Vender, cabeçalhos,
 * folhas — porque o mesmo app fala com a loja e com a demonstração, no mesmo domínio, e o
 * dono não pode vender "de verdade" na de mentira sem perceber. Quem diz qual é qual é o
 * servidor (`GET /configuracao`, `lib/demonstracao.ts`): a loja real e o servidor antigo
 * não têm faixa, e para eles nada aqui muda.
 *
 * Quem fica no topo ocupa a barra de status. A navegação embaixo, então, lê a área segura
 * com o topo zerado (`areaAbaixoDasFaixas`) — senão o cabeçalho azul somaria a ilha de novo,
 * numa tira vazia. O Modal de tela cheia, que desenha por cima de tudo a partir do topo da
 * tela, lê a da janela (`useAreaDaJanela`).
 */

import { type ReactNode, useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaInsetsContext, useSafeAreaInsets } from 'react-native-safe-area-context';

import { BannerConexao, useConexao } from '@/components/BannerConexao';
import { AreaDaJanela } from '@/hooks/useAreaDaJanela';
import { useLoja } from '@/hooks/useLoja';
import { areaAbaixoDasFaixas, respiroDeCima } from '@/lib/areaSegura';
import { ehLojaDeDemonstracao, FRASE_DA_DEMONSTRACAO } from '@/lib/demonstracao';
import { cores, espaco, fonte } from '@/lib/tema';

export function ComFaixasNoTopo({ children }: { children: ReactNode }) {
  const janela = useSafeAreaInsets();
  const semConexao = !useConexao((e) => e.online);
  const demonstracao = ehLojaDeDemonstracao(useLoja());
  const abaixo = useMemo(
    () => areaAbaixoDasFaixas(janela, semConexao || demonstracao),
    [janela, semConexao, demonstracao],
  );

  return (
    <AreaDaJanela.Provider value={janela}>
      <BannerConexao />
      {/* Debaixo do aviso de sem conexão, a barra de status já está coberta por ele. */}
      {demonstracao && <FaixaDeDemonstracao areaDeCima={semConexao ? 0 : janela.top} />}
      <SafeAreaInsetsContext.Provider value={abaixo}>{children}</SafeAreaInsetsContext.Provider>
    </AreaDaJanela.Provider>
  );
}

function FaixaDeDemonstracao({ areaDeCima }: { areaDeCima: number }) {
  // Sem altura fixa: com o Texto Maior do iOS a frase quebra em duas linhas e a faixa cresce.
  return (
    <View style={[s.faixa, { paddingTop: respiroDeCima(areaDeCima, espaco.xs) }]}>
      <Text style={s.texto}>{FRASE_DA_DEMONSTRACAO}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  faixa: {
    backgroundColor: cores.demonstracao,
    paddingHorizontal: espaco.lg,
    paddingBottom: espaco.xs,
  },
  texto: {
    color: cores.aoFundoEscuro,
    fontSize: fonte.pequena,
    fontWeight: '700',
    textAlign: 'center',
  },
});
