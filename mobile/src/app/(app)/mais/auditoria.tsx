/**
 * Auditoria no celular — o diário da loja, só para o dono.
 *
 * Espelho de `web/js/views/auditoria.js`. Cada linha é um ato, com o nome e o papel de quem
 * agiu congelados no momento. A recusa de verdade é do servidor (`VER_AUDITORIA`, que nem o
 * gerente tem); esconder a opção no menu para os outros é só conveniência.
 *
 * O dono senta com o computador para conferir de verdade; no celular é a olhada rápida — "o
 * que aconteceu na loja hoje?". Por isso a lista é enxuta e sem os filtros de data do web.
 */

import { FlashList } from '@shopify/flash-list';
import { useInfiniteQuery } from '@tanstack/react-query';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { RefreshControl, StyleSheet, Text, View } from 'react-native';

import { mensagemDoErro } from '@/api/client';
import { auditoria } from '@/api/endpoints';
import type { Auditoria, Papel } from '@/api/tipos';
import { Carregando, ErroEstado, Etiqueta, Vazio } from '@/components/ui';
import { chaves } from '@/lib/queryClient';
import { cores, espaco, fonte, raio } from '@/lib/tema';

/** Rótulo curto e tom de cada ação. O tom destaca o que o dono varre procurando. */
const ACOES: Record<string, { rotulo: string; tom: 'ok' | 'alerta' | 'perigo' | 'neutro' }> = {
  LOGIN: { rotulo: 'Entrou', tom: 'neutro' },
  LOGOUT: { rotulo: 'Saiu', tom: 'neutro' },
  LOGIN_FALHOU: { rotulo: 'Senha errada', tom: 'alerta' },
  VENDA_CRIADA: { rotulo: 'Venda', tom: 'ok' },
  VENDA_CANCELADA: { rotulo: 'Cancelou venda', tom: 'perigo' },
  DEVOLUCAO: { rotulo: 'Devolução', tom: 'alerta' },
  ENTRADA: { rotulo: 'Entrada', tom: 'neutro' },
  AJUSTE: { rotulo: 'Ajuste', tom: 'alerta' },
  INVENTARIO: { rotulo: 'Inventário', tom: 'neutro' },
  PRODUTO_CRIADO: { rotulo: 'Cadastrou peça', tom: 'neutro' },
  PRODUTO_EDITADO: { rotulo: 'Editou produto', tom: 'neutro' },
  PRODUTO_EXCLUIDO: { rotulo: 'Excluiu produto', tom: 'perigo' },
  PECA_ADICIONADA: { rotulo: 'Nova peça', tom: 'neutro' },
  PECA_EDITADA: { rotulo: 'Editou peça', tom: 'alerta' },
  PECA_EXCLUIDA: { rotulo: 'Excluiu peça', tom: 'perigo' },
  FOTO: { rotulo: 'Trocou foto', tom: 'neutro' },
  CATEGORIA_CRIADA: { rotulo: 'Categoria', tom: 'neutro' },
  CATEGORIA_EDITADA: { rotulo: 'Editou categoria', tom: 'neutro' },
  CATEGORIA_EXCLUIDA: { rotulo: 'Excluiu categoria', tom: 'perigo' },
  CLIENTE_CRIADO: { rotulo: 'Cadastrou cliente', tom: 'neutro' },
  CLIENTE_EDITADO: { rotulo: 'Editou cliente', tom: 'neutro' },
  CLIENTE_EXCLUIDO: { rotulo: 'Excluiu cliente', tom: 'perigo' },
  FIADO_RECEBIDO: { rotulo: 'Recebeu fiado', tom: 'ok' },
  DESPESA_CRIADA: { rotulo: 'Lançou despesa', tom: 'neutro' },
  DESPESA_EDITADA: { rotulo: 'Editou despesa', tom: 'neutro' },
  DESPESA_EXCLUIDA: { rotulo: 'Excluiu despesa', tom: 'perigo' },
  DESPESAS_REPLICADAS: { rotulo: 'Contas fixas', tom: 'neutro' },
  CAIXA_FECHADO: { rotulo: 'Fechou o caixa', tom: 'ok' },
  USUARIO_CRIADO: { rotulo: 'Criou usuário', tom: 'perigo' },
  USUARIO_EDITADO: { rotulo: 'Editou usuário', tom: 'perigo' },
  SENHA_REDEFINIDA: { rotulo: 'Redefiniu senha', tom: 'perigo' },
  SENHA_PROPRIA: { rotulo: 'Trocou a senha', tom: 'neutro' },
  // A carga da demonstração na Vercel (ADR-42): quem age é o build, não uma pessoa.
  DEMONSTRACAO_INICIADA: { rotulo: 'Carga da demonstração', tom: 'neutro' },
  DEMONSTRACAO_SEMEADA: { rotulo: 'Demonstração carregada', tom: 'ok' },
  OUTRO: { rotulo: 'Outra ação', tom: 'neutro' },
};

const PAPEIS: Record<Papel, string> = {
  ADMIN: 'Dono',
  GERENTE: 'Gerente',
  SUPERVISORA: 'Supervisora',
  VENDEDOR: 'Vendedora',
};

const CORES_TOM = {
  ok: { fundo: cores.sucessoFraco, texto: cores.acaoEscura },
  alerta: { fundo: cores.alertaFraco, texto: '#7A5A00' },
  perigo: { fundo: cores.perigoFraco, texto: cores.perigo },
  neutro: { fundo: cores.primariaFraca, texto: cores.primaria },
} as const;

export default function AuditoriaTela() {
  const consulta = useInfiniteQuery({
    queryKey: [...chaves.auditoria, 'app'],
    initialPageParam: 1,
    queryFn: ({ pageParam }) => auditoria.listar({ page: pageParam, size: 30 }),
    getNextPageParam: (ultima) =>
      ultima.page * ultima.size < ultima.total ? ultima.page + 1 : undefined,
  });

  const linhas = consulta.data?.pages.flatMap((p) => p.items) ?? [];

  if (consulta.isPending) return <Carregando />;
  if (consulta.isError) {
    return (
      <ErroEstado
        mensagem={mensagemDoErro(consulta.error, 'Não deu para carregar a auditoria.')}
        aoTentarNovamente={() => void consulta.refetch()}
      />
    );
  }
  if (linhas.length === 0) {
    return <Vazio titulo="Nada por aqui ainda" descricao="Assim que alguém agir, aparece." />;
  }

  return (
    <FlashList
      data={linhas}
      keyExtractor={(e) => String(e.id)}
      contentContainerStyle={s.lista}
      ListHeaderComponent={
        <Text style={s.aviso}>Tudo que cada pessoa fez no login dela. Só você vê isto.</Text>
      }
      onEndReached={() => {
        if (consulta.hasNextPage && !consulta.isFetchingNextPage) {
          void consulta.fetchNextPage();
        }
      }}
      refreshControl={
        <RefreshControl
          refreshing={consulta.isRefetching && !consulta.isFetchingNextPage}
          onRefresh={() => void consulta.refetch()}
        />
      }
      renderItem={({ item }) => <Linha ato={item} />}
    />
  );
}

function Linha({ ato }: { ato: Auditoria }) {
  const info = ACOES[ato.acao] ?? { rotulo: ato.acao, tom: 'neutro' as const };
  const cor = CORES_TOM[info.tom];
  return (
    <View style={s.linha}>
      <View style={s.linhaTopo}>
        <Text style={s.quem} numberOfLines={1}>
          {ato.usuario}
          {ato.papel ? <Text style={s.papel}>  ·  {PAPEIS[ato.papel] ?? ato.papel}</Text> : null}
        </Text>
        <Text style={s.quando}>{format(new Date(ato.quando), "dd/MM HH:mm", { locale: ptBR })}</Text>
      </View>
      <View style={s.linhaBaixo}>
        <Etiqueta texto={info.rotulo} cor={cor.fundo} corTexto={cor.texto} />
        <Text style={s.descricao} numberOfLines={2}>
          {ato.descricao}
        </Text>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  lista: { padding: espaco.md },
  aviso: {
    fontSize: fonte.pequena,
    color: cores.textoSuave,
    paddingHorizontal: espaco.sm,
    paddingBottom: espaco.md,
  },
  linha: {
    backgroundColor: cores.superficie,
    borderRadius: raio.md,
    padding: espaco.lg,
    marginBottom: espaco.sm,
  },
  linhaTopo: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: espaco.sm,
    gap: espaco.sm,
  },
  quem: { flex: 1, fontSize: fonte.base, fontWeight: '700', color: cores.texto },
  papel: { fontWeight: '400', color: cores.textoFraco, fontSize: fonte.pequena },
  quando: { fontSize: fonte.micro, color: cores.textoFraco },
  linhaBaixo: { flexDirection: 'row', alignItems: 'center', gap: espaco.sm },
  descricao: { flex: 1, fontSize: fonte.pequena, color: cores.textoSuave },
});
