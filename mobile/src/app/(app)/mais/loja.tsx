/**
 * A loja: o nome que sai no recibo e o ramo que decide as palavras das telas.
 *
 * Só o dono chega aqui (`CONFIGURAR_LOJA`) — a entrada em "Mais" já não aparece para
 * ninguém mais, e o servidor recusa de qualquer jeito.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { mensagemDoErro } from '@/api/client';
import { sistema } from '@/api/endpoints';
import { Botao, Campo } from '@/components/ui';
import { CHAVE_CONFIGURACAO_COMPLETA, useDadosDaLoja } from '@/hooks/useLoja';
import { chaves } from '@/lib/queryClient';
import { cores, espaco, fonte, raio } from '@/lib/tema';

export default function ConfiguracaoDaLoja() {
  const router = useRouter();
  const cliente = useQueryClient();
  const atual = useDadosDaLoja();

  const [nome, setNome] = useState(atual.nome);
  const [segmento, setSegmento] = useState(atual.segmento);
  const [documento, setDocumento] = useState(atual.documento ?? '');
  const [telefone, setTelefone] = useState(atual.telefone ?? '');
  const [endereco, setEndereco] = useState(atual.endereco ?? '');
  const [erro, setErro] = useState<string | null>(null);

  // A primeira renderização acontece com o padrão, antes de a consulta responder; quando
  // ela chega, os campos precisam adotar o que está gravado de verdade.
  useEffect(() => {
    setNome(atual.nome);
    setSegmento(atual.segmento);
    setDocumento(atual.documento ?? '');
    setTelefone(atual.telefone ?? '');
    setEndereco(atual.endereco ?? '');
  }, [atual.nome, atual.segmento, atual.documento, atual.telefone, atual.endereco]);

  const ramos = useQuery({
    queryKey: [...chaves.configuracao, 'segmentos'],
    queryFn: sistema.segmentos,
    staleTime: Infinity, // a lista de ramos só muda quando o sistema é atualizado
  });

  const salvar = useMutation({
    mutationFn: () =>
      sistema.salvarConfiguracao({ nome: nome.trim(), segmento, documento, telefone, endereco }),
    onSuccess: (salvo) => {
      // A resposta do PATCH é a configuração inteira: serve às duas leituras.
      cliente.setQueryData(chaves.configuracao, salvo);
      cliente.setQueryData(CHAVE_CONFIGURACAO_COMPLETA, salvo);
      Alert.alert('Pronto', `A loja agora se chama ${salvo.nome}.`, [
        { text: 'Ok', onPress: () => router.back() },
      ]);
    },
    onError: (e) => setErro(mensagemDoErro(e, 'Não deu para salvar.')),
  });

  const escolhido = ramos.data?.find((r) => r.valor === segmento);

  return (
    <KeyboardAvoidingView
      style={s.tela}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={s.conteudo} keyboardShouldPersistTaps="handled">
        <Campo
          rotulo="Nome da loja"
          value={nome}
          onChangeText={setNome}
          ajuda="Aparece na tela de entrada e no recibo do cliente"
        />

        <Text style={s.rotulo}>Ramo</Text>
        <Text style={s.ajuda}>
          Troca só as palavras do sistema. Nenhum produto, preço ou estoque muda.
        </Text>
        <View style={s.ramos}>
          {(ramos.data ?? []).map((r) => (
            <Pressable
              key={r.valor}
              onPress={() => setSegmento(r.valor)}
              style={[s.ramo, r.valor === segmento && s.ramoAtivo]}
            >
              <Text style={[s.ramoTexto, r.valor === segmento && s.ramoTextoAtivo]}>
                {r.rotulo}
              </Text>
              <Text style={[s.ramoEixos, r.valor === segmento && s.ramoTextoAtivo]}>
                {r.eixo1} · {r.eixo2}
              </Text>
            </Pressable>
          ))}
        </View>
        {escolhido ? (
          <Text style={s.previa}>
            No cadastro, as duas variações vão se chamar "{escolhido.eixo1}" e "
            {escolhido.eixo2}".
          </Text>
        ) : null}

        <Campo
          rotulo="CNPJ ou CPF"
          value={documento}
          onChangeText={setDocumento}
          ajuda="Opcional — sai no recibo"
        />
        <Campo
          rotulo="Telefone"
          value={telefone}
          onChangeText={setTelefone}
          keyboardType="phone-pad"
          ajuda="Opcional — sai no recibo"
        />
        <Campo
          rotulo="Endereço"
          value={endereco}
          onChangeText={setEndereco}
          ajuda="Opcional — sai no recibo"
        />

        {erro ? <Text style={s.erro}>{erro}</Text> : null}

        <Botao
          titulo="Salvar"
          onPress={() => {
            if (!nome.trim()) return setErro('A loja precisa de um nome.');
            setErro(null);
            salvar.mutate();
          }}
          carregando={salvar.isPending}
          // Antes de o documento chegar, os campos estão vazios por falta de resposta, não
          // por escolha: salvar ali apagaria o CNPJ do recibo sem ninguém pedir.
          desabilitado={!atual.carregado}
        />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  tela: { flex: 1, backgroundColor: cores.fundo },
  conteudo: { padding: espaco.lg, paddingBottom: espaco.xxl, gap: espaco.md },
  rotulo: { fontSize: fonte.base, fontWeight: '700', color: cores.texto },
  ajuda: { fontSize: fonte.pequena, color: cores.textoSuave, marginTop: -espaco.xs },
  ramos: { gap: espaco.xs },
  ramo: {
    borderWidth: 1,
    borderColor: cores.borda,
    borderRadius: raio.md,
    padding: espaco.md,
    backgroundColor: cores.superficie,
  },
  ramoAtivo: { borderColor: cores.primaria, backgroundColor: cores.primariaFraca },
  ramoTexto: { fontSize: fonte.base, fontWeight: '600', color: cores.texto },
  ramoTextoAtivo: { color: cores.primaria },
  ramoEixos: { fontSize: fonte.pequena, color: cores.textoSuave, marginTop: 2 },
  previa: { fontSize: fonte.pequena, color: cores.textoSuave, fontStyle: 'italic' },
  erro: { color: cores.perigo, fontSize: fonte.pequena },
});
