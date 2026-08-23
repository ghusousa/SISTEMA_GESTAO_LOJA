/**
 * As duas formas de pagamento que não são dinheiro: vale de troca e fiado.
 *
 * Cada uma precisa de uma pergunta ANTES do valor — "qual vale?" e "de quem é a dívida?" —
 * e é isso que as tira do teclado de cobrança e traz para cá. Espelho de
 * `web/js/pagar-fiado-vale.js`: mesmas perguntas, mesmas travas, mesmo texto.
 *
 * **O servidor decide os valores** (ADR-4). O vale é consultado aqui só para a tela saber
 * quanto propor e avisar cedo que o papel na mão da cliente já foi usado; quem trava o
 * consumo de verdade é o `UPDATE` condicional no banco, na hora de fechar a venda.
 */

import { useEffect, useState } from 'react';
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
import { clientes as apiClientes, vendas } from '@/api/endpoints';
import type { Cliente } from '@/api/tipos';
import { Botao } from '@/components/ui';
import { formatar, paraCentavos, type Centavos } from '@/lib/money';
import { ALVO_TOQUE, cores, espaco, fonte, raio } from '@/lib/tema';

export interface ValeEscolhido {
  codigo: string;
  saldo: Centavos;
}

/* ------------------------------------------------------------------- vale */

export function ModalVale({
  visivel,
  falta,
  aoEscolher,
  aoCancelar,
}: {
  visivel: boolean;
  /** Quanto ainda falta pagar, em centavos — o teto do que este vale vai cobrir. */
  falta: Centavos;
  aoEscolher: (vale: ValeEscolhido) => void;
  aoCancelar: () => void;
}) {
  const [codigo, setCodigo] = useState('');
  const [erro, setErro] = useState<string | null>(null);
  const [conferindo, setConferindo] = useState(false);

  useEffect(() => {
    if (visivel) {
      setCodigo('');
      setErro(null);
    }
  }, [visivel]);

  async function conferir() {
    const limpo = codigo.trim().toUpperCase();
    if (!limpo) {
      setErro('Digite o código do vale.');
      return;
    }
    setConferindo(true);
    setErro(null);
    try {
      const vale = await vendas.consultarVale(limpo);
      const saldo = paraCentavos(vale.saldo);
      if (saldo <= 0) {
        setErro('Este vale já foi usado por inteiro.');
        return;
      }
      aoEscolher({ codigo: limpo, saldo });
    } catch {
      setErro('Vale não encontrado.');
    } finally {
      setConferindo(false);
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
          <Text style={s.titulo}>Pagar com vale de troca</Text>
          <Text style={s.ajuda}>
            O código está no papel que a cliente recebeu na devolução. O vale cobre até{' '}
            {formatar(falta)} desta venda.
          </Text>

          <TextInput
            value={codigo}
            onChangeText={(t) => {
              setCodigo(t.toUpperCase());
              if (erro) setErro(null);
            }}
            style={[s.campo, s.campoCodigo, !!erro && s.campoErro]}
            placeholder="V000123"
            placeholderTextColor={cores.textoFraco}
            autoCapitalize="characters"
            autoCorrect={false}
            autoFocus
            maxLength={16}
            returnKeyType="done"
            onSubmitEditing={() => void conferir()}
          />
          {!!erro && <Text style={s.erro}>{erro}</Text>}

          <View style={s.botoes}>
            <Botao
              titulo="Cancelar"
              variante="secundario"
              estilo={s.metade}
              onPress={aoCancelar}
            />
            <Botao
              titulo="Usar este vale"
              estilo={s.metade}
              carregando={conferindo}
              onPress={() => void conferir()}
            />
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

/* ------------------------------------------------------------------ fiado */

/**
 * Escolhe (ou cadastra) a cliente da venda no fiado.
 *
 * Cadastrar aqui dentro não é conveniência: a cliente está na frente, com a peça na mão, e
 * mandar a vendedora sair da venda para cadastrar é o caminho mais curto para o fiado
 * voltar a ser anotado no papel — que é o problema que o crediário veio resolver.
 */
export function ModalCliente({
  visivel,
  aoEscolher,
  aoCancelar,
}: {
  visivel: boolean;
  aoEscolher: (cliente: Cliente) => void;
  aoCancelar: () => void;
}) {
  const [termo, setTermo] = useState('');
  const [achados, setAchados] = useState<Cliente[]>([]);
  const [procurando, setProcurando] = useState(false);
  const [nome, setNome] = useState('');
  const [telefone, setTelefone] = useState('');
  const [erro, setErro] = useState<string | null>(null);
  const [cadastrando, setCadastrando] = useState(false);

  useEffect(() => {
    if (visivel) {
      setTermo('');
      setAchados([]);
      setNome('');
      setTelefone('');
      setErro(null);
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
        const { items } = await apiClientes.listar({ q: limpo, size: 8 });
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
    setCadastrando(true);
    setErro(null);
    try {
      aoEscolher(
        await apiClientes.criar({ nome: limpo, telefone: telefone.trim() || null }),
      );
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
        <View style={[s.caixa, s.caixaAlta]}>
          <Text style={s.titulo}>Fiado — de quem é a dívida?</Text>

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

            {achados.map((c) => {
              const deve = paraCentavos(c.deve);
              return (
                <Pressable
                  key={c.id}
                  style={({ pressed }) => [s.achado, pressed && s.achadoPressionado]}
                  onPress={() => aoEscolher(c)}
                >
                  <View style={s.achadoTexto}>
                    <Text style={s.achadoNome}>{c.nome}</Text>
                    <Text style={s.achadoDetalhe}>{c.telefone || 'sem telefone'}</Text>
                  </View>
                  <View>
                    <Text style={[s.achadoSaldo, deve > 0 && s.achadoDevendo]}>
                      {deve > 0 ? `deve ${formatar(deve)}` : 'em dia'}
                    </Text>
                    {/* Avisa, não bloqueia (ADR-20): quem conhece a freguesa é a dona, e
                        travar aqui só ensina a lançar como dinheiro e anotar no papel. */}
                    {c.acima_do_limite && (
                      <Text style={s.achadoLimite}>acima do limite combinado</Text>
                    )}
                  </View>
                </Pressable>
              );
            })}

            {termo.trim().length >= 2 && !procurando && achados.length === 0 && (
              <Text style={s.ajuda}>Ninguém com esse nome.</Text>
            )}

            <Text style={s.secao}>Não está cadastrada?</Text>
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
            {!!erro && <Text style={s.erro}>{erro}</Text>}
          </ScrollView>

          <View style={s.botoes}>
            <Botao
              titulo="Cancelar"
              variante="secundario"
              estilo={s.metade}
              onPress={aoCancelar}
            />
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
  caixa: { backgroundColor: cores.superficie, borderRadius: raio.lg, padding: espaco.xl },
  caixaAlta: { maxHeight: '85%' },
  titulo: { fontSize: fonte.grande, fontWeight: '800', color: cores.texto },
  ajuda: {
    fontSize: fonte.pequena,
    color: cores.textoSuave,
    marginTop: espaco.xs,
    marginBottom: espaco.md,
    lineHeight: 19,
  },
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
  campoCodigo: { fontSize: fonte.grande, fontWeight: '800', letterSpacing: 2 },
  campoErro: { borderColor: cores.perigo },
  erro: { color: cores.perigo, fontSize: fonte.pequena, marginTop: espaco.xs },

  girando: { marginTop: espaco.md },
  achado: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: espaco.sm,
    minHeight: ALVO_TOQUE,
    paddingHorizontal: espaco.md,
    paddingVertical: espaco.sm,
    marginTop: espaco.sm,
    borderRadius: raio.md,
    backgroundColor: cores.fundo,
  },
  achadoPressionado: { backgroundColor: cores.primariaFraca },
  achadoTexto: { flex: 1 },
  achadoNome: { fontSize: fonte.base, fontWeight: '700', color: cores.texto },
  achadoDetalhe: { fontSize: fonte.pequena, color: cores.textoSuave },
  achadoSaldo: { fontSize: fonte.pequena, color: cores.textoSuave, textAlign: 'right' },
  achadoDevendo: { color: cores.perigo, fontWeight: '700' },
  achadoLimite: { fontSize: fonte.micro, color: cores.alerta, textAlign: 'right' },

  botoes: { flexDirection: 'row', gap: espaco.sm, marginTop: espaco.lg },
  metade: { flex: 1 },
});
