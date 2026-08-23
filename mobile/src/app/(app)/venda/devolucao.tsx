/**
 * Devolução no celular: a cliente voltou com a peça.
 *
 * Espelha `web/js/views/devolucao.js`. O caminho começa na peça e não na venda, porque é
 * assim que a coisa acontece no balcão: a cliente chega com a blusa e sem nota. Bipa (ou
 * busca pelo nome, quando a etiqueta caiu), o sistema mostra de quais vendas aquela peça
 * saiu, e a devolução parte dali.
 *
 * Quem decide os valores é o servidor (ADR-4). A tela mostra o que ele respondeu — inclusive
 * o código do vale, quando o valor não pode voltar em dinheiro.
 */

import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { mensagemDoErro } from '@/api/client';
import { catalogo, vendas } from '@/api/endpoints';
import type { Devolucao, Venda } from '@/api/tipos';
import { BuscarPeca } from '@/components/BuscarPeca';
import { CodigoManual } from '@/components/CodigoManual';
import { Botao, Cartao, Etiqueta } from '@/components/ui';
import { Scanner } from '@/components/Scanner';
import { formatar, paraCentavos } from '@/lib/money';
import { chaves, invalidarAposDevolucao } from '@/lib/queryClient';
import { gerarUuid } from '@/lib/uuid';
import { ALVO_TOQUE, cores, espaco, fonte, raio } from '@/lib/tema';

export default function DevolucaoTela() {
  const router = useRouter();
  const params = useLocalSearchParams<{ venda?: string }>();
  const [varianteId, setVarianteId] = useState<number | null>(null);
  const [rotuloPeca, setRotuloPeca] = useState('');
  const [vendaId, setVendaId] = useState<number | null>(
    params.venda ? Number(params.venda) : null,
  );
  const [quantidades, setQuantidades] = useState<Record<number, number>>({});
  // Peça manchada ou rasgada volta para a loja, não para a arara: o dinheiro sai igual,
  // mas o estoque não sobe. Sem esta escolha a vendedora devolveria e depois teria que
  // lembrar de fazer um ajuste — e é justamente disso que o estoque adoece.
  const [naoVolta, setNaoVolta] = useState<Record<number, boolean>>({});
  const [devolvidos, setDevolvidos] = useState<Devolucao | null>(null);
  // O uuid nasce com a devolução que está sendo montada, não a cada envio. Resposta
  // perdida na rede + tentar de novo com uuid novo = peça devolvida duas vezes e dinheiro
  // saindo duas vezes da gaveta. Com o mesmo uuid, o servidor responde a MESMA devolução.
  const [clientUuid, setClientUuid] = useState(() => gerarUuid());
  const [lendo, setLendo] = useState(false);

  // As chaves vêm de `chaves` de propósito: `invalidarAposDevolucao` derruba `['vendas']`
  // e `chaves.venda(id)`, e uma chave inventada aqui não casaria por prefixo — a tela
  // reabriria com o `quantidade_devolvida` de antes e ofereceria devolver o que já voltou.
  const listaDeVendas = useQuery({
    queryKey: [...chaves.vendas, { variante_id: varianteId }],
    queryFn: () => vendas.listar({ variante_id: varianteId!, size: 20 }),
    enabled: varianteId != null,
  });

  const venda = useQuery({
    queryKey: chaves.venda(vendaId ?? 0),
    queryFn: () => vendas.detalhe(vendaId!),
    enabled: vendaId != null,
  });

  async function aoLer(codigo: string) {
    try {
      const peca = await catalogo.porCodigoBarras(codigo);
      setVendaId(null);
      setVarianteId(peca.variante_id);
      setRotuloPeca(`${peca.produto} ${peca.tamanho} · ${peca.cor}`);
      setLendo(false);
    } catch (erro) {
      Alert.alert('Não achei a peça', mensagemDoErro(erro));
    }
  }

  const devolver = useMutation({
    mutationFn: () =>
      vendas.devolver(vendaId!, {
        client_uuid: clientUuid,
        itens: Object.entries(quantidades)
          .filter(([, q]) => q > 0)
          .map(([itemId, q]) => ({
            item_id: Number(itemId),
            quantidade: q,
            voltar_ao_estoque: !naoVolta[Number(itemId)],
          })),
      }),
    onSuccess: (devolucao) => {
      invalidarAposDevolucao(vendaId!);
      setDevolvidos(devolucao);
    },
    onError: (erro) => Alert.alert('Não deu para devolver', mensagemDoErro(erro)),
  });

  /* ------------------------------------------------------------ resultado */

  if (devolvidos) {
    const vale = devolvidos.pagamentos.find((p) => p.codigo_vale);
    return (
      <ScrollView contentContainerStyle={s.conteudo}>
        <Cartao>
          <Text style={s.titulo}>Devolução registrada</Text>
          <Text style={s.valorGrande}>{formatar(paraCentavos(devolvidos.total))}</Text>
          {devolvidos.pagamentos.map((p, i) => (
            <View key={i} style={s.linha}>
              <Text style={s.rotulo}>{p.forma.toLowerCase()}</Text>
              <Text style={s.valor}>{formatar(paraCentavos(p.valor))}</Text>
            </View>
          ))}
          {!!vale && (
            <View style={s.vale}>
              <Text style={s.valeTitulo}>Vale {vale.codigo_vale}</Text>
              <Text style={s.valeTexto}>
                Anote no papel e entregue à cliente. Ele é aceito como pagamento na próxima
                compra — é assim que a troca acontece.
              </Text>
            </View>
          )}
        </Cartao>
        <Botao
          titulo="Devolver outra peça"
          onPress={() => {
            setDevolvidos(null);
            setVendaId(null);
            setVarianteId(null);
            setQuantidades({});
            setNaoVolta({});
            // Outra devolução é outra devolução: uuid novo, senão o servidor devolveria o
            // registro da anterior como se fosse replay desta.
            setClientUuid(gerarUuid());
          }}
        />
        <Botao titulo="Voltar" variante="secundario" onPress={() => router.back()} />
      </ScrollView>
    );
  }

  /* ------------------------------------------------- escolher o que volta */

  if (vendaId && venda.data) {
    const disponivel = (item: Venda['itens'][number]) =>
      item.quantidade - (item.quantidade_devolvida ?? 0);
    const total = Object.values(quantidades).reduce((t, q) => t + q, 0);

    return (
      <ScrollView contentContainerStyle={s.conteudo}>
        <Text style={s.titulo}>Venda #{venda.data.id}</Text>
        {venda.data.itens.map((item) => {
          const podeVoltar = disponivel(item);
          const escolhida = quantidades[item.id] ?? 0;
          return (
            <Cartao key={item.id}>
              <Text style={s.itemNome}>{item.produto}</Text>
              <Text style={s.itemDetalhe}>
                {item.tamanho} · {item.cor} · levou {item.quantidade}
                {(item.quantidade_devolvida ?? 0) > 0
                  ? ` · ${item.quantidade_devolvida} já voltou`
                  : ''}
              </Text>
              {podeVoltar > 0 ? (
                <View style={s.contador}>
                  <Pressable
                    style={s.contadorBotao}
                    onPress={() =>
                      setQuantidades((a) => ({ ...a, [item.id]: Math.max(0, escolhida - 1) }))
                    }
                  >
                    <Text style={s.contadorSinal}>−</Text>
                  </Pressable>
                  <Text style={s.contadorValor}>{escolhida}</Text>
                  <Pressable
                    style={s.contadorBotao}
                    onPress={() =>
                      setQuantidades((a) => ({
                        ...a,
                        [item.id]: Math.min(podeVoltar, escolhida + 1),
                      }))
                    }
                  >
                    <Text style={s.contadorSinal}>+</Text>
                  </Pressable>
                </View>
              ) : (
                <Etiqueta texto="já devolvida" cor={cores.superficieAlt} corTexto={cores.textoSuave} />
              )}

              {escolhida > 0 && (
                <Pressable
                  style={s.voltaLinha}
                  accessibilityRole="switch"
                  accessibilityState={{ checked: !naoVolta[item.id] }}
                  onPress={() =>
                    setNaoVolta((a) => ({ ...a, [item.id]: !a[item.id] }))
                  }
                >
                  <View style={[s.caixinha, !naoVolta[item.id] && s.caixinhaMarcada]}>
                    {!naoVolta[item.id] && <Text style={s.caixinhaMarca}>✓</Text>}
                  </View>
                  <Text style={s.voltaTexto}>
                    {naoVolta[item.id]
                      ? 'Não volta ao estoque (peça com defeito)'
                      : 'Volta ao estoque'}
                  </Text>
                </Pressable>
              )}
            </Cartao>
          );
        })}
        <Botao
          titulo={total ? `Devolver ${total} peça(s)` : 'Escolha o que está voltando'}
          onPress={() =>
            Alert.alert('Confirmar devolução', 'O estoque e o dinheiro são ajustados na hora.', [
              { text: 'Não', style: 'cancel' },
              { text: 'Devolver', onPress: () => devolver.mutate() },
            ])
          }
          carregando={devolver.isPending}
        />
        <Botao
          titulo="Escolher outra venda"
          variante="secundario"
          onPress={() => setVendaId(null)}
        />
      </ScrollView>
    );
  }

  /* --------------------------------------------------------- achar a venda */

  return (
    <View style={s.tela}>
      {lendo ? (
        <View style={s.cameraArea}>
          <Scanner aoLer={(c) => void aoLer(c)} modo="unico" dica="Bipe a peça devolvida" />
        </View>
      ) : (
        <View style={s.acoes}>
          <Botao titulo="Ler código de barras" onPress={() => setLendo(true)} />
          <View style={s.acoesLinha}>
            <CodigoManual aoConfirmar={(c) => void aoLer(c)} />
            <BuscarPeca
              aoEscolher={(peca) => {
                setVendaId(null);
                setVarianteId(peca.id);
                setRotuloPeca(`${peca.produto} ${peca.tamanho} · ${peca.cor}`);
              }}
            />
          </View>
        </View>
      )}

      <ScrollView contentContainerStyle={s.conteudo}>
        {varianteId == null ? (
          <View style={s.vazio}>
            <MaterialCommunityIcons name="keyboard-return" size={36} color={cores.textoFraco} />
            <Text style={s.vazioTexto}>
              Comece pela peça: bipe a etiqueta ou procure pelo nome. O sistema mostra de
              quais vendas ela saiu.
            </Text>
          </View>
        ) : listaDeVendas.isLoading ? (
          <Text style={s.vazioTexto}>Procurando…</Text>
        ) : !listaDeVendas.data?.items.length ? (
          <Text style={s.vazioTexto}>
            {rotuloPeca} não saiu por nenhuma venda registrada.
          </Text>
        ) : (
          <>
            <Text style={s.itemDetalhe}>Vendas com {rotuloPeca}</Text>
            {listaDeVendas.data.items.map((v) => (
              <Pressable
                key={v.id}
                onPress={() => v.status === 'CONCLUIDA' && setVendaId(v.id)}
                style={[s.vendaLinha, v.status !== 'CONCLUIDA' && s.vendaCancelada]}
              >
                <View style={{ flex: 1 }}>
                  <Text style={s.itemNome}>Venda #{v.id}</Text>
                  <Text style={s.itemDetalhe}>
                    {new Date(v.vendida_em).toLocaleDateString('pt-BR')} · {v.vendedor}
                  </Text>
                </View>
                <Text style={s.valor}>{formatar(paraCentavos(v.total))}</Text>
              </Pressable>
            ))}
          </>
        )}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  tela: { flex: 1, backgroundColor: cores.fundo },
  cameraArea: { height: 300 },
  acoes: { padding: espaco.lg, gap: espaco.sm },
  acoesLinha: { flexDirection: 'row', gap: espaco.sm },
  conteudo: { padding: espaco.lg, gap: espaco.sm },

  titulo: { fontSize: fonte.grande, fontWeight: '800', color: cores.texto },
  valorGrande: {
    fontSize: 30,
    fontWeight: '800',
    color: cores.texto,
    marginVertical: espaco.sm,
  },
  voltaLinha: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: espaco.sm,
    marginTop: espaco.sm,
    minHeight: ALVO_TOQUE - 8,
  },
  caixinha: {
    width: 24,
    height: 24,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: cores.bordaForte,
    alignItems: 'center',
    justifyContent: 'center',
  },
  caixinhaMarcada: { backgroundColor: cores.acao, borderColor: cores.acao },
  caixinhaMarca: { color: cores.aoFundoEscuro, fontSize: fonte.pequena, fontWeight: '900' },
  voltaTexto: { flex: 1, fontSize: fonte.pequena, color: cores.textoSuave },

  linha: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 },
  rotulo: { color: cores.textoSuave, fontSize: fonte.base, textTransform: 'capitalize' },
  valor: { color: cores.texto, fontSize: fonte.base, fontWeight: '700' },

  itemNome: { fontSize: fonte.base, fontWeight: '700', color: cores.texto },
  itemDetalhe: { fontSize: fonte.pequena, color: cores.textoSuave, marginTop: 2 },

  contador: { flexDirection: 'row', alignItems: 'center', gap: espaco.md, marginTop: espaco.sm },
  contadorBotao: {
    width: ALVO_TOQUE,
    height: ALVO_TOQUE,
    borderRadius: raio.md,
    backgroundColor: cores.superficieAlt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  contadorSinal: { fontSize: 24, color: cores.texto },
  contadorValor: { fontSize: fonte.grande, fontWeight: '800', minWidth: 32, textAlign: 'center' },

  vendaLinha: {
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
  vendaCancelada: { opacity: 0.5 },

  vale: {
    marginTop: espaco.lg,
    padding: espaco.md,
    borderRadius: raio.md,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: cores.primaria,
  },
  valeTitulo: { fontSize: fonte.grande, fontWeight: '800', color: cores.primaria },
  valeTexto: { fontSize: fonte.pequena, color: cores.textoSuave, marginTop: 4, lineHeight: 18 },

  vazio: { alignItems: 'center', gap: espaco.sm, paddingVertical: espaco.xl },
  vazioTexto: {
    color: cores.textoSuave,
    fontSize: fonte.base,
    textAlign: 'center',
    lineHeight: 22,
  },
});
