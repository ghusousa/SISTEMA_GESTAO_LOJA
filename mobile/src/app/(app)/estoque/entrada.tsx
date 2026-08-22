/**
 * Entrada de mercadoria por bipagem contínua.
 *
 * O fluxo real do estoquista é: abrir a caixa e bipar peça por peça. A tela soma sozinha e
 * só envia no final, em uma única requisição — com client_uuid, para um reenvio depois de
 * queda de rede não somar o estoque duas vezes.
 */

import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useMutation } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useCallback, useRef, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { codigoDoErro, mensagemDoErro } from '@/api/client';
import { catalogo, estoque } from '@/api/endpoints';
import { Scanner } from '@/components/Scanner';
import { Botao, Campo } from '@/components/ui';
import { gerarUuid } from '@/lib/uuid';
import { invalidarAposMovimentoEstoque } from '@/lib/queryClient';
import { ALVO_TOQUE, cores, espaco, fonte, raio } from '@/lib/tema';

interface ItemBipado {
  varianteId: number;
  produto: string;
  tamanho: string;
  cor: string;
  codigo: string;
  quantidade: number;
}

export default function EntradaEstoque() {
  const router = useRouter();
  const [itens, setItens] = useState<ItemBipado[]>([]);
  const [fornecedor, setFornecedor] = useState('');
  const [aviso, setAviso] = useState<string | null>(null);
  const [clientUuid] = useState(() => gerarUuid());
  const buscando = useRef(false);

  const aoLer = useCallback(async (codigo: string) => {
    if (buscando.current) return;
    buscando.current = true;
    setAviso(null);
    try {
      const peca = await catalogo.porCodigoBarras(codigo);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setItens((atuais) => {
        const existente = atuais.find((i) => i.varianteId === peca.variante_id);
        if (existente) {
          return atuais.map((i) =>
            i.varianteId === peca.variante_id ? { ...i, quantidade: i.quantidade + 1 } : i,
          );
        }
        return [
          {
            varianteId: peca.variante_id,
            produto: peca.produto,
            tamanho: peca.tamanho,
            cor: peca.cor,
            codigo: peca.codigo_barras,
            quantidade: 1,
          },
          ...atuais,
        ];
      });
    } catch (erro) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setAviso(
        codigoDoErro(erro) === 'NAO_ENCONTRADO'
          ? `Código ${codigo} não está cadastrado. Cadastre a peça antes de dar entrada.`
          : mensagemDoErro(erro),
      );
    } finally {
      buscando.current = false;
    }
  }, []);

  const salvar = useMutation({
    mutationFn: () =>
      estoque.registrarEntrada({
        client_uuid: clientUuid,
        fornecedor: fornecedor.trim() || null,
        itens: itens.map((i) => ({ variante_id: i.varianteId, quantidade: i.quantidade })),
      }),
    onSuccess: (entrada) => {
      invalidarAposMovimentoEstoque();
      Alert.alert(
        'Entrada registrada',
        `${entrada.total_pecas} peça(s) somadas ao estoque.`,
        [{ text: 'Pronto', onPress: () => router.back() }],
      );
    },
    onError: (erro) => Alert.alert('Não deu para registrar', mensagemDoErro(erro)),
  });

  const totalPecas = itens.reduce((soma, i) => soma + i.quantidade, 0);

  return (
    <View style={s.tela}>
      <View style={s.cameraArea}>
        <Scanner
          aoLer={(codigo) => void aoLer(codigo)}
          modo="continuo"
          dica="Bipe cada peça que chegou"
        />
      </View>

      {!!aviso && (
        <Pressable onPress={() => setAviso(null)} style={s.aviso}>
          <Text style={s.avisoTexto}>{aviso}</Text>
        </Pressable>
      )}

      <ScrollView contentContainerStyle={s.conteudo} keyboardShouldPersistTaps="handled">
        <Campo
          rotulo="Fornecedor (opcional)"
          value={fornecedor}
          onChangeText={setFornecedor}
          placeholder="Malharia Nova"
          autoCapitalize="words"
        />

        {itens.length === 0 ? (
          <View style={s.vazio}>
            <MaterialCommunityIcons name="tray-arrow-down" size={36} color={cores.textoFraco} />
            <Text style={s.vazioTexto}>Nenhuma peça bipada ainda</Text>
          </View>
        ) : (
          itens.map((item) => (
            <View key={item.varianteId} style={s.item}>
              <View style={s.itemInfo}>
                <Text style={s.itemNome} numberOfLines={1}>
                  {item.produto}
                </Text>
                <Text style={s.itemDetalhe}>
                  {item.tamanho} · {item.cor}
                </Text>
              </View>
              <View style={s.contador}>
                <Pressable
                  style={s.contadorBotao}
                  onPress={() =>
                    setItens((atuais) =>
                      atuais
                        .map((i) =>
                          i.varianteId === item.varianteId
                            ? { ...i, quantidade: i.quantidade - 1 }
                            : i,
                        )
                        .filter((i) => i.quantidade > 0),
                    )
                  }
                >
                  <Text style={s.contadorSinal}>−</Text>
                </Pressable>
                <Text style={s.contadorValor}>{item.quantidade}</Text>
                <Pressable
                  style={s.contadorBotao}
                  onPress={() =>
                    setItens((atuais) =>
                      atuais.map((i) =>
                        i.varianteId === item.varianteId
                          ? { ...i, quantidade: i.quantidade + 1 }
                          : i,
                      ),
                    )
                  }
                >
                  <Text style={s.contadorSinal}>+</Text>
                </Pressable>
              </View>
            </View>
          ))
        )}
      </ScrollView>

      <View style={s.rodape}>
        <Text style={s.total}>
          {totalPecas} peça{totalPecas === 1 ? '' : 's'} para entrar
        </Text>
        <Botao
          titulo="Registrar entrada"
          variante="acao"
          grande
          desabilitado={itens.length === 0}
          carregando={salvar.isPending}
          onPress={() => salvar.mutate()}
        />
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  tela: { flex: 1, backgroundColor: cores.fundo },
  cameraArea: { height: '34%', backgroundColor: '#000' },

  aviso: { backgroundColor: cores.perigoFraco, padding: espaco.md },
  avisoTexto: { color: cores.perigo, fontSize: fonte.pequena, fontWeight: '600' },

  conteudo: { padding: espaco.lg },
  vazio: { alignItems: 'center', paddingVertical: espaco.xl, gap: espaco.sm },
  vazioTexto: { color: cores.textoFraco, fontSize: fonte.base },

  item: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: cores.superficie,
    borderRadius: raio.md,
    padding: espaco.md,
    marginBottom: espaco.sm,
    gap: espaco.md,
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
  contadorSinal: { fontSize: fonte.grande, fontWeight: '800', color: cores.primaria },
  contadorValor: {
    minWidth: 32,
    textAlign: 'center',
    fontSize: fonte.media,
    fontWeight: '800',
    color: cores.texto,
  },

  rodape: {
    padding: espaco.lg,
    backgroundColor: cores.superficie,
    borderTopWidth: 1,
    borderTopColor: cores.borda,
    gap: espaco.sm,
  },
  total: { fontSize: fonte.base, fontWeight: '700', color: cores.textoSuave },
});
