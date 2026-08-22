/**
 * Cobrança: desconto, formas de pagamento (podendo dividir) e confirmação.
 *
 * Toda conta acontece em centavos inteiros. O troco é calculado aqui e não vai para a API:
 * o que o servidor precisa saber é quanto entrou em cada forma, não quanto o cliente deu.
 */

import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { mensagemDoErro, codigoDoErro, detalheDoErro } from '@/api/client';
import { vendas } from '@/api/endpoints';
import type { FormaPagamento } from '@/api/tipos';
import { TecladoNumerico } from '@/components/TecladoNumerico';
import { Botao } from '@/components/ui';
import { formatar, paraDecimalString, percentual, type Centavos } from '@/lib/money';
import { invalidarAposVenda } from '@/lib/queryClient';
import { ALVO_TOQUE, cores, espaco, fonte, raio } from '@/lib/tema';
import { useCartStore } from '@/stores/cartStore';

const FORMAS: { forma: FormaPagamento; rotulo: string }[] = [
  { forma: 'DINHEIRO', rotulo: 'Dinheiro' },
  { forma: 'PIX', rotulo: 'PIX' },
  { forma: 'DEBITO', rotulo: 'Débito' },
  { forma: 'CREDITO', rotulo: 'Crédito' },
];

type Etapa = 'desconto' | 'pagamento';

export default function Pagamento() {
  const router = useRouter();

  const clientUuid = useCartStore((e) => e.clientUuid);
  const itens = useCartStore((e) => e.itens);
  const subtotal = useCartStore((e) => e.subtotal());
  const descontoAtual = useCartStore((e) => e.desconto);
  const definirDesconto = useCartStore((e) => e.definirDesconto);
  const limpar = useCartStore((e) => e.limpar);

  const [etapa, setEtapa] = useState<Etapa>('pagamento');
  const [descontoDigitado, setDescontoDigitado] = useState<Centavos>(descontoAtual);
  const [pagos, setPagos] = useState<{ forma: FormaPagamento; valor: Centavos }[]>([]);
  const [valorDigitado, setValorDigitado] = useState<Centavos>(0);
  const [recebidoDinheiro, setRecebidoDinheiro] = useState<Centavos>(0);
  const [enviando, setEnviando] = useState(false);

  const total = Math.max(0, subtotal - descontoAtual);
  const jaPago = pagos.reduce((soma, p) => soma + p.valor, 0);
  const restante = total - jaPago;
  const troco = Math.max(0, recebidoDinheiro - total);

  function aplicarDesconto() {
    definirDesconto(descontoDigitado);
    setPagos([]);
    setValorDigitado(0);
    setEtapa('pagamento');
  }

  function registrarPagamento(forma: FormaPagamento) {
    // Sem valor digitado, a forma escolhida quita o que falta — o caso de sempre.
    const valor = valorDigitado > 0 ? Math.min(valorDigitado, restante) : restante;
    if (valor <= 0) return;

    void Haptics.selectionAsync();
    if (forma === 'DINHEIRO' && valorDigitado > restante) {
      // Digitou mais que o devido em dinheiro: a diferença é troco, não pagamento a mais.
      setRecebidoDinheiro(valorDigitado);
    }
    setPagos((atuais) => {
      const existente = atuais.find((p) => p.forma === forma);
      return existente
        ? atuais.map((p) => (p.forma === forma ? { ...p, valor: p.valor + valor } : p))
        : [...atuais, { forma, valor }];
    });
    setValorDigitado(0);
  }

  function removerPagamento(forma: FormaPagamento) {
    setPagos((atuais) => atuais.filter((p) => p.forma !== forma));
    if (forma === 'DINHEIRO') setRecebidoDinheiro(0);
  }

  async function confirmar() {
    if (restante !== 0) return;
    setEnviando(true);
    try {
      const venda = await vendas.registrar({
        client_uuid: clientUuid,
        desconto: paraDecimalString(descontoAtual),
        itens: itens.map((i) => ({ variante_id: i.varianteId, quantidade: i.quantidade })),
        pagamentos: pagos.map((p) => ({ forma: p.forma, valor: paraDecimalString(p.valor) })),
      });

      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      invalidarAposVenda();
      limpar();
      router.dismissAll();
      router.push({ pathname: '/venda/[id]', params: { id: String(venda.id) } });
    } catch (erro) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);

      if (codigoDoErro(erro) === 'PAGAMENTO_DIVERGENTE') {
        // O preço mudou no servidor entre o bipe e a cobrança. O total certo vem no erro.
        const detalhe = detalheDoErro(erro);
        Alert.alert(
          'O preço mudou',
          `O total correto agora é ${detalhe?.total_da_venda ?? '—'}. Refaça a cobrança.`,
        );
      } else if (codigoDoErro(erro) === 'ESTOQUE_INSUFICIENTE') {
        Alert.alert(
          'Estoque acabou',
          'Alguma peça do carrinho foi vendida enquanto esta venda era montada. Confira o carrinho.',
        );
      } else {
        Alert.alert('Não deu para concluir', mensagemDoErro(erro));
      }
    } finally {
      setEnviando(false);
    }
  }

  if (etapa === 'desconto') {
    return (
      <View style={s.tela}>
        <View style={s.painel}>
          <Text style={s.painelRotulo}>Desconto na venda</Text>
          <Text style={s.painelValor}>{formatar(descontoDigitado)}</Text>
          <Text style={s.painelAjuda}>Subtotal {formatar(subtotal)}</Text>
        </View>

        <ScrollView contentContainerStyle={s.corpo}>
          <TecladoNumerico
            valor={descontoDigitado}
            aoMudar={(v) => setDescontoDigitado(Math.min(v, subtotal))}
            atalhos={[
              { rotulo: 'Zerar', valor: 0 },
              { rotulo: '5%', valor: percentual(subtotal, 5) },
              { rotulo: '10%', valor: percentual(subtotal, 10) },
            ]}
          />
        </ScrollView>

        <View style={s.rodape}>
          <Botao
            titulo="Voltar"
            variante="secundario"
            estilo={s.metade}
            onPress={() => setEtapa('pagamento')}
          />
          <Botao titulo="Aplicar" estilo={s.metade} onPress={aplicarDesconto} />
        </View>
      </View>
    );
  }

  return (
    <View style={s.tela}>
      <View style={s.painel}>
        <Text style={s.painelRotulo}>
          {restante > 0 ? 'Falta receber' : 'Recebido por completo'}
        </Text>
        <Text style={s.painelValor}>{formatar(restante > 0 ? restante : total)}</Text>
        <View style={s.painelLinha}>
          <Text style={s.painelAjuda}>Total {formatar(total)}</Text>
          {descontoAtual > 0 && (
            <Text style={s.painelAjuda}>Desconto {formatar(descontoAtual)}</Text>
          )}
        </View>
      </View>

      <ScrollView contentContainerStyle={s.corpo} keyboardShouldPersistTaps="handled">
        {pagos.length > 0 && (
          <View style={s.pagos}>
            {pagos.map((p) => (
              <Pressable
                key={p.forma}
                style={s.pagoItem}
                onPress={() => removerPagamento(p.forma)}
              >
                <Text style={s.pagoForma}>
                  {FORMAS.find((f) => f.forma === p.forma)?.rotulo}
                </Text>
                <Text style={s.pagoValor}>{formatar(p.valor)}</Text>
                <Text style={s.pagoRemover}>remover</Text>
              </Pressable>
            ))}
            {troco > 0 && (
              <View style={[s.pagoItem, s.trocoItem]}>
                <Text style={s.trocoRotulo}>Troco</Text>
                <Text style={s.trocoValor}>{formatar(troco)}</Text>
              </View>
            )}
          </View>
        )}

        {restante > 0 && (
          <>
            <Text style={s.instrucao}>
              {valorDigitado > 0
                ? `Receber ${formatar(valorDigitado)} em:`
                : 'Toque na forma que quitou a venda, ou digite um valor para dividir'}
            </Text>

            <View style={s.formas}>
              {FORMAS.map(({ forma, rotulo }) => (
                <Pressable
                  key={forma}
                  style={({ pressed }) => [s.forma, pressed && s.formaPressionada]}
                  onPress={() => registrarPagamento(forma)}
                >
                  <Text style={s.formaTexto}>{rotulo}</Text>
                </Pressable>
              ))}
            </View>

            <View style={s.valorDigitado}>
              <Text style={s.valorDigitadoRotulo}>Valor parcial</Text>
              <Text style={s.valorDigitadoValor}>{formatar(valorDigitado)}</Text>
            </View>

            <TecladoNumerico
              valor={valorDigitado}
              aoMudar={setValorDigitado}
              atalhos={[
                { rotulo: 'Limpar', valor: 0 },
                { rotulo: `Metade ${formatar(Math.floor(restante / 2))}`, valor: Math.floor(restante / 2) },
                { rotulo: `Tudo ${formatar(restante)}`, valor: restante },
              ]}
            />
          </>
        )}
      </ScrollView>

      <View style={s.rodape}>
        <Botao
          titulo="Desconto"
          variante="secundario"
          estilo={s.metade}
          onPress={() => {
            setDescontoDigitado(descontoAtual);
            setEtapa('desconto');
          }}
        />
        <Botao
          titulo={restante === 0 ? 'Confirmar venda' : 'Falta receber'}
          variante="acao"
          estilo={s.metade}
          desabilitado={restante !== 0}
          carregando={enviando}
          onPress={() => void confirmar()}
        />
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  tela: { flex: 1, backgroundColor: cores.fundo },

  painel: {
    backgroundColor: cores.primaria,
    paddingHorizontal: espaco.lg,
    paddingVertical: espaco.lg,
  },
  painelRotulo: { color: '#B9CBE0', fontSize: fonte.pequena, fontWeight: '600' },
  painelValor: {
    color: cores.aoFundoEscuro,
    fontSize: fonte.destaque,
    fontWeight: '800',
    marginTop: 2,
  },
  painelLinha: { flexDirection: 'row', gap: espaco.lg, marginTop: espaco.xs },
  painelAjuda: { color: '#B9CBE0', fontSize: fonte.pequena },

  corpo: { padding: espaco.lg, gap: espaco.md, paddingBottom: espaco.xxl },

  pagos: { gap: espaco.sm, marginBottom: espaco.sm },
  pagoItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: cores.sucessoFraco,
    borderRadius: raio.md,
    paddingHorizontal: espaco.lg,
    minHeight: ALVO_TOQUE,
  },
  pagoForma: { fontSize: fonte.base, fontWeight: '700', color: cores.acaoEscura },
  pagoValor: { fontSize: fonte.media, fontWeight: '800', color: cores.acaoEscura },
  pagoRemover: { fontSize: fonte.micro, color: cores.perigo },
  trocoItem: { backgroundColor: cores.alertaFraco },
  trocoRotulo: { fontSize: fonte.base, fontWeight: '700', color: '#7A5A00' },
  trocoValor: { fontSize: fonte.grande, fontWeight: '800', color: '#7A5A00' },

  instrucao: { fontSize: fonte.base, color: cores.textoSuave, fontWeight: '600' },

  formas: { flexDirection: 'row', flexWrap: 'wrap', gap: espaco.sm },
  forma: {
    width: '48%',
    minHeight: 56,
    borderRadius: raio.md,
    backgroundColor: cores.primariaFraca,
    alignItems: 'center',
    justifyContent: 'center',
  },
  formaPressionada: { backgroundColor: cores.bordaForte },
  formaTexto: { fontSize: fonte.media, fontWeight: '700', color: cores.primaria },

  valorDigitado: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingTop: espaco.sm,
  },
  valorDigitadoRotulo: { fontSize: fonte.pequena, color: cores.textoSuave },
  valorDigitadoValor: { fontSize: fonte.grande, fontWeight: '800', color: cores.texto },

  rodape: {
    flexDirection: 'row',
    gap: espaco.sm,
    padding: espaco.lg,
    backgroundColor: cores.superficie,
    borderTopWidth: 1,
    borderTopColor: cores.borda,
  },
  metade: { flex: 1 },
});
