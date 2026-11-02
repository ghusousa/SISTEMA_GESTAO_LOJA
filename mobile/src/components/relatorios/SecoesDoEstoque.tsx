/**
 * O giro do estoque (ADR-38): quanto vale a arara, o que está parado e o que sustenta a loja.
 *
 * Valor do estoque e estoque parado são fotografias do AGORA (não dependem do período) e
 * caem com qualquer mexida no saldo. A curva ABC é do período escolhido. As três listas
 * são paginadas no servidor; os totais que aparecem valem para a loja inteira.
 */

import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { mensagemDoErro } from '@/api/client';
import { relatorios } from '@/api/endpoints';
import type { ClasseAbc } from '@/api/tipos';
import { Botao, Cartao, Etiqueta } from '@/components/ui';
import { formatar, formatarPercentual, paraCentavos } from '@/lib/money';
import { chaves } from '@/lib/queryClient';
import { cores, espaco, fonte, raio } from '@/lib/tema';

import { r } from './estilos';

const POR_PAGINA = 20;
const proxima = (u: { page: number; size: number; total: number }) =>
  u.page * u.size < u.total ? u.page + 1 : undefined;

// ---------------------------------------------------------------- valor do estoque
export function SecaoValorEstoque() {
  const consulta = useQuery({
    queryKey: chaves.valorDoEstoque,
    queryFn: relatorios.valorDoEstoque,
  });
  return (
    <Cartao>
      <Text style={r.titulo}>Valor do estoque</Text>
      {consulta.isPending ? (
        <Text style={r.vazio}>Somando a arara…</Text>
      ) : consulta.isError ? (
        <Text style={r.erro}>{mensagemDoErro(consulta.error, 'Não deu para somar.')}</Text>
      ) : (
        <>
          <Text style={r.destaque}>{formatar(paraCentavos(consulta.data.valor_em_custo))}</Text>
          <Text style={r.legenda}>
            em custo · {consulta.data.pecas} peça(s) em {consulta.data.variantes} variante(s)
          </Text>
          <Text style={[r.detalhe, { marginTop: espaco.sm }]}>
            A preço de venda: {formatar(paraCentavos(consulta.data.valor_em_venda))}
          </Text>
        </>
      )}
    </Cartao>
  );
}

// ------------------------------------------------------------------ estoque parado
const OPCOES_DIAS = [30, 60, 90, 180] as const;

export function SecaoEstoqueParado() {
  const [dias, setDias] = useState<number>(90);
  const consulta = useInfiniteQuery({
    queryKey: chaves.estoqueParado(dias),
    initialPageParam: 1,
    queryFn: ({ pageParam }) => relatorios.estoqueParado(dias, { page: pageParam, size: POR_PAGINA }),
    getNextPageParam: proxima,
  });
  const primeira = consulta.data?.pages[0];
  const pecas = consulta.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <Cartao>
      <Text style={r.titulo}>Estoque parado</Text>
      <Text style={r.legenda}>Peças com saldo que não vendem há mais de {dias} dias.</Text>
      <View style={e.opcoes}>
        {OPCOES_DIAS.map((d) => (
          <Pressable
            key={d}
            onPress={() => setDias(d)}
            style={[e.opcao, dias === d && e.opcaoAtiva]}
          >
            <Text style={[e.opcaoTexto, dias === d && e.opcaoTextoAtivo]}>{d} dias</Text>
          </Pressable>
        ))}
      </View>
      {consulta.isPending ? (
        <Text style={r.vazio}>Conferindo…</Text>
      ) : consulta.isError ? (
        <Text style={r.erro}>{mensagemDoErro(consulta.error, 'Não deu para conferir.')}</Text>
      ) : pecas.length === 0 ? (
        <Text style={r.vazio}>Nada parado há tanto tempo.</Text>
      ) : (
        <>
          <View style={r.totais}>
            <Text style={r.totalRotulo}>
              {primeira!.total} peça(s) · {primeira!.pecas_total} unidade(s)
            </Text>
            <Text style={r.totalValor}>
              {formatar(paraCentavos(primeira!.valor_em_custo_total))}
            </Text>
          </View>
          <Text style={r.legenda}>parados, em custo (a loja inteira, não só a lista abaixo)</Text>
          {pecas.map((p) => (
            <View key={p.variante_id} style={r.linha}>
              <View style={r.info}>
                <Text style={r.nome} numberOfLines={1}>
                  {p.produto}
                </Text>
                <Text style={r.detalhe}>
                  {p.tamanho} · {p.cor} · {p.saldo} un. ·{' '}
                  {p.ultima_venda ? 'última venda' : 'nunca vendeu'} há {p.dias_parada} dias
                </Text>
              </View>
              <Text style={r.valor}>{formatar(paraCentavos(p.valor_em_custo))}</Text>
            </View>
          ))}
          {consulta.hasNextPage && (
            <Botao
              titulo="Ver mais"
              variante="secundario"
              carregando={consulta.isFetchingNextPage}
              onPress={() => void consulta.fetchNextPage()}
              estilo={{ marginTop: espaco.sm }}
            />
          )}
        </>
      )}
    </Cartao>
  );
}

// ---------------------------------------------------------------------- curva ABC
const COR_CLASSE: Record<ClasseAbc, { fundo: string; texto: string }> = {
  A: { fundo: cores.sucessoFraco, texto: cores.acaoEscura },
  B: { fundo: cores.alertaFraco, texto: '#7A5A00' },
  C: { fundo: cores.superficieAlt, texto: cores.textoSuave },
};

export function SecaoCurvaAbc({ inicio, fim }: { inicio: string; fim: string }) {
  const consulta = useInfiniteQuery({
    queryKey: chaves.relatorioCurvaAbc(inicio, fim),
    initialPageParam: 1,
    queryFn: ({ pageParam }) => relatorios.curvaAbc(inicio, fim, { page: pageParam, size: POR_PAGINA }),
    getNextPageParam: proxima,
  });
  const produtos = consulta.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <Cartao>
      <Text style={r.titulo}>Curva ABC</Text>
      <Text style={r.legenda}>
        A: os produtos que fazem os primeiros 80% do faturamento · B: até 95% · C: o resto.
      </Text>
      {consulta.isPending ? (
        <Text style={r.vazio}>Ordenando…</Text>
      ) : consulta.isError ? (
        <Text style={r.erro}>{mensagemDoErro(consulta.error, 'Não deu para montar a curva.')}</Text>
      ) : produtos.length === 0 ? (
        <Text style={r.vazio}>Nenhuma venda no período.</Text>
      ) : (
        <>
          {produtos.map((p) => (
            <View key={p.produto_id} style={r.linha}>
              <Etiqueta
                texto={p.classe}
                cor={COR_CLASSE[p.classe].fundo}
                corTexto={COR_CLASSE[p.classe].texto}
              />
              <View style={r.info}>
                <Text style={r.nome} numberOfLines={1}>
                  {p.produto}
                </Text>
                <Text style={r.detalhe}>
                  {p.pecas} peça(s) · {formatarPercentual(p.percentual)} · acumulado{' '}
                  {formatarPercentual(p.percentual_acumulado)}
                </Text>
              </View>
              <Text style={r.valor}>{formatar(paraCentavos(p.faturamento_liquido))}</Text>
            </View>
          ))}
          {consulta.hasNextPage && (
            <Botao
              titulo="Ver mais"
              variante="secundario"
              carregando={consulta.isFetchingNextPage}
              onPress={() => void consulta.fetchNextPage()}
              estilo={{ marginTop: espaco.sm }}
            />
          )}
        </>
      )}
    </Cartao>
  );
}

const e = StyleSheet.create({
  opcoes: { flexDirection: 'row', gap: espaco.xs, marginTop: espaco.sm },
  opcao: {
    flex: 1,
    paddingVertical: espaco.xs,
    borderRadius: raio.sm,
    borderWidth: 1,
    borderColor: cores.borda,
    alignItems: 'center',
  },
  opcaoAtiva: { backgroundColor: cores.primaria, borderColor: cores.primaria },
  opcaoTexto: { fontSize: fonte.micro, fontWeight: '700', color: cores.textoSuave },
  opcaoTextoAtivo: { color: cores.aoFundoEscuro },
});
