import { useMutation } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { mensagemDoErro } from '@/api/client';
import { usuarios } from '@/api/endpoints';
import type { Papel } from '@/api/tipos';
import { Botao, Campo } from '@/components/ui';
import { chaves, queryClient } from '@/lib/queryClient';
import { cores, espaco, fonte, raio } from '@/lib/tema';

const PAPEIS: { papel: Papel; rotulo: string; descricao: string }[] = [
  {
    papel: 'VENDEDOR',
    rotulo: 'Vendedor',
    descricao: 'Vende, cadastra peças e consulta estoque. Não vê custo, lucro nem despesas.',
  },
  {
    papel: 'ADMIN',
    rotulo: 'Administrador',
    descricao: 'Vê tudo: resultado, despesas, relatórios e gestão de usuários.',
  },
];

export default function NovoUsuario() {
  const router = useRouter();
  const [nome, setNome] = useState('');
  const [email, setEmail] = useState('');
  const [senha, setSenha] = useState('');
  const [papel, setPapel] = useState<Papel>('VENDEDOR');
  const [erro, setErro] = useState<string | null>(null);

  const criar = useMutation({
    mutationFn: () =>
      usuarios.criar({ nome: nome.trim(), email: email.trim().toLowerCase(), senha, papel }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: chaves.usuarios });
      Alert.alert('Usuário criado', `${nome.trim()} já pode entrar com esta senha.`, [
        { text: 'Pronto', onPress: () => router.back() },
      ]);
    },
    onError: (e) => setErro(mensagemDoErro(e, 'Não deu para criar o usuário.')),
  });

  function enviar() {
    if (nome.trim().length < 2) return setErro('Informe o nome.');
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) return setErro('E-mail inválido.');
    if (senha.length < 8) return setErro('A senha precisa de ao menos 8 caracteres.');
    setErro(null);
    criar.mutate();
  }

  return (
    <KeyboardAvoidingView
      style={s.tela}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={s.conteudo} keyboardShouldPersistTaps="handled">
        <Campo rotulo="Nome" value={nome} onChangeText={setNome} autoCapitalize="words" />
        <Campo
          rotulo="E-mail"
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          keyboardType="email-address"
        />
        <Campo
          rotulo="Senha inicial"
          value={senha}
          onChangeText={setSenha}
          secureTextEntry
          ajuda="Mínimo de 8 caracteres. A pessoa pode trocar depois."
        />

        <Text style={s.rotulo}>Papel</Text>
        {PAPEIS.map((opcao) => (
          <Pressable
            key={opcao.papel}
            style={[s.papel, papel === opcao.papel && s.papelAtivo]}
            onPress={() => setPapel(opcao.papel)}
          >
            <View style={s.radio}>
              {papel === opcao.papel && <View style={s.radioMarcado} />}
            </View>
            <View style={s.papelTexto}>
              <Text style={s.papelRotulo}>{opcao.rotulo}</Text>
              <Text style={s.papelDescricao}>{opcao.descricao}</Text>
            </View>
          </Pressable>
        ))}

        {!!erro && <Text style={s.erro}>{erro}</Text>}

        <Botao titulo="Criar usuário" grande carregando={criar.isPending} onPress={enviar} />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  tela: { flex: 1, backgroundColor: cores.fundo },
  conteudo: { padding: espaco.lg },
  rotulo: {
    fontSize: fonte.pequena,
    fontWeight: '600',
    color: cores.textoSuave,
    marginBottom: espaco.sm,
  },
  papel: {
    flexDirection: 'row',
    gap: espaco.md,
    backgroundColor: cores.superficie,
    borderRadius: raio.md,
    padding: espaco.lg,
    marginBottom: espaco.sm,
    borderWidth: 1,
    borderColor: cores.borda,
  },
  papelAtivo: { borderColor: cores.primaria, backgroundColor: cores.primariaFraca },
  radio: {
    width: 22,
    height: 22,
    borderRadius: raio.redondo,
    borderWidth: 2,
    borderColor: cores.primaria,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 2,
  },
  radioMarcado: {
    width: 12,
    height: 12,
    borderRadius: raio.redondo,
    backgroundColor: cores.primaria,
  },
  papelTexto: { flex: 1 },
  papelRotulo: { fontSize: fonte.base, fontWeight: '700', color: cores.texto },
  papelDescricao: { fontSize: fonte.pequena, color: cores.textoSuave, marginTop: 2 },

  erro: { color: cores.perigo, fontWeight: '600', marginBottom: espaco.md },
});
