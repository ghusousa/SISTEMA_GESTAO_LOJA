/**
 * Comissão e meta do dia de uma pessoa da equipe (ADR-37). Só o dono chega aqui.
 *
 * O gerente administra a equipe, mas também recebe comissão — quem recebe não decide
 * quanto. A lista de usuários só oferece esta tela a quem tem `DEFINIR_COMISSAO`, e a API
 * recusa (403) o resto de qualquer jeito.
 *
 * A % vai como string decimal ("2.50"), a meta em reais; meta zero é "sem meta" e a régua
 * some do PDV dela.
 */

import { useMutation, useQuery } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text } from 'react-native';

import { mensagemDoErro } from '@/api/client';
import { usuarios } from '@/api/endpoints';
import { Botao, Campo, Carregando, Cartao, ErroEstado } from '@/components/ui';
import { metaParaApi, paraPercentualDecimal, percentualParaCampo } from '@/lib/comissao';
import { formatarSemSimbolo, paraCentavos } from '@/lib/money';
import { chaves, queryClient } from '@/lib/queryClient';
import { cores, espaco, fonte } from '@/lib/tema';

export default function ComissaoDoUsuario() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const usuarioId = Number(id);

  const consulta = useQuery({
    queryKey: [...chaves.usuarios, usuarioId],
    queryFn: () => usuarios.obter(usuarioId),
  });

  const [comissao, setComissao] = useState('');
  const [meta, setMeta] = useState('');
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    if (!consulta.data) return;
    setComissao(percentualParaCampo(consulta.data.comissao_percentual));
    const centavos = paraCentavos(consulta.data.meta_diaria ?? '0');
    setMeta(centavos > 0 ? formatarSemSimbolo(centavos) : '');
  }, [consulta.data]);

  const salvar = useMutation({
    mutationFn: (dados: { comissao_percentual: string; meta_diaria: string | null }) =>
      usuarios.atualizar(usuarioId, dados),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: chaves.usuarios });
      // A régua do PDV e o relatório da equipe usam estes números.
      void queryClient.invalidateQueries({ queryKey: chaves.meuDia });
      void queryClient.invalidateQueries({ queryKey: ['relatorio-vendedoras'] });
      router.back();
    },
    onError: (e) => setErro(mensagemDoErro(e, 'Não deu para salvar.')),
  });

  if (consulta.isPending) return <Carregando />;
  if (consulta.isError) {
    return (
      <ErroEstado
        mensagem={mensagemDoErro(consulta.error, 'Não deu para carregar a pessoa.')}
        aoTentarNovamente={() => void consulta.refetch()}
      />
    );
  }

  function enviar() {
    const pct = paraPercentualDecimal(comissao);
    if (pct === null) return setErro('Comissão é uma % de 0 a 100, com até duas casas.');
    const centavos = paraCentavos(meta);
    if (centavos < 0) return setErro('A meta não pode ser negativa.');
    setErro(null);
    salvar.mutate({ comissao_percentual: pct, meta_diaria: metaParaApi(centavos) });
  }

  return (
    <KeyboardAvoidingView style={s.tela} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={s.conteudo} keyboardShouldPersistTaps="handled">
        <Text style={s.nome}>{consulta.data.nome}</Text>
        <Cartao>
          <Text style={s.explica}>
            A comissão é sobre o que a pessoa vendeu menos o que voltou de devolução. Peça
            devolvida tira a comissão no período em que voltou. Mudar a % vale para as vendas
            daqui em diante: a venda já feita guarda a % do dia dela.
          </Text>
        </Cartao>
        <Campo
          rotulo="Comissão (%)"
          value={comissao}
          onChangeText={setComissao}
          keyboardType="decimal-pad"
          placeholder="0"
          ajuda="Use 0 para quem não ganha comissão. Ex.: 2,5"
        />
        <Campo
          rotulo="Meta do dia (R$)"
          value={meta}
          onChangeText={setMeta}
          keyboardType="decimal-pad"
          placeholder="sem meta"
          ajuda='Aparece no PDV dela como "hoje: R$ X de R$ meta". Vazio = sem meta.'
        />
        {!!erro && <Text style={s.erro}>{erro}</Text>}
        <Botao titulo="Salvar" grande carregando={salvar.isPending} onPress={enviar} />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  tela: { flex: 1, backgroundColor: cores.fundo },
  conteudo: { padding: espaco.lg },
  nome: { fontSize: fonte.titulo, fontWeight: '800', color: cores.texto, marginBottom: espaco.md },
  explica: { fontSize: fonte.pequena, color: cores.textoSuave },
  erro: { color: cores.perigo, fontWeight: '600', marginBottom: espaco.md },
});
