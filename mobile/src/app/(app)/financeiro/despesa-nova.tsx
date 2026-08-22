import { useMutation, useQuery } from '@tanstack/react-query';
import { format } from 'date-fns';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';

import { mensagemDoErro } from '@/api/client';
import { despesas } from '@/api/endpoints';
import { Botao, Campo, Carregando } from '@/components/ui';
import { paraCentavos, paraDecimalString } from '@/lib/money';
import { chaves, queryClient } from '@/lib/queryClient';
import { cores, espaco, fonte, raio } from '@/lib/tema';

export default function NovaDespesa() {
  const router = useRouter();
  const [categoriaId, setCategoriaId] = useState<number | null>(null);
  const [descricao, setDescricao] = useState('');
  const [valor, setValor] = useState('');
  const [data, setData] = useState(format(new Date(), 'dd/MM/yyyy'));
  const [recorrente, setRecorrente] = useState(false);
  const [novaCategoria, setNovaCategoria] = useState('');
  const [erro, setErro] = useState<string | null>(null);

  const categorias = useQuery({
    queryKey: chaves.categoriasDespesa,
    queryFn: () => despesas.categorias({ size: 100 }),
  });

  const criarCategoria = useMutation({
    mutationFn: (nome: string) => despesas.criarCategoria(nome),
    onSuccess: (categoria) => {
      void queryClient.invalidateQueries({ queryKey: chaves.categoriasDespesa });
      setCategoriaId(categoria.id);
      setNovaCategoria('');
    },
    onError: (e) => Alert.alert('Não deu para criar', mensagemDoErro(e)),
  });

  const salvar = useMutation({
    mutationFn: () => {
      const [dia, mes, ano] = data.split('/');
      return despesas.criar({
        categoria_id: categoriaId!,
        descricao: descricao.trim(),
        valor: paraDecimalString(paraCentavos(valor)),
        data: `${ano}-${mes}-${dia}`,
        recorrente,
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: chaves.despesas });
      router.back();
    },
    onError: (e) => Alert.alert('Não deu para lançar', mensagemDoErro(e)),
  });

  function enviar() {
    if (!categoriaId) return setErro('Escolha uma categoria.');
    if (descricao.trim().length < 2) return setErro('Descreva a despesa.');
    if (paraCentavos(valor) <= 0) return setErro('Informe o valor.');
    if (!/^\d{2}\/\d{2}\/\d{4}$/.test(data)) return setErro('Data no formato dd/mm/aaaa.');
    setErro(null);
    salvar.mutate();
  }

  if (categorias.isPending) return <Carregando />;

  return (
    <KeyboardAvoidingView
      style={s.tela}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={s.conteudo} keyboardShouldPersistTaps="handled">
        <Text style={s.rotulo}>Categoria</Text>
        <View style={s.chips}>
          {categorias.data?.items.map((c) => (
            <Pressable
              key={c.id}
              onPress={() => setCategoriaId(c.id)}
              style={[s.chip, categoriaId === c.id && s.chipAtivo]}
            >
              <Text style={[s.chipTexto, categoriaId === c.id && s.chipTextoAtivo]}>
                {c.nome}
              </Text>
            </Pressable>
          ))}
        </View>

        <View style={s.novaCategoria}>
          <View style={s.novaCategoriaCampo}>
            <Campo
              rotulo="Criar categoria"
              value={novaCategoria}
              onChangeText={setNovaCategoria}
              placeholder="Aluguel, Energia…"
              autoCapitalize="words"
            />
          </View>
          <Botao
            titulo="Criar"
            variante="secundario"
            desabilitado={novaCategoria.trim().length < 2}
            carregando={criarCategoria.isPending}
            onPress={() => criarCategoria.mutate(novaCategoria.trim())}
            estilo={s.botaoCriar}
          />
        </View>

        <Campo
          rotulo="Descrição"
          value={descricao}
          onChangeText={setDescricao}
          placeholder="Aluguel de agosto"
        />

        <View style={s.duasColunas}>
          <View style={s.coluna}>
            <Campo
              rotulo="Valor (R$)"
              value={valor}
              onChangeText={setValor}
              keyboardType="decimal-pad"
              placeholder="2.500,00"
            />
          </View>
          <View style={s.coluna}>
            <Campo
              rotulo="Data"
              value={data}
              onChangeText={setData}
              keyboardType="numbers-and-punctuation"
              placeholder="dd/mm/aaaa"
            />
          </View>
        </View>

        <Pressable style={s.recorrente} onPress={() => setRecorrente((v) => !v)}>
          <View style={s.recorrenteTexto}>
            <Text style={s.recorrenteTitulo}>Conta fixa</Text>
            <Text style={s.recorrenteAjuda}>
              Repete todo mês. Depois é só tocar em "Lançar fixas" para trazer ao mês novo.
            </Text>
          </View>
          <Switch value={recorrente} onValueChange={setRecorrente} />
        </Pressable>

        {!!erro && <Text style={s.erro}>{erro}</Text>}
      </ScrollView>

      <View style={s.rodape}>
        <Botao
          titulo="Lançar despesa"
          grande
          carregando={salvar.isPending}
          onPress={enviar}
        />
      </View>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  tela: { flex: 1, backgroundColor: cores.fundo },
  conteudo: { padding: espaco.lg, paddingBottom: espaco.xxl },

  rotulo: {
    fontSize: fonte.pequena,
    fontWeight: '600',
    color: cores.textoSuave,
    marginBottom: espaco.xs,
  },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: espaco.sm, marginBottom: espaco.md },
  chip: {
    minHeight: 40,
    paddingHorizontal: espaco.lg,
    borderRadius: raio.redondo,
    backgroundColor: cores.superficie,
    borderWidth: 1,
    borderColor: cores.borda,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipAtivo: { backgroundColor: cores.primaria, borderColor: cores.primaria },
  chipTexto: { fontSize: fonte.base, fontWeight: '600', color: cores.textoSuave },
  chipTextoAtivo: { color: cores.aoFundoEscuro },

  novaCategoria: { flexDirection: 'row', gap: espaco.sm, alignItems: 'flex-start' },
  novaCategoriaCampo: { flex: 1 },
  botaoCriar: { marginTop: 20 },

  duasColunas: { flexDirection: 'row', gap: espaco.md },
  coluna: { flex: 1 },

  recorrente: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: espaco.md,
    backgroundColor: cores.superficie,
    borderRadius: raio.md,
    padding: espaco.lg,
  },
  recorrenteTexto: { flex: 1 },
  recorrenteTitulo: { fontSize: fonte.base, fontWeight: '700', color: cores.texto },
  recorrenteAjuda: { fontSize: fonte.micro, color: cores.textoSuave, marginTop: 2 },

  erro: { color: cores.perigo, fontWeight: '600', marginTop: espaco.md },
  rodape: {
    padding: espaco.lg,
    backgroundColor: cores.superficie,
    borderTopWidth: 1,
    borderTopColor: cores.borda,
  },
});
