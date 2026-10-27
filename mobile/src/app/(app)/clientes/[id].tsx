/**
 * A conta de uma cliente: o que levou no fiado, o que já pagou, o que ainda deve.
 *
 * O botão grande é "Receber" — é o que a dona abre esta tela para fazer. O valor já vem
 * preenchido com o que falta, que é o que ela digita em nove de dez vezes.
 *
 * O saldo é **sempre calculado pelo servidor**, nunca guardado: saldo guardado é saldo que
 * sai do lugar no dia em que alguém esquece de atualizar.
 */

import { useInfiniteQuery, useMutation } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import {
  Alert,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { mensagemDoErro } from '@/api/client';
import { clientes } from '@/api/endpoints';
import { FORMAS_DE_GAVETA, type FormaPagamento } from '@/api/tipos';
import { TecladoNumerico } from '@/components/TecladoNumerico';
import { Botao, Carregando, Cartao, ErroEstado, Etiqueta, Separador } from '@/components/ui';
import { formatar, paraCentavos, paraDecimalString, type Centavos } from '@/lib/money';
import { PODE, pode } from '@/lib/permissoes';
import { chaves, invalidarAposCrediario } from '@/lib/queryClient';
import { gerarUuid } from '@/lib/uuid';
import { ALVO_TOQUE, cores, espaco, fonte, raio } from '@/lib/tema';
import { useAuthStore } from '@/stores/authStore';

const ROTULO_FORMA: Record<FormaPagamento, string> = {
  DINHEIRO: 'Dinheiro',
  PIX: 'PIX',
  DEBITO: 'Débito',
  CREDITO: 'Crédito',
  VALE: 'Vale de troca',
  FIADO: 'Fiado',
};

export default function ClienteDetalhe() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const clienteId = Number(id);
  const podeReceber = pode(useAuthStore((e) => e.usuario?.papel), PODE.GERIR_CREDIARIO);
  const [recebendo, setRecebendo] = useState(false);

  // Compras e pagamentos vêm paginados juntos (o mesmo ?page=&size=): "Carregar mais" traz
  // a próxima leva das duas listas. A caderneta de anos não desce numa resposta só, e os
  // totais continuam sendo da conta inteira — iguais em toda página.
  const extrato = useInfiniteQuery({
    queryKey: chaves.extratoCliente(clienteId),
    initialPageParam: 1,
    queryFn: ({ pageParam }) => clientes.extrato(clienteId, { page: pageParam, size: 20 }),
    getNextPageParam: (ultima) =>
      ultima.vendas.page * ultima.vendas.size <
      Math.max(ultima.vendas.total, ultima.pagamentos.total)
        ? ultima.vendas.page + 1
        : undefined,
    enabled: Number.isFinite(clienteId),
  });

  if (extrato.isPending) return <Carregando />;
  if (extrato.isError) {
    return (
      <ErroEstado
        mensagem={mensagemDoErro(extrato.error, 'Não deu para carregar o extrato.')}
        aoTentarNovamente={() => void extrato.refetch()}
      />
    );
  }

  const e = extrato.data.pages[0];
  const comprasNoFiado = extrato.data.pages.flatMap((p) => p.vendas.items);
  const pagamentosFeitos = extrato.data.pages.flatMap((p) => p.pagamentos.items);
  const deve = paraCentavos(e.deve);

  return (
    <View style={s.tela}>
      <ScrollView
        contentContainerStyle={s.conteudo}
        refreshControl={
          <RefreshControl
            refreshing={extrato.isRefetching && !extrato.isFetchingNextPage}
            onRefresh={() => void extrato.refetch()}
          />
        }
      >
        <View style={[s.destaque, deve > 0 && s.destaqueDevendo]}>
          <Text style={s.destaqueNome}>{e.cliente.nome}</Text>
          <Text style={s.destaqueRotulo}>{deve > 0 ? 'Está devendo' : 'Em dia'}</Text>
          <Text style={s.destaqueValor}>{formatar(deve)}</Text>
          {!!e.cliente.telefone && <Text style={s.destaqueAjuda}>{e.cliente.telefone}</Text>}
          {e.cliente.acima_do_limite && (
            <Etiqueta
              texto="acima do limite combinado"
              cor={cores.alertaFraco}
              corTexto="#7A5A00"
              estilo={s.etiqueta}
            />
          )}
        </View>

        <Cartao>
          <Linha rotulo="Levou no fiado" valor={paraCentavos(e.total_fiado)} />
          <Linha rotulo="Já pagou" valor={paraCentavos(e.total_pago)} />
          <Linha rotulo="Devolveu" valor={paraCentavos(e.total_devolvido)} />
          <Separador />
          <Linha rotulo="Deve" valor={deve} destaque />
        </Cartao>

        <Text style={s.secao}>Compras no fiado</Text>
        {comprasNoFiado.length === 0 ? (
          <Text style={s.vazio}>Nenhuma.</Text>
        ) : (
          comprasNoFiado.map((v) => (
            <Pressable
              key={v.venda_id}
              style={({ pressed }) => [s.item, pressed && s.itemPressionado]}
              onPress={() =>
                router.push({ pathname: '/venda/[id]', params: { id: String(v.venda_id) } })
              }
            >
              <View style={s.itemTexto}>
                <Text style={s.itemNome}>Venda #{v.venda_id}</Text>
                <Text style={s.itemDetalhe}>
                  {new Date(v.vendida_em).toLocaleDateString('pt-BR')} · total{' '}
                  {formatar(paraCentavos(v.total_da_venda))}
                </Text>
              </View>
              <Text style={s.itemValor}>{formatar(paraCentavos(v.no_fiado))}</Text>
            </Pressable>
          ))
        )}

        <Text style={s.secao}>Pagamentos</Text>
        {pagamentosFeitos.length === 0 ? (
          <Text style={s.vazio}>Ainda não pagou nada.</Text>
        ) : (
          pagamentosFeitos.map((p) => (
            <View key={p.id} style={s.item}>
              <View style={s.itemTexto}>
                <Text style={s.itemNome}>{ROTULO_FORMA[p.forma] ?? p.forma}</Text>
                <Text style={s.itemDetalhe}>
                  {new Date(p.pago_em).toLocaleDateString('pt-BR')}
                </Text>
              </View>
              <Text style={[s.itemValor, s.itemValorPago]}>
                {formatar(paraCentavos(p.valor))}
              </Text>
            </View>
          ))
        )}

        {extrato.hasNextPage && (
          <Botao
            titulo="Carregar mais"
            variante="secundario"
            carregando={extrato.isFetchingNextPage}
            onPress={() => void extrato.fetchNextPage()}
          />
        )}
      </ScrollView>

      {podeReceber && deve > 0 && (
        <View style={s.rodape}>
          <Botao titulo="Receber pagamento" grande onPress={() => setRecebendo(true)} />
        </View>
      )}

      <ModalReceber
        visivel={recebendo}
        clienteId={clienteId}
        nome={e.cliente.nome}
        deve={deve}
        aoFechar={() => setRecebendo(false)}
      />
    </View>
  );
}

function Linha({
  rotulo,
  valor,
  destaque = false,
}: {
  rotulo: string;
  valor: Centavos;
  destaque?: boolean;
}) {
  return (
    <View style={s.linha}>
      <Text style={[s.linhaRotulo, destaque && s.linhaDestaque]}>{rotulo}</Text>
      <Text style={[s.linhaValor, destaque && s.linhaDestaque]}>{formatar(valor)}</Text>
    </View>
  );
}

/* ------------------------------------------------------------- recebimento */

function ModalReceber({
  visivel,
  clienteId,
  nome,
  deve,
  aoFechar,
}: {
  visivel: boolean;
  clienteId: number;
  nome: string;
  deve: Centavos;
  aoFechar: () => void;
}) {
  // Já vem com o que falta: é o valor de nove em dez recebimentos, e o teclado troca tudo
  // no primeiro dígito quando for outro.
  const [valor, setValor] = useState<Centavos>(deve);
  const [forma, setForma] = useState<FormaPagamento>('DINHEIRO');
  // UUID por abertura do diálogo: o retry de um toque duplo é a mesma cobrança; um novo
  // recebimento, aberto de novo, é outra.
  const [uuid, setUuid] = useState(() => gerarUuid());

  const receber = useMutation({
    mutationFn: () =>
      clientes.receber(clienteId, {
        forma,
        valor: paraDecimalString(valor),
        client_uuid: uuid,
      }),
    onSuccess: () => {
      invalidarAposCrediario();
      aoFechar();
      Alert.alert('Pagamento registrado', `${formatar(valor)} recebidos de ${nome}.`);
    },
    onError: (erro) => Alert.alert('Não deu para registrar', mensagemDoErro(erro)),
  });

  function abrirDoZero() {
    setValor(deve);
    setForma('DINHEIRO');
    setUuid(gerarUuid());
  }

  return (
    <Modal
      visible={visivel}
      animationType="slide"
      onRequestClose={aoFechar}
      onShow={abrirDoZero}
    >
      <View style={s.tela}>
        <View style={s.painel}>
          <Text style={s.painelRotulo}>Recebendo de {nome}</Text>
          <Text style={s.painelValor}>{formatar(valor)}</Text>
          <Text style={s.painelAjuda}>Deve {formatar(deve)}</Text>
        </View>

        <ScrollView contentContainerStyle={s.conteudo} keyboardShouldPersistTaps="handled">
          <Text style={s.secao}>Como recebeu</Text>
          <View style={s.formas}>
            {FORMAS_DE_GAVETA.map((f) => (
              <Pressable
                key={f}
                style={[s.forma, forma === f && s.formaAtiva]}
                onPress={() => setForma(f)}
              >
                <Text style={[s.formaTexto, forma === f && s.formaTextoAtivo]}>
                  {ROTULO_FORMA[f]}
                </Text>
              </Pressable>
            ))}
          </View>

          <TecladoNumerico
            valor={valor}
            aoMudar={setValor}
            atalhos={[
              { rotulo: 'Limpar', valor: 0 },
              { rotulo: `Metade ${formatar(Math.floor(deve / 2))}`, valor: Math.floor(deve / 2) },
              { rotulo: `Tudo ${formatar(deve)}`, valor: deve },
            ]}
          />
        </ScrollView>

        <View style={s.rodapeDuplo}>
          <Botao titulo="Cancelar" variante="secundario" estilo={s.metade} onPress={aoFechar} />
          <Botao
            titulo="Registrar"
            variante="acao"
            estilo={s.metade}
            // Pagar mais do que deve viraria crédito que ninguém sabe cobrar de volta.
            desabilitado={valor <= 0 || valor > deve}
            carregando={receber.isPending}
            onPress={() => receber.mutate()}
          />
        </View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  tela: { flex: 1, backgroundColor: cores.fundo },
  conteudo: { padding: espaco.lg, gap: espaco.sm, paddingBottom: espaco.xxl },

  destaque: { padding: espaco.lg, borderRadius: raio.md, backgroundColor: cores.primaria },
  destaqueDevendo: { backgroundColor: cores.perigo },
  destaqueNome: { color: cores.aoFundoEscuro, fontSize: fonte.media, fontWeight: '800' },
  destaqueRotulo: { color: 'rgba(255,255,255,0.8)', fontSize: fonte.pequena, marginTop: 4 },
  destaqueValor: { color: cores.aoFundoEscuro, fontSize: fonte.destaque, fontWeight: '800' },
  destaqueAjuda: { color: 'rgba(255,255,255,0.8)', fontSize: fonte.pequena },
  etiqueta: { alignSelf: 'flex-start', marginTop: espaco.sm },

  linha: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 },
  linhaRotulo: { fontSize: fonte.base, color: cores.textoSuave },
  linhaValor: { fontSize: fonte.base, color: cores.texto, fontWeight: '600' },
  linhaDestaque: { fontSize: fonte.grande, fontWeight: '800', color: cores.texto },

  secao: {
    fontSize: fonte.pequena,
    fontWeight: '700',
    color: cores.textoSuave,
    marginTop: espaco.md,
  },
  vazio: { fontSize: fonte.base, color: cores.textoFraco },

  item: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: espaco.sm,
    minHeight: 56,
    paddingHorizontal: espaco.lg,
    borderRadius: raio.md,
    backgroundColor: cores.superficie,
  },
  itemPressionado: { opacity: 0.85 },
  itemTexto: { flex: 1, paddingVertical: espaco.sm },
  itemNome: { fontSize: fonte.base, fontWeight: '700', color: cores.texto },
  itemDetalhe: { fontSize: fonte.pequena, color: cores.textoSuave },
  itemValor: { fontSize: fonte.media, fontWeight: '800', color: cores.texto },
  itemValorPago: { color: cores.acaoEscura },

  rodape: {
    padding: espaco.lg,
    backgroundColor: cores.superficie,
    borderTopWidth: 1,
    borderTopColor: cores.borda,
  },
  rodapeDuplo: {
    flexDirection: 'row',
    gap: espaco.sm,
    padding: espaco.lg,
    backgroundColor: cores.superficie,
    borderTopWidth: 1,
    borderTopColor: cores.borda,
  },
  metade: { flex: 1 },

  painel: {
    backgroundColor: cores.primaria,
    paddingHorizontal: espaco.lg,
    paddingVertical: espaco.lg,
  },
  painelRotulo: { color: '#B9CBE0', fontSize: fonte.pequena, fontWeight: '600' },
  painelValor: {
    color: cores.aoFundoEscuro,
    fontSize: fonte.destaque,
    fontWeight: '800',
    marginTop: 2,
  },
  painelAjuda: { color: '#B9CBE0', fontSize: fonte.pequena },

  formas: { flexDirection: 'row', flexWrap: 'wrap', gap: espaco.sm },
  forma: {
    minHeight: ALVO_TOQUE,
    minWidth: '47%',
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: raio.md,
    borderWidth: 1,
    borderColor: cores.borda,
    backgroundColor: cores.superficie,
  },
  formaAtiva: { backgroundColor: cores.primariaFraca, borderColor: cores.primaria },
  formaTexto: { fontSize: fonte.base, fontWeight: '700', color: cores.textoSuave },
  formaTextoAtivo: { color: cores.primaria },
});
