/**
 * A escolha do papel de alguém da equipe: um cartão por papel, com o que ele vê e faz. A
 * mesma lista no cadastro (Novo usuário) e na troca (Mudar papel). Quais papéis aparecem é
 * de quem chama (`papeisQuePossoDar`): o gerente não dá "Dono" — o servidor recusaria.
 */

import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { Papel } from '@/api/tipos';
import { DESCRICAO, titulo } from '@/lib/permissoes';
import { cores, espaco, fonte, raio } from '@/lib/tema';

export function EscolhaDoPapel({
  opcoes,
  valor,
  aoEscolher,
}: {
  opcoes: Papel[];
  valor: Papel;
  aoEscolher: (papel: Papel) => void;
}) {
  return (
    <View accessibilityRole="radiogroup">
      {opcoes.map((opcao) => (
        <Pressable
          key={opcao}
          style={[s.papel, valor === opcao && s.papelAtivo]}
          onPress={() => aoEscolher(opcao)}
          accessibilityRole="radio"
          accessibilityState={{ checked: valor === opcao }}
          aria-checked={valor === opcao}
        >
          <View style={s.radio}>{valor === opcao && <View style={s.radioMarcado} />}</View>
          <View style={s.papelTexto}>
            <Text style={s.papelRotulo}>{titulo(opcao)}</Text>
            <Text style={s.papelDescricao}>{DESCRICAO[opcao]}</Text>
          </View>
        </Pressable>
      ))}
    </View>
  );
}

const s = StyleSheet.create({
  papel: {
    flexDirection: 'row',
    gap: espaco.md,
    backgroundColor: cores.superficie,
    borderRadius: raio.md,
    padding: espaco.lg,
    marginBottom: espaco.sm,
    borderWidth: 1,
    borderColor: cores.borda,
  },
  papelAtivo: { borderColor: cores.primaria, backgroundColor: cores.primariaFraca },
  radio: {
    width: 22,
    height: 22,
    borderRadius: raio.redondo,
    borderWidth: 2,
    borderColor: cores.primaria,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 2,
  },
  radioMarcado: {
    width: 12,
    height: 12,
    borderRadius: raio.redondo,
    backgroundColor: cores.primaria,
  },
  papelTexto: { flex: 1 },
  papelRotulo: { fontSize: fonte.base, fontWeight: '700', color: cores.texto },
  papelDescricao: { fontSize: fonte.pequena, color: cores.textoSuave, marginTop: 2 },
});
