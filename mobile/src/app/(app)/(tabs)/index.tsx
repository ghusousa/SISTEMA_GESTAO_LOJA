/**
 * PDV: a tela onde a loja passa o dia.
 *
 * O scanner fica sempre ligado na metade de cima e o carrinho cresce embaixo — sem trocar
 * de modo, sem tocar em nada entre uma peça e outra. Venda comum sai em quatro toques:
 * bipar, Cobrar, escolher a forma, confirmar.
 */

import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useCallback, useRef, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { codigoDoErro, mensagemDoErro } from '@/api/client';
import { catalogo } from '@/api/endpoints';
import { CodigoManual } from '@/components/CodigoManual';
import { Scanner } from '@/components/Scanner';
import { Botao } from '@/components/ui';
import { useConexao } from '@/components/BannerConexao';
import { formatar, paraCentavos } from '@/lib/money';
import { ALVO_TOQUE, cores, espaco, fonte, raio } from '@/lib/tema';
import { useCartStore } from '@/stores/cartStore';

export default function Pdv() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const online = useConexao((e) => e.online);

  const itens = useCartStore((e) => e.itens);
  const adicionar = useCartStore((e) => e.adicionar);
  const alterarQuantidade = useCartStore((e) => e.alterarQuantidade);
  const remover = useCartStore((e) => e.remover);
  const limpar = useCartStore((e) => e.limpar);
  const subtotal = useCartStore((e) => e.subtotal());
  const desconto = useCartStore((e) => e.desconto);
  const total = useCartStore((e) => e.total());
  const pecas = useCartStore((e) => e.quantidadePecas());

  const [buscando, setBuscando] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);
  // Evita duas buscas simultâneas quando a câmera insiste no mesmo código.
  const buscaEmAndamento = useRef(false);

  const aoLerCodigo = useCallback(
    async (codigo: string) => {
      if (buscaEmAndamento.current) return;
      buscaEmAndamento.current = true;
      setBuscando(true);
      setAviso(null);

      try {
        const peca = await catalogo.porCodigoBarras(codigo);
        const resultado = adicionar(peca, paraCentavos(peca.preco_venda));

        if (!resultado.ok) {
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
          setAviso(
            resultado.disponivel === 0
              ? `${peca.produto} ${peca.tamanho} está sem estoque.`
              : `Só há ${resultado.disponivel} de ${peca.produto} ${peca.tamanho} em estoque.`,
          );
        }
      } catch (erro) {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        if (codigoDoErro(erro) === 'NAO_ENCONTRADO') {
          Alert.alert(
            'Peça não cadastrada',
            `Nenhuma peça com o código ${codigo}. Quer cadastrar agora?`,
            [
              { text: 'Agora não', style: 'cancel' },
              {
                text: 'Cadastrar',
                onPress: () =>
                  router.push({
                    pathname: '/produto/novo',
                    params: { codigo, retorno: 'pdv' },
                  }),
              },
            ],
          );
        } else {
          setAviso(mensagemDoErro(erro, 'Não deu para consultar a peça.'));
        }
      } finally {
        setBuscando(false);
        buscaEmAndamento.current = false;
      }
    },
    [adicionar, router],
  );

  function confirmarLimpeza() {
    Alert.alert('Cancelar a venda?', 'O carrinho será esvaziado.', [
      { text: 'Continuar vendendo', style: 'cancel' },
      { text: 'Cancelar venda', style: 'destructive', onPress: limpar },
    ]);
  }

  return (
    <View style={s.tela}>
      <View style={[s.cameraArea, { marginTop: insets.top }]}>
        <Scanner
          aoLer={(codigo) => void aoLerCodigo(codigo)}
          modo="continuo"
          ocupado={buscando}
          dica={buscando ? 'Consultando…' : 'Bipe a etiqueta da peça'}
        />
      </View>

      {!!aviso && (
        <Pressable onPress={() => setAviso(null)} style={s.aviso}>
          <Text style={s.avisoTexto}>{aviso}</Text>
        </Pressable>
      )}

      <View style={s.carrinho}>
        <View style={s.carrinhoCabecalho}>
          <Text style={s.carrinhoTitulo}>
            {pecas === 0 ? 'Carrinho vazio' : `${pecas} ${pecas === 1 ? 'peça' : 'peças'}`}
          </Text>
          <View style={s.carrinhoAcoes}>
            {/* Etiqueta rasgada ou desbotada é rotina: sem esta saída a peça não vende. */}
            <CodigoManual aoConfirmar={(codigo) => void aoLerCodigo(codigo)} />
            {itens.length > 0 && (
              <Pressable onPress={confirmarLimpeza} hitSlop={12}>
                <Text style={s.limpar}>Limpar</Text>
              </Pressable>
            )}
          </View>
        </View>

        {itens.length === 0 ? (
          <View style={s.vazio}>
            <MaterialCommunityIcons
              name="barcode-scan"
              size={40}
              color={cores.textoFraco}
            />
            <Text style={s.vazioTexto}>Bipe a primeira peça para começar a venda</Text>
          </View>
        ) : (
          <ScrollView contentContainerStyle={s.lista} keyboardShouldPersistTaps="handled">
            {itens.map((item) => (
              <View key={item.varianteId} style={s.item}>
                <View style={s.itemInfo}>
                  <Text style={s.itemNome} numberOfLines={1}>
                    {item.produto}
                  </Text>
                  <Text style={s.itemDetalhe}>
                    {item.tamanho} · {item.cor} · {formatar(item.precoUnitario)}
                  </Text>
                </View>

                <View style={s.contador}>
                  <Pressable
                    style={s.contadorBotao}
                    onPress={() => alterarQuantidade(item.varianteId, item.quantidade - 1)}
                    accessibilityLabel="Diminuir quantidade"
                  >
                    <Text style={s.contadorSinal}>−</Text>
                  </Pressable>
                  <Text style={s.contadorValor}>{item.quantidade}</Text>
                  <Pressable
                    style={[
                      s.contadorBotao,
                      item.quantidade >= item.saldoDisponivel && s.contadorBotaoInativo,
                    ]}
                    disabled={item.quantidade >= item.saldoDisponivel}
                    onPress={() => alterarQuantidade(item.varianteId, item.quantidade + 1)}
                    accessibilityLabel="Aumentar quantidade"
                  >
                    <Text style={s.contadorSinal}>+</Text>
                  </Pressable>
                </View>

                <View style={s.itemTotalArea}>
                  <Text style={s.itemTotal}>
                    {formatar(item.precoUnitario * item.quantidade)}
                  </Text>
                  <Pressable onPress={() => remover(item.varianteId)} hitSlop={10}>
                    <Text style={s.remover}>remover</Text>
                  </Pressable>
                </View>
              </View>
            ))}
          </ScrollView>
        )}
      </View>

      <View style={[s.rodape, { paddingBottom: espaco.md + insets.bottom / 2 }]}>
        {desconto > 0 && (
          <View style={s.linhaDesconto}>
            <Text style={s.descontoTexto}>Subtotal {formatar(subtotal)}</Text>
            <Text style={s.descontoTexto}>Desconto −{formatar(desconto)}</Text>
          </View>
        )}
        <View style={s.totalLinha}>
          <Text style={s.totalRotulo}>Total</Text>
          <Text style={s.totalValor}>{formatar(total)}</Text>
        </View>
        <Botao
          titulo={online ? 'Cobrar' : 'Sem conexão'}
          variante="acao"
          grande
          desabilitado={itens.length === 0 || !online}
          onPress={() => router.push('/venda/pagamento')}
        />
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  tela: { flex: 1, backgroundColor: cores.fundo },
  cameraArea: { height: '38%', backgroundColor: '#000' },

  aviso: { backgroundColor: cores.alertaFraco, padding: espaco.md },
  avisoTexto: { color: '#7A5A00', fontSize: fonte.base, fontWeight: '600' },

  carrinho: { flex: 1 },
  carrinhoCabecalho: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: espaco.lg,
    paddingTop: espaco.md,
    paddingBottom: espaco.sm,
  },
  carrinhoTitulo: { fontSize: fonte.base, fontWeight: '700', color: cores.textoSuave },
  carrinhoAcoes: { flexDirection: 'row', alignItems: 'center', gap: espaco.lg },
  limpar: { color: cores.perigo, fontWeight: '700', fontSize: fonte.pequena },

  vazio: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: espaco.sm },
  vazioTexto: { color: cores.textoFraco, fontSize: fonte.base, textAlign: 'center' },

  lista: { paddingHorizontal: espaco.md, paddingBottom: espaco.md },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: cores.superficie,
    borderRadius: raio.md,
    padding: espaco.md,
    marginBottom: espaco.sm,
    gap: espaco.sm,
  },
  itemInfo: { flex: 1 },
  itemNome: { fontSize: fonte.base, fontWeight: '700', color: cores.texto },
  itemDetalhe: { fontSize: fonte.pequena, color: cores.textoSuave, marginTop: 2 },

  contador: { flexDirection: 'row', alignItems: 'center', gap: espaco.xs },
  contadorBotao: {
    width: ALVO_TOQUE - 8,
    height: ALVO_TOQUE - 8,
    borderRadius: raio.sm,
    backgroundColor: cores.primariaFraca,
    alignItems: 'center',
    justifyContent: 'center',
  },
  contadorBotaoInativo: { opacity: 0.35 },
  contadorSinal: { fontSize: fonte.grande, fontWeight: '800', color: cores.primaria },
  contadorValor: {
    minWidth: 28,
    textAlign: 'center',
    fontSize: fonte.media,
    fontWeight: '800',
    color: cores.texto,
  },

  itemTotalArea: { alignItems: 'flex-end', minWidth: 84 },
  itemTotal: { fontSize: fonte.base, fontWeight: '800', color: cores.texto },
  remover: { fontSize: fonte.micro, color: cores.perigo, marginTop: 2 },

  rodape: {
    backgroundColor: cores.superficie,
    padding: espaco.lg,
    borderTopWidth: 1,
    borderTopColor: cores.borda,
    gap: espaco.sm,
  },
  linhaDesconto: { flexDirection: 'row', justifyContent: 'space-between' },
  descontoTexto: { fontSize: fonte.pequena, color: cores.textoSuave },
  totalLinha: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end' },
  totalRotulo: { fontSize: fonte.media, color: cores.textoSuave, fontWeight: '600' },
  totalValor: { fontSize: fonte.destaque, fontWeight: '800', color: cores.texto },
});
