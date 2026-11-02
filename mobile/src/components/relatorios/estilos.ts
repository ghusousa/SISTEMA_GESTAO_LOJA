/** O vocabulário visual das seções de relatório: o mesmo cartão, título, linha e legenda. */

import { StyleSheet } from 'react-native';

import { cores, espaco, fonte } from '@/lib/tema';

export const r = StyleSheet.create({
  titulo: { fontSize: fonte.media, fontWeight: '700', color: cores.texto },
  legenda: { fontSize: fonte.micro, color: cores.textoFraco, marginTop: espaco.xs },
  vazio: { fontSize: fonte.base, color: cores.textoFraco, marginTop: espaco.sm },
  erro: { fontSize: fonte.pequena, color: cores.perigo, marginTop: espaco.sm },
  destaque: { fontSize: fonte.grande, fontWeight: '800', color: cores.texto, marginTop: espaco.xs },

  linha: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: espaco.md,
    paddingVertical: espaco.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: cores.borda,
  },
  info: { flex: 1 },
  nome: { fontSize: fonte.base, fontWeight: '600', color: cores.texto },
  detalhe: { fontSize: fonte.micro, color: cores.textoSuave, marginTop: 2 },
  numeros: { alignItems: 'flex-end' },
  valor: { fontSize: fonte.base, fontWeight: '800', color: cores.texto },
  valorNegativo: { color: cores.perigo },
  valorBom: { color: cores.acaoEscura },

  totais: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: espaco.md,
    paddingTop: espaco.sm,
    borderTopWidth: 1,
    borderTopColor: cores.bordaForte,
  },
  totalRotulo: { fontSize: fonte.pequena, fontWeight: '700', color: cores.textoSuave },
  totalValor: { fontSize: fonte.base, fontWeight: '800', color: cores.texto },
});
