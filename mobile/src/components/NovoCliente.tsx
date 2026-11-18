/**
 * Cadastrar cliente sem sair de onde se está.
 *
 * Mesma razão do `NovaCategoria`: a pessoa está no balcão, com a cliente na frente. O
 * limite combinado entra aqui porque é a hora em que a dona sabe dizer o número — e ele
 * **só avisa, nunca bloqueia** (ADR-20).
 */

import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { mensagemDoErro } from '@/api/client';
import { clientes } from '@/api/endpoints';
import type { Cliente } from '@/api/tipos';
import { Botao } from '@/components/ui';
import { mascararData, paraDataISO } from '@/lib/aniversario';
import { paraCentavos, paraDecimalString } from '@/lib/money';
import { chaves, queryClient } from '@/lib/queryClient';
import { ALVO_TOQUE, cores, espaco, fonte, raio } from '@/lib/tema';

export function NovoCliente({ aoCriar }: { aoCriar: (cliente: Cliente) => void }) {
  const [aberto, setAberto] = useState(false);
  const [nome, setNome] = useState('');
  const [telefone, setTelefone] = useState('');
  const [documento, setDocumento] = useState('');
  const [limite, setLimite] = useState('');
  const [nascimento, setNascimento] = useState('');
  const [preferencias, setPreferencias] = useState('');
  const [erro, setErro] = useState<string | null>(null);

  const criar = useMutation({
    mutationFn: () =>
      clientes.criar({
        nome: nome.trim(),
        telefone: telefone.trim() || null,
        documento: documento.trim() || null,
        limite: paraCentavos(limite) > 0 ? paraDecimalString(paraCentavos(limite)) : null,
        nascimento: nascimento.trim() ? paraDataISO(nascimento) : null,
        preferencias: preferencias.trim() || null,
      }),
    onSuccess: (cliente) => {
      void queryClient.invalidateQueries({ queryKey: chaves.clientes });
      fechar();
      aoCriar(cliente);
    },
    onError: (e) => setErro(mensagemDoErro(e, 'Não deu para cadastrar.')),
  });

  function fechar() {
    setAberto(false);
    setNome('');
    setTelefone('');
    setDocumento('');
    setLimite('');
    setNascimento('');
    setPreferencias('');
    setErro(null);
  }

  function confirmar() {
    if (nome.trim().length < 2) {
      setErro('Escreva o nome da cliente.');
      return;
    }
    if (nascimento.trim() && !paraDataISO(nascimento)) {
      setErro('Aniversário no formato dia/mês/ano, por exemplo 14/03/1990.');
      return;
    }
    setErro(null);
    criar.mutate();
  }

  return (
    <>
      <Pressable
        style={s.chipNovo}
        onPress={() => setAberto(true)}
        accessibilityRole="button"
        accessibilityLabel="Cadastrar cliente"
      >
        <Text style={s.chipNovoTexto}>+ Cliente</Text>
      </Pressable>

      <Modal visible={aberto} transparent animationType="fade" onRequestClose={fechar}>
        <KeyboardAvoidingView
          style={s.fundo}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <Pressable style={StyleSheet.absoluteFill} onPress={fechar} />
          <View style={s.caixa}>
            <Text style={s.titulo}>Novo cliente</Text>

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
              autoFocus
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
              value={documento}
              onChangeText={setDocumento}
              style={s.campo}
              placeholder="Documento (opcional)"
              placeholderTextColor={cores.textoFraco}
              maxLength={20}
            />
            <TextInput
              value={limite}
              onChangeText={setLimite}
              style={s.campo}
              placeholder="Limite combinado (R$)"
              placeholderTextColor={cores.textoFraco}
              keyboardType="decimal-pad"
              maxLength={12}
            />
            <Text style={s.ajuda}>O limite só avisa na hora da venda; não bloqueia.</Text>
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

            <View style={s.botoes}>
              <Botao titulo="Cancelar" variante="secundario" estilo={s.metade} onPress={fechar} />
              <Botao
                titulo="Cadastrar"
                estilo={s.metade}
                carregando={criar.isPending}
                onPress={confirmar}
              />
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </>
  );
}

const s = StyleSheet.create({
  chipNovo: {
    minHeight: ALVO_TOQUE - 8,
    justifyContent: 'center',
    paddingHorizontal: espaco.lg,
    borderRadius: raio.redondo,
    borderWidth: 1,
    borderColor: cores.primaria,
    borderStyle: 'dashed',
    backgroundColor: cores.superficie,
  },
  chipNovoTexto: { color: cores.primaria, fontWeight: '800', fontSize: fonte.base },

  fundo: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'center',
    padding: espaco.xl,
  },
  caixa: { backgroundColor: cores.superficie, borderRadius: raio.lg, padding: espaco.xl },
  titulo: { fontSize: fonte.grande, fontWeight: '800', color: cores.texto },
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
  ajuda: { color: cores.textoFraco, fontSize: fonte.micro, marginTop: espaco.xs },
  erro: { color: cores.perigo, fontSize: fonte.pequena, marginTop: espaco.xs },
  botoes: { flexDirection: 'row', gap: espaco.sm, marginTop: espaco.lg },
  metade: { flex: 1 },
});
