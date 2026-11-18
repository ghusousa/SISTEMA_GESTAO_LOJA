/**
 * Vendas e comissão por pessoa da equipe, no período (ADR-37).
 *
 * Líquido = vendido − devolvido no período, e a devolução pesa para quem fez a venda
 * original. Os totais vêm do servidor e valem para a equipe inteira, não para a página —
 * é a folha do mês.
 */

import { useQuery } from '@tanstack/react-query';
import { Text, View } from 'react-native';

import { mensagemDoErro } from '@/api/client';
import { relatorios } from '@/api/endpoints';
import { Cartao } from '@/components/ui';
import { percentualParaCampo } from '@/lib/comissao';
import { formatar, paraCentavos } from '@/lib/money';
import { chaves } from '@/lib/queryClient';

import { r } from './estilos';

/** A equipe de uma loja cabe numa página; se não couber, a legenda diz. */
const TAMANHO = 100;

export function SecaoVendedoras({ inicio, fim }: { inicio: string; fim: string }) {
  const consulta = useQuery({
    queryKey: chaves.relatorioVendedoras(inicio, fim),
    queryFn: () => relatorios.vendedoras(inicio, fim, { size: TAMANHO }),
  });

  return (
    <Cartao>
      <Text style={r.titulo}>Vendas por vendedora</Text>
      <Text style={r.legenda}>
        Vendido menos devolvido no período. A comissão sai deste líquido, pela % que valia em
        cada venda; a % entre parênteses é a de hoje, a das vendas novas.
      </Text>
      {consulta.isPending ? (
        <Text style={r.vazio}>Somando…</Text>
      ) : consulta.isError ? (
        <Text style={r.erro}>{mensagemDoErro(consulta.error, 'Não deu para somar a equipe.')}</Text>
      ) : consulta.data.items.length === 0 ? (
        <Text style={r.vazio}>Nenhuma venda no período.</Text>
      ) : (
        <>
          {consulta.data.items.map((v) => {
            const liquido = paraCentavos(v.faturamento_liquido);
            const comissao = paraCentavos(v.comissao);
            return (
              <View key={v.usuario_id} style={r.linha}>
                <View style={r.info}>
                  <Text style={r.nome} numberOfLines={1}>
                    {v.nome}
                  </Text>
                  <Text style={r.detalhe}>
                    {v.quantidade_vendas} venda(s) · {v.pecas} peça(s) · ticket{' '}
                    {formatar(paraCentavos(v.ticket_medio))}
                    {paraCentavos(v.devolucoes) > 0
                      ? ` · voltou ${formatar(paraCentavos(v.devolucoes))}`
                      : ''}
                  </Text>
                </View>
                <View style={r.numeros}>
                  <Text style={[r.valor, liquido < 0 && r.valorNegativo]}>
                    {formatar(liquido)}
                  </Text>
                  <Text style={[r.detalhe, comissao < 0 ? r.valorNegativo : r.valorBom]}>
                    comissão {formatar(comissao)} ({percentualParaCampo(v.comissao_percentual)}%)
                  </Text>
                </View>
              </View>
            );
          })}
          <View style={r.totais}>
            <Text style={r.totalRotulo}>Comissão a pagar</Text>
            <Text style={r.totalValor}>
              {formatar(paraCentavos(consulta.data.comissao_total))}
            </Text>
          </View>
          {consulta.data.total > consulta.data.items.length && (
            <Text style={r.legenda}>
              Mostrando {consulta.data.items.length} de {consulta.data.total}; o total vale para
              todas.
            </Text>
          )}
        </>
      )}
    </Cartao>
  );
}
