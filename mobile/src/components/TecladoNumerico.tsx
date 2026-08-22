/**
 * Teclado de caixa registradora: os dígitos entram pela direita, então 1-5-0 vira R$ 1,50.
 * Não usa o teclado do sistema porque no balcão a vírgula é a maior fonte de erro de
 * digitação, e as teclas do SO são pequenas demais para uso rápido.
 */

import * as Haptics from 'expo-haptics';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { apagarDigito, digitar, type Centavos } from '@/lib/money';
import { ALVO_TOQUE_GRANDE, cores, espaco, fonte, raio } from '@/lib/tema';

const TECLAS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '00', '0', '⌫'];

interface Props {
  valor: Centavos;
  aoMudar: (valor: Centavos) => void;
  atalhos?: { rotulo: string; valor: Centavos }[];
}

export function TecladoNumerico({ valor, aoMudar, atalhos }: Props) {
  function tocar(tecla: string) {
    void Haptics.selectionAsync();
    if (tecla === '⌫') {
      aoMudar(apagarDigito(valor));
      return;
    }
    if (tecla === '00') {
      aoMudar(digitar(digitar(valor, '0'), '0'));
      return;
    }
    aoMudar(digitar(valor, tecla));
  }

  return (
    <View style={s.container}>
      {!!atalhos?.length && (
        <View style={s.atalhos}>
          {atalhos.map((atalho) => (
            <Pressable
              key={atalho.rotulo}
              style={s.atalho}
              onPress={() => {
                void Haptics.selectionAsync();
                aoMudar(atalho.valor);
              }}
            >
              <Text style={s.atalhoTexto}>{atalho.rotulo}</Text>
            </Pressable>
          ))}
        </View>
      )}

      <View style={s.grade}>
        {TECLAS.map((tecla) => (
          <Pressable
            key={tecla}
            style={({ pressed }) => [s.tecla, pressed && s.teclaPressionada]}
            onPress={() => tocar(tecla)}
            accessibilityRole="button"
            accessibilityLabel={tecla === '⌫' ? 'Apagar' : tecla}
          >
            <Text style={[s.teclaTexto, tecla === '⌫' && s.teclaApagar]}>{tecla}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  container: { gap: espaco.sm },
  atalhos: { flexDirection: 'row', gap: espaco.sm, flexWrap: 'wrap' },
  atalho: {
    flexGrow: 1,
    minHeight: 40,
    borderRadius: raio.sm,
    backgroundColor: cores.primariaFraca,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: espaco.md,
  },
  atalhoTexto: { color: cores.primaria, fontWeight: '700', fontSize: fonte.pequena },

  grade: { flexDirection: 'row', flexWrap: 'wrap', gap: espaco.sm },
  tecla: {
    width: '31.5%',
    minHeight: ALVO_TOQUE_GRANDE,
    borderRadius: raio.md,
    backgroundColor: cores.superficie,
    borderWidth: 1,
    borderColor: cores.borda,
    alignItems: 'center',
    justifyContent: 'center',
  },
  teclaPressionada: { backgroundColor: cores.superficieAlt },
  teclaTexto: { fontSize: fonte.titulo, fontWeight: '700', color: cores.texto },
  teclaApagar: { color: cores.perigo },
});
