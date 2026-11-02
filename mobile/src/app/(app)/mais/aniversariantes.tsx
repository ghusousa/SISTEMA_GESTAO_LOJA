/**
 * Aniversariantes do mês — o "feliz aniversário, chegou coleção no seu tamanho" (ADR-36).
 *
 * Espelho de `web/js/views/aniversariantes.js`. É do balcão (`ATENDER_CLIENTE`): nome,
 * telefone e preferências, nada do crediário. Paginada no servidor; "Mais" traz a próxima.
 */

import { useInfiniteQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { mensagemDoErro } from '@/api/client';
import { clientes } from '@/api/endpoints';
import { Botao, Carregando, ErroEstado, Vazio } from '@/components/ui';
import { chaves } from '@/lib/queryClient';
import { ALVO_TOQUE, cores, espaco, fonte, raio } from '@/lib/tema';

const MESES = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];

export default function Aniversariantes() {
  // O mês do aparelho só escolhe o botão aceso na abertura; quem responde é o servidor.
  const [mes, setMes] = useState(new Date().getMonth() + 1);

  const consulta = useInfiniteQuery({
    queryKey: chaves.aniversariantes(mes),
    initialPageParam: 1,
    queryFn: ({ pageParam }) => clientes.aniversariantes({ mes, page: pageParam, size: 50 }),
    getNextPageParam: (ultima) =>
      ultima.page * ultima.size < ultima.total ? ultima.page + 1 : undefined,
  });

  const lista = consulta.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <ScrollView contentContainerStyle={s.conteudo}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.meses}>
        {MESES.map((nome, i) => (
          <Pressable
            key={nome}
            style={[s.mes, mes === i + 1 && s.mesMarcado]}
            onPress={() => setMes(i + 1)}
          >
            <Text style={[s.mesTexto, mes === i + 1 && s.mesTextoMarcado]}>{nome}</Text>
          </Pressable>
        ))}
      </ScrollView>

      {consulta.isPending ? (
        <Carregando />
      ) : consulta.isError ? (
        <ErroEstado
          mensagem={mensagemDoErro(consulta.error, 'Não deu para carregar.')}
          aoTentarNovamente={() => void consulta.refetch()}
        />
      ) : lista.length === 0 ? (
        <Vazio
          titulo="Ninguém neste mês"
          descricao="O aniversário entra no cadastro da cliente, no balcão ou no crediário."
        />
      ) : (
        lista.map((c) => (
          <View key={c.id} style={s.item}>
            <Text style={s.dia}>{c.nascimento?.slice(8, 10)}</Text>
            <View style={s.itemTexto}>
              <Text style={s.nome}>{c.nome}</Text>
              <Text style={s.detalhe}>
                {[c.telefone || 'sem telefone', c.preferencias].filter(Boolean).join(' · ')}
              </Text>
            </View>
          </View>
        ))
      )}

      {consulta.hasNextPage && (
        <Botao
          titulo="Mais"
          variante="secundario"
          carregando={consulta.isFetchingNextPage}
          onPress={() => void consulta.fetchNextPage()}
        />
      )}
    </ScrollView>
  );
}

const s = StyleSheet.create({
  conteudo: { padding: espaco.lg, gap: espaco.sm },
  meses: { gap: espaco.sm, paddingBottom: espaco.sm },
  mes: {
    minHeight: ALVO_TOQUE,
    paddingHorizontal: espaco.md,
    borderRadius: raio.md,
    borderWidth: 1,
    borderColor: cores.borda,
    justifyContent: 'center',
  },
  mesMarcado: { backgroundColor: cores.primaria, borderColor: cores.primaria },
  mesTexto: { fontSize: fonte.base, fontWeight: '700', color: cores.texto },
  mesTextoMarcado: { color: cores.aoFundoEscuro },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: espaco.md,
    backgroundColor: cores.superficie,
    borderRadius: raio.md,
    padding: espaco.md,
  },
  dia: { fontSize: fonte.grande, fontWeight: '800', color: cores.primaria, minWidth: 36 },
  itemTexto: { flex: 1 },
  nome: { fontSize: fonte.base, fontWeight: '700', color: cores.texto },
  detalhe: { fontSize: fonte.pequena, color: cores.textoSuave },
});
