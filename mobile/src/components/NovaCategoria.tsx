/**
 * Criar categoria sem sair do cadastro da peça.
 *
 * A mercadoria chega e alguém precisa cadastrá-la agora, com a caixa aberta no balcão.
 * Mandar a pessoa sair do formulário, ir em Mais → Categorias, criar, voltar e digitar
 * tudo de novo é o tipo de caminho que faz a peça ficar sem cadastro — e sem cadastro ela
 * não vende.
 *
 * `Alert.prompt` resolveria em três linhas e **só existe no iOS**: no Android ele não
 * abre nada e o botão simplesmente não faria efeito. Por isso o diálogo é montado à mão.
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
import { catalogo } from '@/api/endpoints';
import type { Categoria } from '@/api/tipos';
import { Botao } from '@/components/ui';
import { chaves, queryClient } from '@/lib/queryClient';
import { ALVO_TOQUE, cores, espaco, fonte, raio } from '@/lib/tema';

interface Props {
  /** Recebe a categoria criada, já para ser selecionada na hora. */
  aoCriar: (categoria: Categoria) => void;
}

export function NovaCategoria({ aoCriar }: Props) {
  const [aberto, setAberto] = useState(false);
  const [nome, setNome] = useState('');
  const [erro, setErro] = useState<string | null>(null);

  const criar = useMutation({
    mutationFn: (valor: string) => catalogo.criarCategoria(valor),
    onSuccess: (categoria) => {
      // A lista de categorias é a mesma consulta usada em outras telas: invalidar aqui
      // faz a nova aparecer em todas, sem cada uma precisar saber desta.
      void queryClient.invalidateQueries({ queryKey: chaves.categorias });
      fechar();
      aoCriar(categoria);
    },
    onError: (e) => setErro(mensagemDoErro(e, 'Não deu para criar a categoria.')),
  });

  function fechar() {
    setAberto(false);
    setNome('');
    setErro(null);
  }

  function confirmar() {
    const limpo = nome.trim();
    if (limpo.length < 2) {
      setErro('Escreva o nome da categoria.');
      return;
    }
    setErro(null);
    criar.mutate(limpo);
  }

  return (
    <>
      <Pressable
        style={s.chipNovo}
        onPress={() => setAberto(true)}
        accessibilityRole="button"
        accessibilityLabel="Criar categoria"
      >
        <Text style={s.chipNovoTexto}>+ Nova</Text>
      </Pressable>

      <Modal visible={aberto} transparent animationType="fade" onRequestClose={fechar}>
        <KeyboardAvoidingView
          style={s.fundo}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <Pressable style={StyleSheet.absoluteFill} onPress={fechar} />
          <View style={s.caixa}>
            <Text style={s.titulo}>Nova categoria</Text>
            <Text style={s.ajuda}>
              Como você chama esse tipo de peça na loja: Camisetas, Calças, Vestidos…
            </Text>

            <TextInput
              value={nome}
              onChangeText={(t) => {
                setNome(t);
                if (erro) setErro(null);
              }}
              style={[s.campo, !!erro && s.campoErro]}
              placeholder="Camisetas"
              placeholderTextColor={cores.textoFraco}
              autoCapitalize="words"
              autoCorrect={false}
              autoFocus
              maxLength={80}
              returnKeyType="done"
              onSubmitEditing={confirmar}
            />
            {!!erro && <Text style={s.erro}>{erro}</Text>}

            <View style={s.botoes}>
              <Botao
                titulo="Cancelar"
                variante="secundario"
                estilo={s.metade}
                onPress={fechar}
              />
              <Botao
                titulo="Criar"
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
  caixa: {
    backgroundColor: cores.superficie,
    borderRadius: raio.lg,
    padding: espaco.xl,
  },
  titulo: { fontSize: fonte.grande, fontWeight: '800', color: cores.texto },
  ajuda: {
    fontSize: fonte.pequena,
    color: cores.textoSuave,
    marginTop: espaco.xs,
    marginBottom: espaco.lg,
    lineHeight: 19,
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
  },
  campoErro: { borderColor: cores.perigo },
  erro: { color: cores.perigo, fontSize: fonte.pequena, marginTop: espaco.xs },
  botoes: { flexDirection: 'row', gap: espaco.sm, marginTop: espaco.lg },
  metade: { flex: 1 },
});
