import { zodResolver } from '@hookform/resolvers/zod';
import { Controller, useForm } from 'react-hook-form';
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useState } from 'react';
import { z } from 'zod';

import { mensagemDoErro } from '@/api/client';
import { Botao, Campo } from '@/components/ui';
import { cores, espaco, fonte } from '@/lib/tema';
import { useAuthStore } from '@/stores/authStore';

const esquema = z.object({
  email: z.email('Digite um e-mail válido.'),
  senha: z.string().min(1, 'Informe a senha.'),
});

type Formulario = z.infer<typeof esquema>;

export default function Login() {
  const entrar = useAuthStore((e) => e.entrar);
  const [erroServidor, setErroServidor] = useState<string | null>(null);
  const insets = useSafeAreaInsets();

  const {
    control,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<Formulario>({
    resolver: zodResolver(esquema),
    defaultValues: { email: '', senha: '' },
  });

  async function aoEnviar(dados: Formulario) {
    setErroServidor(null);
    try {
      await entrar(dados.email, dados.senha);
    } catch (erro) {
      setErroServidor(mensagemDoErro(erro, 'Não foi possível entrar.'));
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
          <Text style={s.titulo}>Gestão da Loja</Text>
          <Text style={s.subtitulo}>Estoque, vendas e resultado na palma da mão</Text>
        </View>

        <Controller
          control={control}
          name="email"
          render={({ field: { onChange, onBlur, value } }) => (
            <Campo
              rotulo="E-mail"
              value={value}
              onChangeText={onChange}
              onBlur={onBlur}
              erro={errors.email?.message}
              autoCapitalize="none"
              autoComplete="email"
              keyboardType="email-address"
              placeholder="voce@sualoja.com"
              returnKeyType="next"
            />
          )}
        />

        <Controller
          control={control}
          name="senha"
          render={({ field: { onChange, onBlur, value } }) => (
            <Campo
              rotulo="Senha"
              value={value}
              onChangeText={onChange}
              onBlur={onBlur}
              erro={errors.senha?.message}
              secureTextEntry
              autoComplete="current-password"
              placeholder="••••••••"
              returnKeyType="go"
              onSubmitEditing={handleSubmit(aoEnviar)}
            />
          )}
        />

        {!!erroServidor && <Text style={s.erroServidor}>{erroServidor}</Text>}

        <Botao
          titulo="Entrar"
          grande
          carregando={isSubmitting}
          onPress={handleSubmit(aoEnviar)}
        />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  tela: { flex: 1, backgroundColor: cores.fundo },
  conteudo: { padding: espaco.xl, flexGrow: 1, justifyContent: 'center' },
  cabecalho: { marginBottom: espaco.xxl, alignItems: 'center' },
  titulo: { fontSize: fonte.titulo, fontWeight: '800', color: cores.primaria },
  subtitulo: {
    fontSize: fonte.base,
    color: cores.textoSuave,
    marginTop: espaco.xs,
    textAlign: 'center',
  },
  erroServidor: {
    color: cores.perigo,
    fontSize: fonte.base,
    marginBottom: espaco.lg,
    textAlign: 'center',
    fontWeight: '600',
  },
});
