/**
 * Mudar o papel de alguém da equipe (Mais › Usuários › a pessoa › Mudar papel).
 *
 * É também o caminho do dono único que quer excluir a própria conta: a loja não fica sem
 * dono, então ele passa o papel de dono a outra pessoa antes (ADR-45) — e isso tem de dar
 * para fazer no celular, não só no computador. A régua é a do servidor (`_barrar_escalada`):
 * só o dono dá ou tira o papel de dono, e ninguém troca o próprio papel; a lista da equipe
 * só abre esta tela onde o servidor aceitaria (`possoMudarPapel`).
 */

import { useMutation, useQuery } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text } from 'react-native';

import { mensagemDoErro } from '@/api/client';
import { usuarios } from '@/api/endpoints';
import type { Papel } from '@/api/tipos';
import { EscolhaDoPapel } from '@/components/EscolhaDoPapel';
import { Botao, Carregando, Cartao, ErroEstado } from '@/components/ui';
import { chaves, queryClient } from '@/lib/queryClient';
import { papeisQuePossoDar, titulo } from '@/lib/permissoes';
import { cores, espaco, fonte } from '@/lib/tema';
import { useAuthStore } from '@/stores/authStore';

export default function PapelDoUsuario() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const usuarioId = Number(id);
  const meuPapel = useAuthStore((e) => e.usuario?.papel);

  const consulta = useQuery({
    queryKey: [...chaves.usuarios, usuarioId],
    queryFn: () => usuarios.obter(usuarioId),
  });
  const [papel, setPapel] = useState<Papel | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    if (consulta.data) setPapel(consulta.data.papel);
  }, [consulta.data]);

  const salvar = useMutation({
    mutationFn: (novo: Papel) => usuarios.atualizar(usuarioId, { papel: novo }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: chaves.usuarios });
      router.back();
    },
    // O servidor diz o porquê: "A loja precisa de pelo menos um dono ativo", "Só o dono…".
    onError: (e) => setErro(mensagemDoErro(e, 'Não deu para mudar o papel.')),
  });

  if (consulta.isPending || !papel) return <Carregando />;
  if (consulta.isError) {
    return (
      <ErroEstado
        mensagem={mensagemDoErro(consulta.error, 'Não deu para carregar a pessoa.')}
        aoTentarNovamente={() => void consulta.refetch()}
      />
    );
  }

  const pessoa = consulta.data;
  // O papel de hoje fica na lista mesmo quando quem mexe não poderia dá-lo (não acontece:
  // gerente nem chega aqui numa conta de dono), para a tela nunca abrir sem nada marcado.
  const opcoes = papeisQuePossoDar(meuPapel);
  if (!opcoes.includes(pessoa.papel)) opcoes.push(pessoa.papel);

  return (
    <ScrollView contentContainerStyle={s.conteudo}>
      <Text style={s.nome}>{pessoa.nome}</Text>
      <Cartao>
        <Text style={s.explica}>
          Hoje: {titulo(pessoa.papel).toLowerCase()}. O papel decide o que a pessoa vê e faz, e vale
          na próxima tela que ela abrir. Para sair da loja sendo o único dono, passe o papel de dono
          a outra pessoa aqui e depois exclua a sua conta em Minha conta.
        </Text>
      </Cartao>
      <Text style={s.rotulo}>Papel</Text>
      <EscolhaDoPapel
        opcoes={opcoes}
        valor={papel}
        aoEscolher={(p) => {
          setErro(null);
          setPapel(p);
        }}
      />
      {!!erro && (
        <Text style={s.erro} accessibilityRole="alert">
          {erro}
        </Text>
      )}
      <Botao
        titulo="Salvar papel"
        grande
        desabilitado={papel === pessoa.papel}
        carregando={salvar.isPending}
        onPress={() => salvar.mutate(papel)}
      />
    </ScrollView>
  );
}

const s = StyleSheet.create({
  conteudo: { padding: espaco.lg, paddingBottom: espaco.xxl },
  nome: { fontSize: fonte.titulo, fontWeight: '800', color: cores.texto, marginBottom: espaco.md },
  explica: { fontSize: fonte.pequena, color: cores.textoSuave, lineHeight: 19 },
  rotulo: {
    fontSize: fonte.pequena,
    fontWeight: '600',
    color: cores.textoSuave,
    marginTop: espaco.lg,
    marginBottom: espaco.sm,
  },
  erro: { color: cores.perigo, fontWeight: '600', marginBottom: espaco.md },
});
