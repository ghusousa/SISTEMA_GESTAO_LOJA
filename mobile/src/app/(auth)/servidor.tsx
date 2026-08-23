/**
 * Onde fica o servidor da loja. Abre pela engrenagem do login.
 *
 * Já foi obrigatória na primeira abertura, e era uma parede: quem recebe o `.apk` pronto
 * quase sempre já tem o endereço certo, e ainda assim tinha de passar por uma tela de IP
 * antes de digitar a senha. Agora é uma tela que se procura quando o servidor muda de
 * endereço — o que acontece uma vez a cada muito tempo.
 *
 * O endereço é testado antes de ser aceito: um dígito errado no IP viraria "não foi
 * possível entrar" na tela de senha, e a pessoa culparia a senha.
 */

import { useRouter } from 'expo-router';
import { useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { enderecoSugerido, normalizarEndereco, testarServidor } from '@/api/servidor';
import { MaterialCommunityIcons } from '@expo/vector-icons';

import { Botao, Campo } from '@/components/ui';
import { ALVO_TOQUE, cores, espaco, fonte, raio } from '@/lib/tema';
import { useServidorStore } from '@/stores/servidorStore';

export default function ConfigurarServidor() {
  const router = useRouter();
  const definir = useServidorStore((e) => e.definir);
  const atual = useServidorStore((e) => e.endereco);
  // Quem já tem servidor vem corrigir o que está lá; quem não tem recebe o palpite (o
  // endereço do build, ou o computador que serve o Expo).
  const [texto, setTexto] = useState(atual ?? enderecoSugerido());
  const [erro, setErro] = useState<string | null>(null);
  const [testando, setTestando] = useState(false);
  const insets = useSafeAreaInsets();

  async function conectar() {
    setErro(null);

    const endereco = normalizarEndereco(texto);
    if (!endereco) {
      setErro('Endereço inválido. Confira os números.');
      return;
    }

    setTestando(true);
    try {
      const resultado = await testarServidor(endereco);
      if (!resultado.ok) {
        setErro(resultado.mensagem);
        return;
      }
      // Guarda já limpo: o que a pessoa digitou pode ter vindo da barra do navegador.
      await definir(endereco);
      voltar();
    } finally {
      setTestando(false);
    }
  }

  function voltar() {
    // Aberta pela engrenagem, tem para onde voltar. Aberta por um link direto (ou depois
    // de o app recarregar em desenvolvimento), não tem — e aí o login é o destino.
    if (router.canGoBack()) router.back();
    else router.replace('/login');
  }

  return (
    <KeyboardAvoidingView
      style={s.tela}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <Pressable
        onPress={voltar}
        style={[s.voltar, { top: insets.top + espaco.sm }]}
        hitSlop={12}
        accessibilityRole="button"
        accessibilityLabel="Voltar"
      >
        <MaterialCommunityIcons name="arrow-left" size={24} color={cores.textoSuave} />
      </Pressable>
      <ScrollView
        contentContainerStyle={[s.conteudo, { paddingTop: insets.top + espaco.xxl }]}
        keyboardShouldPersistTaps="handled"
      >
        <View style={s.cabecalho}>
          <Text style={s.titulo}>Conectar à loja</Text>
          <Text style={s.subtitulo}>
            O endereço que este celular usa para falar com o sistema da loja.
          </Text>
        </View>

        <View style={s.ajudaCaixa}>
          <Text style={s.ajudaTitulo}>Onde encontrar o endereço</Text>
          <Text style={s.ajudaTexto}>
            É o mesmo que aparece no navegador do computador do balcão, sem o final. Peça a
            quem cuida do sistema.
          </Text>
          <Text style={s.ajudaExemplo}>Exemplo: 192.168.0.10  ou  loja.minhaloja.com.br</Text>
        </View>

        <Campo
          rotulo="Endereço do servidor"
          value={texto}
          onChangeText={setTexto}
          erro={erro ?? undefined}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          placeholder="192.168.0.10"
          returnKeyType="go"
          onSubmitEditing={conectar}
        />

        <Botao titulo="Conectar" grande carregando={testando} onPress={conectar} />

        {!!atual && (
          <Pressable onPress={voltar} style={s.cancelar} hitSlop={8}>
            <Text style={s.cancelarTexto}>Deixar como está</Text>
          </Pressable>
        )}

        <Text style={s.rodape}>
          Pode colar o endereço inteiro do navegador — o app aproveita só a parte que
          interessa.
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  tela: { flex: 1, backgroundColor: cores.fundo },
  voltar: {
    position: 'absolute',
    left: espaco.md,
    zIndex: 1,
    width: ALVO_TOQUE,
    height: ALVO_TOQUE,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: raio.redondo,
  },
  cancelar: { alignItems: 'center', paddingVertical: espaco.md, marginTop: espaco.xs },
  cancelarTexto: { fontSize: fonte.base, color: cores.textoSuave, fontWeight: '600' },
  conteudo: { padding: espaco.xl, flexGrow: 1, justifyContent: 'center' },
  cabecalho: { marginBottom: espaco.xl, alignItems: 'center' },
  titulo: { fontSize: fonte.titulo, fontWeight: '800', color: cores.primaria },
  subtitulo: {
    fontSize: fonte.base,
    color: cores.textoSuave,
    marginTop: espaco.xs,
    textAlign: 'center',
  },
  ajudaCaixa: {
    backgroundColor: cores.primariaFraca,
    borderRadius: raio.md,
    padding: espaco.lg,
    marginBottom: espaco.xl,
  },
  ajudaTitulo: {
    fontSize: fonte.pequena,
    fontWeight: '800',
    color: cores.primaria,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: espaco.xs,
  },
  ajudaTexto: { fontSize: fonte.base, color: cores.texto, lineHeight: 21 },
  ajudaExemplo: {
    fontSize: fonte.pequena,
    color: cores.textoSuave,
    marginTop: espaco.sm,
    fontVariant: ['tabular-nums'],
  },
  rodape: {
    fontSize: fonte.pequena,
    color: cores.textoFraco,
    textAlign: 'center',
    marginTop: espaco.lg,
  },
});
