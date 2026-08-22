import { FlashList } from '@shopify/flash-list';
import { useInfiniteQuery } from '@tanstack/react-query';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { useRouter } from 'expo-router';
import { Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';

import { mensagemDoErro } from '@/api/client';
import { vendas } from '@/api/endpoints';
import type { FormaPagamento, VendaResumo } from '@/api/tipos';
import { Carregando, ErroEstado, Etiqueta, Vazio } from '@/components/ui';
import { formatar, paraCentavos } from '@/lib/money';
import { chaves } from '@/lib/queryClient';
import { cores, espaco, fonte, raio } from '@/lib/tema';

const SIGLA: Record<FormaPagamento, string> = {
  DINHEIRO: 'dinheiro',
  PIX: 'pix',
  DEBITO: 'débito',
  CREDITO: 'crédito',
};

export default function HistoricoVendas() {
  const router = useRouter();

  const consulta = useInfiniteQuery({
    queryKey: chaves.vendas,
    initialPageParam: 1,
    queryFn: ({ pageParam }) => vendas.listar({ page: pageParam, size: 20 }),
    getNextPageParam: (ultima) =>
      ultima.page * ultima.size < ultima.total ? ultima.page + 1 : undefined,
  });

  const lista = consulta.data?.pages.flatMap((p) => p.items) ?? [];

  if (consulta.isPending) return <Carregando />;
  if (consulta.isError) {
    return (
      <ErroEstado
        mensagem={mensagemDoErro(consulta.error, 'Não deu para carregar as vendas.')}
        aoTentarNovamente={() => void consulta.refetch()}
      />
    );
  }
  if (lista.length === 0) {
    return <Vazio titulo="Nenhuma venda ainda" descricao="A primeira venda aparece aqui." />;
  }

  return (
    <FlashList
      data={lista}
      keyExtractor={(v) => String(v.id)}
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
      renderItem={({ item }) => (
        <LinhaVenda
          venda={item}
          aoAbrir={() =>
            router.push({ pathname: '/venda/[id]', params: { id: String(item.id) } })
          }
        />
      )}
    />
  );
}

function LinhaVenda({ venda, aoAbrir }: { venda: VendaResumo; aoAbrir: () => void }) {
  const cancelada = venda.status === 'CANCELADA';
  return (
    <Pressable style={[s.linha, cancelada && s.linhaCancelada]} onPress={aoAbrir}>
      <View style={s.linhaInfo}>
        <Text style={s.numero}>Venda #{venda.id}</Text>
        <Text style={s.detalhe}>
          {format(new Date(venda.vendida_em), "dd/MM 'às' HH:mm", { locale: ptBR })} ·{' '}
          {venda.vendedor}
        </Text>
        <Text style={s.detalhe}>
          {venda.quantidade_pecas} peça(s) ·{' '}
          {venda.formas_pagamento.map((f) => SIGLA[f]).join(' + ')}
        </Text>
      </View>
      <View style={s.linhaDireita}>
        <Text style={[s.total, cancelada && s.totalCancelado]}>
          {formatar(paraCentavos(venda.total))}
        </Text>
        {cancelada && (
          <Etiqueta texto="cancelada" cor={cores.perigoFraco} corTexto={cores.perigo} />
        )}
      </View>
    </Pressable>
  );
}

const s = StyleSheet.create({
  lista: { padding: espaco.md },
  linha: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: cores.superficie,
    borderRadius: raio.md,
    padding: espaco.lg,
    marginBottom: espaco.sm,
    gap: espaco.md,
  },
  linhaCancelada: { borderLeftWidth: 3, borderLeftColor: cores.perigo },
  linhaInfo: { flex: 1 },
  numero: { fontSize: fonte.base, fontWeight: '700', color: cores.texto },
  detalhe: { fontSize: fonte.pequena, color: cores.textoSuave, marginTop: 2 },
  linhaDireita: { alignItems: 'flex-end', gap: espaco.xs },
  total: { fontSize: fonte.media, fontWeight: '800', color: cores.texto },
  totalCancelado: { textDecorationLine: 'line-through', color: cores.textoFraco },
});
