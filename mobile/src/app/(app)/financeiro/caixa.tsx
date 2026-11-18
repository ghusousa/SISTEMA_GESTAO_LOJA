/**
 * Fechamento de caixa: conferir o que o sistema esperava contra o que foi contado.
 * A diferença aparece na tela — esconder um caixa que não bate não resolve nada.
 */

import { useMutation, useQuery } from '@tanstack/react-query';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, View } from 'react-native';

import { mensagemDoErro } from '@/api/client';
import { caixa } from '@/api/endpoints';
import type { FormaPagamento } from '@/api/tipos';
import { Botao, Campo, Carregando, Cartao, ErroEstado } from '@/components/ui';
import { camposDoContado } from '@/lib/caixa';
import { formatar, paraCentavos, paraDecimalString } from '@/lib/money';
import { chaves, queryClient } from '@/lib/queryClient';
import { cores, espaco, fonte } from '@/lib/tema';
import { plural, primeiraMaiuscula } from '@/lib/texto';

const ROTULOS: Record<FormaPagamento, string> = {
  DINHEIRO: 'Dinheiro na gaveta',
  PIX: 'PIX recebido',
  DEBITO: 'Cartão de débito',
  CREDITO: 'Cartão de crédito',
  // Não aparecem na conferência (o caixa só itera formas de gaveta), mas o Record
  // precisa ser completo — e é o TypeScript que garante que ninguém esqueça um caso.
  VALE: 'Vale de troca',
  FIADO: 'Fiado',
};

export default function Caixa() {
  const hoje = format(new Date(), 'yyyy-MM-dd');
  const [contado, setContado] = useState<Record<string, string>>({});
  // As formas em que a pessoa digitou. Ref, e não estado: digitar não precisa refazer o
  // preenchimento, só impedir que o próximo passe por cima.
  const editados = useRef(new Set<string>());

  const dia = useQuery({
    queryKey: chaves.caixaDia(hoje),
    queryFn: () => caixa.dia(hoje),
  });
  const { refetch } = dia;

  // Voltar para a tela traz o esperado de agora. O aviso de tempo real (vendas, caixa) já
  // invalida a consulta, mas aviso se perde — canal caído, aparelho dormindo — e a
  // conferência é o último lugar para confiar num número velho. Sem cancelar a busca que a
  // abertura da tela já disparou.
  useFocusEffect(
    useCallback(() => {
      void refetch({ cancelRefetch: false });
    }, [refetch]),
  );

  // Pré-preenche com o esperado (na maioria dos dias o caixa bate e o admin só confirma) e
  // acompanha o esperado a cada consulta nova nos campos que ninguém mexeu.
  useEffect(() => {
    if (!dia.data) return;
    const linhas = dia.data.linhas;
    setContado((atual) => camposDoContado(linhas, atual, editados.current));
  }, [dia.data]);

  const fechar = useMutation({
    mutationFn: async () => {
      // O esperado de AGORA, e não o da última consulta: uma venda que entrou no último
      // segundo, antes do aviso chegar, virava falta na conferência de quem confirmou direto.
      const { data: agora } = await refetch({ throwOnError: true });
      const linhas = agora?.linhas ?? [];
      const campos = camposDoContado(linhas, contado, editados.current);
      setContado(campos);
      return caixa.fechar({
        data: hoje,
        contagens: linhas.map((linha) => ({
          forma: linha.forma,
          valor_contado: paraDecimalString(paraCentavos(campos[linha.forma] ?? '0')),
        })),
      });
    },
    onSuccess: (fechamento) => {
      void queryClient.invalidateQueries({ queryKey: ['caixa-dia'] });
      const diferenca = paraCentavos(fechamento.diferenca);
      Alert.alert(
        'Caixa fechado',
        diferenca === 0
          ? 'Bateu certinho.'
          : diferenca > 0
            ? `Sobrou ${formatar(diferenca)} em relação ao esperado.`
            : `Faltou ${formatar(Math.abs(diferenca))} em relação ao esperado.`,
      );
    },
    onError: (e) => Alert.alert('Não deu para fechar', mensagemDoErro(e)),
  });

  if (dia.isPending) return <Carregando />;
  if (dia.isError) {
    return (
      <ErroEstado
        mensagem={mensagemDoErro(dia.error, 'Não deu para carregar o caixa.')}
        aoTentarNovamente={() => void dia.refetch()}
      />
    );
  }

  const totalContado = (dia.data.linhas ?? []).reduce(
    (soma, linha) => soma + paraCentavos(contado[linha.forma] ?? '0'),
    0,
  );
  const totalEsperado = paraCentavos(dia.data.total_esperado);
  const diferenca = totalContado - totalEsperado;

  return (
    <ScrollView contentContainerStyle={s.conteudo} keyboardShouldPersistTaps="handled">
      <Cartao>
        <Text style={s.data}>
          {primeiraMaiuscula(
            format(new Date(`${hoje}T12:00:00`), "EEEE, dd 'de' MMMM", { locale: ptBR }),
          )}
        </Text>
        <Text style={s.esperado}>{formatar(totalEsperado)}</Text>
        <Text style={s.ajuda}>
          {plural(dia.data.quantidade_vendas, 'venda concluída', 'vendas concluídas')}
          {dia.data.quantidade_canceladas > 0
            ? ` · ${plural(dia.data.quantidade_canceladas, 'cancelada', 'canceladas')}`
            : ''}
        </Text>
        {dia.data.fechado && (
          <Text style={s.jaFechado}>
            Já fechado hoje — fechar de novo atualiza a conferência.
          </Text>
        )}
      </Cartao>

      {dia.data.linhas.map((linha) => {
        const esperado = paraCentavos(linha.esperado);
        const contadoLinha = paraCentavos(contado[linha.forma] ?? '0');
        const diff = contadoLinha - esperado;
        return (
          <Cartao key={linha.forma}>
            <View style={s.linhaTopo}>
              <Text style={s.forma}>{ROTULOS[linha.forma]}</Text>
              <Text style={s.esperadoLinha}>esperado {formatar(esperado)}</Text>
            </View>
            <Campo
              rotulo="Contado (R$)"
              value={contado[linha.forma] ?? ''}
              onChangeText={(valor) => {
                editados.current.add(linha.forma);
                setContado((atual) => ({ ...atual, [linha.forma]: valor }));
              }}
              keyboardType="decimal-pad"
              placeholder="0,00"
            />
            {diff !== 0 && (
              <Text style={[s.diferenca, diff > 0 ? s.sobra : s.falta]}>
                {diff > 0 ? 'Sobrou' : 'Faltou'} {formatar(Math.abs(diff))}
              </Text>
            )}
          </Cartao>
        );
      })}

      <Cartao>
        <View style={s.totais}>
          <Text style={s.totalRotulo}>Total contado</Text>
          <Text style={s.totalValor}>{formatar(totalContado)}</Text>
        </View>
        <View style={s.totais}>
          <Text style={s.totalRotulo}>Diferença</Text>
          <Text
            style={[
              s.totalValor,
              diferenca === 0 ? s.neutro : diferenca > 0 ? s.sobra : s.falta,
            ]}
          >
            {diferenca > 0 ? '+' : ''}
            {formatar(diferenca)}
          </Text>
        </View>
      </Cartao>

      <Botao
        titulo={dia.data.fechado ? 'Atualizar fechamento' : 'Fechar caixa'}
        grande
        carregando={fechar.isPending}
        onPress={() => fechar.mutate()}
      />
    </ScrollView>
  );
}

const s = StyleSheet.create({
  conteudo: { padding: espaco.lg, paddingBottom: espaco.xxl },
  data: {
    fontSize: fonte.pequena,
    color: cores.textoSuave,
    fontWeight: '700',
  },
  esperado: { fontSize: fonte.destaque, fontWeight: '800', color: cores.texto, marginTop: 2 },
  ajuda: { fontSize: fonte.pequena, color: cores.textoSuave, marginTop: espaco.xs },
  jaFechado: { fontSize: fonte.micro, color: cores.alerta, marginTop: espaco.sm, fontWeight: '600' },

  linhaTopo: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: espaco.sm,
  },
  forma: { fontSize: fonte.base, fontWeight: '700', color: cores.texto },
  esperadoLinha: { fontSize: fonte.pequena, color: cores.textoSuave },
  diferenca: { fontSize: fonte.pequena, fontWeight: '700' },
  sobra: { color: cores.acaoEscura },
  falta: { color: cores.perigo },
  neutro: { color: cores.texto },

  totais: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: espaco.xs },
  totalRotulo: { fontSize: fonte.base, color: cores.textoSuave },
  totalValor: { fontSize: fonte.grande, fontWeight: '800', color: cores.texto },
});
