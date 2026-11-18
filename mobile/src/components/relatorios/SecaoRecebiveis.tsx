/**
 * "A receber do cartão": quanto a maquininha ainda vai depositar, dia a dia, já sem a taxa.
 *
 * A rota (`GET /relatorios/recebiveis`) nasce junto com o cálculo de taxas da maquininha.
 * Servidor que ainda não a tem responde 404 — `relatorios.recebiveis` devolve `null` e a
 * seção simplesmente não aparece, em vez de pintar erro na tela do dono.
 */

import { useQuery } from '@tanstack/react-query';
import { format } from 'date-fns';
import { Text, View } from 'react-native';

import { relatorios } from '@/api/endpoints';
import { Cartao } from '@/components/ui';
import { formatar, paraCentavos, somar } from '@/lib/money';
import { chaves } from '@/lib/queryClient';

import { r } from './estilos';

const TAMANHO = 100;

export function SecaoRecebiveis({ inicio, fim }: { inicio: string; fim: string }) {
  const consulta = useQuery({
    queryKey: chaves.relatorioRecebiveis(inicio, fim),
    queryFn: () => relatorios.recebiveis(inicio, fim, { size: TAMANHO }),
  });
  const pagina = consulta.data;
  // Sem a rota, com erro ou sem nada a receber: a seção fica de fora.
  if (!pagina || pagina.items.length === 0) return null;

  const liquidos = pagina.items.map((d) => paraCentavos(d.liquido));
  return (
    <Cartao>
      <Text style={r.titulo}>A receber do cartão</Text>
      <Text style={r.legenda}>O que a maquininha deposita em cada dia, já sem a taxa.</Text>
      {pagina.items.map((d) => (
        <View key={d.data} style={r.linha}>
          <View style={r.info}>
            <Text style={r.nome}>{format(new Date(`${d.data}T12:00:00`), 'dd/MM/yyyy')}</Text>
            <Text style={r.detalhe}>
              bruto {formatar(paraCentavos(d.bruto))} · taxa {formatar(paraCentavos(d.taxa))}
            </Text>
          </View>
          <Text style={r.valor}>{formatar(paraCentavos(d.liquido))}</Text>
        </View>
      ))}
      <View style={r.totais}>
        <Text style={r.totalRotulo}>
          {pagina.total > pagina.items.length
            ? `Nos ${pagina.items.length} primeiros dias`
            : 'No período'}
        </Text>
        <Text style={r.totalValor}>{formatar(somar(liquidos))}</Text>
      </View>
    </Cartao>
  );
}
