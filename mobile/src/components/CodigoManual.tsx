/**
 * Busca pelo código digitado, para quando a câmera não resolve.
 *
 * Etiqueta amassada, rasgada ou desbotada é rotina em loja de roupa, e câmera de celular
 * antigo às vezes não pega. Sem esta saída, a peça simplesmente não vende — o operador
 * fica preso na tela do scanner.
 */

import { useState } from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { Botao } from '@/components/ui';
import { ALVO_TOQUE, cores, espaco, fonte, raio } from '@/lib/tema';

interface Props {
  aoConfirmar: (codigo: string) => void;
  rotulo?: string;
}

export function CodigoManual({ aoConfirmar, rotulo = 'Digitar código' }: Props) {
  const [aberto, setAberto] = useState(false);
  const [codigo, setCodigo] = useState('');

  function confirmar() {
    const limpo = codigo.trim();
    if (limpo.length < 4) return;
    setAberto(false);
    setCodigo('');
    aoConfirmar(limpo);
  }

  return (
    <>
      <Pressable
        style={s.atalho}
        onPress={() => setAberto(true)}
        accessibilityRole="button"
        accessibilityLabel={rotulo}
      >
        <Text style={s.atalhoTexto}>{rotulo}</Text>
      </Pressable>

      <Modal
        visible={aberto}
        transparent
        animationType="fade"
        onRequestClose={() => setAberto(false)}
      >
        <KeyboardAvoidingView
          style={s.fundo}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <View style={s.caixa}>
            <Text style={s.titulo}>Código de barras</Text>
            <Text style={s.ajuda}>
              Os números impressos embaixo das barras da etiqueta.
            </Text>

            <TextInput
              value={codigo}
              onChangeText={setCodigo}
              placeholder="7891234567895"
              placeholderTextColor={cores.textoFraco}
              keyboardType="number-pad"
              autoFocus
              style={s.entrada}
              onSubmitEditing={confirmar}
              returnKeyType="search"
            />

            <View style={s.acoes}>
              <Botao
                titulo="Voltar"
                variante="secundario"
                estilo={s.metade}
                onPress={() => {
                  setAberto(false);
                  setCodigo('');
                }}
              />
              <Botao
                titulo="Buscar"
                estilo={s.metade}
                desabilitado={codigo.trim().length < 4}
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
  caixa: {
    backgroundColor: cores.superficie,
    borderRadius: raio.lg,
    padding: espaco.xl,
    gap: espaco.md,
  },
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
