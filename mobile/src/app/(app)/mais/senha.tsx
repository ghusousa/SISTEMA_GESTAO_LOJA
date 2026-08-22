import { useMutation } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Alert, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text } from 'react-native';

import { mensagemDoErro } from '@/api/client';
import { usuarios } from '@/api/endpoints';
import { Botao, Campo } from '@/components/ui';
import { cores, espaco, fonte } from '@/lib/tema';

const MINIMO = 8;

export default function TrocarSenha() {
  const router = useRouter();
  const [atual, setAtual] = useState('');
  const [nova, setNova] = useState('');
  const [confirmacao, setConfirmacao] = useState('');
  const [erro, setErro] = useState<string | null>(null);

  const trocar = useMutation({
    mutationFn: () => usuarios.trocarMinhaSenha(atual, nova),
    onSuccess: () => {
      Alert.alert('Senha alterada', 'Use a nova senha no próximo login.', [
        { text: 'Pronto', onPress: () => router.back() },
      ]);
    },
    onError: (e) => setErro(mensagemDoErro(e, 'Não deu para trocar a senha.')),
  });

  function enviar() {
    if (atual.length === 0) return setErro('Informe a senha atual.');
    if (nova.length < MINIMO) return setErro(`A nova senha precisa de ao menos ${MINIMO} caracteres.`);
    if (nova !== confirmacao) return setErro('A confirmação não confere com a nova senha.');
    setErro(null);
    trocar.mutate();
  }

  return (
    <KeyboardAvoidingView
      style={s.tela}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={s.conteudo} keyboardShouldPersistTaps="handled">
        <Campo
          rotulo="Senha atual"
          value={atual}
          onChangeText={setAtual}
          secureTextEntry
          autoComplete="current-password"
        />
        <Campo
          rotulo="Nova senha"
          value={nova}
          onChangeText={setNova}
          secureTextEntry
          autoComplete="new-password"
          ajuda={`Mínimo de ${MINIMO} caracteres`}
        />
        <Campo
          rotulo="Repita a nova senha"
          value={confirmacao}
          onChangeText={setConfirmacao}
          secureTextEntry
          autoComplete="new-password"
        />

        {!!erro && <Text style={s.erro}>{erro}</Text>}

        <Botao titulo="Trocar senha" grande carregando={trocar.isPending} onPress={enviar} />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  tela: { flex: 1, backgroundColor: cores.fundo },
  conteudo: { padding: espaco.lg },
  erro: { color: cores.perigo, fontWeight: '600', marginBottom: espaco.md },
});
