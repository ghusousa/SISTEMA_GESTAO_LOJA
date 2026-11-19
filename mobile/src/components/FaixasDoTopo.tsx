/**
 * O que fica por cima de TODA a navegação: o aviso de sem conexão (`BannerConexao`), a
 * faixa da loja de demonstração (ADR-46) e o chamado do computador ("O computador está
 * chamando", ADR-47, `components/FaixaDoChamado.tsx`), nessa ordem.
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
 * tela, lê a da janela (`useAreaDaJanela`). E o teclado, medido na tela inteira: o
 * KeyboardAvoidingView de tela aqui embaixo desconta a altura das faixas (`useAlturaDasFaixas`).
 */

import { type ReactNode, useCallback, useMemo, useState } from 'react';
import { type LayoutChangeEvent, StyleSheet, Text, View } from 'react-native';
import { SafeAreaInsetsContext, useSafeAreaInsets } from 'react-native-safe-area-context';

import { BannerConexao, useConexao } from '@/components/BannerConexao';
import { FaixaDoChamado, useFaixaDoChamado } from '@/components/FaixaDoChamado';
import { AlturaDasFaixas } from '@/hooks/useAlturaDasFaixas';
import { AreaDaJanela } from '@/hooks/useAreaDaJanela';
import { useLoja } from '@/hooks/useLoja';
import { areaAbaixoDasFaixas, respiroDeCima } from '@/lib/areaSegura';
import { ehLojaDeDemonstracao, FRASE_DA_DEMONSTRACAO } from '@/lib/demonstracao';
import { cores, espaco, fonte } from '@/lib/tema';

export function ComFaixasNoTopo({ children }: { children: ReactNode }) {
  const janela = useSafeAreaInsets();
  const semConexao = !useConexao((e) => e.online);
  const demonstracao = ehLojaDeDemonstracao(useLoja());
  // O chamado só existe com sessão; sem ele (e fora da sessão) a função devolve `null`.
  const chamado = useFaixaDoChamado();
  const temChamado = chamado !== null;
  const abaixo = useMemo(
    () => areaAbaixoDasFaixas(janela, semConexao || demonstracao || temChamado),
    [janela, semConexao, demonstracao, temChamado],
  );
  // A navegação começa debaixo do bloco; o teclado é medido na tela inteira. Quem desvia do
  // teclado lá embaixo (a entrada) desconta esta altura (`useAlturaDasFaixas`).
  const [alturaDasFaixas, setAlturaDasFaixas] = useState(0);
  const medir = useCallback((e: LayoutChangeEvent) => setAlturaDasFaixas(e.nativeEvent.layout.height), []);

  return (
    <AreaDaJanela.Provider value={janela}>
      {/* Sem faixa nenhuma, o bloco mede 0 e nada muda embaixo. */}
      <View onLayout={medir}>
        <BannerConexao />
        {/* Debaixo do aviso de sem conexão, a barra de status já está coberta por ele. */}
        {demonstracao && <FaixaDeDemonstracao areaDeCima={semConexao ? 0 : janela.top} />}
        {/* A primeira faixa visível é quem ocupa a barra de status. */}
        {chamado && (
          <FaixaDoChamado faixa={chamado} areaDeCima={semConexao || demonstracao ? 0 : janela.top} />
        )}
      </View>
      <AlturaDasFaixas.Provider value={alturaDasFaixas}>
        <SafeAreaInsetsContext.Provider value={abaixo}>{children}</SafeAreaInsetsContext.Provider>
      </AlturaDasFaixas.Provider>
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
