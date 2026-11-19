/**
 * Busca pelo código digitado, para quando a câmera não resolve.
 *
 * Etiqueta amassada, rasgada ou desbotada é rotina em loja de roupa, e câmera de celular
 * antigo às vezes não pega. Sem esta saída, a peça simplesmente não vende — o operador
 * fica preso na tela do scanner.
 *
 * As regras (o que dá para mandar, uma abertura e um código, a câmera parada enquanto a caixa
 * está na frente dela) moram em `lib/codigoDigitado.ts`, com teste. A tela que tem câmera passa
 * `aoAbrir`/`aoFechar` para pará-la e devolvê-la (`ScannerRef.pausar`/`retomar`).
 */

import { useEffect, useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { Botao, useRespiroDeCima } from '@/components/ui';
import { codigoDigitado, criarDigitacao, MAX_CODIGO_DIGITADO } from '@/lib/codigoDigitado';
import { ALVO_TOQUE, cores, espaco, fonte, raio } from '@/lib/tema';

interface Props {
  aoConfirmar: (codigo: string) => void;
  rotulo?: string;
  /** O botão que manda o código: "Buscar" na busca da peça, "Enviar" no leitor do computador. */
  acao?: string;
  /** A caixa abriu na frente de uma câmera: a tela para a leitura. */
  aoAbrir?: () => void;
  /** A caixa fechou (com código ou sem): a tela devolve a câmera. */
  aoFechar?: () => void;
}

export function CodigoManual({
  aoConfirmar,
  rotulo = 'Digitar código',
  acao = 'Buscar',
  aoAbrir,
  aoFechar,
}: Props) {
  const [aberto, setAberto] = useState(false);
  const [codigo, setCodigo] = useState('');
  // A caixa é um Modal de tela cheia: o topo dela desce da barra de status (e da ilha) quando o
  // Texto Maior a estica até lá em cima.
  const respiroDeCima = useRespiroDeCima();
  // Quem usa passa funções novas a cada render (setas em linha): a digitação chama as de agora.
  const avisos = useRef({ aoConfirmar, aoAbrir, aoFechar });
  avisos.current = { aoConfirmar, aoAbrir, aoFechar };
  const [digitacao] = useState(() =>
    criarDigitacao({
      pausar: () => avisos.current.aoAbrir?.(),
      retomar: () => avisos.current.aoFechar?.(),
      entregar: (limpo) => avisos.current.aoConfirmar(limpo),
    }),
  );
  // A tela que sai com a caixa aberta (o leitor que o computador desligou) não deixa a câmera
  // de quem fica parada para sempre.
  useEffect(() => () => digitacao.fechar(), [digitacao]);

  function abrir() {
    digitacao.abrir();
    setAberto(true);
  }

  function fechar() {
    digitacao.fechar();
    setAberto(false);
    setCodigo('');
  }

  function confirmar() {
    if (!digitacao.confirmar(codigo)) return;
    setAberto(false);
    setCodigo('');
  }

  return (
    <>
      <Pressable
        style={s.atalho}
        onPress={abrir}
        accessibilityRole="button"
        accessibilityLabel={rotulo}
      >
        <Text style={s.atalhoTexto}>{rotulo}</Text>
      </Pressable>

      <Modal visible={aberto} transparent animationType="fade" onRequestClose={fechar}>
        <KeyboardAvoidingView
          style={[s.fundo, { paddingTop: respiroDeCima }]}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <View style={s.caixa} accessibilityViewIsModal>
            {/* O texto rola; o campo e os botões não. Com o Texto Maior do iOS, o título e a
                ajuda passam do que sobra acima do teclado no SE, e sem rolagem os botões saíam
                da tela — e no iPhone não há o voltar do Android para sair da caixa. */}
            <ScrollView
              style={s.rolagem}
              contentContainerStyle={s.corpo}
              keyboardShouldPersistTaps="handled"
            >
              <Text style={s.titulo} accessibilityRole="header">
                Código de barras
              </Text>
              <Text style={s.ajuda}>Os números impressos embaixo das barras da etiqueta.</Text>
            </ScrollView>

            <TextInput
              value={codigo}
              onChangeText={setCodigo}
              placeholder="7891234567895"
              placeholderTextColor={cores.textoFraco}
              keyboardType="number-pad"
              autoFocus
              maxLength={MAX_CODIGO_DIGITADO}
              style={s.entrada}
              onSubmitEditing={confirmar}
              returnKeyType="search"
              accessibilityLabel="Código de barras"
            />

            <View style={s.acoes}>
              <Botao titulo="Voltar" variante="secundario" estilo={s.metade} onPress={fechar} />
              <Botao
                titulo={acao}
                estilo={s.metade}
                desabilitado={codigoDigitado(codigo) === null}
                onPress={confirmar}
              />
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </>
  );
}

const s = StyleSheet.create({
  atalho: {
    minHeight: ALVO_TOQUE - 12,
    justifyContent: 'center',
    paddingHorizontal: espaco.sm,
  },
  atalhoTexto: { color: cores.primaria, fontWeight: '700', fontSize: fonte.pequena },

  fundo: {
    flex: 1,
    backgroundColor: 'rgba(11,27,43,0.55)',
    justifyContent: 'center',
    padding: espaco.lg,
  },
  // `maxHeight` e `flexShrink`: a caixa cabe no que sobra acima do teclado, e quem encolhe é
  // a rolagem do texto — o campo e os botões ficam sempre à vista.
  caixa: {
    maxHeight: '85%',
    flexShrink: 1,
    backgroundColor: cores.superficie,
    borderRadius: raio.lg,
    padding: espaco.xl,
    gap: espaco.md,
  },
  rolagem: { flexGrow: 0, flexShrink: 1 },
  corpo: { gap: espaco.md },
  titulo: { fontSize: fonte.media, fontWeight: '800', color: cores.texto },
  ajuda: { fontSize: fonte.pequena, color: cores.textoSuave },
  entrada: {
    minHeight: 56,
    borderWidth: 1,
    borderColor: cores.borda,
    borderRadius: raio.md,
    paddingHorizontal: espaco.md,
    fontSize: fonte.grande,
    color: cores.texto,
    letterSpacing: 1,
  },
  acoes: { flexDirection: 'row', gap: espaco.sm },
  metade: { flex: 1 },
});
