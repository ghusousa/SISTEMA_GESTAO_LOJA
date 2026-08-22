/**
 * Relatórios do período: curva de vendas, campeões de venda, para onde o dinheiro foi
 * e o que precisa repor. Gráfico é barra desenhada com View — evita uma biblioteca
 * inteira de charts para mostrar sete a trinta e um números.
 */

import { useQuery } from '@tanstack/react-query';
import { endOfMonth, format, startOfMonth, subDays } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { mensagemDoErro } from '@/api/client';
import { relatorios } from '@/api/endpoints';
import { Carregando, Cartao, ErroEstado, Etiqueta } from '@/components/ui';
import { formatar, formatarPercentual, paraCentavos } from '@/lib/money';
import { chaves } from '@/lib/queryClient';
import { cores, espaco, fonte, raio } from '@/lib/tema';

type Periodo = '7d' | '30d' | 'mes';

function intervalo(periodo: Periodo): { inicio: string; fim: string; rotulo: string } {
  const hoje = new Date();
  if (periodo === 'mes') {
    return {
      inicio: format(startOfMonth(hoje), 'yyyy-MM-dd'),
      fim: format(endOfMonth(hoje), 'yyyy-MM-dd'),
      rotulo: format(hoje, "MMMM 'de' yyyy", { locale: ptBR }),
    };
  }
  const dias = periodo === '7d' ? 6 : 29;
  return {
    inicio: format(subDays(hoje, dias), 'yyyy-MM-dd'),
    fim: format(hoje, 'yyyy-MM-dd'),
    rotulo: `Últimos ${dias + 1} dias`,
  };
}

export default function Relatorios() {
  const [periodo, setPeriodo] = useState<Periodo>('30d');
  const { inicio, fim, rotulo } = intervalo(periodo);

  const porDia = useQuery({
    queryKey: chaves.relatorioVendasDia(inicio, fim),
    queryFn: () => relatorios.vendasPorDia(inicio, fim),
  });
  const maisVendidos = useQuery({
    queryKey: chaves.relatorioMaisVendidos(inicio, fim),
    queryFn: () => relatorios.maisVendidos(inicio, fim, 8),
  });
  const porCategoria = useQuery({
    queryKey: chaves.relatorioDespesas(inicio, fim),
    queryFn: () => relatorios.despesasPorCategoria(inicio, fim),
  });
  const estoqueBaixo = useQuery({
    queryKey: chaves.estoqueBaixo,
    queryFn: () => relatorios.estoqueBaixo(),
  });

  if (porDia.isPending) return <Carregando />;
  if (porDia.isError) {
    return (
      <ErroEstado
        mensagem={mensagemDoErro(porDia.error, 'Não deu para carregar os relatórios.')}
        aoTentarNovamente={() => void porDia.refetch()}
      />
    );
  }

  const serie = porDia.data;
  const maiorFaturamento = Math.max(...serie.map((d) => paraCentavos(d.faturamento)), 1);

  return (
    <ScrollView contentContainerStyle={s.conteudo}>
      <View style={s.periodos}>
        {(['7d', '30d', 'mes'] as Periodo[]).map((p) => (
          <Pressable
            key={p}
            onPress={() => setPeriodo(p)}
            style={[s.periodo, periodo === p && s.periodoAtivo]}
          >
            <Text style={[s.periodoTexto, periodo === p && s.periodoTextoAtivo]}>
              {p === '7d' ? '7 dias' : p === '30d' ? '30 dias' : 'Este mês'}
            </Text>
          </Pressable>
        ))}
      </View>

      <Cartao>
        <Text style={s.titulo}>Vendas por dia</Text>
        <Text style={s.subtitulo}>{rotulo}</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.grafico}>
          <View style={s.barras}>
            {serie.map((dia) => {
              const valor = paraCentavos(dia.faturamento);
              const altura = Math.max((valor / maiorFaturamento) * 120, valor > 0 ? 4 : 2);
              return (
                <View key={dia.data} style={s.barraColuna}>
                  <Text style={s.barraValor}>
                    {valor > 0 ? Math.round(valor / 100) : ''}
                  </Text>
                  <View
                    style={[
                      s.barra,
                      { height: altura },
                      valor === 0 && s.barraVazia,
                    ]}
                  />
                  <Text style={s.barraRotulo}>
                    {format(new Date(`${dia.data}T12:00:00`), 'dd')}
                  </Text>
                </View>
              );
            })}
          </View>
        </ScrollView>
        <Text style={s.legenda}>Valores em reais (sem centavos)</Text>
      </Cartao>

      <Cartao>
        <Text style={s.titulo}>Mais vendidos</Text>
        {(maisVendidos.data?.length ?? 0) === 0 ? (
          <Text style={s.vazio}>Nenhuma venda no período.</Text>
        ) : (
          maisVendidos.data!.map((item, indice) => (
            <View key={item.variante_id} style={s.linha}>
              <Text style={s.posicao}>{indice + 1}</Text>
              <View style={s.linhaInfo}>
                <Text style={s.linhaNome} numberOfLines={1}>
                  {item.produto}
                </Text>
                <Text style={s.linhaDetalhe}>
                  {item.tamanho} · {item.cor}
                </Text>
              </View>
              <View style={s.linhaNumeros}>
                <Text style={s.linhaQuantidade}>{item.quantidade}x</Text>
                <Text style={s.linhaLucro}>
                  lucro {formatar(paraCentavos(item.lucro_bruto))}
                </Text>
              </View>
            </View>
          ))
        )}
      </Cartao>

      <Cartao>
        <Text style={s.titulo}>Para onde o dinheiro foi</Text>
        {(porCategoria.data?.length ?? 0) === 0 ? (
          <Text style={s.vazio}>Nenhuma despesa no período.</Text>
        ) : (
          porCategoria.data!.map((c) => (
            <View key={c.categoria_id} style={s.categoria}>
              <View style={s.categoriaTopo}>
                <Text style={s.categoriaNome}>{c.categoria}</Text>
                <Text style={s.categoriaValor}>{formatar(paraCentavos(c.total))}</Text>
              </View>
              <View style={s.barraFundo}>
                <View style={[s.barraProgresso, { width: `${Number(c.percentual)}%` }]} />
              </View>
              <Text style={s.categoriaPct}>{formatarPercentual(c.percentual)} das despesas</Text>
            </View>
          ))
        )}
      </Cartao>

      <Cartao>
        <Text style={s.titulo}>Hora de repor</Text>
        {(estoqueBaixo.data?.length ?? 0) === 0 ? (
          <Text style={s.vazio}>Todo o estoque está acima do mínimo.</Text>
        ) : (
          estoqueBaixo.data!.map((peca) => (
            <View key={peca.variante_id} style={s.linha}>
              <View style={s.linhaInfo}>
                <Text style={s.linhaNome} numberOfLines={1}>
                  {peca.produto}
                </Text>
                <Text style={s.linhaDetalhe}>
                  {peca.tamanho} · {peca.cor} · mínimo {peca.estoque_minimo}
                </Text>
              </View>
              <Etiqueta
                texto={peca.saldo === 0 ? 'zerado' : `restam ${peca.saldo}`}
                cor={peca.saldo === 0 ? cores.perigoFraco : cores.alertaFraco}
                corTexto={peca.saldo === 0 ? cores.perigo : '#7A5A00'}
              />
            </View>
          ))
        )}
      </Cartao>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  conteudo: { padding: espaco.lg, paddingBottom: espaco.xxl },

  periodos: { flexDirection: 'row', gap: espaco.sm, marginBottom: espaco.md },
  periodo: {
    flex: 1,
    paddingVertical: espaco.sm,
    borderRadius: raio.md,
    backgroundColor: cores.superficie,
    borderWidth: 1,
    borderColor: cores.borda,
    alignItems: 'center',
  },
  periodoAtivo: { backgroundColor: cores.primaria, borderColor: cores.primaria },
  periodoTexto: { fontSize: fonte.pequena, fontWeight: '700', color: cores.textoSuave },
  periodoTextoAtivo: { color: cores.aoFundoEscuro },

  titulo: { fontSize: fonte.media, fontWeight: '700', color: cores.texto },
  subtitulo: {
    fontSize: fonte.pequena,
    color: cores.textoSuave,
    textTransform: 'capitalize',
    marginBottom: espaco.md,
  },
  vazio: { fontSize: fonte.base, color: cores.textoFraco, marginTop: espaco.sm },

  grafico: { marginTop: espaco.sm },
  barras: { flexDirection: 'row', alignItems: 'flex-end', gap: espaco.xs },
  barraColuna: { alignItems: 'center', width: 30 },
  barra: { width: 18, backgroundColor: cores.primaria, borderRadius: 4 },
  barraVazia: { backgroundColor: cores.borda },
  barraValor: { fontSize: 9, color: cores.textoSuave, marginBottom: 2 },
  barraRotulo: { fontSize: 9, color: cores.textoFraco, marginTop: 4 },
  legenda: { fontSize: fonte.micro, color: cores.textoFraco, marginTop: espaco.sm },

  linha: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: espaco.md,
    paddingVertical: espaco.sm,
  },
  posicao: { fontSize: fonte.media, fontWeight: '800', color: cores.textoFraco, width: 20 },
  linhaInfo: { flex: 1 },
  linhaNome: { fontSize: fonte.base, fontWeight: '600', color: cores.texto },
  linhaDetalhe: { fontSize: fonte.micro, color: cores.textoSuave, marginTop: 2 },
  linhaNumeros: { alignItems: 'flex-end' },
  linhaQuantidade: { fontSize: fonte.media, fontWeight: '800', color: cores.texto },
  linhaLucro: { fontSize: fonte.micro, color: cores.acaoEscura },

  categoria: { marginTop: espaco.md },
  categoriaTopo: { flexDirection: 'row', justifyContent: 'space-between' },
  categoriaNome: { fontSize: fonte.base, fontWeight: '600', color: cores.texto },
  categoriaValor: { fontSize: fonte.base, fontWeight: '800', color: cores.texto },
  barraFundo: {
    height: 8,
    backgroundColor: cores.superficieAlt,
    borderRadius: 4,
    marginTop: espaco.xs,
    overflow: 'hidden',
  },
  barraProgresso: { height: 8, backgroundColor: cores.perigo, borderRadius: 4 },
  categoriaPct: { fontSize: fonte.micro, color: cores.textoFraco, marginTop: 2 },
});
