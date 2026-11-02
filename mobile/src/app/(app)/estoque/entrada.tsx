/**
 * Entrada de mercadoria por bipagem contínua.
 *
 * O fluxo real do estoquista é: abrir a caixa e bipar peça por peça. A tela soma sozinha e
 * só envia no final, em uma única requisição — com client_uuid, para um reenvio depois de
 * queda de rede não somar o estoque duas vezes.
 *
 * Quem vê dinheiro pode lançar junto a nota do fornecedor: valor e vencimentos viram Contas
 * a pagar na MESMA transação da entrada (ADR-40). A vendedora dá entrada sem ela.
 */

import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useMutation } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useCallback, useRef, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { codigoDoErro, detalheDoErro, mensagemDoErro } from '@/api/client';
import { catalogo, estoque } from '@/api/endpoints';
import { BuscarPeca } from '@/components/BuscarPeca';
import { NOTA_VAZIA, NotaFornecedor, notaParaApi, type EstadoNota } from '@/components/NotaFornecedor';
import { CodigoManual } from '@/components/CodigoManual';
import { Scanner } from '@/components/Scanner';
import { Botao, Campo } from '@/components/ui';
import { type ItemGravado, tirarOQueJaEntrou } from '@/lib/entrada';
import { gerarUuid } from '@/lib/uuid';
import { PODE, pode } from '@/lib/permissoes';
import { chaves, invalidarAposMovimentoEstoque, queryClient } from '@/lib/queryClient';
import { useAuthStore } from '@/stores/authStore';
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
  const [clientUuid, setClientUuid] = useState(() => gerarUuid());
  const [consultando, setConsultando] = useState(false);
  const [nota, setNota] = useState<EstadoNota>(NOTA_VAZIA);
  const veDinheiro = pode(useAuthStore((e) => e.usuario?.papel), PODE.VER_DINHEIRO);
  const buscando = useRef(false);

  /** Soma uma peça à conferência, venha ela do bipe ou da busca pelo nome. */
  const somar = useCallback(
    (peca: { varianteId: number; produto: string; tamanho: string; cor: string; codigo: string }) => {
      setItens((atuais) => {
        const existente = atuais.find((i) => i.varianteId === peca.varianteId);
        if (existente) {
          return atuais.map((i) =>
            i.varianteId === peca.varianteId ? { ...i, quantidade: i.quantidade + 1 } : i,
          );
        }
        return [{ ...peca, quantidade: 1 }, ...atuais];
      });
    },
    [],
  );

  const aoLer = useCallback(async (codigo: string) => {
    if (buscando.current) return;
    buscando.current = true;
    setConsultando(true);
    setAviso(null);
    try {
      const peca = await catalogo.porCodigoBarras(codigo);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      somar({
        varianteId: peca.variante_id,
        produto: peca.produto,
        tamanho: peca.tamanho,
        cor: peca.cor,
        codigo: peca.codigo_barras,
      });
    } catch (erro) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setAviso(
        codigoDoErro(erro) === 'NAO_ENCONTRADO'
          ? `Código ${codigo} não está cadastrado. Se a peça é nova, cadastre-a em Produtos — o estoque inicial entra junto.`
          : mensagemDoErro(erro),
      );
    } finally {
      buscando.current = false;
      setConsultando(false);
    }
  }, [somar]);

  const salvar = useMutation({
    mutationFn: () => {
      const notaApi = veDinheiro ? notaParaApi(nota) : null;
      return estoque.registrarEntrada({
        client_uuid: clientUuid,
        fornecedor: fornecedor.trim() || null,
        itens: itens.map((i) => ({ variante_id: i.varianteId, quantidade: i.quantidade })),
        ...(notaApi ? { nota: notaApi } : {}),
      });
    },
    onSuccess: (entrada) => {
      invalidarAposMovimentoEstoque();
      if (entrada.contas_a_pagar) queryClient.invalidateQueries({ queryKey: chaves.contasPagar });
      setNota(NOTA_VAZIA);
      // Limpa e troca o UUID ANTES do alerta: no Android o alerta pode ser fechado pelo
      // botão voltar sem rodar o onPress, e a próxima entrada reusaria a chave de
      // idempotência — o servidor devolveria a entrada antiga e as peças novas sumiriam.
      setItens([]);
      setFornecedor('');
      setClientUuid(gerarUuid());
      Alert.alert(
        'Entrada registrada',
        `${entrada.total_pecas} peça(s) somadas ao estoque.` +
          (entrada.contas_a_pagar ? ` ${entrada.contas_a_pagar} parcela(s) foram para Contas a pagar.` : ''),
        [{ text: 'Pronto', onPress: () => router.back() }],
      );
    },
    onError: (erro) => {
      if (codigoDoErro(erro) === 'DUPLICADO' && detalheDoErro(erro)?.entrada_id) {
        // Esta chave já gravou OUTRA entrada (a resposta se perdeu e a lista mudou depois):
        // o servidor recusa em vez de devolver a antiga como sucesso (ADR-2). O que ela
        // gravou sai da lista ANTES de a chave ser trocada — só trocar a chave e reenviar
        // tudo somaria de novo as peças que já entraram. Fica o que falta registrar.
        const gravados = (detalheDoErro(erro)?.itens ?? []) as ItemGravado[];
        setItens((atuais) => tirarOQueJaEntrou(atuais, gravados));
        setClientUuid(gerarUuid());
        Alert.alert(
          'Esta entrada já foi gravada',
          `${mensagemDoErro(erro)} Tirei da lista o que ela já gravou; confira e registre o que falta.`,
          [
            { text: 'Conferir a lista', style: 'cancel' },
            { text: 'Ver extrato', onPress: () => router.push('/estoque/movimentacoes') },
          ],
        );
        return;
      }
      Alert.alert('Não deu para registrar', mensagemDoErro(erro));
    },
  });

  const totalPecas = itens.reduce((soma, i) => soma + i.quantidade, 0);

  return (
    <View style={s.tela}>
      <View style={s.cameraArea}>
        <Scanner
          aoLer={(codigo) => void aoLer(codigo)}
          modo="continuo"
          ocupado={consultando}
          dica={consultando ? 'Consultando…' : 'Bipe a etiqueta — ou busque pelo nome'}
        />
      </View>

      {/* Bipar serve para a peça JÁ etiquetada. Mercadoria que chega do fornecedor vem sem
          a nossa etiqueta — nesse caso o caminho é o nome. */}
      <View style={s.barraCodigo}>
        <CodigoManual aoConfirmar={(codigo) => void aoLer(codigo)} />
        <BuscarPeca
          aoEscolher={(peca) =>
            somar({
              varianteId: peca.id,
              produto: peca.produto,
              tamanho: peca.tamanho,
              cor: peca.cor,
              codigo: peca.codigo_barras,
            })
          }
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
        {veDinheiro && <NotaFornecedor nota={nota} aoMudar={setNota} />}

        {itens.length === 0 ? (
          <View style={s.vazio}>
            <MaterialCommunityIcons name="tray-arrow-down" size={36} color={cores.textoFraco} />
            <Text style={s.vazioTexto}>Nenhuma peça conferida ainda</Text>
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
          onPress={() => {
            // A nota que não fecha é avisada ANTES de enviar, com a frase dela.
            try {
              if (veDinheiro) notaParaApi(nota);
            } catch (erro) {
              Alert.alert('Nota do fornecedor', (erro as Error).message);
              return;
            }
            salvar.mutate();
          }}
        />
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  tela: { flex: 1, backgroundColor: cores.fundo },
  cameraArea: { height: '34%', backgroundColor: '#000' },

  barraCodigo: {
    flexDirection: 'row',
    gap: espaco.sm,
    paddingHorizontal: espaco.lg,
    paddingTop: espaco.sm,
    alignItems: 'flex-start',
  },
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
