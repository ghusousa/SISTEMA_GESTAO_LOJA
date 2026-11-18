import { useMutation } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Alert, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text } from 'react-native';

import { mensagemDoErro } from '@/api/client';
import { usuarios } from '@/api/endpoints';
import type { Papel } from '@/api/tipos';
import { EscolhaDoPapel } from '@/components/EscolhaDoPapel';
import { Botao, Campo } from '@/components/ui';
import { chaves, queryClient } from '@/lib/queryClient';
import { papeisQuePossoDar } from '@/lib/permissoes';
import { useAuthStore } from '@/stores/authStore';
import { cores, espaco, fonte } from '@/lib/tema';

export default function NovoUsuario() {
  const router = useRouter();
  const [nome, setNome] = useState('');
  const [email, setEmail] = useState('');
  const [senha, setSenha] = useState('');
  const [papel, setPapel] = useState<Papel>('VENDEDOR');
  // Do mais baixo para o mais alto: a escolha mais comum (vendedora) fica no primeiro toque.
  // Um gerente administra a equipe, mas não cria dono: seria virar dono. O servidor recusa
  // com 403 de qualquer jeito; aqui a opção nem aparece.
  const opcoes = papeisQuePossoDar(useAuthStore((e) => e.usuario?.papel));
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
        <EscolhaDoPapel opcoes={opcoes} valor={papel} aoEscolher={setPapel} />

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
  erro: { color: cores.perigo, fontWeight: '600', marginBottom: espaco.md },
});
