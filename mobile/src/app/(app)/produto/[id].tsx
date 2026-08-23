import { useQuery } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { mensagemDoErro } from '@/api/client';
import { catalogo } from '@/api/endpoints';
import { Carregando, Cartao, ErroEstado, Etiqueta } from '@/components/ui';
import { formatar, paraCentavos } from '@/lib/money';
import { chaves } from '@/lib/queryClient';
import { PODE, pode } from '@/lib/permissoes';
import { cores, espaco, fonte, raio } from '@/lib/tema';
import { useAuthStore } from '@/stores/authStore';

export default function DetalheProduto() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const veDinheiro = useAuthStore((e) => pode(e.usuario?.papel, PODE.VER_DINHEIRO));
  const produtoId = Number(id);

  const consulta = useQuery({
    queryKey: chaves.produto(produtoId),
    queryFn: () => catalogo.produto(produtoId),
    enabled: Number.isFinite(produtoId),
  });

  if (consulta.isPending) return <Carregando />;
  if (consulta.isError) {
    return (
      <ErroEstado
        mensagem={mensagemDoErro(consulta.error, 'Produto não encontrado.')}
        aoTentarNovamente={() => void consulta.refetch()}
      />
    );
  }

  const produto = consulta.data;

  return (
    <ScrollView contentContainerStyle={s.conteudo}>
      <Cartao>
        <Text style={s.nome}>{produto.nome}</Text>
        <Text style={s.categoria}>{produto.categoria}</Text>
        {!!produto.descricao && <Text style={s.descricao}>{produto.descricao}</Text>}
        <View style={s.resumo}>
          <Etiqueta
            texto={`${produto.saldo_total} peça(s) em estoque`}
            cor={produto.saldo_total === 0 ? cores.perigoFraco : cores.sucessoFraco}
            corTexto={produto.saldo_total === 0 ? cores.perigo : cores.acaoEscura}
          />
        </View>
      </Cartao>

      <Text style={s.secao}>Grade</Text>
      {produto.variantes.map((v) => {
        const baixo = v.saldo <= v.estoque_minimo;
        return (
          <Pressable
            key={v.id}
            style={s.variante}
            onPress={() =>
              router.push({
                pathname: '/estoque/movimentacoes',
                params: { varianteId: String(v.id), titulo: `${produto.nome} ${v.tamanho}` },
              })
            }
          >
            <View style={s.varianteTopo}>
              <Text style={s.varianteNome}>
                {v.tamanho} · {v.cor}
              </Text>
              <Text style={s.variantePreco}>{formatar(paraCentavos(v.preco_venda))}</Text>
            </View>
            <Text style={s.codigo}>
              {v.codigo_barras}
              {v.tipo_codigo === 'INTERNO' ? ' (código interno)' : ''}
            </Text>
            <View style={s.varianteRodape}>
              <Etiqueta
                texto={`saldo ${v.saldo}`}
                cor={baixo ? cores.alertaFraco : cores.superficieAlt}
                corTexto={baixo ? '#7A5A00' : cores.textoSuave}
              />
              <Etiqueta texto={`mínimo ${v.estoque_minimo}`} cor={cores.superficieAlt} corTexto={cores.textoSuave} />
              {/* preco_custo só chega para quem vê dinheiro — a API nem envia para os demais. */}
              {veDinheiro && v.preco_custo && (
                <Etiqueta
                  texto={`custo ${formatar(paraCentavos(v.preco_custo))}`}
                  cor={cores.primariaFraca}
                  corTexto={cores.primaria}
                />
              )}
            </View>
          </Pressable>
        );
      })}

      <View style={s.acoes}>
        <Text style={s.dica}>Toque em uma peça para ver o extrato dela.</Text>
      </View>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  conteudo: { padding: espaco.lg, paddingBottom: espaco.xxl },
  nome: { fontSize: fonte.grande, fontWeight: '800', color: cores.texto },
  categoria: { fontSize: fonte.pequena, color: cores.textoSuave, marginTop: 2 },
  descricao: { fontSize: fonte.base, color: cores.textoSuave, marginTop: espaco.sm },
  resumo: { flexDirection: 'row', marginTop: espaco.md },

  secao: {
    fontSize: fonte.base,
    fontWeight: '700',
    color: cores.textoSuave,
    marginBottom: espaco.sm,
  },
  variante: {
    backgroundColor: cores.superficie,
    borderRadius: raio.md,
    padding: espaco.lg,
    marginBottom: espaco.sm,
  },
  varianteTopo: { flexDirection: 'row', justifyContent: 'space-between' },
  varianteNome: { fontSize: fonte.media, fontWeight: '700', color: cores.texto },
  variantePreco: { fontSize: fonte.media, fontWeight: '800', color: cores.primaria },
  codigo: {
    fontSize: fonte.pequena,
    color: cores.textoFraco,
    marginTop: 2,
    fontVariant: ['tabular-nums'],
  },
  varianteRodape: { flexDirection: 'row', gap: espaco.xs, marginTop: espaco.md, flexWrap: 'wrap' },

  acoes: { marginTop: espaco.lg, gap: espaco.sm },
  dica: { fontSize: fonte.pequena, color: cores.textoFraco, textAlign: 'center' },
});
