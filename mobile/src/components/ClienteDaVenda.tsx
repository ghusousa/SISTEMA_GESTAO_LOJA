/**
 * Quem está comprando — o nome da cliente em QUALQUER venda, não só no fiado (ADR-36).
 *
 * É a porta do balcão (`ATENDER_CLIENTE`): busca e cadastro sem saldo, sem limite, sem a
 * observação do crediário. Quem precisa ver a dívida é o fiado, que continua com a
 * pergunta dele (`ModalCliente`, em `PagarValeFiado.tsx`).
 *
 * Espelho de `web/js/cliente-balcao.js`: mesmas perguntas, mesmo texto.
 */

import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { mensagemDoErro } from '@/api/client';
import { clientes } from '@/api/endpoints';
import type { ClienteBalcao } from '@/api/tipos';
import { Botao } from '@/components/ui';
import { mascararData, paraDataISO } from '@/lib/aniversario';
import { chaves, queryClient } from '@/lib/queryClient';
import { ALVO_TOQUE, cores, espaco, fonte, raio } from '@/lib/tema';
import { gerarUuid } from '@/lib/uuid';

export function ModalClienteDaVenda({
  visivel,
  aoEscolher,
  aoCancelar,
}: {
  visivel: boolean;
  aoEscolher: (cliente: ClienteBalcao) => void;
  aoCancelar: () => void;
}) {
  const [termo, setTermo] = useState('');
  const [achados, setAchados] = useState<ClienteBalcao[]>([]);
  const [procurando, setProcurando] = useState(false);
  const [nome, setNome] = useState('');
  const [telefone, setTelefone] = useState('');
  const [nascimento, setNascimento] = useState('');
  const [preferencias, setPreferencias] = useState('');
  const [erro, setErro] = useState<string | null>(null);
  const [cadastrando, setCadastrando] = useState(false);
  // Uma chave por abertura: a rede caiu depois de gravar e a pessoa tocou de novo — o
  // servidor devolve o mesmo cadastro, em vez de a cliente nascer duas vezes.
  const chave = useRef(gerarUuid());

  useEffect(() => {
    if (visivel) {
      setTermo('');
      setAchados([]);
      setNome('');
      setTelefone('');
      setNascimento('');
      setPreferencias('');
      setErro(null);
      chave.current = gerarUuid();
    }
  }, [visivel]);

  useEffect(() => {
    const limpo = termo.trim();
    if (limpo.length < 2) {
      setAchados([]);
      return;
    }
    let valeu = true;
    setProcurando(true);
    const timer = setTimeout(async () => {
      try {
        const { items } = await clientes.buscarNoBalcao({ q: limpo, size: 8 });
        if (valeu) setAchados(items);
      } catch {
        if (valeu) setAchados([]);
      } finally {
        if (valeu) setProcurando(false);
      }
    }, 250);
    return () => {
      valeu = false;
      clearTimeout(timer);
    };
  }, [termo]);

  async function cadastrar() {
    const limpo = nome.trim();
    if (limpo.length < 2) {
      setErro('Escreva o nome da cliente.');
      return;
    }
    const iso = nascimento.trim() ? paraDataISO(nascimento) : null;
    if (nascimento.trim() && !iso) {
      setErro('Aniversário no formato dia/mês/ano, por exemplo 14/03/1990.');
      return;
    }
    setCadastrando(true);
    setErro(null);
    try {
      const cliente = await clientes.cadastrarNoBalcao({
        client_uuid: chave.current,
        nome: limpo,
        telefone: telefone.trim() || null,
        nascimento: iso,
        preferencias: preferencias.trim() || null,
      });
      void queryClient.invalidateQueries({ queryKey: chaves.clientes });
      aoEscolher(cliente);
    } catch (e) {
      setErro(mensagemDoErro(e, 'Não deu para cadastrar.'));
    } finally {
      setCadastrando(false);
    }
  }

  return (
    <Modal visible={visivel} transparent animationType="fade" onRequestClose={aoCancelar}>
      <KeyboardAvoidingView
        style={s.fundo}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <Pressable style={StyleSheet.absoluteFill} onPress={aoCancelar} />
        <View style={s.caixa}>
          <Text style={s.titulo}>Quem está comprando?</Text>

          <ScrollView keyboardShouldPersistTaps="handled">
            <TextInput
              value={termo}
              onChangeText={setTermo}
              style={s.campo}
              placeholder="Procure pelo nome ou telefone"
              placeholderTextColor={cores.textoFraco}
              autoCorrect={false}
              autoFocus
              maxLength={80}
            />

            {procurando && <ActivityIndicator style={s.girando} color={cores.primaria} />}

            {achados.map((c) => (
              <Pressable
                key={c.id}
                style={({ pressed }) => [s.achado, pressed && s.achadoPressionado]}
                onPress={() => aoEscolher(c)}
              >
                <Text style={s.achadoNome}>{c.nome}</Text>
                <Text style={s.achadoDetalhe}>
                  {[c.telefone || 'sem telefone', c.preferencias].filter(Boolean).join(' · ')}
                </Text>
              </Pressable>
            ))}

            {termo.trim().length >= 2 && !procurando && achados.length === 0 && (
              <Text style={s.ajuda}>Ninguém com esse nome.</Text>
            )}

            <Text style={s.secao}>Primeira vez na loja?</Text>
            <TextInput
              value={nome}
              onChangeText={(t) => {
                setNome(t);
                if (erro) setErro(null);
              }}
              style={[s.campo, !!erro && s.campoErro]}
              placeholder="Nome"
              placeholderTextColor={cores.textoFraco}
              autoCapitalize="words"
              maxLength={120}
            />
            <TextInput
              value={telefone}
              onChangeText={setTelefone}
              style={s.campo}
              placeholder="Telefone"
              placeholderTextColor={cores.textoFraco}
              keyboardType="phone-pad"
              maxLength={20}
            />
            <TextInput
              value={nascimento}
              onChangeText={(t) => setNascimento(mascararData(t))}
              style={s.campo}
              placeholder="Aniversário (dd/mm/aaaa), opcional"
              placeholderTextColor={cores.textoFraco}
              keyboardType="number-pad"
              maxLength={10}
            />
            <TextInput
              value={preferencias}
              onChangeText={setPreferencias}
              style={s.campo}
              placeholder="Preferências: tamanho, estilo"
              placeholderTextColor={cores.textoFraco}
              maxLength={200}
            />
            {!!erro && <Text style={s.erro}>{erro}</Text>}
          </ScrollView>

          <View style={s.botoes}>
            <Botao titulo="Cancelar" variante="secundario" estilo={s.metade} onPress={aoCancelar} />
            <Botao
              titulo="Cadastrar e usar"
              estilo={s.metade}
              carregando={cadastrando}
              onPress={() => void cadastrar()}
            />
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const s = StyleSheet.create({
  fundo: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'center',
    padding: espaco.lg,
  },
  caixa: {
    backgroundColor: cores.superficie,
    borderRadius: raio.lg,
    padding: espaco.xl,
    maxHeight: '85%',
  },
  titulo: { fontSize: fonte.grande, fontWeight: '800', color: cores.texto },
  ajuda: { fontSize: fonte.pequena, color: cores.textoSuave, marginTop: espaco.xs },
  secao: {
    fontSize: fonte.pequena,
    color: cores.textoSuave,
    fontWeight: '700',
    marginTop: espaco.lg,
    marginBottom: espaco.xs,
  },
  campo: {
    minHeight: ALVO_TOQUE,
    borderWidth: 1,
    borderColor: cores.borda,
    borderRadius: raio.md,
    paddingHorizontal: espaco.md,
    fontSize: fonte.base,
    color: cores.texto,
    backgroundColor: cores.fundo,
    marginTop: espaco.sm,
  },
  campoErro: { borderColor: cores.perigo },
  erro: { color: cores.perigo, fontSize: fonte.pequena, marginTop: espaco.xs },
  girando: { marginTop: espaco.md },
  achado: {
    minHeight: ALVO_TOQUE,
    justifyContent: 'center',
    paddingHorizontal: espaco.md,
    paddingVertical: espaco.sm,
    marginTop: espaco.sm,
    borderRadius: raio.md,
    backgroundColor: cores.fundo,
  },
  achadoPressionado: { backgroundColor: cores.primariaFraca },
  achadoNome: { fontSize: fonte.base, fontWeight: '700', color: cores.texto },
  achadoDetalhe: { fontSize: fonte.pequena, color: cores.textoSuave },
  botoes: { flexDirection: 'row', gap: espaco.sm, marginTop: espaco.lg },
  metade: { flex: 1 },
});
