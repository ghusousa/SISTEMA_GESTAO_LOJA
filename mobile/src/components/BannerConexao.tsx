/**
 * O app é online-only: sem internet, ele não vende. Melhor dizer isso na cara do
 * usuário do que deixar cada tela falhar com erro genérico.
 */

import NetInfo from '@react-native-community/netinfo';
import { create } from 'zustand';
import { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { cores, espaco, fonte } from '@/lib/tema';

interface ConexaoState {
  online: boolean;
  definir: (online: boolean) => void;
}

export const useConexao = create<ConexaoState>((set) => ({
  online: true,
  definir: (online) => set({ online }),
}));

export function BannerConexao() {
  const online = useConexao((e) => e.online);
  const definir = useConexao((e) => e.definir);
  const insets = useSafeAreaInsets();

  useEffect(() => {
    const cancelar = NetInfo.addEventListener((estado) => {
      // `isInternetReachable` fica null enquanto o teste não terminou: só o `isConnected`
      // definitivamente falso significa offline, senão o banner pisca à toa.
      definir(estado.isConnected !== false && estado.isInternetReachable !== false);
    });
    return cancelar;
  }, [definir]);

  if (online) return null;

  return (
    <View style={[s.banner, { paddingTop: insets.top + espaco.sm }]}>
      <Text style={s.texto}>Sem conexão — vendas e cadastros ficam bloqueados</Text>
    </View>
  );
}
const s = StyleSheet.create({
  banner: {
    backgroundColor: cores.perigo,
    paddingHorizontal: espaco.lg,
    paddingBottom: espaco.sm,
  },
  texto: {
    color: cores.aoFundoEscuro,
    fontSize: fonte.pequena,
    fontWeight: '700',
    textAlign: 'center',
  },
});
