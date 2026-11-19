import { focusManager, QueryClientProvider } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { AppState } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { registrarPerdaDeSessao } from '@/api/client';
import { ComFaixasNoTopo } from '@/components/FaixasDoTopo';
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
    //
    // No celular não existe `visibilitychange`: o TanStack só sabe que o app foi para o
    // fundo se alguém contar. Contado, ele pausa as novas tentativas de consulta, e o tempo
    // real segura a rodada de avisos enquanto ninguém olha a tela (`lib/tempoReal.ts`).
    // O foco volta ANTES de acordar: é ele que libera a recarga.
    const assinatura = AppState.addEventListener('change', (estado) => {
      focusManager.setFocused(estado === 'active');
      if (estado === 'active') acordarTempoReal();
    });
    return () => assinatura.remove();
  }, [restaurar, restaurarServidor, encerrarPorTokenInvalido]);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <QueryClientProvider client={queryClient}>
          {/* Clara: quase toda tela tem o cabeçalho azul embaixo da barra. As telas claras sem
              cabeçalho (entrada, servidor, Vender) pedem a escura no foco
              (useBarraDeStatusEscura); a abertura ("Abrindo a loja…", fundo claro) também. */}
          <StatusBar style={carregando || servidorCarregando ? 'dark' : 'light'} />
          {carregando || servidorCarregando ? (
            <Carregando texto="Abrindo a loja…" />
          ) : (
            // Sem conexão e loja de demonstração (ADR-46): faixas por cima de toda tela.
            <ComFaixasNoTopo>
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
            </ComFaixasNoTopo>
          )}
        </QueryClientProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
