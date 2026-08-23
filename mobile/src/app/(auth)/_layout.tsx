import { Stack } from 'expo-router';

/**
 * A área de quem ainda não entrou.
 *
 * O login vem primeiro, sempre — mesmo num celular recém-instalado. A configuração do
 * servidor virou uma tela que se abre pela engrenagem, e não um pedágio antes da senha:
 * quem recebe o `.apk` pronto costuma já ter o endereço certo (do build ou de uma
 * instalação anterior), e obrigar todo mundo a passar por uma tela de IP para depois
 * digitar e-mail e senha era uma parede na primeira abertura.
 */
export default function AuthLayout() {
  return (
    <Stack screenOptions={{ headerShown: false }} initialRouteName="login">
      <Stack.Screen name="login" />
      <Stack.Screen name="servidor" options={{ presentation: 'modal' }} />
    </Stack>
  );
}
