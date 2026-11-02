/**
 * Extrato do estoque: a resposta para "por que tenho 3 e não 5?".
 */

import { FlashList } from '@shopify/flash-list';
import { useInfiniteQuery } from '@tanstack/react-query';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';

import { mensagemDoErro } from '@/api/client';
import { estoque } from '@/api/endpoints';
import type { Movimento, TipoMovimento } from '@/api/tipos';
import { Carregando, ErroEstado, Etiqueta, Vazio } from '@/components/ui';
import { chaves } from '@/lib/queryClient';
import { cores, espaco, fonte, raio } from '@/lib/tema';

const FILTROS: { rotulo: string; tipo?: TipoMovimento }[] = [
  { rotulo: 'Tudo' },
  { rotulo: 'Vendas', tipo: 'VENDA' },
  { rotulo: 'Entradas', tipo: 'ENTRADA' },
  { rotulo: 'Ajustes', tipo: 'AJUSTE' },
  { rotulo: 'Inventário', tipo: 'INVENTARIO' },
  { rotulo: 'Estornos', tipo: 'ESTORNO' },
  { rotulo: 'Devoluções', tipo: 'DEVOLUCAO' },
  { rotulo: 'Saiu em condicional', tipo: 'CONDICIONAL_SAIDA' },
  { rotulo: 'Voltou da condicional', tipo: 'CONDICIONAL_RETORNO' },
];

const CORES_TIPO: Record<TipoMovimento, { fundo: string; texto: string }> = {
  ENTRADA: { fundo: cores.sucessoFraco, texto: cores.acaoEscura },
  ESTORNO: { fundo: cores.sucessoFraco, texto: cores.acaoEscura },
  DEVOLUCAO: { fundo: cores.sucessoFraco, texto: cores.acaoEscura },
  VENDA: { fundo: cores.primariaFraca, texto: cores.primaria },
  AJUSTE: { fundo: cores.alertaFraco, texto: '#7A5A00' },
  INVENTARIO: { fundo: cores.superficieAlt, texto: cores.textoSuave },
  CONDICIONAL_SAIDA: { fundo: cores.alertaFraco, texto: '#7A5A00' },
  CONDICIONAL_RETORNO: { fundo: cores.sucessoFraco, texto: cores.acaoEscura },
};

/** A frase da etiqueta. Tipo sem frase aqui aparece pelo nome técnico, em minúsculas. */
const ROTULO_TIPO: Partial<Record<TipoMovimento, string>> = {
  CONDICIONAL_SAIDA: 'saiu em condicional',
  CONDICIONAL_RETORNO: 'voltou da condicional',
};

/** Cor de um tipo que o app ainda não conhece — cinza, mas VISÍVEL. */
const COR_DESCONHECIDA = { fundo: cores.superficieAlt, texto: cores.textoSuave };

export default function Movimentacoes() {
  const params = useLocalSearchParams<{ varianteId?: string; titulo?: string }>();
  const varianteId = params.varianteId ? Number(params.varianteId) : undefined;
  const [tipo, setTipo] = useState<TipoMovimento | undefined>();

  const consulta = useInfiniteQuery({
    queryKey: [...chaves.movimentacoes, tipo ?? 'todos', varianteId ?? 'todas'],
    initialPageParam: 1,
    queryFn: ({ pageParam }) =>
      estoque.movimentacoes({ tipo, variante_id: varianteId, page: pageParam, size: 25 }),
    getNextPageParam: (ultima) =>
      ultima.page * ultima.size < ultima.total ? ultima.page + 1 : undefined,
  });

  const movimentos = consulta.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <View style={s.tela}>
      {!!params.titulo && <Text style={s.filtroPeca}>Extrato de {params.titulo}</Text>}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={s.filtros}
      >
        {FILTROS.map((filtro) => {
          const ativo = filtro.tipo === tipo;
          return (
            <Pressable
              key={filtro.rotulo}
              onPress={() => setTipo(filtro.tipo)}
              style={[s.filtro, ativo && s.filtroAtivo]}
            >
              <Text style={[s.filtroTexto, ativo && s.filtroTextoAtivo]}>{filtro.rotulo}</Text>
            </Pressable>
          );
        })}
      </ScrollView>

      {consulta.isPending ? (
        <Carregando />
      ) : consulta.isError ? (
        <ErroEstado
          mensagem={mensagemDoErro(consulta.error, 'Não deu para carregar o extrato.')}
          aoTentarNovamente={() => void consulta.refetch()}
        />
      ) : movimentos.length === 0 ? (
        <Vazio titulo="Nenhuma movimentação" descricao="Nada aconteceu com este filtro." />
      ) : (
        <FlashList
          data={movimentos}
          keyExtractor={(m) => String(m.id)}
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
          renderItem={({ item }) => <LinhaMovimento movimento={item} />}
        />
      )}
    </View>
  );
}

function LinhaMovimento({ movimento }: { movimento: Movimento }) {
  // O `??` não é paranoia: quando a API ganhou o movimento DEVOLUCAO, este mapa não tinha
  // a chave, `cor` veio `undefined`, e o `cor.fundo` derrubou a TELA INTEIRA em branco —
  // por uma etiqueta colorida. Tipo novo agora aparece em cinza, e o extrato continua de pé.
  const cor = CORES_TIPO[movimento.tipo] ?? COR_DESCONHECIDA;
  const entrada = movimento.quantidade > 0;

  return (
    <View style={s.linha}>
      <View style={s.linhaInfo}>
        <Text style={s.linhaNome} numberOfLines={1}>
          {movimento.produto ?? 'Peça removida'}
        </Text>
        <Text style={s.linhaDetalhe}>
          {movimento.tamanho} · {movimento.cor} · {movimento.usuario}
        </Text>
        <Text style={s.linhaData}>
          {format(new Date(movimento.criado_em), "dd/MM 'às' HH:mm", { locale: ptBR })}
          {movimento.venda_id ? ` · venda #${movimento.venda_id}` : ''}
          {movimento.condicional_id ? ` · condicional #${movimento.condicional_id}` : ''}
        </Text>
        {!!movimento.observacao && (
          <Text style={s.linhaObs} numberOfLines={2}>
            {movimento.observacao}
          </Text>
        )}
      </View>

      <View style={s.linhaNumeros}>
        <Etiqueta
          texto={ROTULO_TIPO[movimento.tipo] ?? movimento.tipo.toLowerCase()}
          cor={cor.fundo}
          corTexto={cor.texto}
        />
        <Text style={[s.quantidade, entrada ? s.entrada : s.saida]}>
          {entrada ? '+' : ''}
          {movimento.quantidade}
        </Text>
        <Text style={s.saldoApos}>saldo {movimento.saldo_apos}</Text>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  tela: { flex: 1, backgroundColor: cores.fundo },

  filtroPeca: {
    fontSize: fonte.base,
    fontWeight: '700',
    color: cores.texto,
    paddingHorizontal: espaco.lg,
    paddingTop: espaco.md,
  },
  filtros: { padding: espaco.md, gap: espaco.sm },
  filtro: {
    paddingHorizontal: espaco.lg,
    paddingVertical: espaco.sm,
    borderRadius: raio.redondo,
    backgroundColor: cores.superficie,
    borderWidth: 1,
    borderColor: cores.borda,
  },
  filtroAtivo: { backgroundColor: cores.primaria, borderColor: cores.primaria },
  filtroTexto: { fontSize: fonte.pequena, fontWeight: '700', color: cores.textoSuave },
  filtroTextoAtivo: { color: cores.aoFundoEscuro },

  lista: { paddingHorizontal: espaco.md, paddingBottom: espaco.xl },
  linha: {
    flexDirection: 'row',
    backgroundColor: cores.superficie,
    borderRadius: raio.md,
    padding: espaco.lg,
    marginBottom: espaco.sm,
    gap: espaco.md,
  },
  linhaInfo: { flex: 1 },
  linhaNome: { fontSize: fonte.base, fontWeight: '700', color: cores.texto },
  linhaDetalhe: { fontSize: fonte.pequena, color: cores.textoSuave, marginTop: 2 },
  linhaData: { fontSize: fonte.micro, color: cores.textoFraco, marginTop: 2 },
  linhaObs: { fontSize: fonte.micro, color: cores.textoSuave, marginTop: espaco.xs },

  linhaNumeros: { alignItems: 'flex-end', gap: espaco.xs },
  quantidade: { fontSize: fonte.grande, fontWeight: '800' },
  entrada: { color: cores.acaoEscura },
  saida: { color: cores.perigo },
  saldoApos: { fontSize: fonte.micro, color: cores.textoFraco },
});
