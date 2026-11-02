/**
 * Uma condicional e o fechamento dela (ADR-39). Espelho de `web/js/views/condicionais-detalhe.js`.
 *
 * Fechar é conferir a sacola peça por peça: cada linha pede quantas VOLTARAM, sem valor
 * sugerido — "tudo voltou" é um botão, não o padrão. O que ficou vira venda comum (caixa,
 * recibo, comissão), com os pagamentos daqui; a conta é de `lib/condicional.ts` e quem
 * decide o preço de verdade é o servidor (ADR-4). A chave do fechamento nasce com a tela:
 * a resposta perdida e o reenvio caem no mesmo fechamento, nunca em dois.
 */

import { useMutation, useQuery } from '@tanstack/react-query';
import { format } from 'date-fns';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { codigoDoErro, mensagemDoErro } from '@/api/client';
import { condicionais } from '@/api/endpoints';
import type { FormaPagamento } from '@/api/tipos';
import { ModalParcelas, type CreditoEscolhido } from '@/components/PagarCredito';
import { ModalVale } from '@/components/PagarValeFiado';
import { Botao, Carregando, Cartao, ErroEstado, Etiqueta, Linha } from '@/components/ui';
import { rotuloPagamento } from '@/lib/cartao';
import { itensDoFechamento, resumirFechamento, textoDoPrazo } from '@/lib/condicional';
import { formatar, paraCentavos, paraDecimalString, somar, type Centavos } from '@/lib/money';
import { PODE, pode } from '@/lib/permissoes';
import { chaves, invalidarAposCondicional } from '@/lib/queryClient';
import { cores, espaco, fonte, raio } from '@/lib/tema';
import { gerarUuid } from '@/lib/uuid';
import { useAuthStore } from '@/stores/authStore';

interface Pagamento {
  forma: FormaPagamento;
  valor: Centavos;
  codigoVale?: string;
  parcelas?: number;
  bandeira?: string | null;
}

const ROTULO: Record<FormaPagamento, string> = {
  DINHEIRO: 'Dinheiro', PIX: 'PIX', DEBITO: 'Débito', CREDITO: 'Crédito', VALE: 'Vale', FIADO: 'Fiado',
};

export default function CondicionalDetalhe() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const podeFiado = pode(useAuthStore((e) => e.usuario?.papel), PODE.GERIR_CREDIARIO);
  const [devolvidas, setDevolvidas] = useState<Map<number, number>>(new Map());
  const [pagamentos, setPagamentos] = useState<Pagamento[]>([]);
  const [desconto, setDesconto] = useState<Centavos>(0);
  const [perguntandoVale, setPerguntandoVale] = useState(false);
  const [perguntandoParcelas, setPerguntandoParcelas] = useState(false);
  const [chave] = useState(() => gerarUuid());

  const consulta = useQuery({
    queryKey: chaves.condicional(Number(id)),
    queryFn: () => condicionais.obter(Number(id)),
  });

  const fechar = useMutation({
    mutationFn: () =>
      condicionais.fechar(Number(id), {
        client_uuid: chave,
        itens: itensDoFechamento(consulta.data!.itens, devolvidas),
        // Tudo voltou, o campo some — e o desconto digitado antes não pode ir junto: o
        // servidor recusa desconto sem venda (422). Espelho do web.
        desconto: paraDecimalString(
          Math.min(desconto, resumirFechamento(consulta.data!.itens, devolvidas).total),
        ),
        pagamentos: pagamentos.map((p) => ({
          forma: p.forma,
          valor: paraDecimalString(p.valor),
          ...(p.codigoVale ? { codigo_vale: p.codigoVale } : {}),
          ...(p.parcelas ? { parcelas: p.parcelas } : {}),
          ...(p.bandeira ? { bandeira: p.bandeira } : {}),
        })),
      }),
    onSuccess: (c) => {
      invalidarAposCondicional();
      if (c.venda_id) router.replace({ pathname: '/venda/[id]', params: { id: String(c.venda_id) } });
      else void consulta.refetch();
    },
    onError: (erro) => {
      Alert.alert('Não deu para fechar', mensagemDoErro(erro));
      // Já fechada (outro aparelho, outro pagamento): a tela antiga não vale mais.
      if (codigoDoErro(erro) === 'DUPLICADO' || codigoDoErro(erro) === 'OPERACAO_INVALIDA') void consulta.refetch();
    },
  });

  if (consulta.isPending) return <Carregando />;
  if (consulta.isError) {
    return <ErroEstado mensagem={mensagemDoErro(consulta.error)} aoTentarNovamente={() => void consulta.refetch()} />;
  }
  const c = consulta.data;
  const aberta = c.status === 'ABERTA';
  const respondeuTudo = c.itens.every((i) => devolvidas.has(i.variante_id));
  const r = resumirFechamento(c.itens, devolvidas);
  const aPagar = Math.max(0, r.total - desconto);
  const falta = aPagar - somar(pagamentos.map((p) => p.valor));
  const pronto = aberta && respondeuTudo && (r.total === 0 || (pagamentos.length > 0 && falta === 0));

  function responder(varianteId: number, texto: string) {
    setDevolvidas((atual) => {
      const novo = new Map(atual);
      if (texto.trim() === '') novo.delete(varianteId);
      else novo.set(varianteId, Math.max(0, Math.trunc(Number(texto.replace(/\D/g, '')) || 0)));
      return novo;
    });
    setPagamentos([]);
  }

  function adicionar(forma: FormaPagamento) {
    if (forma === 'VALE') return setPerguntandoVale(true);
    if (pagamentos.some((p) => p.forma === forma) || falta <= 0) return;
    // Como no PDV (ADR-35): em quantas vezes e em que bandeira, antes do valor entrar.
    // Sem isto toda condicional parcelada virava 1x — a taxa e os recebíveis do à vista.
    if (forma === 'CREDITO') return setPerguntandoParcelas(true);
    setPagamentos((atuais) => [...atuais, { forma, valor: falta }]);
  }

  function aplicarCredito(escolha: CreditoEscolhido) {
    setPerguntandoParcelas(false);
    if (falta <= 0) return;
    setPagamentos((atuais) => [...atuais, { forma: 'CREDITO', valor: falta, ...escolha }]);
  }

  return (
    <ScrollView contentContainerStyle={s.conteudo} keyboardShouldPersistTaps="handled">
      <Cartao>
        <Text style={s.titulo}>#{c.id} · {c.cliente}</Text>
        <Text style={s.detalhe}>{c.cliente_telefone ?? 'sem telefone'} · atendida por {c.vendedora}</Text>
        <Text style={s.detalhe}>
          Saiu em {format(new Date(c.criada_em), 'dd/MM HH:mm')} · prazo {c.prazo.split('-').reverse().join('/')}
        </Text>
        <View style={{ marginTop: espaco.sm }}>
          {aberta ? (
            <Etiqueta texto={textoDoPrazo(c.dias_para_vencer)} cor={c.vencida ? cores.perigoFraco : cores.primariaFraca} corTexto={c.vencida ? cores.perigo : cores.primaria} />
          ) : (
            <Etiqueta texto={c.venda_id ? `fechada · venda #${c.venda_id}` : 'fechada · tudo voltou'} />
          )}
        </View>
      </Cartao>

      {c.itens.map((i) => (
        <View key={i.variante_id} style={s.item}>
          <View style={{ flex: 1 }}>
            <Text style={s.nome} numberOfLines={1}>{i.produto}</Text>
            <Text style={s.detalhe}>{i.tamanho} · {i.cor} · {formatar(paraCentavos(i.preco_venda))} · levou {i.quantidade}</Text>
          </View>
          {aberta ? (
            <View style={{ alignItems: 'center' }}>
              <Text style={s.detalhe}>voltou</Text>
              <TextInput
                style={s.entrada}
                keyboardType="number-pad"
                value={devolvidas.has(i.variante_id) ? String(devolvidas.get(i.variante_id)) : ''}
                onChangeText={(t) => responder(i.variante_id, t)}
                placeholder="?"
              />
            </View>
          ) : (
            <Text style={s.detalhe}>voltou {i.devolvida} · ficou {i.ficou}</Text>
          )}
        </View>
      ))}

      {aberta && (
        <>
          <Botao
            titulo="Tudo voltou"
            variante="secundario"
            onPress={() => {
              setDevolvidas(new Map(c.itens.map((i) => [i.variante_id, i.quantidade])));
              setPagamentos([]);
            }}
          />
          {respondeuTudo && (
            <Cartao estilo={{ marginTop: espaco.md }}>
              <Linha esquerda="Voltam ao estoque" direita={String(r.pecasQueVoltaram)} />
              <Linha esquerda="Ficam com a cliente" direita={String(r.pecasQueFicaram)} />
              {r.total > 0 && (
                <>
                  <Linha esquerda="Peças que ficaram" direita={formatar(r.total)} />
                  <View style={s.linha}>
                    <Text style={s.detalhe}>Desconto</Text>
                    <TextInput
                      style={[s.entrada, { width: 110 }]}
                      keyboardType="decimal-pad"
                      placeholder="0,00"
                      onEndEditing={(e) => {
                        setDesconto(Math.min(paraCentavos(e.nativeEvent.text), r.total));
                        setPagamentos([]);
                      }}
                    />
                  </View>
                  <Linha esquerda="A cobrar" direita={formatar(aPagar)} destaque />
                  <View style={s.formas}>
                    {(['DINHEIRO', 'PIX', 'DEBITO', 'CREDITO', 'VALE', 'FIADO'] as FormaPagamento[])
                      .filter((f) => f !== 'FIADO' || podeFiado)
                      .map((f) => (
                        <Pressable key={f} style={s.forma} onPress={() => adicionar(f)}>
                          <Text style={s.formaTexto}>{ROTULO[f]}</Text>
                        </Pressable>
                      ))}
                  </View>
                  {pagamentos.map((p, n) => (
                    <View key={`${p.forma}-${n}`} style={s.linha}>
                      <Text style={s.nome}>{p.forma === 'CREDITO' ? rotuloPagamento(p) : ROTULO[p.forma]}{p.codigoVale ? ` ${p.codigoVale}` : ''}</Text>
                      <Text style={s.nome}>{formatar(p.valor)}</Text>
                      <Pressable onPress={() => setPagamentos((a) => a.filter((_, j) => j !== n))}>
                        <Text style={s.remover}>✕</Text>
                      </Pressable>
                    </View>
                  ))}
                  <Text style={s.detalhe}>{falta > 0 ? `Falta ${formatar(falta)}` : falta < 0 ? `Passou ${formatar(-falta)}` : 'Pago'}</Text>
                </>
              )}
            </Cartao>
          )}
          <Botao
            titulo="Fechar condicional"
            variante="acao"
            grande
            estilo={{ marginTop: espaco.lg }}
            desabilitado={!pronto}
            carregando={fechar.isPending}
            onPress={() => fechar.mutate()}
          />
        </>
      )}

      <ModalParcelas
        visivel={perguntandoParcelas}
        valor={Math.max(0, falta)}
        aoEscolher={aplicarCredito}
        aoCancelar={() => setPerguntandoParcelas(false)}
      />
      <ModalVale
        visivel={perguntandoVale}
        falta={Math.max(0, falta)}
        aoCancelar={() => setPerguntandoVale(false)}
        aoEscolher={(vale) => {
          setPerguntandoVale(false);
          setPagamentos((a) => [...a, { forma: 'VALE', valor: Math.min(vale.saldo, Math.max(0, falta)), codigoVale: vale.codigo }]);
        }}
      />
    </ScrollView>
  );
}

const s = StyleSheet.create({
  conteudo: { padding: espaco.lg, gap: espaco.sm },
  titulo: { fontSize: fonte.media, fontWeight: '800', color: cores.texto },
  nome: { fontSize: fonte.base, fontWeight: '700', color: cores.texto },
  detalhe: { fontSize: fonte.pequena, color: cores.textoSuave, marginTop: 2 },
  item: { flexDirection: 'row', alignItems: 'center', gap: espaco.md, backgroundColor: cores.superficie, borderRadius: raio.md, padding: espaco.md },
  entrada: { borderWidth: 1, borderColor: cores.borda, borderRadius: raio.sm, minWidth: 56, paddingVertical: espaco.xs, paddingHorizontal: espaco.sm, fontSize: fonte.media, textAlign: 'center', color: cores.texto, backgroundColor: cores.fundo },
  linha: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: espaco.sm, marginTop: espaco.sm },
  formas: { flexDirection: 'row', flexWrap: 'wrap', gap: espaco.sm, marginTop: espaco.md },
  forma: { paddingHorizontal: espaco.md, paddingVertical: espaco.sm, borderRadius: raio.redondo, backgroundColor: cores.primariaFraca },
  formaTexto: { fontWeight: '700', color: cores.primaria },
  remover: { color: cores.perigo, fontSize: fonte.media, paddingHorizontal: espaco.sm },
});
