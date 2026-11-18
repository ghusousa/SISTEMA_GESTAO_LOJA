/**
 * A nota do fornecedor na Entrada: valor, número e parcelas — vira Contas a pagar (ADR-40).
 *
 * Só aparece para quem vê dinheiro (o servidor recusa a nota de outro papel). A sugestão
 * 30/60/90 e a conta do centavo são de `lib/parcelas.ts`; o servidor confere a soma.
 * Espelho de `web/js/nota-fornecedor.js`: mesmas perguntas, mesmo texto.
 */

import { format } from 'date-fns';
import { Pressable, StyleSheet, Switch, Text, TextInput, View } from 'react-native';

import type { NotaFornecedor as NotaApi } from '@/api/tipos';
import { Campo } from '@/components/ui';
import { formatar, formatarSemSimbolo, paraCentavos, paraDecimalString, type Centavos } from '@/lib/money';
import { diferencaDaNota, notaFecha, sugerirParcelas, type Parcela } from '@/lib/parcelas';
import { cores, espaco, fonte, raio } from '@/lib/tema';

export interface EstadoNota {
  ligada: boolean;
  numero: string;
  total: Centavos;
  /** O que a pessoa digitou no valor, como texto (o campo é livre: "2.500,00"). */
  totalTexto: string;
  parcelas: Parcela[];
}

export const NOTA_VAZIA: EstadoNota = { ligada: false, numero: '', total: 0, totalTexto: '', parcelas: [] };

const hoje = () => format(new Date(), 'yyyy-MM-dd');

/** A nota pronta para a API, `null` se desligada; lança Error com a frase se não fecha. */
export function notaParaApi(nota: EstadoNota): NotaApi | null {
  if (!nota.ligada) return null;
  if (!notaFecha(nota.total, nota.parcelas)) {
    throw new Error('A nota do fornecedor não fecha: confira o valor e as parcelas.');
  }
  return {
    numero: nota.numero.trim() || null,
    valor_total: paraDecimalString(nota.total),
    parcelas: nota.parcelas.map((p) => ({ vencimento: p.vencimento, valor: paraDecimalString(p.valor) })),
  };
}

export function NotaFornecedor({
  nota,
  aoMudar,
}: {
  nota: EstadoNota;
  aoMudar: (nota: EstadoNota) => void;
}) {
  const diferenca = diferencaDaNota(nota.total, nota.parcelas);

  function dividirEm(quantidade: number, total = nota.total) {
    return sugerirParcelas(total, quantidade, hoje());
  }

  return (
    <View style={s.caixa}>
      <View style={s.linha}>
        <Text style={s.titulo}>Lançar a nota em Contas a pagar</Text>
        <Switch value={nota.ligada} onValueChange={(ligada) => aoMudar({ ...nota, ligada })} />
      </View>
      <Text style={s.dica}>
        Não entra no Resultado: o custo da mercadoria já entra pelo CMV quando a peça é vendida.
      </Text>
      {nota.ligada && (
        <>
          <Campo
            rotulo="Número da nota (opcional)"
            value={nota.numero}
            onChangeText={(numero) => aoMudar({ ...nota, numero })}
            placeholder="NF 4512"
          />
          <Campo
            rotulo="Valor da nota"
            value={nota.totalTexto}
            keyboardType="decimal-pad"
            placeholder="0,00"
            onChangeText={(totalTexto) => {
              const total = paraCentavos(totalTexto);
              const quantidade = nota.parcelas.length || 3;
              aoMudar({ ...nota, totalTexto, total, parcelas: dividirEm(quantidade, total) });
            }}
          />
          <View style={s.linha}>
            {[1, 2, 3, 4, 5, 6].map((n) => (
              <Pressable
                key={n}
                onPress={() => aoMudar({ ...nota, parcelas: dividirEm(n) })}
                style={[s.chip, nota.parcelas.length === n && s.chipAtivo]}
              >
                <Text style={[s.chipTexto, nota.parcelas.length === n && s.chipTextoAtivo]}>{n}x</Text>
              </Pressable>
            ))}
          </View>
          {nota.parcelas.map((p, i) => (
            // A chave muda com o valor: a sugestão nova remonta o campo com o número novo.
            <View key={`${i}-${nota.parcelas.length}-${p.valor}`} style={s.parcela}>
              <Text style={s.parcelaRotulo}>{i + 1}ª</Text>
              <TextInput
                style={[s.entrada, { flex: 1 }]}
                value={p.vencimento}
                placeholder="AAAA-MM-DD"
                onChangeText={(vencimento) =>
                  aoMudar({ ...nota, parcelas: nota.parcelas.map((q, j) => (j === i ? { ...q, vencimento } : q)) })
                }
              />
              <TextInput
                style={[s.entrada, { width: 110, textAlign: 'right' }]}
                defaultValue={formatarSemSimbolo(p.valor)}
                keyboardType="decimal-pad"
                onEndEditing={(e) =>
                  aoMudar({
                    ...nota,
                    parcelas: nota.parcelas.map((q, j) => (j === i ? { ...q, valor: paraCentavos(e.nativeEvent.text) } : q)),
                  })
                }
              />
            </View>
          ))}
          <Text style={[s.dica, diferenca !== 0 && nota.total > 0 && { color: cores.perigo }]}>
            {!nota.total
              ? 'Digite o valor: as parcelas saem de 30 em 30 dias, e dá para mudar cada uma.'
              : diferenca === 0
                ? `${nota.parcelas.length}x — fecha com a nota.`
                : diferenca > 0
                  ? `Faltam ${formatar(diferenca)} nas parcelas.`
                  : `As parcelas passam da nota em ${formatar(-diferenca)}.`}
          </Text>
        </>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  caixa: {
    backgroundColor: cores.superficie,
    borderRadius: raio.md,
    padding: espaco.md,
    marginBottom: espaco.lg,
    gap: espaco.sm,
  },
  linha: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: espaco.xs },
  titulo: { fontSize: fonte.base, fontWeight: '700', color: cores.texto, flex: 1 },
  dica: { fontSize: fonte.pequena, color: cores.textoSuave },
  chip: {
    paddingHorizontal: espaco.md,
    paddingVertical: espaco.xs,
    borderRadius: raio.redondo,
    borderWidth: 1,
    borderColor: cores.borda,
  },
  chipAtivo: { backgroundColor: cores.primaria, borderColor: cores.primaria },
  chipTexto: { fontWeight: '700', color: cores.textoSuave },
  chipTextoAtivo: { color: cores.aoFundoEscuro },
  parcela: { flexDirection: 'row', alignItems: 'center', gap: espaco.sm },
  parcelaRotulo: { width: 28, fontWeight: '700', color: cores.textoSuave },
  entrada: {
    borderWidth: 1,
    borderColor: cores.borda,
    borderRadius: raio.sm,
    paddingHorizontal: espaco.sm,
    paddingVertical: espaco.xs,
    fontSize: fonte.base,
    color: cores.texto,
    backgroundColor: cores.fundo,
  },
});
