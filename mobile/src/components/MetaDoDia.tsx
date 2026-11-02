/**
 * "Hoje: R$ X de R$ meta" no cabeçalho do PDV de quem está logado (ADR-37).
 *
 * Vem de `GET /relatorios/meu-dia`: cada um vê só o PRÓPRIO dia, sem custo, lucro nem
 * comissão, e o vendido já desconta a devolução de hoje — a mesma conta do relatório do
 * dono. Sem meta, não aparece nada. A chave cai com cada venda (relatório) e quando o dono
 * muda a meta (aviso de usuários); se a consulta falhar, a régua some e o PDV segue.
 */

import { useQuery } from '@tanstack/react-query';
import { StyleSheet, Text, View } from 'react-native';

import { relatorios } from '@/api/endpoints';
import { progressoDaMeta } from '@/lib/comissao';
import { formatar, paraCentavos } from '@/lib/money';
import { chaves } from '@/lib/queryClient';
import { cores, espaco, fonte, raio } from '@/lib/tema';

export function MetaDoDia() {
  const consulta = useQuery({ queryKey: chaves.meuDia, queryFn: relatorios.meuDia });
  const dia = consulta.data;
  if (!dia || dia.meta === null) return null;

  const vendido = paraCentavos(dia.vendido);
  const meta = paraCentavos(dia.meta);
  const { pct, falta, batida } = progressoDaMeta(vendido, meta);

  return (
    <View
      style={s.caixa}
      accessibilityLabel={`Hoje você vendeu ${formatar(vendido)} de ${formatar(meta)} da meta`}
    >
      <View style={s.linha}>
        <Text style={s.rotulo}>Hoje</Text>
        <Text style={s.valor}>
          {formatar(vendido)} <Text style={s.meta}>de {formatar(meta)}</Text>
        </Text>
      </View>
      <View style={s.fundo}>
        <View style={[s.barra, batida && s.barraBatida, { width: `${pct}%` }]} />
      </View>
      <Text style={s.nota}>
        {batida ? 'Meta do dia batida' : `Faltam ${formatar(falta)} para a meta`}
      </Text>
    </View>
  );
}

const s = StyleSheet.create({
  caixa: {
    marginHorizontal: espaco.lg,
    marginTop: espaco.sm,
    padding: espaco.md,
    backgroundColor: cores.superficie,
    borderRadius: raio.md,
    borderWidth: 1,
    borderColor: cores.borda,
  },
  linha: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  rotulo: { fontSize: fonte.pequena, fontWeight: '700', color: cores.textoSuave },
  valor: { fontSize: fonte.base, fontWeight: '800', color: cores.texto },
  meta: { fontSize: fonte.pequena, fontWeight: '600', color: cores.textoFraco },
  fundo: {
    height: 8,
    backgroundColor: cores.superficieAlt,
    borderRadius: 4,
    marginTop: espaco.xs,
    overflow: 'hidden',
  },
  barra: { height: 8, backgroundColor: cores.primaria, borderRadius: 4 },
  barraBatida: { backgroundColor: cores.acao },
  nota: { fontSize: fonte.micro, color: cores.textoFraco, marginTop: 4 },
});
