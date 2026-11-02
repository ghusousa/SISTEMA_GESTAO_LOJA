/**
 * PDV: a tela onde a loja passa o dia.
 *
 * A tela abre com o carrinho inteiro à vista e um botão para ler o código. A câmera só
 * liga quando alguém pede: ligada o dia todo ela comia bateria, esquentava o aparelho e
 * ficava apontada para a loja sem necessidade. Aberta, ela lê em sequência — não é preciso
 * tocar em nada entre uma peça e outra.
 */

import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useCallback, useRef, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { codigoDoErro, mensagemDoErro } from '@/api/client';
import { catalogo } from '@/api/endpoints';
import { BuscarPeca } from '@/components/BuscarPeca';
import { CodigoManual } from '@/components/CodigoManual';
import { MetaDoDia } from '@/components/MetaDoDia';
import { Scanner, type ScannerRef } from '@/components/Scanner';
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
  const scanner = useRef<ScannerRef | null>(null);
  // Códigos que a pessoa já viu e recusou cadastrar. Sem esta lista, a câmera continua
  // apontada para a mesma etiqueta desconhecida e reabre o diálogo a cada 1,5 s.
  const recusados = useRef(new Set<string>());
  // A câmera só liga quando alguém pede. Ela nasceu ligada e ficava assim o dia inteiro:
  // gastava bateria, esquentava o aparelho e deixava a lente apontada para a loja sem
  // ninguém ter pedido nada.
  const [camera, setCamera] = useState(false);

  useFocusEffect(
    useCallback(() => {
      // A aba do PDV continua montada quando outra tela entra por cima (cadastro rápido,
      // cobrança) — e a câmera junto, lendo o que estiver na frente dela e enchendo o
      // carrinho sozinha. Sair de foco desliga; voltar começa de novo com ela apagada.
      return () => setCamera(false);
    }, []),
  );

  const aoLerCodigo = useCallback(
    async (codigo: string, origem: 'camera' | 'digitado' = 'camera') => {
      if (buscaEmAndamento.current) return;

      // Já perguntamos por este código e a resposta foi "agora não": basta o aviso na
      // tela. Sem consulta e sem vibrar, porque a etiqueta segue na frente da câmera.
      // Digitar o mesmo código à mão é outra história — aí a pessoa quer, e o convite
      // para cadastrar volta a aparecer.
      if (origem === 'camera' && recusados.current.has(codigo)) {
        setAviso(`Código ${codigo} não está cadastrado.`);
        return;
      }

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
          // A câmera para enquanto o diálogo está na frente dela; só assim ele não
          // reabre sozinho por trás e vira uma pilha de avisos iguais.
          scanner.current?.pausar();
          Alert.alert(
            'Peça não cadastrada',
            `Nenhuma peça com o código ${codigo}. Quer cadastrar agora?`,
            [
              {
                text: 'Agora não',
                style: 'cancel',
                onPress: () => {
                  recusados.current.add(codigo);
                  setAviso(`Código ${codigo} não está cadastrado.`);
                  scanner.current?.retomar();
                },
              },
              {
                // Sem retomar aqui: quem devolve a câmera é o foco, quando esta tela
                // voltar. Retomar agora deixaria a câmera lendo por baixo do cadastro.
                text: 'Cadastrar',
                onPress: () =>
                  router.push({
                    pathname: '/produto/novo',
                    params: { codigo, retorno: 'pdv' },
                  }),
              },
            ],
            // No Android dá para fechar o diálogo pelo botão voltar, sem tocar em
            // nenhum dos dois botões. Sem isto o PDV ficaria mudo, com a câmera
            // pausada, e ninguém entenderia por que parou de bipar. (No iOS o RN
            // ignora esta opção — lá não existe como sair sem escolher.)
            { onDismiss: () => scanner.current?.retomar() },
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
      {camera ? (
        <View style={[s.cameraArea, { marginTop: insets.top }]}>
          <Scanner
            controle={scanner}
            aoLer={(codigo) => void aoLerCodigo(codigo)}
            modo="continuo"
            ocupado={buscando}
            dica={buscando ? 'Consultando…' : 'Bipe a etiqueta da peça'}
            rodape={
              <Pressable
                onPress={() => setCamera(false)}
                style={s.fecharCamera}
                accessibilityRole="button"
              >
                <Text style={s.fecharCameraTexto}>Fechar câmera</Text>
              </Pressable>
            }
          />
        </View>
      ) : (
        <View style={[s.chamada, { paddingTop: insets.top + espaco.lg }]}>
          <Pressable
            onPress={() => setCamera(true)}
            style={s.abrirCamera}
            accessibilityRole="button"
            accessibilityLabel="Ler código de barras"
          >
            <MaterialCommunityIcons name="barcode-scan" size={30} color="#FFF" />
            <Text style={s.abrirCameraTexto}>Ler código de barras</Text>
          </Pressable>
        </View>
      )}

      {!!aviso && (
        <Pressable
          onPress={() => {
            // Tocar no aviso é a saída para quem cadastrou a peça por outro caminho:
            // limpa a lista de recusados e a próxima leitura consulta de novo.
            recusados.current.clear();
            setAviso(null);
          }}
          style={s.aviso}
        >
          <Text style={s.avisoTexto}>{aviso}</Text>
        </Pressable>
      )}

      {/* O placar do dia de quem está logado; sem meta definida, não ocupa espaço. */}
      <MetaDoDia />

      <View style={s.carrinho}>
        <View style={s.carrinhoCabecalho}>
          <Text style={s.carrinhoTitulo}>
            {pecas === 0 ? 'Carrinho vazio' : `${pecas} ${pecas === 1 ? 'peça' : 'peças'}`}
          </Text>
          <View style={s.carrinhoAcoes}>
            {/* Etiqueta rasgada ou desbotada é rotina: sem esta saída a peça não vende. */}
            <CodigoManual aoConfirmar={(codigo) => void aoLerCodigo(codigo, 'digitado')} />
            {/* Etiqueta rasgada, peça que voltou do provador sem tag: no balcão também
                existe o dia em que não há o que bipar. */}
            <BuscarPeca
              rotulo="Buscar"
              mostrarPreco
              aoEscolher={(peca) => {
                // A busca devolve `Variante`; o carrinho fala `VarianteLookup`. Categoria e
                // foto não entram na conta da venda, e a lista não as traz.
                const resultado = adicionar(
                  {
                    variante_id: peca.id,
                    produto_id: peca.produto_id,
                    produto: peca.produto,
                    categoria: '',
                    tamanho: peca.tamanho,
                    cor: peca.cor,
                    codigo_barras: peca.codigo_barras,
                    preco_venda: peca.preco_venda,
                    saldo: peca.saldo,
                    foto_url: null,
                  },
                  paraCentavos(peca.preco_venda),
                );
                if (!resultado.ok) {
                  setAviso(
                    resultado.disponivel === 0
                      ? `${peca.produto} ${peca.tamanho} está sem estoque.`
                      : `Só há ${resultado.disponivel} de ${peca.produto} ${peca.tamanho} em estoque.`,
                  );
                }
              }}
            />
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
            <Text style={s.vazioTexto}>
              Toque em "Ler código de barras" e bipe a primeira peça
            </Text>
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

  // Com a câmera desligada a chamada é enxuta: o carrinho ganha a tela, que é o que a
  // pessoa olha entre uma peça e outra.
  chamada: { paddingHorizontal: espaco.lg, paddingBottom: espaco.md },
  abrirCamera: {
    minHeight: ALVO_TOQUE + 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: espaco.sm,
    borderRadius: raio.md,
    backgroundColor: cores.primaria,
  },
  abrirCameraTexto: { color: '#FFF', fontSize: fonte.grande, fontWeight: '800' },
  fecharCamera: {
    minHeight: ALVO_TOQUE,
    justifyContent: 'center',
    paddingHorizontal: espaco.lg,
    marginTop: espaco.sm,
    borderRadius: raio.redondo,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  fecharCameraTexto: { color: '#FFF', fontWeight: '700', fontSize: fonte.pequena },

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
