/**
 * A venda por dentro: confirmação para quem vendeu, e a base do cancelamento, da
 * devolução e do recibo que vai para a cliente.
 */

import { useMutation, useQuery } from '@tanstack/react-query';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Alert, ScrollView, StyleSheet, Text, View } from 'react-native';

import { mensagemDoErro } from '@/api/client';
import { vendas } from '@/api/endpoints';
import type { FormaPagamento } from '@/api/tipos';
import { Botao, Carregando, Cartao, ErroEstado, Etiqueta, Linha, Separador } from '@/components/ui';
import { rotuloPagamento } from '@/lib/cartao';
import { formatar, paraCentavos } from '@/lib/money';
import { chaves, invalidarAposVenda } from '@/lib/queryClient';
import { PODE, pode } from '@/lib/permissoes';
import { cores, espaco, fonte } from '@/lib/tema';
import { useAuthStore } from '@/stores/authStore';

const ROTULO_FORMA: Record<FormaPagamento, string> = {
  DINHEIRO: 'Dinheiro',
  PIX: 'PIX',
  DEBITO: 'Cartão de débito',
  CREDITO: 'Cartão de crédito',
  VALE: 'Vale de troca',
  FIADO: 'Fiado',
};

export default function DetalheVenda() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const usuario = useAuthStore((e) => e.usuario);
  const vendaId = Number(id);

  const consulta = useQuery({
    queryKey: chaves.venda(vendaId),
    queryFn: () => vendas.detalhe(vendaId),
    enabled: Number.isFinite(vendaId),
  });

  // As devoluções já feitas nesta venda. Só existe conversa sobre devolver o que ainda
  // não voltou, e o histórico responde "já devolvi isso?" sem sair da tela.
  const devolucoes = useQuery({
    queryKey: chaves.devolucoesDaVenda(vendaId),
    queryFn: () => vendas.devolucoesDaVenda(vendaId),
    enabled: Number.isFinite(vendaId),
  });

  const cancelar = useMutation({
    mutationFn: (motivo: string) => vendas.cancelar(vendaId, motivo),
    onSuccess: () => {
      invalidarAposVenda();
      void consulta.refetch();
      Alert.alert('Venda cancelada', 'As peças voltaram para o estoque.');
    },
    onError: (e) => Alert.alert('Não deu para cancelar', mensagemDoErro(e)),
  });

  if (consulta.isPending) return <Carregando />;
  if (consulta.isError) {
    return (
      <ErroEstado
        mensagem={mensagemDoErro(consulta.error, 'Venda não encontrada.')}
        aoTentarNovamente={() => void consulta.refetch()}
      />
    );
  }

  const venda = consulta.data;
  const cancelada = venda.status === 'CANCELADA';
  // Estornar é de dono e gerente — quem vende não desfaz a própria venda. A API recusa de
  // qualquer forma; esconder o botão evita oferecer uma ação que daria 403.
  const podeCancelar = !cancelada && pode(usuario?.papel, PODE.CANCELAR_VENDA);
  const podeDevolver = !cancelada && pode(usuario?.papel, PODE.DEVOLVER_VENDA);
  // Sobra alguma peça para voltar? Uma venda inteira já devolvida não abre a tela.
  const temOQueDevolver = venda.itens.some(
    (i) => i.quantidade - (i.quantidade_devolvida ?? 0) > 0,
  );
  const jaDevolvido = devolucoes.data ?? [];

  function pedirMotivo() {
    Alert.prompt?.(
      'Cancelar venda',
      'Por que esta venda está sendo cancelada?',
      [
        { text: 'Voltar', style: 'cancel' },
        {
          text: 'Cancelar venda',
          style: 'destructive',
          // A API exige ao menos 3 caracteres: "ok" viraria 422 e a venda não cancelaria.
          onPress: (motivo?: string) => {
            const texto = (motivo ?? '').trim();
            cancelar.mutate(texto.length >= 3 ? texto : 'Cancelada no aplicativo');
          },
        },
      ],
      'plain-text',
    );

    // Alert.prompt só existe no iOS: no Android o cancelamento usa um motivo padrão.
    if (!Alert.prompt) {
      Alert.alert('Cancelar venda?', 'As peças voltam para o estoque.', [
        { text: 'Voltar', style: 'cancel' },
        {
          text: 'Cancelar venda',
          style: 'destructive',
          onPress: () => cancelar.mutate('Cancelada no aplicativo'),
        },
      ]);
    }
  }

  return (
    <ScrollView contentContainerStyle={s.conteudo}>
      <Cartao estilo={cancelada ? s.cartaoCancelado : undefined}>
        <View style={s.cabecalho}>
          <View>
            <Text style={s.numero}>Venda #{venda.id}</Text>
            <Text style={s.data}>
              {format(new Date(venda.vendida_em), "dd 'de' MMMM 'às' HH:mm", { locale: ptBR })}
            </Text>
            <Text style={s.data}>por {venda.vendedor}</Text>
            {!!venda.cliente && <Text style={s.data}>cliente: {venda.cliente}</Text>}
          </View>
          <Etiqueta
            texto={cancelada ? 'cancelada' : 'concluída'}
            cor={cancelada ? cores.perigoFraco : cores.sucessoFraco}
            corTexto={cancelada ? cores.perigo : cores.acaoEscura}
          />
        </View>

        {cancelada && !!venda.motivo_cancelamento && (
          <Text style={s.motivo}>Motivo: {venda.motivo_cancelamento}</Text>
        )}
      </Cartao>

      <Cartao>
        <Text style={s.secao}>Peças</Text>
        {venda.itens.map((item) => (
          <View key={item.id} style={s.item}>
            <View style={s.itemInfo}>
              <Text style={s.itemNome}>{item.produto}</Text>
              <Text style={s.itemDetalhe}>
                {item.tamanho} · {item.cor} · {item.quantidade}x{' '}
                {formatar(paraCentavos(item.preco_unitario))}
              </Text>
              {(item.quantidade_devolvida ?? 0) > 0 && (
                <Text style={s.itemDevolvido}>
                  {item.quantidade_devolvida} devolvida(s)
                </Text>
              )}
            </View>
            <Text style={s.itemTotal}>{formatar(paraCentavos(item.total_item))}</Text>
          </View>
        ))}

        <Separador />
        <Linha esquerda="Subtotal" direita={formatar(paraCentavos(venda.subtotal))} />
        {paraCentavos(venda.desconto) > 0 && (
          <Linha
            esquerda="Desconto"
            direita={`− ${formatar(paraCentavos(venda.desconto))}`}
          />
        )}
        <Linha esquerda="Total" direita={formatar(paraCentavos(venda.total))} destaque />
      </Cartao>

      <Cartao>
        <Text style={s.secao}>Pagamento</Text>
        {venda.pagamentos.map((p, indice) => (
          <Linha
            key={`${p.forma}-${indice}`}
            esquerda={rotuloPagamento(p, ROTULO_FORMA)}
            direita={formatar(paraCentavos(p.valor))}
          />
        ))}
      </Cartao>

      {/* Custo e lucro só existem na resposta para quem vê dinheiro. */}
      {venda.lucro_bruto !== undefined && (
        <Cartao>
          <Text style={s.secao}>Resultado da venda</Text>
          <Linha
            esquerda="Custo das peças"
            direita={formatar(paraCentavos(venda.custo_total ?? '0'))}
          />
          <Linha
            esquerda="Lucro bruto"
            direita={formatar(paraCentavos(venda.lucro_bruto))}
            destaque
          />
          {/* A taxa fotografada na venda (ADR-35). O lucro bruto não a desconta; o
              Resultado dos relatórios, sim. */}
          {paraCentavos(venda.taxas_cartao ?? '0') > 0 && (
            <Linha
              esquerda="Taxa da maquininha"
              direita={`− ${formatar(paraCentavos(venda.taxas_cartao ?? '0'))}`}
            />
          )}
        </Cartao>
      )}

      {jaDevolvido.length > 0 && (
        <Cartao>
          <Text style={s.secao}>Devoluções</Text>
          {jaDevolvido.map((d) => (
            <Linha
              key={d.id}
              esquerda={format(new Date(d.devolvida_em), 'dd/MM/yyyy', { locale: ptBR })}
              direita={`− ${formatar(paraCentavos(d.total))}`}
            />
          ))}
        </Cartao>
      )}

      <View style={s.acoes}>
        <Botao
          titulo="Recibo para a cliente"
          variante="secundario"
          onPress={() =>
            router.push({ pathname: '/venda/recibo', params: { id: String(venda.id) } })
          }
        />
        {podeDevolver && temOQueDevolver && (
          <Botao
            titulo="Devolver peça desta venda"
            variante="secundario"
            onPress={() =>
              router.push({ pathname: '/venda/devolucao', params: { venda: String(venda.id) } })
            }
          />
        )}
        {podeCancelar && (
          <Botao
            titulo="Cancelar esta venda"
            variante="perigo"
            carregando={cancelar.isPending}
            onPress={pedirMotivo}
          />
        )}
        <Botao titulo="Nova venda" onPress={() => router.replace('/(app)/(tabs)')} />
      </View>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  conteudo: { padding: espaco.lg, paddingBottom: espaco.xxl },
  cartaoCancelado: { borderLeftWidth: 4, borderLeftColor: cores.perigo },
  cabecalho: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  numero: { fontSize: fonte.grande, fontWeight: '800', color: cores.texto },
  data: { fontSize: fonte.pequena, color: cores.textoSuave, marginTop: 2 },
  motivo: { fontSize: fonte.pequena, color: cores.perigo, marginTop: espaco.sm },

  secao: {
    fontSize: fonte.pequena,
    fontWeight: '700',
    color: cores.textoSuave,
    marginBottom: espaco.sm,
    textTransform: 'uppercase',
  },
  item: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: espaco.sm,
    gap: espaco.sm,
  },
  itemInfo: { flex: 1 },
  itemNome: { fontSize: fonte.base, fontWeight: '600', color: cores.texto },
  itemDetalhe: { fontSize: fonte.pequena, color: cores.textoSuave, marginTop: 2 },
  itemTotal: { fontSize: fonte.base, fontWeight: '700', color: cores.texto },
  itemDevolvido: { fontSize: fonte.micro, color: cores.perigo, marginTop: 2 },

  acoes: { gap: espaco.sm, marginTop: espaco.sm },
});
