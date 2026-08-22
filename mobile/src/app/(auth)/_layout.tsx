import { Stack } from 'expo-router';

import { useServidorStore } from '@/stores/servidorStore';

/**
 * Antes de pedir e-mail e senha, o app precisa saber COM QUEM falar. Num celular novo o
 * endereço ainda não existe, e a tela de conexão vem primeiro.
 */
export default function AuthLayout() {
  const endereco = useServidorStore((e) => e.endereco);

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Protected guard={!endereco}>
        <Stack.Screen name="servidor" />
      </Stack.Protected>
      <Stack.Protected guard={!!endereco}>
        <Stack.Screen name="login" />
      </Stack.Protected>
    </Stack>
  );
}
