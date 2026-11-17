/**
 * Atalho do convite do celular-leitor (ADR-43): `gestaoloja://leitor?v=1&c=ABC234&api=…`.
 *
 * Num app instalado com o esquema próprio, apontar a câmera do aparelho para o QR do
 * computador abre o app aqui; daqui vai para a tela do leitor com o código preenchido.
 * Ligar continua sendo um toque da pessoa — um link sozinho não liga leitor nenhum. Sem
 * sessão, o `Stack.Protected` leva ao login antes (e o convite se perde: é só ler de novo).
 */

import { Redirect, useLocalSearchParams } from 'expo-router';

export default function AtalhoDoLeitor() {
  const { c, api } = useLocalSearchParams<{ c?: string; api?: string }>();
  const params: Record<string, string> = {};
  if (typeof c === 'string') params.c = c;
  if (typeof api === 'string') params.api = api;
  return <Redirect href={{ pathname: '/mais/leitor', params } as never} />;
}
