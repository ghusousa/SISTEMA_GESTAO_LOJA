/**
 * Contas a pagar do fornecedor (ADR-40). Espelho de `web/js/views/contas-pagar.js`.
 *
 * **Não é despesa e não entra no Resultado**: a mercadoria já entra pelo CMV quando a peça
 * é vendida. Aqui é o calendário de saída de dinheiro — o topo é o aviso do que venceu e
 * do que vence na semana (`/contas-pagar/resumo`). A nota nasce na Entrada de mercadoria.
 */

import { FlashList } from '@shopify/flash-list';
import { useInfiniteQuery, useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Alert, Modal, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';

import { mensagemDoErro } from '@/api/client';
import { contasPagar } from '@/api/endpoints';
import type { ContaPagar, FiltroContas, FormaPagamentoConta } from '@/api/tipos';
import { Botao, Carregando, ErroEstado, Etiqueta, Vazio } from '@/components/ui';
import { formatar, paraCentavos } from '@/lib/money';
import { chaves, queryClient } from '@/lib/queryClient';
import { cores, espaco, fonte, raio } from '@/lib/tema';

const ABAS: { rotulo: string; filtro: FiltroContas }[] = [
  { rotulo: 'Abertas', filtro: 'abertas' },
  { rotulo: 'Vencidas', filtro: 'vencidas' },
  { rotulo: '7 dias', filtro: 'proximos_7_dias' },
  { rotulo: 'Pagas', filtro: 'pagas' },
];

const FORMAS: { forma: FormaPagamentoConta; rotulo: string }[] = [
  { forma: 'BOLETO', rotulo: 'Boleto' },
  { forma: 'PIX', rotulo: 'PIX' },
  { forma: 'TRANSFERENCIA', rotulo: 'Transferência' },
  { forma: 'DINHEIRO', rotulo: 'Dinheiro' },
  { forma: 'CARTAO', rotulo: 'Cartão' },
];

const dia = (iso: string) => iso.split('-').reverse().join('/');

export default function ContasPagar() {
  const [filtro, setFiltro] = useState<FiltroContas>('abertas');
  const [pagando, setPagando] = useState<ContaPagar | null>(null);

  const resumo = useQuery({ queryKey: [...chaves.contasPagar, 'resumo'], queryFn: contasPagar.resumo });
  const consulta = useInfiniteQuery({
    queryKey: [...chaves.contasPagar, filtro],
    initialPageParam: 1,
    queryFn: ({ pageParam }) => contasPagar.listar({ situacao: filtro, page: pageParam, size: 25 }),
    getNextPageParam: (u) => (u.page * u.size < u.total ? u.page + 1 : undefined),
  });
  const lista = consulta.data?.pages.flatMap((p) => p.items) ?? [];

  const pagar = useMutation({
    mutationFn: (dados: { id: number; forma: FormaPagamentoConta }) =>
      contasPagar.pagar(dados.id, { forma: dados.forma }),
    onSuccess: () => {
      setPagando(null);
      void queryClient.invalidateQueries({ queryKey: chaves.contasPagar });
    },
    onError: (erro) => Alert.alert('Não deu para marcar como paga', mensagemDoErro(erro)),
  });
  const desfazer = useMutation({
    mutationFn: (id: number) => contasPagar.desfazerPagamento(id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: chaves.contasPagar }),
    onError: (erro) => Alert.alert('Não deu para desfazer', mensagemDoErro(erro)),
  });

  const r = resumo.data;
  return (
    <View style={s.tela}>
      {r && (
        <View style={s.cartoes}>
          <Indicador rotulo="Vencidas" valor={r.vencidas.valor} nota={`${r.vencidas.quantidade} sem pagar`} alerta={r.vencidas.quantidade > 0} />
          <Indicador rotulo="Próximos 7 dias" valor={r.proximos_7_dias.valor} nota={`${r.proximos_7_dias.quantidade} a pagar`} />
          <Indicador rotulo="Em aberto" valor={r.em_aberto.valor} nota={`${r.em_aberto.quantidade} parcelas`} />
        </View>
      )}
      <Text style={s.aviso}>Não entra no Resultado: a mercadoria já entra pelo custo das peças vendidas.</Text>
      <View style={s.abas}>
        {ABAS.map((a) => (
          <Pressable key={a.filtro} onPress={() => setFiltro(a.filtro)} style={[s.aba, filtro === a.filtro && s.abaAtiva]}>
            <Text style={[s.abaTexto, filtro === a.filtro && s.abaTextoAtiva]}>{a.rotulo}</Text>
          </Pressable>
        ))}
      </View>

      {consulta.isPending ? (
        <Carregando />
      ) : consulta.isError ? (
        <ErroEstado mensagem={mensagemDoErro(consulta.error)} aoTentarNovamente={() => void consulta.refetch()} />
      ) : lista.length === 0 ? (
        <Vazio titulo="Nenhuma conta aqui" descricao="A nota do fornecedor entra pela Entrada de mercadoria." />
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
              onRefresh={() => {
                void consulta.refetch();
                void resumo.refetch();
              }}
            />
          }
          renderItem={({ item: c }) => (
            <View style={s.linha}>
              <View style={{ flex: 1 }}>
                <Text style={s.nome} numberOfLines={1}>{c.fornecedor}</Text>
                <Text style={s.detalhe} numberOfLines={1}>
                  {c.descricao}{c.parcelas > 1 ? ` · ${c.parcela}/${c.parcelas}` : ''}{c.numero_nota ? ` · ${c.numero_nota}` : ''}
                </Text>
                <Text style={s.detalhe}>
                  {c.situacao === 'PAGA' ? `paga em ${dia(c.paga_em ?? '')}` : `vence ${dia(c.vencimento)}`}
                </Text>
              </View>
              <View style={{ alignItems: 'flex-end', gap: espaco.xs }}>
                <Text style={s.valor}>{formatar(paraCentavos(c.valor))}</Text>
                {c.situacao === 'PAGA' ? (
                  <Pressable onPress={() => desfazer.mutate(c.id)}>
                    <Text style={s.acao}>desfazer</Text>
                  </Pressable>
                ) : (
                  <Pressable onPress={() => setPagando(c)}>
                    <Etiqueta
                      texto={c.situacao === 'VENCIDA' ? 'vencida · pagar' : 'pagar'}
                      cor={c.situacao === 'VENCIDA' ? cores.perigoFraco : cores.primariaFraca}
                      corTexto={c.situacao === 'VENCIDA' ? cores.perigo : cores.primaria}
                    />
                  </Pressable>
                )}
              </View>
            </View>
          )}
        />
      )}

      <Modal visible={!!pagando} transparent animationType="fade" onRequestClose={() => setPagando(null)}>
        <View style={s.fundo}>
          <View style={s.caixa}>
            <Text style={s.nome}>
              Pagar {pagando ? formatar(paraCentavos(pagando.valor)) : ''} — {pagando?.fornecedor}
            </Text>
            <Text style={s.detalhe}>Marca como paga hoje. Pagar em dinheiro aqui não tira da conferência do caixa.</Text>
            {FORMAS.map((f) => (
              <Botao
                key={f.forma}
                titulo={f.rotulo}
                variante="secundario"
                carregando={pagar.isPending && pagar.variables?.forma === f.forma}
                onPress={() => pagando && pagar.mutate({ id: pagando.id, forma: f.forma })}
              />
            ))}
            <Botao titulo="Cancelar" variante="texto" onPress={() => setPagando(null)} />
          </View>
        </View>
      </Modal>
    </View>
  );
}

function Indicador({ rotulo, valor, nota, alerta }: { rotulo: string; valor: string; nota: string; alerta?: boolean }) {
  return (
    <View style={[s.indicador, alerta && { backgroundColor: cores.perigoFraco }]}>
      <Text style={s.detalhe}>{rotulo}</Text>
      <Text style={[s.valor, alerta && { color: cores.perigo }]}>{formatar(paraCentavos(valor))}</Text>
      <Text style={s.detalhe}>{nota}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  tela: { flex: 1, backgroundColor: cores.fundo },
  cartoes: { flexDirection: 'row', gap: espaco.sm, padding: espaco.md, paddingBottom: 0 },
  indicador: { flex: 1, backgroundColor: cores.superficie, borderRadius: raio.md, padding: espaco.sm },
  aviso: { fontSize: fonte.micro, color: cores.textoSuave, paddingHorizontal: espaco.md, paddingTop: espaco.sm },
  abas: { flexDirection: 'row', gap: espaco.sm, padding: espaco.md },
  aba: { paddingHorizontal: espaco.md, paddingVertical: espaco.sm, borderRadius: raio.redondo, backgroundColor: cores.superficie, borderWidth: 1, borderColor: cores.borda },
  abaAtiva: { backgroundColor: cores.primaria, borderColor: cores.primaria },
  abaTexto: { fontSize: fonte.pequena, fontWeight: '700', color: cores.textoSuave },
  abaTextoAtiva: { color: cores.aoFundoEscuro },
  lista: { paddingHorizontal: espaco.md, paddingBottom: espaco.xl },
  linha: { flexDirection: 'row', gap: espaco.md, backgroundColor: cores.superficie, borderRadius: raio.md, padding: espaco.lg, marginBottom: espaco.sm },
  nome: { fontSize: fonte.base, fontWeight: '700', color: cores.texto },
  detalhe: { fontSize: fonte.pequena, color: cores.textoSuave, marginTop: 2 },
  valor: { fontSize: fonte.base, fontWeight: '800', color: cores.texto },
  acao: { fontSize: fonte.pequena, fontWeight: '700', color: cores.primaria },
  fundo: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'center', padding: espaco.xl },
  caixa: { backgroundColor: cores.superficie, borderRadius: raio.lg, padding: espaco.xl, gap: espaco.sm },
});
