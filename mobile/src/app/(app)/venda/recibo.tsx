/**
 * Recibo da venda, para dar à cliente.
 *
 * Não é nota fiscal e não finge ser — está escrito no rodapé. É o papel que a loja de
 * bairro entrega há sempre: o que levou, quanto pagou, quando, com quem.
 *
 * **No celular não existe bobina.** O caminho real é o WhatsApp: a vendedora manda o
 * recibo para a cliente antes mesmo de ela sair da loja. Por isso a tela mostra o recibo e
 * o botão principal é "Enviar" — `Share` do próprio React Native, sem dependência nova
 * (mexer em dependência do Expo é mexer no SDK 54, ADR-14).
 *
 * O que NÃO entra aqui: custo, margem e qualquer número de dentro da loja. O recibo vai
 * para a mão da cliente.
 */

import { useQuery } from '@tanstack/react-query';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { useLocalSearchParams } from 'expo-router';
import { Alert, Share, StyleSheet, Text, View, ScrollView } from 'react-native';

import { mensagemDoErro } from '@/api/client';
import { vendas } from '@/api/endpoints';
import type { ConfiguracaoLoja, FormaPagamento, Venda } from '@/api/tipos';
import { Botao, Carregando, ErroEstado } from '@/components/ui';
import { rotuloPagamento } from '@/lib/cartao';
import { formatar, formatarSemSimbolo, paraCentavos } from '@/lib/money';
import { chaves } from '@/lib/queryClient';
import { cores, espaco, fonte, raio } from '@/lib/tema';
import { useDadosDaLoja } from '@/hooks/useLoja';

const ROTULO_FORMA: Record<FormaPagamento, string> = {
  DINHEIRO: 'Dinheiro',
  PIX: 'PIX',
  DEBITO: 'Cartão de débito',
  CREDITO: 'Cartão de crédito',
  VALE: 'Vale de troca',
  FIADO: 'Fiado',
};

const RODAPE_TROCA = 'Troca em até 30 dias, com este recibo e a etiqueta na peça.';
const RODAPE_FISCAL = 'Documento sem valor fiscal.';

/** O bastante da loja para o papel: `reciboEmTexto` roda fora do React e não tem hook. */
type DadosDaLoja = Pick<ConfiguracaoLoja, 'nome' | 'documento' | 'telefone' | 'endereco'>;

/** O mesmo recibo em texto puro, do jeito que chega legível no WhatsApp. */
export function reciboEmTexto(venda: Venda, loja?: DadosDaLoja): string {
  const linhas: string[] = [
    `*${loja?.nome ?? 'Minha Loja'}*`,
    ...[loja?.documento, loja?.endereco, loja?.telefone].filter(Boolean).map(String),
    format(new Date(venda.vendida_em), "dd/MM/yyyy 'às' HH:mm", { locale: ptBR }),
    `Venda #${venda.id} · ${venda.vendedor}`,
  ];
  if (venda.cliente) linhas.push(`Cliente: ${venda.cliente}`);
  linhas.push('');

  for (const item of venda.itens) {
    linhas.push(`${item.quantidade}x ${item.produto} (${item.tamanho} · ${item.cor})`);
    linhas.push(
      `   ${formatarSemSimbolo(paraCentavos(item.preco_unitario))} = R$ ${formatarSemSimbolo(
        paraCentavos(item.total_item),
      )}`,
    );
  }

  linhas.push('');
  linhas.push(`Subtotal: ${formatar(paraCentavos(venda.subtotal))}`);
  if (paraCentavos(venda.desconto) > 0) {
    linhas.push(`Desconto: − ${formatar(paraCentavos(venda.desconto))}`);
  }
  linhas.push(`*Total: ${formatar(paraCentavos(venda.total))}*`);
  linhas.push('');

  for (const p of venda.pagamentos) {
    linhas.push(`${rotuloPagamento(p, ROTULO_FORMA)}: ${formatar(paraCentavos(p.valor))}`);
  }

  if (venda.pagamentos.some((p) => p.forma === 'FIADO')) {
    linhas.push('');
    linhas.push('Parte desta compra ficou no fiado. Guarde este recibo para o acerto.');
  }

  linhas.push('');
  linhas.push(RODAPE_TROCA);
  linhas.push(RODAPE_FISCAL);
  return linhas.join('\n');
}

export default function Recibo() {
  // Documento e contato da loja só vêm com sessão — o recibo é sempre de quem está logado.
  const loja = useDadosDaLoja();
  const { id } = useLocalSearchParams<{ id: string }>();
  const vendaId = Number(id);

  const consulta = useQuery({
    queryKey: chaves.venda(vendaId),
    queryFn: () => vendas.detalhe(vendaId),
    enabled: Number.isFinite(vendaId),
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
  const temFiado = venda.pagamentos.some((p) => p.forma === 'FIADO');

  async function enviar() {
    try {
      await Share.share({ message: reciboEmTexto(venda, loja) });
    } catch (erro) {
      Alert.alert('Não deu para enviar', mensagemDoErro(erro));
    }
  }

  return (
    <View style={s.tela}>
      <ScrollView contentContainerStyle={s.conteudo}>
        <View style={s.papel}>
          <Text style={s.loja}>{loja.nome}</Text>
          {[loja.documento, loja.endereco, loja.telefone].filter(Boolean).map((linha) => (
            <Text key={String(linha)} style={s.cabecalho}>
              {linha}
            </Text>
          ))}
          <Text style={s.cabecalho}>
            {format(new Date(venda.vendida_em), "dd/MM/yyyy 'às' HH:mm", { locale: ptBR })}
          </Text>
          <Text style={s.cabecalho}>
            Venda #{venda.id} · {venda.vendedor}
          </Text>
          {!!venda.cliente && <Text style={s.cabecalho}>Cliente: {venda.cliente}</Text>}

          <View style={s.tracejado} />

          {venda.itens.map((item) => (
            <View key={item.id} style={s.item}>
              <Text style={s.itemNome}>{item.produto}</Text>
              <View style={s.itemLinha}>
                <Text style={s.itemDetalhe}>
                  {item.quantidade} × {formatar(paraCentavos(item.preco_unitario))} ·{' '}
                  {item.tamanho} · {item.cor}
                </Text>
                <Text style={s.itemValor}>{formatar(paraCentavos(item.total_item))}</Text>
              </View>
            </View>
          ))}

          <View style={s.tracejado} />

          <View style={s.conta}>
            <Text style={s.contaRotulo}>Subtotal</Text>
            <Text style={s.contaValor}>{formatar(paraCentavos(venda.subtotal))}</Text>
          </View>
          {paraCentavos(venda.desconto) > 0 && (
            <View style={s.conta}>
              <Text style={s.contaRotulo}>Desconto</Text>
              <Text style={s.contaValor}>− {formatar(paraCentavos(venda.desconto))}</Text>
            </View>
          )}
          <View style={[s.conta, s.contaTotal]}>
            <Text style={s.totalRotulo}>Total</Text>
            <Text style={s.totalValor}>{formatar(paraCentavos(venda.total))}</Text>
          </View>

          {venda.pagamentos.map((p, i) => (
            <View key={`${p.forma}-${i}`} style={s.conta}>
              <Text style={s.contaRotulo}>{rotuloPagamento(p, ROTULO_FORMA)}</Text>
              <Text style={s.contaValor}>{formatar(paraCentavos(p.valor))}</Text>
            </View>
          ))}

          {temFiado && (
            <Text style={s.aviso}>
              Parte desta compra ficou no fiado. Guarde este recibo para conferir o acerto.
            </Text>
          )}

          <View style={s.tracejado} />
          <Text style={s.rodape}>{RODAPE_TROCA}</Text>
          <Text style={s.rodapeMiudo}>{RODAPE_FISCAL}</Text>
        </View>
      </ScrollView>

      <View style={s.acoes}>
        <Botao titulo="Enviar recibo" grande onPress={() => void enviar()} />
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  tela: { flex: 1, backgroundColor: cores.fundo },
  conteudo: { padding: espaco.lg, paddingBottom: espaco.xxl },

  papel: {
    backgroundColor: cores.superficie,
    borderRadius: raio.md,
    padding: espaco.lg,
    borderWidth: 1,
    borderColor: cores.borda,
  },
  loja: { fontSize: fonte.media, fontWeight: '800', color: cores.texto, textAlign: 'center' },
  cabecalho: {
    fontSize: fonte.pequena,
    color: cores.textoSuave,
    textAlign: 'center',
    marginTop: 2,
  },

  tracejado: {
    borderTopWidth: 1,
    borderTopColor: cores.borda,
    borderStyle: 'dashed',
    marginVertical: espaco.md,
  },

  item: { marginBottom: espaco.sm },
  itemNome: { fontSize: fonte.base, fontWeight: '600', color: cores.texto },
  itemLinha: { flexDirection: 'row', justifyContent: 'space-between', gap: espaco.sm },
  itemDetalhe: { flex: 1, fontSize: fonte.pequena, color: cores.textoSuave },
  itemValor: { fontSize: fonte.pequena, color: cores.texto, fontWeight: '600' },

  conta: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3 },
  contaRotulo: { fontSize: fonte.base, color: cores.textoSuave },
  contaValor: { fontSize: fonte.base, color: cores.texto, fontWeight: '600' },
  contaTotal: {
    borderTopWidth: 1,
    borderTopColor: cores.borda,
    marginTop: espaco.xs,
    paddingTop: espaco.sm,
  },
  totalRotulo: { fontSize: fonte.media, fontWeight: '800', color: cores.texto },
  totalValor: { fontSize: fonte.media, fontWeight: '800', color: cores.texto },

  aviso: {
    fontSize: fonte.pequena,
    color: '#7A5A00',
    backgroundColor: cores.alertaFraco,
    borderRadius: raio.sm,
    padding: espaco.sm,
    marginTop: espaco.sm,
  },

  rodape: { fontSize: fonte.pequena, color: cores.textoSuave, textAlign: 'center' },
  rodapeMiudo: {
    fontSize: fonte.micro,
    color: cores.textoFraco,
    textAlign: 'center',
    marginTop: 2,
  },

  acoes: {
    padding: espaco.lg,
    backgroundColor: cores.superficie,
    borderTopWidth: 1,
    borderTopColor: cores.borda,
  },
});
