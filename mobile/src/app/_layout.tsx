import { QueryClientProvider } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { AppState } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { registrarPerdaDeSessao } from '@/api/client';
import { BannerConexao } from '@/components/BannerConexao';
import { Carregando } from '@/components/ui';
import { queryClient } from '@/lib/queryClient';
import { cores } from '@/lib/tema';
import { useAuthStore } from '@/stores/authStore';
import { acordarTempoReal } from '@/lib/tempoReal';
import { useServidorStore } from '@/stores/servidorStore';

export default function RootLayout() {
  const usuario = useAuthStore((e) => e.usuario);
  const carregando = useAuthStore((e) => e.carregando);
  const restaurar = useAuthStore((e) => e.restaurar);
  const encerrarPorTokenInvalido = useAuthStore((e) => e.encerrarPorTokenInvalido);
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

    // Celular dorme no bolso, entra no elevador, troca Wi-Fi por 4G. Enquanto esteve
    // fora, o servidor avisou de mudanças que este aparelho não ouviu — voltar ao ativo
    // reconecta e recarrega, senão a pessoa olharia dados de horas atrás sem saber.
    const assinatura = AppState.addEventListener('change', (estado) => {
      if (estado === 'active') acordarTempoReal();
    });
    return () => assinatura.remove();
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
                {/* Quem manda aqui é só a sessão. O endereço do servidor não entra na
                    conta: ninguém consegue estar logado sem ter falado com um servidor,
                    e prender a navegação nele fazia a primeira abertura começar numa
                    tela de IP em vez do login. */}
                <Stack.Protected guard={!!usuario}>
                  <Stack.Screen name="(app)" />
                </Stack.Protected>
                <Stack.Protected guard={!usuario}>
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
