/**
 * Primeira tela de um celular novo: onde fica o servidor da loja.
 *
 * Aparece uma vez por aparelho, antes do login. O endereço é testado antes de ser aceito —
 * um dígito errado no IP viraria "não foi possível entrar" na tela de senha, e a pessoa
 * culparia a senha.
 */

import { useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { enderecoSugerido, normalizarEndereco, testarServidor } from '@/api/servidor';
import { Botao, Campo } from '@/components/ui';
import { cores, espaco, fonte, raio } from '@/lib/tema';
import { useServidorStore } from '@/stores/servidorStore';

export default function ConfigurarServidor() {
  const definir = useServidorStore((e) => e.definir);
  const [texto, setTexto] = useState(enderecoSugerido());
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
    } finally {
      setTestando(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={s.tela}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        contentContainerStyle={[s.conteudo, { paddingTop: insets.top + espaco.xxl }]}
        keyboardShouldPersistTaps="handled"
      >
        <View style={s.cabecalho}>
          <Text style={s.titulo}>Conectar à loja</Text>
          <Text style={s.subtitulo}>
            Só desta vez. Depois é só entrar com seu e-mail e senha.
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
