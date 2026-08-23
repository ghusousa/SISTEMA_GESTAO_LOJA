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
import type { Cliente, FormaPagamento } from '@/api/tipos';
import { ModalCliente, ModalVale, type ValeEscolhido } from '@/components/PagarValeFiado';
import { TecladoNumerico } from '@/components/TecladoNumerico';
import { Botao } from '@/components/ui';
import {
  formatar,
  paraCentavos,
  paraDecimalString,
  percentual,
  type Centavos,
} from '@/lib/money';
import { PODE, pode } from '@/lib/permissoes';
import { invalidarAposVenda } from '@/lib/queryClient';
import { ALVO_TOQUE, cores, espaco, fonte, raio } from '@/lib/tema';
import { useAuthStore } from '@/stores/authStore';
import { useCartStore } from '@/stores/cartStore';

const FORMAS: { forma: FormaPagamento; rotulo: string }[] = [
  { forma: 'DINHEIRO', rotulo: 'Dinheiro' },
  { forma: 'PIX', rotulo: 'PIX' },
  { forma: 'DEBITO', rotulo: 'Débito' },
  { forma: 'CREDITO', rotulo: 'Crédito' },
  { forma: 'VALE', rotulo: 'Vale de troca' },
  { forma: 'FIADO', rotulo: 'Fiado' },
];

/** Um pagamento montado na tela. `codigoVale` só existe na linha do VALE. */
interface Pagamento {
  forma: FormaPagamento;
  valor: Centavos;
  codigoVale?: string;
}

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
  const [pagos, setPagos] = useState<Pagamento[]>([]);
  const [valorDigitado, setValorDigitado] = useState<Centavos>(0);
  const [recebidoDinheiro, setRecebidoDinheiro] = useState<Centavos>(0);
  const [enviando, setEnviando] = useState(false);
  // Quem responde pelo fiado. Sem cliente não existe dívida a cobrar depois — por isso a
  // forma FIADO só entra na lista depois que alguém foi escolhido.
  const [cliente, setCliente] = useState<Cliente | null>(null);
  const [perguntandoVale, setPerguntandoVale] = useState(false);
  const [perguntandoCliente, setPerguntandoCliente] = useState(false);
  // Fiado só para quem cuida do crediário: sem a capacidade, a busca de cliente responde
  // 403 e a vendedora fica travada com a cliente na frente — o caminho de volta para o
  // papel. O vale continua para todos: conferir o papel na mão da cliente é do balcão.
  const podeFiado = pode(useAuthStore((e) => e.usuario?.papel), PODE.GERIR_CREDIARIO);
  const formas = podeFiado ? FORMAS : FORMAS.filter((f) => f.forma !== 'FIADO');

  const total = Math.max(0, subtotal - descontoAtual);
  const jaPago = pagos.reduce((soma, p) => soma + p.valor, 0);
  const restante = total - jaPago;
  // Troco é o que sobrou DO DINHEIRO, não da venda: numa venda de R$ 100 paga com R$ 40 no
  // PIX e uma nota de R$ 100, o troco é R$ 40 — comparar a nota com o total daria zero.
  const dinheiroAplicado = pagos.find((p) => p.forma === 'DINHEIRO')?.valor ?? 0;
  const troco = Math.max(0, recebidoDinheiro - dinheiroAplicado);

  function aplicarDesconto() {
    definirDesconto(descontoDigitado);
    // Mudou o total: a divisão montada antes não vale mais, e o fiado ia junto com ela.
    setPagos([]);
    setCliente(null);
    setRecebidoDinheiro(0);
    setValorDigitado(0);
    setEtapa('pagamento');
  }

  /** Quanto esta forma vai cobrir: o digitado, ou tudo que falta — o caso de sempre. */
  function valorPretendido() {
    return valorDigitado > 0 ? Math.min(valorDigitado, restante) : restante;
  }

  function somar(pagamento: Pagamento) {
    void Haptics.selectionAsync();
    setPagos((atuais) => {
      const existente = atuais.find((p) => p.forma === pagamento.forma);
      return existente
        ? atuais.map((p) =>
            p.forma === pagamento.forma ? { ...p, valor: p.valor + pagamento.valor } : p,
          )
        : [...atuais, pagamento];
    });
    setValorDigitado(0);
  }

  function registrarPagamento(forma: FormaPagamento) {
    const valor = valorPretendido();
    if (valor <= 0) return;

    // Vale e fiado precisam de uma pergunta ANTES do valor: qual papel, e de quem é a
    // dívida. Uma linha de cada por venda — dois vales na mesma compra é caso que não
    // existe no balcão, e somar em cima estouraria o saldo do primeiro.
    if (forma === 'VALE' || forma === 'FIADO') {
      if (pagos.some((p) => p.forma === forma)) {
        Alert.alert(
          forma === 'VALE' ? 'Já tem um vale nesta venda' : 'Já tem um fiado nesta venda',
          'Remova o que já está lançado para trocar.',
        );
        return;
      }
      if (forma === 'VALE') setPerguntandoVale(true);
      else setPerguntandoCliente(true);
      return;
    }

    if (forma === 'DINHEIRO') {
      // Recebeu mais do que devia: a diferença é troco, não pagamento a mais.
      setRecebidoDinheiro((atual) => atual + Math.max(valorDigitado, valor));
    } else if (valorDigitado > restante) {
      // Em cartão ou PIX não existe troco: aceitar em silêncio esconderia um erro de
      // digitação (R$ 120,00 numa venda de R$ 100,00 vira R$ 100,00 sem aviso).
      Alert.alert(
        'Valor maior que o devido',
        `Faltam ${formatar(restante)}. Em ${forma.toLowerCase()} não há troco — ajuste o valor ou receba a diferença em dinheiro.`,
      );
      return;
    }

    somar({ forma, valor });
  }

  function aplicarVale(vale: ValeEscolhido) {
    setPerguntandoVale(false);
    // O vale cobre até o saldo dele; o resto sai por outra forma. Pedir mais faria o
    // servidor recusar a venda inteira no fim — depois da cliente já ter ido embora.
    const valor = Math.min(valorPretendido(), vale.saldo);
    if (valor <= 0) return;
    if (vale.saldo < valorPretendido()) {
      Alert.alert(
        'O vale não cobre tudo',
        `Este vale tem ${formatar(vale.saldo)}. O resto sai por outra forma.`,
      );
    }
    somar({ forma: 'VALE', valor, codigoVale: vale.codigo });
  }

  function aplicarFiado(escolhido: Cliente) {
    setPerguntandoCliente(false);
    const valor = valorPretendido();
    if (valor <= 0) return;
    setCliente(escolhido);
    // Avisa, não bloqueia (ADR-20): travar aqui só ensina a lançar como dinheiro e
    // anotar no papel — e aí a dívida some da conta.
    if (escolhido.acima_do_limite) {
      Alert.alert(
        'Acima do limite combinado',
        `${escolhido.nome} já passou do limite. A venda pode seguir — a decisão é sua.`,
      );
    }
    somar({ forma: 'FIADO', valor });
  }

  function removerPagamento(forma: FormaPagamento) {
    setPagos((atuais) => atuais.filter((p) => p.forma !== forma));
    if (forma === 'DINHEIRO') setRecebidoDinheiro(0);
    if (forma === 'FIADO') setCliente(null);
  }

  async function confirmar() {
    if (restante !== 0 || total === 0) return;
    setEnviando(true);
    try {
      const venda = await vendas.registrar({
        client_uuid: clientUuid,
        desconto: paraDecimalString(descontoAtual),
        itens: itens.map((i) => ({ variante_id: i.varianteId, quantidade: i.quantidade })),
        cliente_id: cliente?.id ?? null,
        pagamentos: pagos.map((p) => ({
          forma: p.forma,
          valor: paraDecimalString(p.valor),
          ...(p.codigoVale ? { codigo_vale: p.codigoVale } : {}),
        })),
      });

      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      invalidarAposVenda();
      limpar();
      router.dismissAll();
      router.push({ pathname: '/venda/[id]', params: { id: String(venda.id) } });
    } catch (erro) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);

      if (codigoDoErro(erro) === 'PAGAMENTO_DIVERGENTE') {
        // O preço mudou no servidor entre o bipe e a cobrança. O total certo vem no erro,
        // como string decimal da API — vira R$ antes de aparecer para o vendedor.
        const totalCorreto = detalheDoErro(erro)?.total_da_venda;
        Alert.alert(
          'O preço mudou',
          totalCorreto
            ? `O total correto agora é ${formatar(paraCentavos(String(totalCorreto)))}. Refaça a cobrança.`
            : 'Confira o carrinho e refaça a cobrança.',
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
                style={[s.pagoItem, s.pagoItemDetalhado]}
                onPress={() => removerPagamento(p.forma)}
              >
                <View style={s.pagoTexto}>
                  <Text style={s.pagoForma}>
                    {FORMAS.find((f) => f.forma === p.forma)?.rotulo}
                  </Text>
                  {!!p.codigoVale && <Text style={s.pagoDetalhe}>{p.codigoVale}</Text>}
                  {p.forma === 'FIADO' && !!cliente && (
                    <Text style={s.pagoDetalhe}>{cliente.nome}</Text>
                  )}
                </View>
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
              {formas.map(({ forma, rotulo }) => (
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
          titulo={
            total === 0 ? 'Desconto zera a venda' : restante === 0 ? 'Confirmar venda' : 'Falta receber'
          }
          variante="acao"
          estilo={s.metade}
          // Total zero não tem como ser pago: a API exige ao menos um pagamento, e um
          // desconto de 100% precisa ser corrigido, não enviado.
          desabilitado={restante !== 0 || total === 0}
          carregando={enviando}
          onPress={() => void confirmar()}
        />
      </View>

      <ModalVale
        visivel={perguntandoVale}
        falta={Math.max(0, valorPretendido())}
        aoEscolher={aplicarVale}
        aoCancelar={() => setPerguntandoVale(false)}
      />
      <ModalCliente
        visivel={perguntandoCliente}
        aoEscolher={aplicarFiado}
        aoCancelar={() => setPerguntandoCliente(false)}
      />
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
    gap: espaco.sm,
    backgroundColor: cores.sucessoFraco,
    borderRadius: raio.md,
    paddingHorizontal: espaco.lg,
    minHeight: ALVO_TOQUE,
  },
  pagoItemDetalhado: { paddingVertical: espaco.sm },
  pagoTexto: { flex: 1 },
  pagoForma: { fontSize: fonte.base, fontWeight: '700', color: cores.acaoEscura },
  pagoDetalhe: { fontSize: fonte.micro, color: cores.acaoEscura, opacity: 0.75 },
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
