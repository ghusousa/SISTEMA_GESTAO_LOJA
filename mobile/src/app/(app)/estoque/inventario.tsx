/**
 * Inventário: contar fisicamente e acertar o sistema.
 *
 * A contagem fica no aparelho enquanto acontece e vai ao servidor de uma vez só, no final.
 * Só o que divergiu vira movimentação — o extrato guarda acertos, não a rotina de conferir.
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
import { Botao, Etiqueta } from '@/components/ui';
import { invalidarAposMovimentoEstoque } from '@/lib/queryClient';
import { ALVO_TOQUE, cores, espaco, fonte, raio } from '@/lib/tema';

interface Contagem {
  varianteId: number;
  produto: string;
  tamanho: string;
  cor: string;
  saldoSistema: number;
  contado: number;
}

export default function Inventario() {
  const router = useRouter();
  const [contagens, setContagens] = useState<Contagem[]>([]);
  const [aviso, setAviso] = useState<string | null>(null);
  const buscando = useRef(false);

  const aoLer = useCallback(async (codigo: string) => {
    if (buscando.current) return;
    buscando.current = true;
    setAviso(null);
    try {
      const peca = await catalogo.porCodigoBarras(codigo);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setContagens((atuais) => {
        const existente = atuais.find((c) => c.varianteId === peca.variante_id);
        if (existente) {
          return atuais.map((c) =>
            c.varianteId === peca.variante_id ? { ...c, contado: c.contado + 1 } : c,
          );
        }
        return [
          {
            varianteId: peca.variante_id,
            produto: peca.produto,
            tamanho: peca.tamanho,
            cor: peca.cor,
            saldoSistema: peca.saldo,
            contado: 1,
          },
          ...atuais,
        ];
      });
    } catch (erro) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setAviso(
        codigoDoErro(erro) === 'NAO_ENCONTRADO'
          ? `Código ${codigo} não está cadastrado.`
          : mensagemDoErro(erro),
      );
    } finally {
      buscando.current = false;
    }
  }, []);

  const enviar = useMutation({
    mutationFn: () =>
      estoque.inventariar({
        observacao: 'Contagem pelo aplicativo',
        contagens: contagens.map((c) => ({
          variante_id: c.varianteId,
          quantidade_contada: c.contado,
        })),
      }),
    onSuccess: (resultado) => {
      invalidarAposMovimentoEstoque();
      const resumo =
        resultado.ajustadas === 0
          ? 'Tudo conferido: nenhuma diferença encontrada.'
          : `${resultado.ajustadas} peça(s) ajustada(s), diferença total de ${resultado.diferenca_total}.`;
      Alert.alert('Inventário concluído', resumo, [
        { text: 'Pronto', onPress: () => router.back() },
      ]);
    },
    onError: (erro) => Alert.alert('Não deu para lançar', mensagemDoErro(erro)),
  });

  const comDiferenca = contagens.filter((c) => c.contado !== c.saldoSistema).length;

  return (
    <View style={s.tela}>
      <View style={s.cameraArea}>
        <Scanner
          aoLer={(codigo) => void aoLer(codigo)}
          modo="continuo"
          dica="Bipe cada peça encontrada na loja"
        />
      </View>

      {!!aviso && (
        <Pressable onPress={() => setAviso(null)} style={s.aviso}>
          <Text style={s.avisoTexto}>{aviso}</Text>
        </Pressable>
      )}

      <ScrollView contentContainerStyle={s.conteudo}>
        {contagens.length === 0 ? (
          <View style={s.vazio}>
            <MaterialCommunityIcons
              name="clipboard-list-outline"
              size={36}
              color={cores.textoFraco}
            />
            <Text style={s.vazioTexto}>
              Bipe as peças que estão fisicamente na loja. Só o que você contar entra no acerto.
            </Text>
          </View>
        ) : (
          contagens.map((c) => {
            const diferenca = c.contado - c.saldoSistema;
            return (
              <View key={c.varianteId} style={s.item}>
                <View style={s.itemInfo}>
                  <Text style={s.itemNome} numberOfLines={1}>
                    {c.produto}
                  </Text>
                  <Text style={s.itemDetalhe}>
                    {c.tamanho} · {c.cor} · sistema {c.saldoSistema}
                  </Text>
                </View>
                <View style={s.itemNumeros}>
                  <Text style={s.contado}>{c.contado}</Text>
                  {diferenca !== 0 && (
                    <Etiqueta
                      texto={diferenca > 0 ? `+${diferenca}` : String(diferenca)}
                      cor={diferenca > 0 ? cores.sucessoFraco : cores.perigoFraco}
                      corTexto={diferenca > 0 ? cores.acaoEscura : cores.perigo}
                    />
                  )}
                </View>
              </View>
            );
          })
        )}
      </ScrollView>

      <View style={s.rodape}>
        <Text style={s.resumo}>
          {contagens.length} peça(s) contada(s)
          {comDiferenca > 0 ? ` · ${comDiferenca} com diferença` : ''}
        </Text>
        <Botao
          titulo="Lançar inventário"
          variante="acao"
          grande
          desabilitado={contagens.length === 0}
          carregando={enviar.isPending}
          onPress={() =>
            Alert.alert(
              'Lançar inventário?',
              'O saldo das peças contadas passa a ser o que você contou.',
              [
                { text: 'Voltar', style: 'cancel' },
                { text: 'Lançar', onPress: () => enviar.mutate() },
              ],
            )
          }
        />
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  tela: { flex: 1, backgroundColor: cores.fundo },
  cameraArea: { height: '32%', backgroundColor: '#000' },

  aviso: { backgroundColor: cores.perigoFraco, padding: espaco.md },
  avisoTexto: { color: cores.perigo, fontSize: fonte.pequena, fontWeight: '600' },

  conteudo: { padding: espaco.lg },
  vazio: { alignItems: 'center', paddingVertical: espaco.xl, gap: espaco.sm },
  vazioTexto: {
    color: cores.textoFraco,
    fontSize: fonte.base,
    textAlign: 'center',
    paddingHorizontal: espaco.lg,
  },

  item: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: cores.superficie,
    borderRadius: raio.md,
    padding: espaco.md,
    marginBottom: espaco.sm,
    gap: espaco.md,
    minHeight: ALVO_TOQUE,
  },
  itemInfo: { flex: 1 },
  itemNome: { fontSize: fonte.base, fontWeight: '700', color: cores.texto },
  itemDetalhe: { fontSize: fonte.pequena, color: cores.textoSuave, marginTop: 2 },
  itemNumeros: { alignItems: 'center', gap: espaco.xs },
  contado: { fontSize: fonte.titulo, fontWeight: '800', color: cores.texto },

  rodape: {
    padding: espaco.lg,
    backgroundColor: cores.superficie,
    borderTopWidth: 1,
    borderTopColor: cores.borda,
    gap: espaco.sm,
  },
  resumo: { fontSize: fonte.base, fontWeight: '700', color: cores.textoSuave },
});
