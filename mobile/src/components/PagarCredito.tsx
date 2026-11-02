/**
 * Crédito: em quantas vezes, e em que bandeira (ADR-35).
 *
 * Uma pergunta ANTES do valor entrar na venda, como o vale e o fiado. A taxa não aparece:
 * quem a decide é a tabela do dono, e o servidor a fotografa no pagamento. A vendedora
 * escolhe o que a cliente pediu — "3x no Visa" — e é só isso.
 *
 * Espelho de `web/js/pagar-credito.js`.
 */

import { useEffect, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Botao } from '@/components/ui';
import { BANDEIRAS, MAX_PARCELAS, valorDaParcela } from '@/lib/cartao';
import { formatar, type Centavos } from '@/lib/money';
import { ALVO_TOQUE, cores, espaco, fonte, raio } from '@/lib/tema';

export interface CreditoEscolhido {
  parcelas: number;
  bandeira: string | null;
}

const PARCELAS = Array.from({ length: MAX_PARCELAS }, (_, i) => i + 1);

export function ModalParcelas({
  visivel,
  valor,
  aoEscolher,
  aoCancelar,
}: {
  visivel: boolean;
  /** O que vai no crédito, para mostrar o valor de cada parcela. */
  valor: Centavos;
  aoEscolher: (escolha: CreditoEscolhido) => void;
  aoCancelar: () => void;
}) {
  const [bandeira, setBandeira] = useState<string | null>(null);

  useEffect(() => {
    if (visivel) setBandeira(null);
  }, [visivel]);

  return (
    <Modal visible={visivel} transparent animationType="fade" onRequestClose={aoCancelar}>
      <View style={s.fundo}>
        <Pressable style={StyleSheet.absoluteFill} onPress={aoCancelar} />
        <View style={s.caixa}>
          <Text style={s.titulo}>Crédito — em quantas vezes?</Text>
          <ScrollView>
            {/* A bandeira vem primeiro porque tocar nas parcelas já confirma: o caso de
                sempre ("à vista, tanto faz a bandeira") fecha num toque só. */}
            <Text style={s.secao}>Bandeira (opcional)</Text>
            <View style={s.grade}>
              {BANDEIRAS.map((b) => (
                <Pressable
                  key={b}
                  style={[s.chip, bandeira === b && s.chipMarcado]}
                  onPress={() => setBandeira((atual) => (atual === b ? null : b))}
                >
                  <Text style={[s.chipTexto, bandeira === b && s.chipTextoMarcado]}>{b}</Text>
                </Pressable>
              ))}
            </View>

            <Text style={s.secao}>Parcelas</Text>
            <View style={s.grade}>
              {PARCELAS.map((n) => (
                <Pressable
                  key={n}
                  style={({ pressed }) => [s.parcela, pressed && s.parcelaPressionada]}
                  onPress={() => aoEscolher({ parcelas: n, bandeira })}
                >
                  <Text style={s.parcelaNumero}>{n}x</Text>
                  <Text style={s.parcelaValor}>{formatar(valorDaParcela(valor, n))}</Text>
                </Pressable>
              ))}
            </View>
          </ScrollView>
          <Botao titulo="Cancelar" variante="secundario" estilo={s.cancelar} onPress={aoCancelar} />
        </View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  fundo: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'center',
    padding: espaco.lg,
  },
  caixa: {
    backgroundColor: cores.superficie,
    borderRadius: raio.lg,
    padding: espaco.xl,
    maxHeight: '85%',
  },
  titulo: { fontSize: fonte.grande, fontWeight: '800', color: cores.texto },
  secao: {
    fontSize: fonte.pequena,
    color: cores.textoSuave,
    fontWeight: '700',
    marginTop: espaco.lg,
    marginBottom: espaco.xs,
  },
  grade: { flexDirection: 'row', flexWrap: 'wrap', gap: espaco.sm },
  chip: {
    minHeight: ALVO_TOQUE,
    paddingHorizontal: espaco.md,
    borderRadius: raio.md,
    borderWidth: 1,
    borderColor: cores.borda,
    justifyContent: 'center',
  },
  chipMarcado: { backgroundColor: cores.primaria, borderColor: cores.primaria },
  chipTexto: { fontSize: fonte.base, color: cores.texto, fontWeight: '600' },
  chipTextoMarcado: { color: cores.aoFundoEscuro },
  parcela: {
    width: '30%',
    minHeight: 56,
    borderRadius: raio.md,
    backgroundColor: cores.primariaFraca,
    alignItems: 'center',
    justifyContent: 'center',
  },
  parcelaPressionada: { backgroundColor: cores.bordaForte },
  parcelaNumero: { fontSize: fonte.media, fontWeight: '800', color: cores.primaria },
  parcelaValor: { fontSize: fonte.micro, color: cores.textoSuave },
  cancelar: { marginTop: espaco.lg },
});
