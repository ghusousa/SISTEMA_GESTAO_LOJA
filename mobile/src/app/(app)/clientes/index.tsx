/**
 * Crediário — a caderneta, dentro do sistema.
 *
 * A loja já vendia fiado; o que não existia era o registro. Caderneta perdida é venda
 * perdida, e ninguém cobra o que não sabe que tem a receber.
 *
 * Abre em **quem está devendo**, não na lista inteira de clientes: a pergunta de
 * segunda-feira é "quem preciso cobrar?", e não "quantos clientes eu tenho". Espelho de
 * `web/js/views/clientes.js`.
 */

import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import {
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { mensagemDoErro } from '@/api/client';
import { clientes } from '@/api/endpoints';
import type { Cliente } from '@/api/tipos';
import { NovoCliente } from '@/components/NovoCliente';
import { Carregando, ErroEstado, Etiqueta, Vazio } from '@/components/ui';
import { formatar, paraCentavos } from '@/lib/money';
import { chaves } from '@/lib/queryClient';
import { ALVO_TOQUE, cores, espaco, fonte, raio } from '@/lib/tema';

export default function Clientes() {
  const router = useRouter();
  const [termo, setTermo] = useState('');
  const [soDevendo, setSoDevendo] = useState(true);

  const lista = useQuery({
    queryKey: [...chaves.clientes, { termo, soDevendo }],
    queryFn: () =>
      clientes.listar({ q: termo.trim() || undefined, somente_devendo: soDevendo, size: 50 }),
  });

  const itens = lista.data?.items ?? [];
  const aReceber = itens.reduce((soma, c) => soma + Math.max(0, paraCentavos(c.deve)), 0);

  return (
    <View style={s.tela}>
      <View style={s.topo}>
        <TextInput
          value={termo}
          onChangeText={setTermo}
          style={s.busca}
          placeholder="Nome, telefone ou documento"
          placeholderTextColor={cores.textoFraco}
          autoCorrect={false}
          returnKeyType="search"
        />
        <View style={s.topoLinha}>
          <Pressable
            style={[s.filtro, soDevendo && s.filtroAtivo]}
            accessibilityRole="switch"
            accessibilityState={{ checked: soDevendo }}
            onPress={() => setSoDevendo((v) => !v)}
          >
            <Text style={[s.filtroTexto, soDevendo && s.filtroTextoAtivo]}>
              Só quem está devendo
            </Text>
          </Pressable>
          <NovoCliente aoCriar={(c) => router.push(`/clientes/${c.id}`)} />
        </View>
      </View>

      {aReceber > 0 && (
        <View style={s.destaque}>
          <Text style={s.destaqueRotulo}>A receber</Text>
          <Text style={s.destaqueValor}>{formatar(aReceber)}</Text>
        </View>
      )}

      {lista.isPending ? (
        <Carregando />
      ) : lista.isError ? (
        <ErroEstado
          mensagem={mensagemDoErro(lista.error, 'Não deu para carregar o crediário.')}
          aoTentarNovamente={() => void lista.refetch()}
        />
      ) : (
        <FlatList
          data={itens}
          keyExtractor={(c) => String(c.id)}
          contentContainerStyle={s.conteudo}
          refreshControl={
            <RefreshControl
              refreshing={lista.isRefetching}
              onRefresh={() => void lista.refetch()}
            />
          }
          ListEmptyComponent={
            <Vazio
              titulo={soDevendo ? 'Ninguém devendo' : 'Nenhum cliente'}
              descricao={
                soDevendo
                  ? 'Todo mundo em dia — é o estado que a gente quer.'
                  : 'Cadastre a cliente na hora de vender no fiado.'
              }
            />
          }
          renderItem={({ item }) => <LinhaCliente cliente={item} />}
        />
      )}
    </View>
  );
}

function LinhaCliente({ cliente }: { cliente: Cliente }) {
  const router = useRouter();
  const deve = paraCentavos(cliente.deve);
  return (
    <Pressable
      style={({ pressed }) => [s.linha, pressed && s.linhaPressionada]}
      onPress={() => router.push(`/clientes/${cliente.id}`)}
    >
      <View style={s.linhaTexto}>
        <Text style={s.nome}>{cliente.nome}</Text>
        <Text style={s.detalhe}>{cliente.telefone || 'sem telefone'}</Text>
        {cliente.acima_do_limite && (
          <Etiqueta
            texto="acima do limite combinado"
            cor={cores.alertaFraco}
            corTexto="#7A5A00"
            estilo={s.etiqueta}
          />
        )}
      </View>
      <Text style={[s.deve, deve > 0 && s.devendo]}>{formatar(deve)}</Text>
      <MaterialCommunityIcons name="chevron-right" size={22} color={cores.textoFraco} />
    </Pressable>
  );
}

const s = StyleSheet.create({
  tela: { flex: 1, backgroundColor: cores.fundo },

  topo: {
    padding: espaco.lg,
    gap: espaco.sm,
    backgroundColor: cores.superficie,
    borderBottomWidth: 1,
    borderBottomColor: cores.borda,
  },
  topoLinha: { flexDirection: 'row', alignItems: 'center', gap: espaco.sm },
  busca: {
    minHeight: ALVO_TOQUE,
    borderWidth: 1,
    borderColor: cores.borda,
    borderRadius: raio.md,
    paddingHorizontal: espaco.md,
    fontSize: fonte.base,
    color: cores.texto,
    backgroundColor: cores.fundo,
  },
  filtro: {
    flex: 1,
    minHeight: ALVO_TOQUE - 8,
    justifyContent: 'center',
    paddingHorizontal: espaco.md,
    borderRadius: raio.redondo,
    borderWidth: 1,
    borderColor: cores.borda,
  },
  filtroAtivo: { backgroundColor: cores.primariaFraca, borderColor: cores.primaria },
  filtroTexto: { fontSize: fonte.pequena, color: cores.textoSuave, fontWeight: '600' },
  filtroTextoAtivo: { color: cores.primaria },

  destaque: {
    margin: espaco.lg,
    marginBottom: 0,
    padding: espaco.lg,
    borderRadius: raio.md,
    backgroundColor: cores.primaria,
  },
  destaqueRotulo: { color: '#B9CBE0', fontSize: fonte.pequena, fontWeight: '600' },
  destaqueValor: {
    color: cores.aoFundoEscuro,
    fontSize: fonte.destaque,
    fontWeight: '800',
  },

  conteudo: { padding: espaco.lg, gap: espaco.sm, flexGrow: 1 },
  linha: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: espaco.sm,
    minHeight: 64,
    paddingHorizontal: espaco.lg,
    borderRadius: raio.md,
    backgroundColor: cores.superficie,
  },
  linhaPressionada: { opacity: 0.85 },
  linhaTexto: { flex: 1, paddingVertical: espaco.sm },
  nome: { fontSize: fonte.base, fontWeight: '700', color: cores.texto },
  detalhe: { fontSize: fonte.pequena, color: cores.textoSuave },
  etiqueta: { alignSelf: 'flex-start', marginTop: 4 },
  deve: { fontSize: fonte.media, fontWeight: '800', color: cores.textoSuave },
  devendo: { color: cores.perigo },
});
