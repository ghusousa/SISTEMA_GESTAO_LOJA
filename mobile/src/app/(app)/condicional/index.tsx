/**
 * Condicionais: quem está com o quê, e quem já devia ter devolvido (ADR-39).
 *
 * A peça na casa da cliente não está na arara nem no saldo. Esta lista é o único lugar que
 * diz onde ela está — e a aba "Vencidas" é a lista de ligações do dia: prazo passado no
 * dia da loja, a que venceu primeiro em cima. Espelho de `web/js/views/condicionais.js`.
 */

import { FlashList } from '@shopify/flash-list';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';

import { mensagemDoErro } from '@/api/client';
import { condicionais } from '@/api/endpoints';
import type { Condicional, FiltroCondicionais } from '@/api/tipos';
import { Botao, Carregando, ErroEstado, Etiqueta, Vazio } from '@/components/ui';
import { textoDoPrazo } from '@/lib/condicional';
import { formatar, paraCentavos } from '@/lib/money';
import { chaves } from '@/lib/queryClient';
import { cores, espaco, fonte, raio } from '@/lib/tema';

const ABAS: { rotulo: string; filtro: FiltroCondicionais }[] = [
  { rotulo: 'Abertas', filtro: 'abertas' },
  { rotulo: 'Vencidas', filtro: 'vencidas' },
  { rotulo: 'Fechadas', filtro: 'fechadas' },
];

export default function Condicionais() {
  const router = useRouter();
  const [filtro, setFiltro] = useState<FiltroCondicionais>('abertas');

  const consulta = useInfiniteQuery({
    queryKey: [...chaves.condicionais, filtro],
    initialPageParam: 1,
    queryFn: ({ pageParam }) => condicionais.listar({ situacao: filtro, page: pageParam, size: 20 }),
    getNextPageParam: (ultima) =>
      ultima.page * ultima.size < ultima.total ? ultima.page + 1 : undefined,
  });
  const lista = consulta.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <View style={s.tela}>
      <View style={s.abas}>
        {ABAS.map((aba) => (
          <Pressable
            key={aba.filtro}
            onPress={() => setFiltro(aba.filtro)}
            style={[s.aba, filtro === aba.filtro && s.abaAtiva]}
          >
            <Text style={[s.abaTexto, filtro === aba.filtro && s.abaTextoAtiva]}>{aba.rotulo}</Text>
          </Pressable>
        ))}
      </View>

      {consulta.isPending ? (
        <Carregando />
      ) : consulta.isError ? (
        <ErroEstado
          mensagem={mensagemDoErro(consulta.error, 'Não deu para carregar as condicionais.')}
          aoTentarNovamente={() => void consulta.refetch()}
        />
      ) : lista.length === 0 ? (
        <Vazio
          titulo={filtro === 'vencidas' ? 'Nenhuma vencida' : 'Nenhuma condicional aqui'}
          descricao={
            filtro === 'vencidas'
              ? 'Toda peça que saiu está no prazo.'
              : 'Bipe as peças que a cliente vai levar em "Nova condicional".'
          }
        />
      ) : (
        <FlashList
          data={lista}
          keyExtractor={(c) => String(c.id)}
          contentContainerStyle={s.lista}
          onEndReached={() => {
            if (consulta.hasNextPage && !consulta.isFetchingNextPage) void consulta.fetchNextPage();
          }}
          refreshControl={
            <RefreshControl
              refreshing={consulta.isRefetching && !consulta.isFetchingNextPage}
              onRefresh={() => void consulta.refetch()}
            />
          }
          renderItem={({ item }) => (
            <LinhaCondicional condicional={item} aoAbrir={() => router.push(`/condicional/${item.id}`)} />
          )}
        />
      )}

      <View style={s.rodape}>
        <Botao titulo="Nova condicional" variante="acao" grande onPress={() => router.push('/condicional/nova')} />
      </View>
    </View>
  );
}

function LinhaCondicional({ condicional: c, aoAbrir }: { condicional: Condicional; aoAbrir: () => void }) {
  const aberta = c.status === 'ABERTA';
  return (
    <Pressable onPress={aoAbrir} style={s.linha}>
      <View style={{ flex: 1 }}>
        <Text style={s.nome} numberOfLines={1}>
          #{c.id} · {c.cliente}
        </Text>
        <Text style={s.detalhe}>
          {c.total_pecas} peça(s) · {formatar(paraCentavos(c.valor_pecas))}
          {c.cliente_telefone ? ` · ${c.cliente_telefone}` : ''}
        </Text>
        <Text style={s.detalhe}>atendida por {c.vendedora}</Text>
      </View>
      {aberta ? (
        <Etiqueta
          texto={textoDoPrazo(c.dias_para_vencer)}
          cor={c.vencida ? cores.perigoFraco : cores.primariaFraca}
          corTexto={c.vencida ? cores.perigo : cores.primaria}
        />
      ) : (
        <Etiqueta texto={c.venda_id ? `venda #${c.venda_id}` : 'tudo voltou'} />
      )}
    </Pressable>
  );
}

const s = StyleSheet.create({
  tela: { flex: 1, backgroundColor: cores.fundo },
  abas: { flexDirection: 'row', gap: espaco.sm, padding: espaco.md },
  aba: {
    paddingHorizontal: espaco.lg,
    paddingVertical: espaco.sm,
    borderRadius: raio.redondo,
    backgroundColor: cores.superficie,
    borderWidth: 1,
    borderColor: cores.borda,
  },
  abaAtiva: { backgroundColor: cores.primaria, borderColor: cores.primaria },
  abaTexto: { fontSize: fonte.pequena, fontWeight: '700', color: cores.textoSuave },
  abaTextoAtiva: { color: cores.aoFundoEscuro },
  lista: { paddingHorizontal: espaco.md, paddingBottom: espaco.xl },
  linha: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: espaco.md,
    backgroundColor: cores.superficie,
    borderRadius: raio.md,
    padding: espaco.lg,
    marginBottom: espaco.sm,
  },
  nome: { fontSize: fonte.base, fontWeight: '700', color: cores.texto },
  detalhe: { fontSize: fonte.pequena, color: cores.textoSuave, marginTop: 2 },
  rodape: {
    padding: espaco.lg,
    backgroundColor: cores.superficie,
    borderTopWidth: 1,
    borderTopColor: cores.borda,
  },
});
