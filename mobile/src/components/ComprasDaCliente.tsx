/**
 * O histórico de compras de uma cliente — TODAS, não só as do fiado (ADR-36).
 *
 * Sai de `GET /vendas?cliente_id=`, com o escopo de sempre da lista de vendas: quem vê as
 * vendas da equipe vê todas as dela; a vendedora, só as que ela mesma fez. Espelho de
 * `web/js/compras-da-cliente.js`.
 */

import { useInfiniteQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { vendas } from '@/api/endpoints';
import { Botao } from '@/components/ui';
import { rotuloPagamento } from '@/lib/cartao';
import { formatar, paraCentavos } from '@/lib/money';
import { chaves } from '@/lib/queryClient';
import { cores, espaco, fonte, raio } from '@/lib/tema';

const TAMANHO = 10;

export function ComprasDaCliente({ clienteId }: { clienteId: number }) {
  const router = useRouter();
  const compras = useInfiniteQuery({
    queryKey: chaves.comprasDaCliente(clienteId),
    initialPageParam: 1,
    queryFn: ({ pageParam }) =>
      vendas.listar({ cliente_id: clienteId, page: pageParam, size: TAMANHO }),
    getNextPageParam: (ultima) =>
      ultima.page * ultima.size < ultima.total ? ultima.page + 1 : undefined,
    enabled: Number.isFinite(clienteId),
  });

  const lista = compras.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <View>
      <Text style={s.secao}>Todas as compras</Text>
      {compras.isPending ? (
        <Text style={s.vazio}>Carregando…</Text>
      ) : lista.length === 0 ? (
        <Text style={s.vazio}>Nenhuma compra com o nome dela ainda.</Text>
      ) : (
        lista.map((v) => (
          <Pressable
            key={v.id}
            style={({ pressed }) => [s.item, pressed && s.itemPressionado]}
            onPress={() => router.push({ pathname: '/venda/[id]', params: { id: String(v.id) } })}
          >
            <View style={s.itemTexto}>
              <Text style={s.itemNome}>
                Venda #{v.id}
                {v.status === 'CANCELADA' ? ' (cancelada)' : ''}
              </Text>
              <Text style={s.itemDetalhe}>
                {new Date(v.vendida_em).toLocaleDateString('pt-BR')} · {v.quantidade_pecas} pç ·{' '}
                {v.formas_pagamento.map((forma) => rotuloPagamento({ forma })).join(' + ')}
              </Text>
            </View>
            <Text style={s.itemValor}>{formatar(paraCentavos(v.total))}</Text>
          </Pressable>
        ))
      )}
      {compras.hasNextPage && (
        <Botao
          titulo="Mais compras"
          variante="secundario"
          carregando={compras.isFetchingNextPage}
          onPress={() => void compras.fetchNextPage()}
        />
      )}
    </View>
  );
}

const s = StyleSheet.create({
  secao: {
    fontSize: fonte.pequena,
    color: cores.textoSuave,
    fontWeight: '700',
    marginTop: espaco.lg,
    marginBottom: espaco.sm,
  },
  vazio: { fontSize: fonte.pequena, color: cores.textoFraco },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: espaco.sm,
    backgroundColor: cores.superficie,
    borderRadius: raio.md,
    padding: espaco.md,
    marginBottom: espaco.sm,
  },
  itemPressionado: { backgroundColor: cores.primariaFraca },
  itemTexto: { flex: 1 },
  itemNome: { fontSize: fonte.base, fontWeight: '700', color: cores.texto },
  itemDetalhe: { fontSize: fonte.pequena, color: cores.textoSuave },
  itemValor: { fontSize: fonte.base, fontWeight: '800', color: cores.texto },
});
