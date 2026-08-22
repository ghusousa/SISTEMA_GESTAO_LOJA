import { QueryClientProvider } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { registrarPerdaDeSessao } from '@/api/client';
import { BannerConexao } from '@/components/BannerConexao';
import { Carregando } from '@/components/ui';
import { queryClient } from '@/lib/queryClient';
import { cores } from '@/lib/tema';
import { useAuthStore } from '@/stores/authStore';
import { useServidorStore } from '@/stores/servidorStore';

export default function RootLayout() {
  const usuario = useAuthStore((e) => e.usuario);
  const carregando = useAuthStore((e) => e.carregando);
  const restaurar = useAuthStore((e) => e.restaurar);
  const encerrarPorTokenInvalido = useAuthStore((e) => e.encerrarPorTokenInvalido);
  const endereco = useServidorStore((e) => e.endereco);
  const servidorCarregando = useServidorStore((e) => e.carregando);
  const restaurarServidor = useServidorStore((e) => e.restaurar);

  useEffect(() => {
    // Quando o refresh falha, o cliente HTTP avisa e a navegação volta ao login sozinha.
    registrarPerdaDeSessao(() => {
      encerrarPorTokenInvalido();
      queryClient.clear();
    });
    void restaurarServidor();
    void restaurar();
  }, [restaurar, restaurarServidor, encerrarPorTokenInvalido]);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <QueryClientProvider client={queryClient}>
          <StatusBar style="light" />
          {carregando || servidorCarregando ? (
            <Carregando texto="Abrindo a loja…" />
          ) : (
            <>
              <BannerConexao />
              <Stack screenOptions={{ headerShown: false }}>
                {/* Stack.Protected troca de área sozinho quando a sessão cai. */}
                {/* Sem servidor configurado não há o que mostrar do app: a área de
                    autenticação cuida da conexão antes do login. */}
                <Stack.Protected guard={!!usuario && !!endereco}>
                  <Stack.Screen name="(app)" />
                </Stack.Protected>
                <Stack.Protected guard={!usuario || !endereco}>
                  <Stack.Screen name="(auth)" />
                </Stack.Protected>
              </Stack>
            </>
          )}
        </QueryClientProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
