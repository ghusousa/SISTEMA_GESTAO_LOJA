import { MaterialCommunityIcons } from '@expo/vector-icons';
import { FlashList } from '@shopify/flash-list';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Image, Pressable, RefreshControl, StyleSheet, Text, TextInput, View } from 'react-native';

import { mensagemDoErro, urlDaFoto } from '@/api/client';
import { catalogo } from '@/api/endpoints';
import type { Produto } from '@/api/tipos';
import { Botao, Carregando, ErroEstado, Etiqueta, Vazio } from '@/components/ui';
import { formatar, paraCentavos } from '@/lib/money';
import { chaves } from '@/lib/queryClient';
import { ALVO_TOQUE, cores, espaco, fonte, raio } from '@/lib/tema';

const TAMANHO_PAGINA = 20;

export default function Produtos() {
  const router = useRouter();
  const [busca, setBusca] = useState('');

  const consulta = useInfiniteQuery({
    queryKey: [...chaves.produtos, busca],
    initialPageParam: 1,
    queryFn: ({ pageParam }) =>
      catalogo.produtos({ q: busca || undefined, page: pageParam, size: TAMANHO_PAGINA }),
    getNextPageParam: (ultima) =>
      ultima.page * ultima.size < ultima.total ? ultima.page + 1 : undefined,
  });

  const produtos = consulta.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <View style={s.tela}>
      <View style={s.barraBusca}>
        <MaterialCommunityIcons name="magnify" size={22} color={cores.textoFraco} />
        <TextInput
          value={busca}
          onChangeText={setBusca}
          placeholder="Buscar por nome ou código de barras"
          placeholderTextColor={cores.textoFraco}
          style={s.inputBusca}
          autoCorrect={false}
          returnKeyType="search"
        />
        {busca.length > 0 && (
          <Pressable onPress={() => setBusca('')} hitSlop={10}>
            <MaterialCommunityIcons name="close-circle" size={20} color={cores.textoFraco} />
          </Pressable>
        )}
      </View>

      {consulta.isPending ? (
        <Carregando />
      ) : consulta.isError ? (
        <ErroEstado
          mensagem={mensagemDoErro(consulta.error, 'Não deu para carregar os produtos.')}
          aoTentarNovamente={() => void consulta.refetch()}
        />
      ) : produtos.length === 0 ? (
        <Vazio
          titulo={busca ? 'Nada encontrado' : 'Nenhum produto cadastrado'}
          descricao={
            busca
              ? 'Tente outro nome ou código.'
              : 'Cadastre a primeira peça para começar a vender.'
          }
          acao={<Botao titulo="Cadastrar peça" onPress={() => router.push('/produto/novo')} />}
        />
      ) : (
        <FlashList
          data={produtos}
          keyExtractor={(item) => String(item.id)}
          contentContainerStyle={s.lista}
          onEndReached={() => {
            if (consulta.hasNextPage && !consulta.isFetchingNextPage) {
              void consulta.fetchNextPage();
            }
          }}
          onEndReachedThreshold={0.4}
          refreshControl={
            <RefreshControl
              refreshing={consulta.isRefetching && !consulta.isFetchingNextPage}
              onRefresh={() => void consulta.refetch()}
            />
          }
          renderItem={({ item }) => (
            <CartaoProduto
              produto={item}
              aoAbrir={() =>
                router.push({ pathname: '/produto/[id]', params: { id: String(item.id) } })
              }
            />
          )}
        />
      )}

      <Pressable
        style={s.botaoFlutuante}
        onPress={() => router.push('/produto/novo')}
        accessibilityRole="button"
        accessibilityLabel="Cadastrar peça"
      >
        <MaterialCommunityIcons name="plus" size={30} color={cores.aoFundoEscuro} />
      </Pressable>
    </View>
  );
}

function CartaoProduto({ produto, aoAbrir }: { produto: Produto; aoAbrir: () => void }) {
  const semEstoque = produto.saldo_total === 0;
  const menorPreco = produto.variantes.length
    ? Math.min(...produto.variantes.map((v) => paraCentavos(v.preco_venda)))
    : 0;

  const foto = urlDaFoto(produto.foto_url);

  return (
    <Pressable style={s.cartao} onPress={aoAbrir}>
      <View style={s.cartaoCabecalho}>
        {/* A miniatura é o motivo de existir a foto: achar a peça correndo o olho, quando
            a etiqueta não está à mão. Sem foto, o lugar dela vira um ícone discreto em vez
            de um buraco no cartão. */}
        {foto ? (
          <Image source={{ uri: foto }} style={s.miniatura} resizeMode="cover" />
        ) : (
          <View style={[s.miniatura, s.miniaturaVazia]}>
            <MaterialCommunityIcons name="tshirt-crew-outline" size={22} color={cores.textoFraco} />
          </View>
        )}

        <View style={s.cartaoTexto}>
          <View style={s.cartaoTopo}>
            {/* Duas linhas: no SE, uma só cortava "Blusa Cropped Canelada" ao lado do preço. */}
            <Text style={s.cartaoNome} numberOfLines={2}>
              {produto.nome}
            </Text>
            <Text style={s.cartaoPreco}>{formatar(menorPreco)}</Text>
          </View>
          <Text style={s.cartaoCategoria}>{produto.categoria}</Text>
        </View>
      </View>

      <View style={s.cartaoRodape}>
        <View style={s.grade}>
          {produto.variantes.slice(0, 6).map((v) => (
            <Text key={v.id} style={[s.chip, v.saldo === 0 && s.chipZerado]}>
              {v.tamanho} · {v.saldo}
            </Text>
          ))}
          {produto.variantes.length > 6 && (
            <Text style={s.chip}>+{produto.variantes.length - 6}</Text>
          )}
        </View>
        <Etiqueta
          texto={semEstoque ? 'sem estoque' : `${produto.saldo_total} em estoque`}
          cor={semEstoque ? cores.perigoFraco : cores.sucessoFraco}
          corTexto={semEstoque ? cores.perigo : cores.acaoEscura}
        />
      </View>
    </Pressable>
  );
}

const s = StyleSheet.create({
  tela: { flex: 1, backgroundColor: cores.fundo },

  cartaoCabecalho: { flexDirection: 'row', gap: espaco.sm, alignItems: 'center' },
  cartaoTexto: { flex: 1 },
  miniatura: { width: 48, height: 48, borderRadius: raio.sm, backgroundColor: cores.superficieAlt },
  miniaturaVazia: { alignItems: 'center', justifyContent: 'center' },

  barraBusca: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: espaco.sm,
    backgroundColor: cores.superficie,
    margin: espaco.md,
    paddingHorizontal: espaco.md,
    borderRadius: raio.md,
    borderWidth: 1,
    borderColor: cores.borda,
    minHeight: ALVO_TOQUE,
  },
  inputBusca: { flex: 1, fontSize: fonte.base, color: cores.texto },

  lista: { paddingHorizontal: espaco.md, paddingBottom: 96 },
  cartao: {
    backgroundColor: cores.superficie,
    borderRadius: raio.md,
    padding: espaco.lg,
    marginBottom: espaco.sm,
  },
  cartaoTopo: { flexDirection: 'row', justifyContent: 'space-between', gap: espaco.sm },
  cartaoNome: { flex: 1, fontSize: fonte.media, fontWeight: '700', color: cores.texto },
  cartaoPreco: { fontSize: fonte.media, fontWeight: '800', color: cores.primaria },
  cartaoCategoria: { fontSize: fonte.pequena, color: cores.textoSuave, marginTop: 2 },
  cartaoRodape: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: espaco.md,
    gap: espaco.sm,
  },
  grade: { flexDirection: 'row', flexWrap: 'wrap', gap: espaco.xs, flex: 1 },
  chip: {
    fontSize: fonte.micro,
    fontWeight: '600',
    color: cores.textoSuave,
    backgroundColor: cores.superficieAlt,
    paddingHorizontal: espaco.sm,
    paddingVertical: 3,
    borderRadius: raio.sm,
    overflow: 'hidden',
  },
  chipZerado: { color: cores.perigo, backgroundColor: cores.perigoFraco },

  botaoFlutuante: {
    position: 'absolute',
    right: espaco.lg,
    bottom: espaco.lg,
    width: 60,
    height: 60,
    borderRadius: raio.redondo,
    backgroundColor: cores.acao,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 5,
  },
});
