/**
 * Entrada do sistema.
 *
 * A engrenagem no canto abre a configuração do servidor. Ela fica aqui, e não numa tela
 * obrigatória antes do login, porque quase sempre o endereço já está certo — veio do build
 * ou de uma instalação anterior — e quem precisa trocar é a exceção, não a regra.
 */

import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { zodResolver } from '@hookform/resolvers/zod';
import { Controller, useForm } from 'react-hook-form';
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
import { useState } from 'react';
import { z } from 'zod';

import { baseAtual, mensagemDoErro } from '@/api/client';
import { Botao, Campo } from '@/components/ui';
import { deslocamentoDoTeclado } from '@/lib/areaSegura';
import { ALVO_TOQUE, cores, espaco, fonte, raio } from '@/lib/tema';
import { useServidorStore } from '@/stores/servidorStore';
import { useAuthStore } from '@/stores/authStore';
import { useAlturaDasFaixas } from '@/hooks/useAlturaDasFaixas';
import { useBarraDeStatusEscura } from '@/hooks/useBarraDeStatusEscura';
import { useLoja } from '@/hooks/useLoja';

const esquema = z.object({
  email: z.email('Digite um e-mail válido.'),
  senha: z.string().min(1, 'Informe a senha.'),
});

type Formulario = z.infer<typeof esquema>;

export default function Login() {
  // Sem cabeçalho e de fundo claro: a hora e a bateria em preto (a raiz é a clara).
  useBarraDeStatusEscura();
  const loja = useLoja();
  const router = useRouter();
  const entrar = useAuthStore((e) => e.entrar);
  // "Conta excluída" (ADR-45): quem acabou de excluir a própria conta cai aqui, e a tela
  // confirma o que aconteceu em vez de parecer que a sessão só caiu.
  const avisoDaEntrada = useAuthStore((e) => e.avisoDaEntrada);
  const [erroServidor, setErroServidor] = useState<string | null>(null);
  const insets = useSafeAreaInsets();
  // Na demonstração (e sem conexão) esta tela começa debaixo da faixa do topo, e o teclado é
  // medido na tela inteira: sem descontar a faixa, a altura dela ficaria atrás do teclado.
  const alturaDasFaixas = useAlturaDasFaixas();
  // Lido do store para a linha do rodapé reagir na hora em que o endereço muda; sem isso,
  // quem acabou de configurar o servidor voltaria para o login vendo o endereço antigo.
  useServidorStore((e) => e.endereco);
  const servidor = baseAtual();

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
    if (!servidor) {
      // Sem endereço, a requisição sairia relativa e morreria com um erro de rede que não
      // explica nada. Melhor apontar a engrenagem do que deixar a pessoa culpar a senha.
      setErroServidor('Configure o servidor da loja na engrenagem, aqui em cima.');
      return;
    }
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
      keyboardVerticalOffset={deslocamentoDoTeclado(alturaDasFaixas)}
    >
      <Pressable
        onPress={() => router.push('/servidor')}
        style={[s.engrenagem, { top: insets.top + espaco.sm }]}
        hitSlop={12}
        accessibilityRole="button"
        accessibilityLabel="Configurar o servidor da loja"
      >
        <MaterialCommunityIcons name="cog-outline" size={24} color={cores.textoSuave} />
      </Pressable>

      <ScrollView
        contentContainerStyle={[s.conteudo, { paddingTop: insets.top + espaco.xxl }]}
        keyboardShouldPersistTaps="handled"
      >
        <View style={s.cabecalho}>
          <Text style={s.titulo}>{loja.nome}</Text>
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

        {!!avisoDaEntrada && !erroServidor && (
          <Text style={s.avisoDaEntrada} accessibilityRole="alert">
            {avisoDaEntrada}
          </Text>
        )}

        {!!erroServidor && <Text style={s.erroServidor}>{erroServidor}</Text>}

        <Botao
          titulo="Entrar"
          grande
          carregando={isSubmitting}
          onPress={handleSubmit(aoEnviar)}
        />

        <Pressable onPress={() => router.push('/servidor')} style={s.rodape} hitSlop={8}>
          <MaterialCommunityIcons
            name={servidor ? 'server-network' : 'server-network-off'}
            size={14}
            color={servidor ? cores.textoFraco : cores.alerta}
          />
          <Text style={[s.rodapeTexto, !servidor && s.rodapeAviso]}>
            {servidor ? servidor : 'Nenhum servidor configurado — toque para configurar'}
          </Text>
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  tela: { flex: 1, backgroundColor: cores.fundo },
  engrenagem: {
    position: 'absolute',
    right: espaco.md,
    zIndex: 1,
    width: ALVO_TOQUE,
    height: ALVO_TOQUE,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: raio.redondo,
  },
  rodape: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: espaco.xs,
    marginTop: espaco.xl,
    paddingVertical: espaco.sm,
  },
  rodapeTexto: { fontSize: fonte.pequena, color: cores.textoFraco },
  rodapeAviso: { color: cores.alerta, fontWeight: '700' },
  conteudo: { padding: espaco.xl, flexGrow: 1, justifyContent: 'center' },
  cabecalho: { marginBottom: espaco.xxl, alignItems: 'center' },
  titulo: { fontSize: fonte.titulo, fontWeight: '800', color: cores.primaria },
  subtitulo: {
    fontSize: fonte.base,
    color: cores.textoSuave,
    marginTop: espaco.xs,
    textAlign: 'center',
  },
  avisoDaEntrada: {
    color: cores.acaoEscura,
    backgroundColor: cores.sucessoFraco,
    borderRadius: raio.md,
    padding: espaco.md,
    fontSize: fonte.base,
    marginBottom: espaco.lg,
    textAlign: 'center',
    fontWeight: '600',
  },
  erroServidor: {
    color: cores.perigo,
    fontSize: fonte.base,
    marginBottom: espaco.lg,
    textAlign: 'center',
    fontWeight: '600',
  },
});
