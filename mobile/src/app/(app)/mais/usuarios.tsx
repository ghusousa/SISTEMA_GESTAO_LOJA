import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { Alert, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';

import { mensagemDoErro } from '@/api/client';
import { usuarios } from '@/api/endpoints';
import { Carregando, ErroEstado, Etiqueta } from '@/components/ui';
import { chaves, queryClient } from '@/lib/queryClient';
import { titulo } from '@/lib/permissoes';
import { cores, espaco, fonte, raio } from '@/lib/tema';
import { useAuthStore } from '@/stores/authStore';

export default function Usuarios() {
  const router = useRouter();
  const eu = useAuthStore((e) => e.usuario);

  const consulta = useQuery({
    queryKey: chaves.usuarios,
    queryFn: () => usuarios.listar({ size: 100 }),
  });

  const alternarAtivo = useMutation({
    mutationFn: ({ id, ativo }: { id: number; ativo: boolean }) =>
      usuarios.atualizar(id, { ativo }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: chaves.usuarios }),
    onError: (e) => Alert.alert('Não deu para alterar', mensagemDoErro(e)),
  });

  if (consulta.isPending) return <Carregando />;
  if (consulta.isError) {
    return (
      <ErroEstado
        mensagem={mensagemDoErro(consulta.error, 'Não deu para carregar os usuários.')}
        aoTentarNovamente={() => void consulta.refetch()}
      />
    );
  }

  return (
    <View style={s.tela}>
      <ScrollView
        contentContainerStyle={s.conteudo}
        refreshControl={
          <RefreshControl
            refreshing={consulta.isRefetching}
            onRefresh={() => void consulta.refetch()}
          />
        }
      >
        {consulta.data.items.map((usuario) => {
          const souEu = usuario.id === eu?.id;
          return (
            <View key={usuario.id} style={s.item}>
              <View style={s.itemInfo}>
                <Text style={s.nome}>
                  {usuario.nome}
                  {souEu ? ' (você)' : ''}
                </Text>
                <Text style={s.email}>{usuario.email}</Text>
                <View style={s.etiquetas}>
                  <Etiqueta
                    texto={titulo(usuario.papel).toLowerCase()}
                    cor={usuario.papel === 'ADMIN' ? cores.primariaFraca : cores.superficieAlt}
                    corTexto={usuario.papel === 'ADMIN' ? cores.primaria : cores.textoSuave}
                  />
                  {!usuario.ativo && (
                    <Etiqueta texto="desativado" cor={cores.perigoFraco} corTexto={cores.perigo} />
                  )}
                </View>
              </View>

              {!souEu && (
                <Pressable
                  hitSlop={10}
                  onPress={() =>
                    Alert.alert(
                      usuario.ativo ? 'Desativar acesso?' : 'Reativar acesso?',
                      usuario.ativo
                        ? `${usuario.nome} não conseguirá mais entrar. O histórico de vendas continua.`
                        : `${usuario.nome} volta a poder entrar no sistema.`,
                      [
                        { text: 'Voltar', style: 'cancel' },
                        {
                          text: usuario.ativo ? 'Desativar' : 'Reativar',
                          style: usuario.ativo ? 'destructive' : 'default',
                          onPress: () =>
                            alternarAtivo.mutate({ id: usuario.id, ativo: !usuario.ativo }),
                        },
                      ],
                    )
                  }
                >
                  <MaterialCommunityIcons
                    name={usuario.ativo ? 'account-off-outline' : 'account-check-outline'}
                    size={24}
                    color={usuario.ativo ? cores.perigo : cores.acao}
                  />
                </Pressable>
              )}
            </View>
          );
        })}
      </ScrollView>

      <Pressable
        style={s.botaoFlutuante}
        onPress={() => router.push('/mais/usuario-novo')}
        accessibilityLabel="Novo usuário"
      >
        <MaterialCommunityIcons name="account-plus" size={26} color={cores.aoFundoEscuro} />
      </Pressable>
    </View>
  );
}

const s = StyleSheet.create({
  tela: { flex: 1, backgroundColor: cores.fundo },
  conteudo: { padding: espaco.lg, paddingBottom: 96 },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: espaco.md,
    backgroundColor: cores.superficie,
    borderRadius: raio.md,
    padding: espaco.lg,
    marginBottom: espaco.sm,
  },
  itemInfo: { flex: 1, gap: 2 },
  nome: { fontSize: fonte.base, fontWeight: '700', color: cores.texto },
  email: { fontSize: fonte.pequena, color: cores.textoSuave },
  etiquetas: { flexDirection: 'row', gap: espaco.xs, marginTop: espaco.xs },

  botaoFlutuante: {
    position: 'absolute',
    right: espaco.lg,
    bottom: espaco.lg,
    width: 60,
    height: 60,
    borderRadius: raio.redondo,
    backgroundColor: cores.acao,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 5,
  },
});
