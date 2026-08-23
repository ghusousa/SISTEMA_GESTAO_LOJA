import { MaterialCommunityIcons } from '@expo/vector-icons';
import { FlashList } from '@shopify/flash-list';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, RefreshControl, StyleSheet, Text, TextInput, View } from 'react-native';

import { mensagemDoErro } from '@/api/client';
import { estoque } from '@/api/endpoints';
import type { Saldo } from '@/api/tipos';
import { Carregando, ErroEstado, Etiqueta, Vazio } from '@/components/ui';
import { formatar, paraCentavos } from '@/lib/money';
import { chaves } from '@/lib/queryClient';
import { PODE, pode, type Capacidade } from '@/lib/permissoes';
import { ALVO_TOQUE, cores, espaco, fonte, raio } from '@/lib/tema';
import { useAuthStore } from '@/stores/authStore';

type Atalho = { rotulo: string; icone: keyof typeof MaterialCommunityIcons.glyphMap; rota: string; pode?: Capacidade };

const ATALHOS: Atalho[] = [
  { rotulo: 'Entrada', icone: 'tray-arrow-down', rota: '/estoque/entrada' },
  { rotulo: 'Extrato', icone: 'format-list-bulleted', rota: '/estoque/movimentacoes' },
  { rotulo: 'Ajuste', icone: 'tune', rota: '/estoque/ajuste', pode: PODE.CORRIGIR_ESTOQUE },
  { rotulo: 'Inventário', icone: 'clipboard-list-outline', rota: '/estoque/inventario', pode: PODE.CORRIGIR_ESTOQUE },
];

export default function Estoque() {
  const router = useRouter();
  const corrigeEstoque = useAuthStore((e) => pode(e.usuario?.papel, PODE.CORRIGIR_ESTOQUE));
  const [busca, setBusca] = useState('');
  const [soBaixo, setSoBaixo] = useState(false);

  const consulta = useInfiniteQuery({
    queryKey: [...chaves.saldos, busca, soBaixo],
    initialPageParam: 1,
    queryFn: ({ pageParam }) =>
      estoque.saldos({
        q: busca || undefined,
        somente_baixo: soBaixo || undefined,
        page: pageParam,
        size: 20,
      }),
    getNextPageParam: (ultima) =>
      ultima.page * ultima.size < ultima.total ? ultima.page + 1 : undefined,
  });

  const saldos = consulta.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <View style={s.tela}>
      <View style={s.atalhos}>
        {ATALHOS.filter((a) => !a.pode || corrigeEstoque).map((atalho) => (
          <Pressable
            key={atalho.rota}
            style={s.atalho}
            onPress={() => router.push(atalho.rota as never)}
          >
            <MaterialCommunityIcons name={atalho.icone} size={24} color={cores.primaria} />
            <Text style={s.atalhoTexto}>{atalho.rotulo}</Text>
          </Pressable>
        ))}
      </View>

      <View style={s.filtros}>
        <View style={s.barraBusca}>
          <MaterialCommunityIcons name="magnify" size={20} color={cores.textoFraco} />
          <TextInput
            value={busca}
            onChangeText={setBusca}
            placeholder="Peça ou código"
            placeholderTextColor={cores.textoFraco}
            style={s.inputBusca}
            autoCorrect={false}
          />
        </View>
        <Pressable
          onPress={() => setSoBaixo((v) => !v)}
          style={[s.filtroBaixo, soBaixo && s.filtroBaixoAtivo]}
        >
          <Text style={[s.filtroTexto, soBaixo && s.filtroTextoAtivo]}>Repor</Text>
        </Pressable>
      </View>

      {consulta.isPending ? (
        <Carregando />
      ) : consulta.isError ? (
        <ErroEstado
          mensagem={mensagemDoErro(consulta.error, 'Não deu para carregar o estoque.')}
          aoTentarNovamente={() => void consulta.refetch()}
        />
      ) : saldos.length === 0 ? (
        <Vazio
          titulo={soBaixo ? 'Nada para repor' : 'Sem peças cadastradas'}
          descricao={soBaixo ? 'Todo o estoque está acima do mínimo.' : undefined}
        />
      ) : (
        <FlashList
          data={saldos}
          keyExtractor={(item) => String(item.variante_id)}
          contentContainerStyle={s.lista}
          onEndReached={() => {
            if (consulta.hasNextPage && !consulta.isFetchingNextPage) {
              void consulta.fetchNextPage();
            }
          }}
          refreshControl={
            <RefreshControl
              refreshing={consulta.isRefetching && !consulta.isFetchingNextPage}
              onRefresh={() => void consulta.refetch()}
            />
          }
          renderItem={({ item }) => <LinhaSaldo saldo={item} />}
        />
      )}
    </View>
  );
}

function LinhaSaldo({ saldo }: { saldo: Saldo }) {
  return (
    <View style={s.linha}>
      <View style={s.linhaInfo}>
        <Text style={s.linhaNome} numberOfLines={1}>
          {saldo.produto}
        </Text>
        <Text style={s.linhaDetalhe}>
          {saldo.tamanho} · {saldo.cor} · {formatar(paraCentavos(saldo.preco_venda))}
        </Text>
        {/* valor_em_custo só vem para ADMIN. */}
        {!!saldo.valor_em_custo && (
          <Text style={s.linhaCusto}>
            imobilizado {formatar(paraCentavos(saldo.valor_em_custo))}
          </Text>
        )}
      </View>
      <View style={s.linhaSaldoArea}>
        <Text style={[s.linhaSaldo, saldo.estoque_baixo && s.linhaSaldoBaixo]}>
          {saldo.saldo}
        </Text>
        {saldo.estoque_baixo && (
          <Etiqueta texto="repor" cor={cores.alertaFraco} corTexto="#7A5A00" />
        )}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  tela: { flex: 1, backgroundColor: cores.fundo },

  atalhos: {
    flexDirection: 'row',
    gap: espaco.sm,
    paddingHorizontal: espaco.md,
    paddingTop: espaco.md,
  },
  atalho: {
    flex: 1,
    backgroundColor: cores.superficie,
    borderRadius: raio.md,
    paddingVertical: espaco.md,
    alignItems: 'center',
    gap: espaco.xs,
    borderWidth: 1,
    borderColor: cores.borda,
  },
  atalhoTexto: { fontSize: fonte.micro, fontWeight: '700', color: cores.primaria },

  filtros: { flexDirection: 'row', gap: espaco.sm, padding: espaco.md },
  barraBusca: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: espaco.sm,
    backgroundColor: cores.superficie,
    paddingHorizontal: espaco.md,
    borderRadius: raio.md,
    borderWidth: 1,
    borderColor: cores.borda,
    minHeight: ALVO_TOQUE,
  },
  inputBusca: { flex: 1, fontSize: fonte.base, color: cores.texto },
  filtroBaixo: {
    paddingHorizontal: espaco.lg,
    justifyContent: 'center',
    borderRadius: raio.md,
    backgroundColor: cores.superficie,
    borderWidth: 1,
    borderColor: cores.borda,
  },
  filtroBaixoAtivo: { backgroundColor: cores.alerta, borderColor: cores.alerta },
  filtroTexto: { fontWeight: '700', color: cores.textoSuave, fontSize: fonte.pequena },
  filtroTextoAtivo: { color: '#FFF' },

  lista: { paddingHorizontal: espaco.md, paddingBottom: espaco.xl },
  linha: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: cores.superficie,
    borderRadius: raio.md,
    padding: espaco.lg,
    marginBottom: espaco.sm,
    gap: espaco.md,
  },
  linhaInfo: { flex: 1 },
  linhaNome: { fontSize: fonte.base, fontWeight: '700', color: cores.texto },
  linhaDetalhe: { fontSize: fonte.pequena, color: cores.textoSuave, marginTop: 2 },
  linhaCusto: { fontSize: fonte.micro, color: cores.textoFraco, marginTop: 2 },
  linhaSaldoArea: { alignItems: 'center', gap: espaco.xs, minWidth: 60 },
  linhaSaldo: { fontSize: fonte.titulo, fontWeight: '800', color: cores.texto },
  linhaSaldoBaixo: { color: cores.alerta },
});
