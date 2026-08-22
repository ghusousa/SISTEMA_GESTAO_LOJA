import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { mensagemDoErro } from '@/api/client';
import { catalogo } from '@/api/endpoints';
import { Botao, Campo, Carregando, ErroEstado, Vazio } from '@/components/ui';
import { chaves, queryClient } from '@/lib/queryClient';
import { cores, espaco, fonte, raio } from '@/lib/tema';

export default function Categorias() {
  const [nova, setNova] = useState('');

  const consulta = useQuery({
    queryKey: chaves.categorias,
    queryFn: () => catalogo.categorias({ size: 100 }),
  });

  const criar = useMutation({
    mutationFn: (nome: string) => catalogo.criarCategoria(nome),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: chaves.categorias });
      setNova('');
    },
    onError: (e) => Alert.alert('Não deu para criar', mensagemDoErro(e)),
  });

  const excluir = useMutation({
    mutationFn: (id: number) => catalogo.excluirCategoria(id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: chaves.categorias }),
    onError: (e) => Alert.alert('Não deu para excluir', mensagemDoErro(e)),
  });

  if (consulta.isPending) return <Carregando />;
  if (consulta.isError) {
    return (
      <ErroEstado
        mensagem={mensagemDoErro(consulta.error, 'Não deu para carregar.')}
        aoTentarNovamente={() => void consulta.refetch()}
      />
    );
  }

  const lista = consulta.data.items;

  return (
    <ScrollView contentContainerStyle={s.conteudo} keyboardShouldPersistTaps="handled">
      <View style={s.formulario}>
        <View style={s.campo}>
          <Campo
            rotulo="Nova categoria"
            value={nova}
            onChangeText={setNova}
            placeholder="Camisetas, Calças, Vestidos…"
            autoCapitalize="words"
            onSubmitEditing={() => nova.trim().length >= 2 && criar.mutate(nova.trim())}
          />
        </View>
        <Botao
          titulo="Criar"
          desabilitado={nova.trim().length < 2}
          carregando={criar.isPending}
          onPress={() => criar.mutate(nova.trim())}
          estilo={s.botao}
        />
      </View>

      {lista.length === 0 ? (
        <Vazio
          titulo="Nenhuma categoria"
          descricao="As categorias organizam o catálogo e os relatórios."
        />
      ) : (
        lista.map((categoria) => (
          <View key={categoria.id} style={s.item}>
            <Text style={s.nome}>{categoria.nome}</Text>
            <Pressable
              hitSlop={10}
              onPress={() =>
                Alert.alert('Excluir categoria?', categoria.nome, [
                  { text: 'Voltar', style: 'cancel' },
                  {
                    text: 'Excluir',
                    style: 'destructive',
                    onPress: () => excluir.mutate(categoria.id),
                  },
                ])
              }
            >
              <MaterialCommunityIcons name="trash-can-outline" size={22} color={cores.perigo} />
            </Pressable>
          </View>
        ))
      )}

      <Text style={s.dica}>
        Categoria com produtos não pode ser excluída — mova os produtos antes.
      </Text>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  conteudo: { padding: espaco.lg },
  formulario: { flexDirection: 'row', gap: espaco.sm, alignItems: 'flex-start' },
  campo: { flex: 1 },
  botao: { marginTop: 20 },

  item: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: cores.superficie,
    borderRadius: raio.md,
    padding: espaco.lg,
    marginBottom: espaco.sm,
  },
  nome: { fontSize: fonte.base, fontWeight: '700', color: cores.texto },
  dica: {
    fontSize: fonte.micro,
    color: cores.textoFraco,
    textAlign: 'center',
    marginTop: espaco.md,
  },
});
