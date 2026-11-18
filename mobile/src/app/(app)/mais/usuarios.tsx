import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Alert, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';

import { mensagemDoErro } from '@/api/client';
import { usuarios } from '@/api/endpoints';
import type { Usuario } from '@/api/tipos';
import { Confirmacao } from '@/components/Confirmacao';
import { Carregando, ErroEstado, Etiqueta, useRespiroDeBaixo } from '@/components/ui';
import { resumoDaComissao } from '@/lib/comissao';
import { podeExcluirDaEquipe, textosDaExclusao } from '@/lib/exclusaoDeConta';
import { formatar } from '@/lib/money';
import { chaves, queryClient } from '@/lib/queryClient';
import { PODE, pode, titulo } from '@/lib/permissoes';
import { cores, espaco, fonte, raio } from '@/lib/tema';
import { useAuthStore } from '@/stores/authStore';

export default function Usuarios() {
  const router = useRouter();
  // O botão de novo usuário encosta na base da tela: no iPhone de Face ID, acima do
  // indicador de início (como em Despesas).
  const respiroDeBaixo = useRespiroDeBaixo();
  const eu = useAuthStore((e) => e.usuario);
  // Comissão e meta são do dono (ADR-37): para os outros, a linha não abre nada.
  const defineComissao = pode(eu?.papel, PODE.DEFINIR_COMISSAO);

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

  // Excluir conta (ADR-45): a confirmação é um Modal do app, não Alert — no export web o
  // Alert não aparece, e o botão pareceria morto.
  const [excluindo, setExcluindo] = useState<Usuario | null>(null);
  const [erroExclusao, setErroExclusao] = useState<string | null>(null);
  const excluir = useMutation({
    mutationFn: (id: number) => usuarios.excluir(id),
    onSuccess: () => {
      setExcluindo(null);
      void queryClient.invalidateQueries({ queryKey: chaves.usuarios });
    },
    onError: (e) => setErroExclusao(mensagemDoErro(e, 'Não deu para excluir a conta.')),
  });
  const textosExclusao = excluindo
    ? textosDaExclusao({ propria: false, nome: excluindo.nome })
    : null;

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
        contentContainerStyle={[s.conteudo, { paddingBottom: respiroDeBaixo + 80 }]}
        refreshControl={
          <RefreshControl
            refreshing={consulta.isRefetching}
            onRefresh={() => void consulta.refetch()}
          />
        }
      >
        {consulta.data.items.map((usuario) => {
          const souEu = usuario.id === eu?.id;
          const comissao = resumoDaComissao(
            usuario.comissao_percentual,
            usuario.meta_diaria,
            formatar,
          );
          return (
            <View key={usuario.id} style={s.item}>
              <View style={s.itemLinha}>
                <Pressable
                  style={s.itemInfo}
                  disabled={!defineComissao}
                  onPress={() =>
                    router.push({ pathname: '/mais/usuario-comissao', params: { id: usuario.id } })
                  }
                  accessibilityHint={defineComissao ? 'Abre comissão e meta do dia' : undefined}
                >
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
                  {(!!comissao || defineComissao) && (
                    <Text style={s.comissao}>
                      {comissao || 'sem comissão nem meta'}
                      {defineComissao ? '  ›' : ''}
                    </Text>
                  )}
                </Pressable>

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

              {podeExcluirDaEquipe(eu, usuario) && (
                <Pressable
                  style={s.excluir}
                  hitSlop={6}
                  accessibilityRole="button"
                  accessibilityLabel={`Excluir a conta de ${usuario.nome}`}
                  onPress={() => {
                    setErroExclusao(null);
                    setExcluindo(usuario);
                  }}
                >
                  <MaterialCommunityIcons name="account-remove-outline" size={18} color={cores.perigo} />
                  <Text style={s.excluirTexto}>Excluir conta</Text>
                </Pressable>
              )}
            </View>
          );
        })}
      </ScrollView>

      <Confirmacao
        visivel={!!excluindo}
        titulo={`Excluir a conta de ${excluindo?.nome ?? ''}?`}
        textoConfirmar="Excluir conta"
        carregando={excluir.isPending}
        aoConfirmar={() => excluindo && excluir.mutate(excluindo.id)}
        aoCancelar={() => setExcluindo(null)}
      >
        {textosExclusao && (
          <View>
            <Text style={s.confirmaSubtitulo}>O que some</Text>
            {textosExclusao.some.map((linha) => (
              <Text key={linha} style={s.confirmaItem}>
                • {linha}
              </Text>
            ))}
            <Text style={s.confirmaSubtitulo}>O que fica</Text>
            {textosExclusao.fica.map((linha) => (
              <Text key={linha} style={s.confirmaItem}>
                • {linha}
              </Text>
            ))}
            <Text style={s.confirmaFim}>{textosExclusao.fim}</Text>
            {!!erroExclusao && (
              <Text style={s.confirmaErro} accessibilityRole="alert">
                {erroExclusao}
              </Text>
            )}
          </View>
        )}
      </Confirmacao>

      <Pressable
        style={[s.botaoFlutuante, { bottom: respiroDeBaixo }]}
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
  conteudo: { padding: espaco.lg },
  item: {
    backgroundColor: cores.superficie,
    borderRadius: raio.md,
    padding: espaco.lg,
    marginBottom: espaco.sm,
  },
  itemLinha: { flexDirection: 'row', alignItems: 'center', gap: espaco.md },
  itemInfo: { flex: 1, gap: 2 },
  excluir: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: espaco.xs,
    marginTop: espaco.md,
    paddingTop: espaco.sm,
    paddingRight: espaco.sm,
  },
  excluirTexto: { fontSize: fonte.pequena, fontWeight: '700', color: cores.perigo },
  confirmaSubtitulo: {
    fontSize: fonte.pequena,
    fontWeight: '700',
    color: cores.texto,
    marginTop: espaco.sm,
    marginBottom: 2,
  },
  confirmaItem: { fontSize: fonte.pequena, color: cores.textoSuave, lineHeight: 19 },
  confirmaFim: { fontSize: fonte.pequena, color: cores.texto, fontWeight: '600', marginTop: espaco.sm },
  confirmaErro: { fontSize: fonte.pequena, color: cores.perigo, fontWeight: '700', marginTop: espaco.sm },
  nome: { fontSize: fonte.base, fontWeight: '700', color: cores.texto },
  email: { fontSize: fonte.pequena, color: cores.textoSuave },
  etiquetas: { flexDirection: 'row', gap: espaco.xs, marginTop: espaco.xs },
  comissao: { fontSize: fonte.pequena, color: cores.primaria, marginTop: espaco.xs },

  botaoFlutuante: {
    position: 'absolute',
    right: espaco.lg,
    width: 60,
    height: 60,
    borderRadius: raio.redondo,
    backgroundColor: cores.acao,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 5,
  },
});
