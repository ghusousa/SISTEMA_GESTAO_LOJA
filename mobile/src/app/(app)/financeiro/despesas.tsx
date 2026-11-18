import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useMutation, useQuery } from '@tanstack/react-query';
import { endOfMonth, format, startOfMonth } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { useRouter } from 'expo-router';
import { Alert, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';

import { mensagemDoErro } from '@/api/client';
import { despesas } from '@/api/endpoints';
import { Botao, Carregando, ErroEstado, Etiqueta, useRespiroDeBaixo, Vazio } from '@/components/ui';
import { formatar, paraCentavos } from '@/lib/money';
import { chaves, invalidarAposDespesa, queryClient } from '@/lib/queryClient';
import { cores, espaco, fonte, raio } from '@/lib/tema';
import { primeiraMaiuscula } from '@/lib/texto';

export default function Despesas() {
  const router = useRouter();
  // O botão flutuante encosta na base da tela: no Face ID ele sobe do indicador de início,
  // e a lista ganha o mesmo tanto para a última despesa não ficar embaixo dele.
  const respiroDeBaixo = useRespiroDeBaixo();
  const hoje = new Date();
  const inicio = format(startOfMonth(hoje), 'yyyy-MM-dd');
  const fim = format(endOfMonth(hoje), 'yyyy-MM-dd');
  const competencia = format(hoje, 'yyyy-MM');

  const consulta = useQuery({
    queryKey: [...chaves.despesas, inicio, fim],
    queryFn: () => despesas.listar({ inicio, fim, size: 100 }),
  });

  const replicar = useMutation({
    mutationFn: () => despesas.replicarRecorrentes(competencia),
    onSuccess: (resultado) => {
      invalidarAposDespesa();
      Alert.alert(
        'Contas fixas do mês',
        resultado.criadas === 0
          ? 'Todas as contas fixas já estavam lançadas neste mês.'
          : `${resultado.criadas} conta(s) lançada(s), somando ${formatar(paraCentavos(resultado.valor_total))}.`,
      );
    },
    onError: (e) => Alert.alert('Não deu para replicar', mensagemDoErro(e)),
  });

  const excluir = useMutation({
    mutationFn: (id: number) => despesas.excluir(id),
    onSuccess: () => invalidarAposDespesa(),
    onError: (e) => Alert.alert('Não deu para excluir', mensagemDoErro(e)),
  });

  if (consulta.isPending) return <Carregando />;
  if (consulta.isError) {
    return (
      <ErroEstado
        mensagem={mensagemDoErro(consulta.error, 'Não deu para carregar as despesas.')}
        aoTentarNovamente={() => void consulta.refetch()}
      />
    );
  }

  const lista = consulta.data.items;
  const total = lista.reduce((soma, d) => soma + paraCentavos(d.valor), 0);

  return (
    <View style={s.tela}>
      <ScrollView
        contentContainerStyle={[s.conteudo, { paddingBottom: respiroDeBaixo + 80 }]}
        refreshControl={
          <RefreshControl
            refreshing={consulta.isRefetching}
            onRefresh={() => void consulta.refetch()}
          />
        }
      >
        <View style={s.cabecalho}>
          <View>
            <Text style={s.mes}>
              {primeiraMaiuscula(format(hoje, "MMMM 'de' yyyy", { locale: ptBR }))}
            </Text>
            <Text style={s.total}>{formatar(total)}</Text>
          </View>
          <Botao
            titulo="Lançar fixas"
            variante="secundario"
            carregando={replicar.isPending}
            onPress={() => replicar.mutate()}
          />
        </View>

        {lista.length === 0 ? (
          <Vazio
            titulo="Nenhuma despesa neste mês"
            descricao="Lance aluguel, energia, fornecedores e o que mais sai do caixa."
          />
        ) : (
          lista.map((despesa) => (
            <Pressable
              key={despesa.id}
              style={s.item}
              onLongPress={() =>
                Alert.alert('Excluir despesa?', despesa.descricao, [
                  { text: 'Voltar', style: 'cancel' },
                  {
                    text: 'Excluir',
                    style: 'destructive',
                    onPress: () => excluir.mutate(despesa.id),
                  },
                ])
              }
            >
              <View style={s.itemInfo}>
                <Text style={s.itemDescricao} numberOfLines={1}>
                  {despesa.descricao}
                </Text>
                <Text style={s.itemDetalhe}>
                  {despesa.categoria} ·{' '}
                  {format(new Date(`${despesa.data}T12:00:00`), 'dd/MM')}
                </Text>
              </View>
              <View style={s.itemDireita}>
                <Text style={s.itemValor}>{formatar(paraCentavos(despesa.valor))}</Text>
                {despesa.recorrente && (
                  <Etiqueta texto="fixa" cor={cores.primariaFraca} corTexto={cores.primaria} />
                )}
              </View>
            </Pressable>
          ))
        )}

        {lista.length > 0 && (
          <Text style={s.dica}>Segure em uma despesa para excluir.</Text>
        )}
      </ScrollView>

      <Pressable
        style={[s.botaoFlutuante, { bottom: respiroDeBaixo }]}
        onPress={() => router.push('/financeiro/despesa-nova')}
        accessibilityLabel="Nova despesa"
      >
        <MaterialCommunityIcons name="plus" size={30} color={cores.aoFundoEscuro} />
      </Pressable>
    </View>
  );
}

const s = StyleSheet.create({
  tela: { flex: 1, backgroundColor: cores.fundo },
  conteudo: { padding: espaco.lg },

  cabecalho: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: espaco.lg,
    gap: espaco.md,
  },
  mes: {
    fontSize: fonte.pequena,
    color: cores.textoSuave,
    fontWeight: '700',
  },
  total: { fontSize: fonte.titulo, fontWeight: '800', color: cores.perigo },

  item: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: cores.superficie,
    borderRadius: raio.md,
    padding: espaco.lg,
    marginBottom: espaco.sm,
    gap: espaco.md,
  },
  itemInfo: { flex: 1 },
  itemDescricao: { fontSize: fonte.base, fontWeight: '700', color: cores.texto },
  itemDetalhe: { fontSize: fonte.pequena, color: cores.textoSuave, marginTop: 2 },
  itemDireita: { alignItems: 'flex-end', gap: espaco.xs },
  itemValor: { fontSize: fonte.media, fontWeight: '800', color: cores.texto },

  dica: {
    fontSize: fonte.micro,
    color: cores.textoFraco,
    textAlign: 'center',
    marginTop: espaco.md,
  },

  botaoFlutuante: {
    position: 'absolute',
    right: espaco.lg,
    bottom: espaco.lg,
    width: 60,
    height: 60,
    borderRadius: raio.redondo,
    backgroundColor: cores.acao,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 5,
  },
});
