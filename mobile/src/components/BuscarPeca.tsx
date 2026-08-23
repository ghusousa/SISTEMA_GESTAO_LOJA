/**
 * Achar a peça pelo nome, quando não existe etiqueta para bipar.
 *
 * O caso não é exceção, é o normal da reposição: quem gera o próprio código de barras cria
 * a etiqueta DEPOIS de cadastrar a peça, então a mercadoria que chega do fornecedor vem sem
 * nada colado. Exigir bipada aí obrigaria a imprimir e colar antes de conferir — peça por
 * peça, para registrar o que já se sabe que chegou.
 *
 * Espelha `web/js/busca-peca.js`: mesma consulta, mesma ordem, mesma leitura de saldo. No
 * celular vira folha em vez de lista suspensa porque a mão que segura o aparelho está
 * ocupada com a peça, e alvo pequeno em cima do teclado erra.
 */

import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { catalogo } from '@/api/endpoints';
import type { Variante } from '@/api/tipos';
import { formatar, paraCentavos } from '@/lib/money';
import { ALVO_TOQUE, cores, espaco, fonte, raio } from '@/lib/tema';

const MINIMO = 2;

interface Props {
  aoEscolher: (peca: Variante) => void;
  /** No balcão o preço decide; na entrada, não. O saldo aparece nos dois. */
  mostrarPreco?: boolean;
  rotulo?: string;
}

export function BuscarPeca({ aoEscolher, mostrarPreco = false, rotulo = 'Buscar pelo nome' }: Props) {
  const [aberto, setAberto] = useState(false);
  const [termo, setTermo] = useState('');

  const busca = useQuery({
    queryKey: ['busca-peca', termo],
    queryFn: () => catalogo.buscarVariantes(termo),
    enabled: aberto && termo.trim().length >= MINIMO,
    // Sem refetch ao voltar para a tela: a lista é de um instante, não estado de servidor
    // que precise seguir vivo depois que a peça foi escolhida.
    staleTime: 15_000,
  });

  function fechar() {
    setAberto(false);
    setTermo('');
  }

  function escolher(peca: Variante) {
    fechar();
    aoEscolher(peca);
  }

  const itens = busca.data?.items ?? [];
  const procurando = termo.trim().length >= MINIMO;

  return (
    <>
      <Pressable
        style={s.atalho}
        onPress={() => setAberto(true)}
        accessibilityRole="button"
        accessibilityLabel={rotulo}
      >
        <MaterialCommunityIcons name="magnify" size={18} color={cores.primaria} />
        <Text style={s.atalhoTexto}>{rotulo}</Text>
      </Pressable>

      <Modal visible={aberto} animationType="slide" onRequestClose={fechar}>
        <KeyboardAvoidingView
          style={s.tela}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <View style={s.topo}>
            <TextInput
              value={termo}
              onChangeText={setTermo}
              style={s.campo}
              placeholder="camiseta preta"
              placeholderTextColor={cores.textoFraco}
              autoFocus
              autoCorrect={false}
              autoCapitalize="none"
              returnKeyType="search"
            />
            <Pressable onPress={fechar} style={s.fechar} accessibilityLabel="Fechar busca">
              <Text style={s.fecharTexto}>Fechar</Text>
            </Pressable>
          </View>

          {busca.isFetching && <ActivityIndicator style={{ marginTop: espaco.lg }} />}

          <FlatList
            data={itens}
            keyExtractor={(peca) => String(peca.id)}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={s.lista}
            ListEmptyComponent={
              busca.isFetching ? null : (
                <Text style={s.vazio}>
                  {procurando
                    ? 'Nenhuma peça com esse nome. Confira a escrita, ou cadastre a peça.'
                    : 'Escreva parte do nome da peça — acento não faz falta.'}
                </Text>
              )
            }
            renderItem={({ item }) => (
              <Pressable style={s.item} onPress={() => escolher(item)} accessibilityRole="button">
                <View style={s.itemInfo}>
                  <Text style={s.itemNome} numberOfLines={1}>
                    {item.produto}
                  </Text>
                  <Text style={s.itemDetalhe}>
                    {item.tamanho} · {item.cor}
                  </Text>
                </View>
                <View style={s.itemLado}>
                  {mostrarPreco && (
                    <Text style={s.itemPreco}>{formatar(paraCentavos(item.preco_venda))}</Text>
                  )}
                  <Text style={[s.itemSaldo, item.saldo <= 0 && s.itemSemEstoque]}>
                    {item.saldo > 0 ? `${item.saldo} em estoque` : 'sem estoque'}
                  </Text>
                </View>
              </Pressable>
            )}
          />
        </KeyboardAvoidingView>
      </Modal>
    </>
  );
}

const s = StyleSheet.create({
  atalho: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: espaco.xs,
    minHeight: ALVO_TOQUE,
    paddingHorizontal: espaco.lg,
    borderRadius: raio.md,
    borderWidth: 1,
    borderColor: cores.primaria,
    backgroundColor: cores.superficie,
  },
  atalhoTexto: { color: cores.primaria, fontWeight: '700', fontSize: fonte.base },

  tela: { flex: 1, backgroundColor: cores.fundo },
  topo: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: espaco.sm,
    padding: espaco.lg,
    paddingTop: espaco.xl,
    backgroundColor: cores.superficie,
    borderBottomWidth: 1,
    borderBottomColor: cores.borda,
  },
  campo: {
    flex: 1,
    minHeight: ALVO_TOQUE,
    borderWidth: 1,
    borderColor: cores.borda,
    borderRadius: raio.md,
    paddingHorizontal: espaco.md,
    fontSize: fonte.grande,
    color: cores.texto,
    backgroundColor: cores.fundo,
  },
  fechar: { minHeight: ALVO_TOQUE, justifyContent: 'center', paddingHorizontal: espaco.sm },
  fecharTexto: { color: cores.primaria, fontWeight: '700', fontSize: fonte.base },

  lista: { padding: espaco.lg, gap: espaco.sm },
  vazio: {
    color: cores.textoSuave,
    fontSize: fonte.base,
    textAlign: 'center',
    marginTop: espaco.xl,
    lineHeight: 22,
  },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: espaco.md,
    minHeight: ALVO_TOQUE + 12,
    padding: espaco.md,
    borderRadius: raio.md,
    backgroundColor: cores.superficie,
    borderWidth: 1,
    borderColor: cores.borda,
  },
  itemInfo: { flex: 1 },
  itemNome: { fontSize: fonte.base, fontWeight: '700', color: cores.texto },
  itemDetalhe: { fontSize: fonte.pequena, color: cores.textoSuave, marginTop: 2 },
  itemLado: { alignItems: 'flex-end' },
  itemPreco: { fontSize: fonte.base, fontWeight: '700', color: cores.texto },
  itemSaldo: { fontSize: fonte.pequena, color: cores.textoSuave, marginTop: 2 },
  itemSemEstoque: { color: cores.perigo, fontWeight: '700' },
});
