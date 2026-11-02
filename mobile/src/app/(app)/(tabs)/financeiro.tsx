/**
 * Hub financeiro: a resposta rápida de "como foi o mês" e a porta para o detalhe.
 *
 * A tela é a mesma para dois públicos diferentes. Quem vê dinheiro (dono e gerente) abre
 * no resumo do mês. A supervisora entra pelo mesmo lugar e encontra só o caixa do dia —
 * ela confere o dinheiro que passou pela loja, sem saber o lucro que ficou nele.
 */

import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useQuery } from '@tanstack/react-query';
import { endOfMonth, format, startOfMonth } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { useRouter } from 'expo-router';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';

import { mensagemDoErro } from '@/api/client';
import { relatorios } from '@/api/endpoints';
import { Carregando, Cartao, ErroEstado } from '@/components/ui';
import { formatar, formatarPercentual, paraCentavos } from '@/lib/money';
import { chaves } from '@/lib/queryClient';
import { PODE, pode } from '@/lib/permissoes';
import { cores, espaco, fonte, raio } from '@/lib/tema';
import { useAuthStore } from '@/stores/authStore';

const ATALHOS = [
  { rotulo: 'Despesas', icone: 'receipt', rota: '/financeiro/despesas', pode: PODE.LANCAR_DESPESA },
  { rotulo: 'Relatórios', icone: 'chart-line', rota: '/financeiro/relatorios', pode: PODE.VER_DINHEIRO },
  { rotulo: 'Caixa', icone: 'cash-register', rota: '/financeiro/caixa', pode: PODE.FECHAR_CAIXA },
] as const;

export default function Financeiro() {
  const router = useRouter();
  const papel = useAuthStore((e) => e.usuario?.papel);
  const veDinheiro = pode(papel, PODE.VER_DINHEIRO);
  const atalhos = ATALHOS.filter((a) => pode(papel, a.pode));
  const hoje = new Date();
  const inicio = format(startOfMonth(hoje), 'yyyy-MM-dd');
  const fim = format(endOfMonth(hoje), 'yyyy-MM-dd');

  // `enabled` é o que impede o 403: sem ele a supervisora abriria a aba e dispararia duas
  // consultas de relatório que a API recusa, pintando a tela de erro por nada.
  const resumo = useQuery({
    queryKey: chaves.relatorioResumo(inicio, fim),
    queryFn: () => relatorios.resumo(inicio, fim),
    enabled: veDinheiro,
  });

  // Só o NÚMERO: `size: 1` e o `total` que o servidor conta. Esta consulta refaz a cada
  // venda (aviso de estoque), e baixar a lista inteira para mostrar "N peças" custava
  // 1,5 MB por venda numa loja grande.
  const estoqueBaixo = useQuery({
    queryKey: [...chaves.estoqueBaixo, 'contagem'],
    queryFn: () => relatorios.estoqueBaixo({ size: 1 }),
    enabled: veDinheiro,
  });
  const pecasNoMinimo = estoqueBaixo.data?.total ?? 0;

  if (!veDinheiro) return <SoCaixa atalhos={atalhos} aoAbrir={(rota) => router.push(rota as never)} />;
  if (resumo.isPending) return <Carregando />;
  if (resumo.isError) {
    return (
      <ErroEstado
        mensagem={mensagemDoErro(resumo.error, 'Não deu para carregar o resumo.')}
        aoTentarNovamente={() => void resumo.refetch()}
      />
    );
  }

  const r = resumo.data;
  const resultado = paraCentavos(r.resultado);
  const noVermelho = resultado < 0;

  return (
    <ScrollView
      contentContainerStyle={s.conteudo}
      refreshControl={
        <RefreshControl
          refreshing={resumo.isRefetching}
          onRefresh={() => {
            void resumo.refetch();
            void estoqueBaixo.refetch();
          }}
        />
      }
    >
      <Text style={s.periodo}>{format(hoje, "MMMM 'de' yyyy", { locale: ptBR })}</Text>

      <View style={[s.destaque, noVermelho && s.destaqueVermelho]}>
        <Text style={s.destaqueRotulo}>Resultado do mês</Text>
        <Text style={s.destaqueValor}>{formatar(resultado)}</Text>
        <Text style={s.destaqueAjuda}>
          Faturamento − custo das peças vendidas − despesas
        </Text>
      </View>

      <Cartao>
        <Bloco rotulo="Faturamento" valor={r.faturamento} />
        <Bloco rotulo="Custo das peças vendidas" valor={r.custo_mercadoria_vendida} negativo />
        <Bloco rotulo="Lucro bruto" valor={r.lucro_bruto} forte />
        <Bloco rotulo="Despesas" valor={r.despesas} negativo />
        <View style={s.separador} />
        <View style={s.indicadores}>
          <Indicador rotulo="Vendas" valor={String(r.quantidade_vendas)} />
          <Indicador rotulo="Peças" valor={String(r.quantidade_pecas)} />
          <Indicador rotulo="Ticket médio" valor={formatar(paraCentavos(r.ticket_medio))} />
          <Indicador rotulo="Margem" valor={formatarPercentual(r.margem_bruta_pct)} />
        </View>
      </Cartao>

      {pecasNoMinimo > 0 && (
        <Pressable onPress={() => router.push('/financeiro/relatorios')}>
          <View style={s.alerta}>
            <MaterialCommunityIcons name="alert-circle" size={22} color="#7A5A00" />
            <Text style={s.alertaTexto}>
              {pecasNoMinimo} peça(s) no estoque mínimo — hora de repor
            </Text>
          </View>
        </Pressable>
      )}

      <View style={s.atalhos}>
        {atalhos.map((atalho) => (
          <Pressable
            key={atalho.rota}
            style={s.atalho}
            onPress={() => router.push(atalho.rota as never)}
          >
            <MaterialCommunityIcons name={atalho.icone} size={26} color={cores.primaria} />
            <Text style={s.atalhoTexto}>{atalho.rotulo}</Text>
          </Pressable>
        ))}
      </View>
    </ScrollView>
  );
}

/** O que a supervisora vê ao abrir Financeiro: o caixa, e só. */
function SoCaixa({
  atalhos,
  aoAbrir,
}: {
  atalhos: readonly { rotulo: string; icone: string; rota: string }[];
  aoAbrir: (rota: string) => void;
}) {
  return (
    <ScrollView contentContainerStyle={s.conteudo}>
      <Cartao>
        <Text style={s.soCaixaTitulo}>Caixa do dia</Text>
        <Text style={s.soCaixaTexto}>
          Confira o que passou pela loja hoje e registre o fechamento. Custo, lucro e
          despesas ficam com o dono e o gerente.
        </Text>
      </Cartao>

      <View style={s.atalhos}>
        {atalhos.map((atalho) => (
          <Pressable key={atalho.rota} style={s.atalho} onPress={() => aoAbrir(atalho.rota)}>
            <MaterialCommunityIcons
              name={atalho.icone as never}
              size={26}
              color={cores.primaria}
            />
            <Text style={s.atalhoTexto}>{atalho.rotulo}</Text>
          </Pressable>
        ))}
      </View>
    </ScrollView>
  );
}

function Bloco({
  rotulo,
  valor,
  negativo,
  forte,
}: {
  rotulo: string;
  valor: string;
  negativo?: boolean;
  forte?: boolean;
}) {
  return (
    <View style={s.bloco}>
      <Text style={s.blocoRotulo}>{rotulo}</Text>
      <Text
        style={[
          s.blocoValor,
          negativo && s.blocoNegativo,
          forte && s.blocoForte,
        ]}
      >
        {negativo ? '− ' : ''}
        {formatar(paraCentavos(valor))}
      </Text>
    </View>
  );
}

function Indicador({ rotulo, valor }: { rotulo: string; valor: string }) {
  return (
    <View style={s.indicador}>
      <Text style={s.indicadorValor}>{valor}</Text>
      <Text style={s.indicadorRotulo}>{rotulo}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  soCaixaTitulo: { fontSize: fonte.grande, fontWeight: '800', color: cores.texto },
  soCaixaTexto: {
    fontSize: fonte.base,
    color: cores.textoSuave,
    marginTop: espaco.xs,
    lineHeight: 21,
  },
  conteudo: { padding: espaco.lg, paddingBottom: espaco.xxl },
  periodo: {
    fontSize: fonte.pequena,
    color: cores.textoSuave,
    fontWeight: '700',
    textTransform: 'capitalize',
    marginBottom: espaco.sm,
  },

  destaque: {
    backgroundColor: cores.primaria,
    borderRadius: raio.lg,
    padding: espaco.xl,
    marginBottom: espaco.md,
  },
  destaqueVermelho: { backgroundColor: cores.perigo },
  destaqueRotulo: { color: '#B9CBE0', fontSize: fonte.pequena, fontWeight: '600' },
  destaqueValor: {
    color: cores.aoFundoEscuro,
    fontSize: fonte.destaque,
    fontWeight: '800',
    marginTop: 2,
  },
  destaqueAjuda: { color: '#B9CBE0', fontSize: fonte.micro, marginTop: espaco.xs },

  bloco: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: espaco.sm,
  },
  blocoRotulo: { fontSize: fonte.base, color: cores.textoSuave },
  blocoValor: { fontSize: fonte.media, fontWeight: '700', color: cores.texto },
  blocoNegativo: { color: cores.perigo },
  blocoForte: { fontSize: fonte.grande, fontWeight: '800', color: cores.acaoEscura },

  separador: { height: 1, backgroundColor: cores.borda, marginVertical: espaco.md },
  indicadores: { flexDirection: 'row', justifyContent: 'space-between' },
  indicador: { alignItems: 'center', flex: 1 },
  indicadorValor: { fontSize: fonte.media, fontWeight: '800', color: cores.texto },
  indicadorRotulo: { fontSize: fonte.micro, color: cores.textoFraco, marginTop: 2 },

  alerta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: espaco.sm,
    backgroundColor: cores.alertaFraco,
    borderRadius: raio.md,
    padding: espaco.lg,
    marginBottom: espaco.md,
  },
  alertaTexto: { flex: 1, color: '#7A5A00', fontSize: fonte.base, fontWeight: '600' },

  atalhos: { flexDirection: 'row', gap: espaco.sm },
  atalho: {
    flex: 1,
    backgroundColor: cores.superficie,
    borderRadius: raio.md,
    paddingVertical: espaco.lg,
    alignItems: 'center',
    gap: espaco.xs,
    borderWidth: 1,
    borderColor: cores.borda,
  },
  atalhoTexto: { fontSize: fonte.pequena, fontWeight: '700', color: cores.primaria },
});
