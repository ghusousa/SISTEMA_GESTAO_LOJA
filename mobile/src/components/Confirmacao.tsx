/**
 * Confirmação dentro do app, para o que não tem volta (excluir conta, ADR-45).
 *
 * No lugar do `Alert.alert` de propósito: no react-native-web ele não faz nada, e no export
 * web — a bancada de teste e as capturas — a confirmação sumia e o botão parecia morto. Um
 * `Modal` do próprio app aparece igual no iPhone, no Android e no navegador.
 */

import type { ReactNode } from 'react';
import { Modal, StyleSheet, Text, View } from 'react-native';

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
        <View style={s.caixa} accessibilityViewIsModal>
          <Text style={s.titulo} accessibilityRole="header">
            {titulo}
          </Text>
          {children}
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
    backgroundColor: cores.superficie,
    borderRadius: raio.lg,
    padding: espaco.xl,
    gap: espaco.sm,
  },
  titulo: { fontSize: fonte.grande, fontWeight: '800', color: cores.texto },
  botoes: { flexDirection: 'row', gap: espaco.sm, marginTop: espaco.md },
  botao: { flex: 1 },
});
