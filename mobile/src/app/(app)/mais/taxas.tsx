/**
 * Taxas da maquininha: quanto a credenciadora fica de cada venda no cartão, e quando paga.
 *
 * Espelho de `web/js/views/taxas.js`. É o contrato que o dono assinou — só ele muda
 * (`CONFIGURAR_LOJA`); o gerente lê (`VER_DINHEIRO`), porque o Resultado que ele vê já
 * desconta estas taxas. A taxa vai FOTOGRAFADA em cada venda (ADR-35): mudar aqui vale
 * daqui para frente e não reescreve o mês que passou — por isso nenhuma mutação desta
 * tela invalida os relatórios.
 */

import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { mensagemDoErro } from '@/api/client';
import { taxasCartao } from '@/api/endpoints';
import type { TaxaCartao } from '@/api/tipos';
import { Botao, Campo, Carregando, ErroEstado, Vazio } from '@/components/ui';
import { MAX_PARCELAS, faixaDeParcelas, formatarTaxa, taxaDigitada } from '@/lib/cartao';
import { PODE, pode } from '@/lib/permissoes';
import { chaves, queryClient } from '@/lib/queryClient';
import { ALVO_TOQUE, cores, espaco, fonte, raio } from '@/lib/tema';
import { useAuthStore } from '@/stores/authStore';

type Forma = TaxaCartao['forma'];
const NOMES: Record<Forma, string> = { DEBITO: 'Débito', CREDITO: 'Crédito' };

interface Rascunho {
  id: number | null;
  forma: Forma;
  de: number;
  ate: number;
  percentual: string;
  prazo: string;
}

const VAZIO: Rascunho = { id: null, forma: 'CREDITO', de: 1, ate: 1, percentual: '', prazo: '30' };

/** − 3x + : a faixa anda de uma em uma, sem teclado. */
function Contador({
  rotulo,
  valor,
  aoMudar,
}: {
  rotulo: string;
  valor: number;
  aoMudar: (n: number) => void;
}) {
  return (
    <View style={s.contador}>
      <Text style={s.rotulo}>{rotulo}</Text>
      <View style={s.contadorLinha}>
        <Pressable style={s.contadorBotao} onPress={() => aoMudar(Math.max(1, valor - 1))}>
          <Text style={s.contadorSinal}>−</Text>
        </Pressable>
        <Text style={s.contadorValor}>{valor}x</Text>
        <Pressable
          style={s.contadorBotao}
          onPress={() => aoMudar(Math.min(MAX_PARCELAS, valor + 1))}
        >
          <Text style={s.contadorSinal}>+</Text>
        </Pressable>
      </View>
    </View>
  );
}

export default function Taxas() {
  const podeMudar = pode(useAuthStore((e) => e.usuario?.papel), PODE.CONFIGURAR_LOJA);
  const [r, setR] = useState<Rascunho>(VAZIO);

  const consulta = useQuery({
    queryKey: chaves.taxasCartao,
    queryFn: () => taxasCartao.listar({ size: 50 }),
  });

  const salvar = useMutation({
    mutationFn: (dados: Omit<TaxaCartao, 'id'>) => {
      if (r.id === null) return taxasCartao.criar(dados);
      const { forma: _forma, ...campos } = dados;
      return taxasCartao.atualizar(r.id, campos);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: chaves.taxasCartao });
      setR(VAZIO);
    },
    onError: (e) => Alert.alert('Não deu para salvar', mensagemDoErro(e)),
  });

  const excluir = useMutation({
    mutationFn: (id: number) => taxasCartao.excluir(id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: chaves.taxasCartao }),
    onError: (e) => Alert.alert('Não deu para excluir', mensagemDoErro(e)),
  });

  function enviar() {
    const percentual = taxaDigitada(r.percentual);
    const prazo = Number(r.prazo);
    if (percentual === null) {
      Alert.alert('Taxa inválida', 'Escreva como no contrato, por exemplo 3,19.');
      return;
    }
    if (!Number.isInteger(prazo) || prazo < 0 || prazo > 366) {
      Alert.alert('Prazo inválido', 'Dias para cair na conta, de 0 a 366.');
      return;
    }
    const debito = r.forma === 'DEBITO';
    salvar.mutate({
      forma: r.forma,
      parcelas_de: debito ? 1 : r.de,
      parcelas_ate: debito ? 1 : Math.max(r.de, r.ate),
      percentual,
      prazo_dias: prazo,
    });
  }

  if (consulta.isPending) return <Carregando />;
  if (consulta.isError) {
    return (
      <ErroEstado
        mensagem={mensagemDoErro(consulta.error, 'Não deu para carregar.')}
        aoTentarNovamente={() => void consulta.refetch()}
      />
    );
  }

  const lista = consulta.data.items;

  return (
    <ScrollView contentContainerStyle={s.conteudo} keyboardShouldPersistTaps="handled">
      <Text style={s.dica}>
        O que a maquininha cobra por forma e parcela, e em quantos dias o dinheiro cai. Os
        relatórios descontam estas taxas do Resultado.
      </Text>

      {lista.length === 0 ? (
        <Vazio
          titulo="Nenhuma taxa cadastrada"
          descricao="Sem taxa, o Resultado não desconta a maquininha."
        />
      ) : (
        lista.map((t) => (
          <Pressable
            key={t.id}
            style={[s.item, r.id === t.id && s.itemEditando]}
            disabled={!podeMudar}
            onPress={() =>
              setR({
                id: t.id,
                forma: t.forma,
                de: t.parcelas_de,
                ate: t.parcelas_ate,
                percentual: t.percentual.replace('.', ','),
                prazo: String(t.prazo_dias),
              })
            }
          >
            <View style={s.itemTexto}>
              <Text style={s.nome}>
                {NOMES[t.forma]} {faixaDeParcelas(t)}
              </Text>
              <Text style={s.detalhe}>cai em D+{t.prazo_dias}</Text>
            </View>
            <Text style={s.taxa}>{formatarTaxa(t.percentual)}</Text>
            {podeMudar && (
              <Pressable
                hitSlop={10}
                onPress={() =>
                  Alert.alert(
                    'Excluir esta taxa?',
                    'As próximas vendas entram sem taxa nesta faixa. As de antes não mudam.',
                    [
                      { text: 'Voltar', style: 'cancel' },
                      { text: 'Excluir', style: 'destructive', onPress: () => excluir.mutate(t.id) },
                    ],
                  )
                }
              >
                <MaterialCommunityIcons name="trash-can-outline" size={22} color={cores.perigo} />
              </Pressable>
            )}
          </Pressable>
        ))
      )}

      {podeMudar && (
        <View style={s.formulario}>
          <Text style={s.titulo}>{r.id === null ? 'Nova taxa' : 'Mudar taxa'}</Text>
          {r.id === null && (
            <View style={s.formas}>
              {(['CREDITO', 'DEBITO'] as Forma[]).map((f) => (
                <Pressable
                  key={f}
                  style={[s.forma, r.forma === f && s.formaMarcada]}
                  onPress={() => setR((a) => ({ ...a, forma: f, prazo: f === 'DEBITO' ? '1' : '30' }))}
                >
                  <Text style={[s.formaTexto, r.forma === f && s.formaTextoMarcado]}>
                    {NOMES[f]}
                  </Text>
                </Pressable>
              ))}
            </View>
          )}
          {/* Débito não parcela: a faixa só existe no crédito. */}
          {r.forma === 'CREDITO' && (
            <View style={s.linha}>
              <Contador rotulo="De" valor={r.de} aoMudar={(n) => setR((a) => ({ ...a, de: n }))} />
              <Contador
                rotulo="Até"
                valor={Math.max(r.de, r.ate)}
                aoMudar={(n) => setR((a) => ({ ...a, ate: n }))}
              />
            </View>
          )}
          <View style={s.linha}>
            <View style={s.metade}>
              <Campo
                rotulo="Taxa (%)"
                value={r.percentual}
                onChangeText={(t) => setR((a) => ({ ...a, percentual: t }))}
                placeholder="3,19"
                keyboardType="decimal-pad"
              />
            </View>
            <View style={s.metade}>
              <Campo
                rotulo="Dias até cair"
                value={r.prazo}
                onChangeText={(t) => setR((a) => ({ ...a, prazo: t.replace(/\D/g, '') }))}
                keyboardType="number-pad"
              />
            </View>
          </View>
          <View style={s.linha}>
            {r.id !== null && (
              <Botao
                titulo="Cancelar"
                variante="secundario"
                estilo={s.metade}
                onPress={() => setR(VAZIO)}
              />
            )}
            <Botao
              titulo="Salvar"
              estilo={s.metade}
              carregando={salvar.isPending}
              onPress={enviar}
            />
          </View>
        </View>
      )}
    </ScrollView>
  );
}

const s = StyleSheet.create({
  conteudo: { padding: espaco.lg, gap: espaco.sm },
  dica: { fontSize: fonte.pequena, color: cores.textoSuave, marginBottom: espaco.sm },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: espaco.md,
    backgroundColor: cores.superficie,
    borderRadius: raio.md,
    padding: espaco.lg,
  },
  itemEditando: { borderWidth: 2, borderColor: cores.primaria },
  itemTexto: { flex: 1 },
  nome: { fontSize: fonte.base, fontWeight: '700', color: cores.texto },
  detalhe: { fontSize: fonte.pequena, color: cores.textoSuave },
  taxa: { fontSize: fonte.media, fontWeight: '800', color: cores.texto },
  formulario: {
    backgroundColor: cores.superficie,
    borderRadius: raio.md,
    padding: espaco.lg,
    gap: espaco.md,
    marginTop: espaco.md,
  },
  titulo: { fontSize: fonte.media, fontWeight: '800', color: cores.texto },
  formas: { flexDirection: 'row', gap: espaco.sm },
  forma: {
    flex: 1,
    minHeight: ALVO_TOQUE,
    borderRadius: raio.md,
    borderWidth: 1,
    borderColor: cores.borda,
    alignItems: 'center',
    justifyContent: 'center',
  },
  formaMarcada: { backgroundColor: cores.primaria, borderColor: cores.primaria },
  formaTexto: { fontSize: fonte.base, fontWeight: '700', color: cores.texto },
  formaTextoMarcado: { color: cores.aoFundoEscuro },
  linha: { flexDirection: 'row', gap: espaco.sm },
  metade: { flex: 1 },
  contador: { flex: 1 },
  rotulo: { fontSize: fonte.pequena, color: cores.textoSuave, fontWeight: '600' },
  contadorLinha: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  contadorBotao: {
    width: ALVO_TOQUE,
    height: ALVO_TOQUE,
    borderRadius: raio.md,
    backgroundColor: cores.primariaFraca,
    alignItems: 'center',
    justifyContent: 'center',
  },
  contadorSinal: { fontSize: fonte.grande, fontWeight: '800', color: cores.primaria },
  contadorValor: { fontSize: fonte.media, fontWeight: '800', color: cores.texto },
});
