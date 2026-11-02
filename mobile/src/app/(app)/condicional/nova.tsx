/**
 * Nova condicional: bipar o que a cliente vai levar para provar (ADR-39).
 *
 * O mesmo jeito da Entrada: câmera, código digitado ou nome. Gravar tira as peças do saldo
 * na hora — enquanto estiverem com a cliente, o balcão não as vende de novo. A cliente é
 * obrigatória e vem da busca de balcão (sem saldo nem limite), aberta a toda a equipe.
 * Espelho de `web/js/views/condicionais-nova.js`.
 */

import { useMutation, useQuery } from '@tanstack/react-query';
import { format } from 'date-fns';
import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useCallback, useRef, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { codigoDoErro, mensagemDoErro } from '@/api/client';
import { catalogo, condicionais } from '@/api/endpoints';
import type { ClienteDoBalcao } from '@/api/tipos';
import { BuscarPeca } from '@/components/BuscarPeca';
import { CodigoManual } from '@/components/CodigoManual';
import { Scanner } from '@/components/Scanner';
import { Botao, Campo } from '@/components/ui';
import { formatar, paraCentavos, somar as somarCentavos } from '@/lib/money';
import { somarDias } from '@/lib/parcelas';
import { invalidarAposCondicional } from '@/lib/queryClient';
import { cores, espaco, fonte, raio } from '@/lib/tema';
import { gerarUuid } from '@/lib/uuid';

interface Peca {
  varianteId: number;
  produto: string;
  grade: string;
  preco: string;
  quantidade: number;
}

/** Prazos de bolso: a pessoa escolhe um — não há prazo "padrão" escondido. */
const PRAZOS = [1, 2, 3, 5, 7];

export default function NovaCondicional() {
  const router = useRouter();
  const [pecas, setPecas] = useState<Peca[]>([]);
  const [cliente, setCliente] = useState<ClienteDoBalcao | null>(null);
  const [busca, setBusca] = useState('');
  const [dias, setDias] = useState<number | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  // Nasce com a tela; muda se a sacola, a cliente ou o prazo mudarem (outro pedido).
  const [chave, setChave] = useState(() => gerarUuid());
  const [consultando, setConsultando] = useState(false);
  const ocupado = useRef(false);

  const clientes = useQuery({
    queryKey: ['clientes', 'balcao', busca],
    queryFn: () => condicionais.buscarCliente(busca),
    enabled: !cliente && busca.trim().length >= 2,
  });

  const mudar = useCallback((fn: (atuais: Peca[]) => Peca[]) => {
    setPecas(fn);
    setChave(gerarUuid());
  }, []);

  const somar = useCallback(
    (p: { varianteId: number; produto: string; tamanho: string; cor: string; preco: string }) =>
      mudar((atuais) =>
        atuais.some((i) => i.varianteId === p.varianteId)
          ? atuais.map((i) => (i.varianteId === p.varianteId ? { ...i, quantidade: i.quantidade + 1 } : i))
          : [{ varianteId: p.varianteId, produto: p.produto, grade: `${p.tamanho} · ${p.cor}`, preco: p.preco, quantidade: 1 }, ...atuais],
      ),
    [mudar],
  );

  const aoLer = useCallback(
    async (codigo: string) => {
      if (ocupado.current) return;
      ocupado.current = true;
      setConsultando(true);
      setAviso(null);
      try {
        const p = await catalogo.porCodigoBarras(codigo);
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        somar({ varianteId: p.variante_id, produto: p.produto, tamanho: p.tamanho, cor: p.cor, preco: p.preco_venda });
      } catch (erro) {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        setAviso(codigoDoErro(erro) === 'NAO_ENCONTRADO' ? `Nenhuma peça com o código ${codigo}.` : mensagemDoErro(erro));
      } finally {
        ocupado.current = false;
        setConsultando(false);
      }
    },
    [somar],
  );

  const salvar = useMutation({
    mutationFn: () =>
      condicionais.abrir({
        client_uuid: chave,
        cliente_id: cliente!.id,
        prazo: somarDias(format(new Date(), 'yyyy-MM-dd'), dias!),
        itens: pecas.map((p) => ({ variante_id: p.varianteId, quantidade: p.quantidade })),
      }),
    onSuccess: (c) => {
      invalidarAposCondicional();
      router.replace(`/condicional/${c.id}`);
    },
    onError: (erro) => {
      if (codigoDoErro(erro) === 'DUPLICADO') setChave(gerarUuid());
      setAviso(mensagemDoErro(erro, 'Não deu para registrar a condicional.'));
    },
  });

  const total = somarCentavos(pecas.map((p) => paraCentavos(p.preco) * p.quantidade));
  const qtd = pecas.reduce((t, p) => t + p.quantidade, 0);

  return (
    <View style={s.tela}>
      <View style={s.camera}>
        <Scanner
          aoLer={(codigo) => void aoLer(codigo)}
          modo="continuo"
          ocupado={consultando}
          dica={consultando ? 'Consultando…' : 'Bipe a etiqueta — ou busque pelo nome'}
        />
      </View>
      <View style={s.barra}>
        <CodigoManual aoConfirmar={(codigo) => void aoLer(codigo)} />
        <BuscarPeca
          mostrarPreco
          aoEscolher={(p) => somar({ varianteId: p.id, produto: p.produto, tamanho: p.tamanho, cor: p.cor, preco: p.preco_venda })}
        />
      </View>
      {!!aviso && (
        <Pressable onPress={() => setAviso(null)} style={s.aviso}>
          <Text style={s.avisoTexto}>{aviso}</Text>
        </Pressable>
      )}

      <ScrollView contentContainerStyle={s.conteudo} keyboardShouldPersistTaps="handled">
        {cliente ? (
          <Pressable onPress={() => { setCliente(null); setChave(gerarUuid()); }} style={s.cliente}>
            <Text style={s.clienteNome}>{cliente.nome}</Text>
            <Text style={s.detalhe}>{cliente.telefone ?? 'sem telefone'} · toque para trocar</Text>
          </Pressable>
        ) : (
          <>
            <Campo rotulo="Cliente" value={busca} onChangeText={setBusca} placeholder="Nome ou telefone" />
            {(clientes.data?.items ?? []).map((c) => (
              <Pressable key={c.id} style={s.opcao} onPress={() => { setCliente(c); setChave(gerarUuid()); }}>
                <Text style={s.clienteNome}>{c.nome}</Text>
                {!!c.telefone && <Text style={s.detalhe}>{c.telefone}</Text>}
              </Pressable>
            ))}
            {clientes.isError && <Text style={s.detalhe}>{mensagemDoErro(clientes.error)}</Text>}
          </>
        )}

        <Text style={s.rotulo}>Prazo para devolver</Text>
        <View style={s.prazos}>
          {PRAZOS.map((d) => (
            <Pressable key={d} onPress={() => { setDias(d); setChave(gerarUuid()); }} style={[s.prazo, dias === d && s.prazoAtivo]}>
              <Text style={[s.prazoTexto, dias === d && s.prazoTextoAtivo]}>{d === 1 ? 'amanhã' : `${d} dias`}</Text>
            </Pressable>
          ))}
        </View>

        {pecas.map((p) => (
          <View key={p.varianteId} style={s.item}>
            <View style={{ flex: 1 }}>
              <Text style={s.clienteNome} numberOfLines={1}>{p.produto}</Text>
              <Text style={s.detalhe}>{p.grade} · {formatar(paraCentavos(p.preco))}</Text>
            </View>
            <Pressable onPress={() => mudar((a) => a.map((i) => (i.varianteId === p.varianteId ? { ...i, quantidade: i.quantidade - 1 } : i)).filter((i) => i.quantidade > 0))}>
              <Text style={s.sinal}>−</Text>
            </Pressable>
            <Text style={s.qtd}>{p.quantidade}</Text>
            <Pressable onPress={() => somar({ varianteId: p.varianteId, produto: p.produto, tamanho: '', cor: '', preco: p.preco })}>
              <Text style={s.sinal}>+</Text>
            </Pressable>
          </View>
        ))}
      </ScrollView>

      <View style={s.rodape}>
        <Text style={s.detalhe}>{qtd} peça(s) · {formatar(total)}</Text>
        <Botao
          titulo="Registrar condicional"
          variante="acao"
          grande
          desabilitado={!pecas.length}
          carregando={salvar.isPending}
          onPress={() => {
            if (!cliente) return Alert.alert('Falta a cliente', 'Escolha quem está levando as peças.');
            if (!dias) return Alert.alert('Falta o prazo', 'Combine com a cliente até quando ela devolve.');
            salvar.mutate();
          }}
        />
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  tela: { flex: 1, backgroundColor: cores.fundo },
  camera: { height: '28%', backgroundColor: '#000' },
  barra: { flexDirection: 'row', gap: espaco.sm, paddingHorizontal: espaco.lg, paddingTop: espaco.sm, alignItems: 'flex-start' },
  aviso: { backgroundColor: cores.perigoFraco, padding: espaco.md },
  avisoTexto: { color: cores.perigo, fontSize: fonte.pequena, fontWeight: '600' },
  conteudo: { padding: espaco.lg },
  cliente: { backgroundColor: cores.primariaFraca, borderRadius: raio.md, padding: espaco.md, marginBottom: espaco.md },
  clienteNome: { fontSize: fonte.base, fontWeight: '700', color: cores.texto },
  detalhe: { fontSize: fonte.pequena, color: cores.textoSuave, marginTop: 2 },
  opcao: { backgroundColor: cores.superficie, borderRadius: raio.sm, padding: espaco.md, marginBottom: espaco.xs },
  rotulo: { fontSize: fonte.pequena, fontWeight: '700', color: cores.textoSuave, marginTop: espaco.md },
  prazos: { flexDirection: 'row', flexWrap: 'wrap', gap: espaco.sm, marginVertical: espaco.sm },
  prazo: { paddingHorizontal: espaco.md, paddingVertical: espaco.sm, borderRadius: raio.redondo, borderWidth: 1, borderColor: cores.borda },
  prazoAtivo: { backgroundColor: cores.primaria, borderColor: cores.primaria },
  prazoTexto: { fontWeight: '700', color: cores.textoSuave },
  prazoTextoAtivo: { color: cores.aoFundoEscuro },
  item: { flexDirection: 'row', alignItems: 'center', gap: espaco.md, backgroundColor: cores.superficie, borderRadius: raio.md, padding: espaco.md, marginBottom: espaco.sm },
  sinal: { fontSize: fonte.grande, fontWeight: '800', color: cores.primaria, paddingHorizontal: espaco.sm },
  qtd: { minWidth: 24, textAlign: 'center', fontSize: fonte.media, fontWeight: '800', color: cores.texto },
  rodape: { padding: espaco.lg, backgroundColor: cores.superficie, borderTopWidth: 1, borderTopColor: cores.borda, gap: espaco.sm },
});
