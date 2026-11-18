/**
 * Confirmação dentro do app, para o que não tem volta (excluir conta, ADR-45).
 *
 * No lugar do `Alert.alert` de propósito: no react-native-web ele não faz nada, e no export
 * web — a bancada de teste e as capturas — a confirmação sumia e o botão parecia morto. Um
 * `Modal` do próprio app aparece igual no iPhone, no Android e no navegador.
 *
 * O texto rola e os botões não: com o "Texto Maior" de acessibilidade do iOS, o que some e o que
 * fica de uma exclusão passa da altura do SE, e sem rolagem os dois botões saíam da tela — a
 * pessoa ficava presa no modal (no iPhone, `onRequestClose` não existe). Tocar fora fecha, como
 * nos outros diálogos do app, menos enquanto o pedido roda.
 */

import type { ReactNode } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Botao } from '@/components/ui';
import { cores, espaco, fonte, raio } from '@/lib/tema';

export function Confirmacao({
  visivel,
  titulo,
  children,
  textoConfirmar,
  carregando = false,
  aoConfirmar,
  aoCancelar,
}: {
  visivel: boolean;
  titulo: string;
  children: ReactNode;
  textoConfirmar: string;
  carregando?: boolean;
  aoConfirmar: () => void;
  aoCancelar: () => void;
}) {
  return (
    <Modal
      visible={visivel}
      transparent
      animationType="fade"
      onRequestClose={carregando ? () => undefined : aoCancelar}
    >
      <View style={s.fundo}>
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={carregando ? undefined : aoCancelar}
          accessibilityLabel="Fechar"
        />
        <View style={s.caixa} accessibilityViewIsModal>
          <ScrollView style={s.rolagem} contentContainerStyle={s.corpo}>
            <Text style={s.titulo} accessibilityRole="header">
              {titulo}
            </Text>
            {children}
          </ScrollView>
          <View style={s.botoes}>
            <Botao
              titulo="Cancelar"
              variante="secundario"
              estilo={s.botao}
              desabilitado={carregando}
              onPress={aoCancelar}
            />
            <Botao
              titulo={textoConfirmar}
              variante="perigo"
              estilo={s.botao}
              carregando={carregando}
              onPress={aoConfirmar}
            />
          </View>
        </View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  fundo: {
    flex: 1,
    backgroundColor: 'rgba(11, 27, 43, 0.45)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: espaco.lg,
  },
  caixa: {
    width: '100%',
    maxWidth: 440,
    maxHeight: '85%',
    backgroundColor: cores.superficie,
    borderRadius: raio.lg,
    padding: espaco.xl,
  },
  // `flexGrow: 0`: a rolagem só ocupa o que o texto pede; passou do teto, ela rola e os botões
  // ficam embaixo, sempre à vista.
  rolagem: { flexGrow: 0, flexShrink: 1 },
  corpo: { gap: espaco.sm },
  titulo: { fontSize: fonte.grande, fontWeight: '800', color: cores.texto },
  botoes: { flexDirection: 'row', gap: espaco.sm, marginTop: espaco.md },
  botao: { flex: 1 },
});
