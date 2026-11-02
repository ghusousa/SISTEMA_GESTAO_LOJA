/**
 * Cadastro de peça nova.
 *
 * O trabalho pesado aqui é a grade: uma camiseta em P/M/G/GG são quatro variantes, cada uma
 * com seu código de barras. A tela gera a grade de uma vez e, por peça, ou o operador bipa o
 * EAN da etiqueta ou o sistema gera um código interno — porque muita peça de loja de bairro
 * chega sem etiqueta nenhuma.
 */

import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { mensagemDoErro } from '@/api/client';
import { catalogo, estoque, type VariantePayload } from '@/api/endpoints';
import { Scanner } from '@/components/Scanner';
import { gerarUuid } from '@/lib/uuid';
import { Botao, Campo, Carregando, Etiqueta } from '@/components/ui';
import { formatarSemSimbolo, paraCentavos, paraDecimalString } from '@/lib/money';
import { chaves, invalidarAposMovimentoEstoque, queryClient } from '@/lib/queryClient';
import { useAuthStore } from '@/stores/authStore';
import { PODE, pode } from '@/lib/permissoes';
import { NovaCategoria } from '@/components/NovaCategoria';
import { CamposFiscais, paraPayload, valoresIniciais } from '@/components/CamposFiscais';
import { SeletorDeFoto } from '@/components/SeletorDeFoto';
import type { FotoEscolhida } from '@/lib/foto';
import { ALVO_TOQUE, cores, espaco, fonte, raio } from '@/lib/tema';
import { useVocabulario } from '@/hooks/useLoja';

// Os atalhos da grade vêm do ramo da loja: 'PP, P, M, G' só faz sentido em roupa. Numa
// autopeças a lista vem vazia de propósito — 'Aplicação' se digita, não se escolhe.

interface LinhaGrade {
  chave: string;
  tamanho: string;
  cor: string;
  codigo: string | null;
  estoque: string;
}

export default function NovoProduto() {
  const vocab = useVocabulario();
  const TAMANHOS_RAPIDOS = vocab.eixo1_rapidos;
  // Ramo sem atalhos (autopeças, construção) precisa digitar: sem isto, "Montar grade"
  // recusaria para sempre e o cadastro não teria saída nenhuma.
  const [eixo1Digitado, setEixo1Digitado] = useState('');
  const router = useRouter();
  const params = useLocalSearchParams<{ codigo?: string; retorno?: string }>();
  const veioDoPdv = params.retorno === 'pdv';
  // A SPEC diz que o vendedor não vê preço de custo. Ele cadastra a peça; o custo é
  // preenchido depois pela dona na edição.
  const veDinheiro = useAuthStore((e) => pode(e.usuario?.papel, PODE.VER_DINHEIRO));
  // Categoria é a arrumação do catálogo, não um campo do cadastro: quem organiza a loja
  // cria. Mostrar o botão para quem levaria 403 seria oferecer um caminho fechado.
  const podeCriarCategoria = useAuthStore((e) => pode(e.usuario?.papel, PODE.EDITAR_CATALOGO));

  const [nome, setNome] = useState('');
  const [categoriaId, setCategoriaId] = useState<number | null>(null);
  const [precoCusto, setPrecoCusto] = useState('');
  const [precoVenda, setPrecoVenda] = useState('');
  const [estoqueMinimo, setEstoqueMinimo] = useState('0');
  const [cor, setCor] = useState('Única');
  const [tamanhosEscolhidos, setTamanhosEscolhidos] = useState<string[]>([]);
  const [grade, setGrade] = useState<LinhaGrade[]>([]);
  const [bipandoPara, setBipandoPara] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [fiscais, setFiscais] = useState(valoresIniciais);

  const categorias = useQuery({
    queryKey: chaves.categorias,
    queryFn: () => catalogo.categorias({ size: 100 }),
  });

  function alternarTamanho(tamanho: string) {
    setTamanhosEscolhidos((atuais) =>
      atuais.includes(tamanho)
        ? atuais.filter((t) => t !== tamanho)
        : [...atuais, tamanho].sort(
            (a, b) => TAMANHOS_RAPIDOS.indexOf(a) - TAMANHOS_RAPIDOS.indexOf(b),
          ),
    );
  }

  function gerarGrade() {
    // Vale o que foi digitado (separado por vírgula) OU o que foi escolhido nos atalhos.
    const digitados = eixo1Digitado
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    const escolhidos = digitados.length ? digitados : tamanhosEscolhidos;

    if (escolhidos.length === 0) {
      setErro(
        TAMANHOS_RAPIDOS.length
          ? `Escolha pelo menos um valor de ${vocab.eixo1.toLowerCase()}.`
          : `Digite ao menos um valor de ${vocab.eixo1.toLowerCase()}.`,
      );
      return;
    }
    setErro(null);
    setGrade(
      escolhidos.map((tamanho) => {
        const existente = grade.find((l) => l.tamanho === tamanho && l.cor === cor);
        return (
          existente ?? {
            chave: `${tamanho}-${cor}`,
            tamanho,
            cor,
            // Quem chegou aqui pelo PDV já tem um código na mão: ele vai na primeira peça.
            codigo:
              params.codigo && tamanho === escolhidos[0] ? params.codigo : null,
            estoque: '',
          }
        );
      }),
    );
  }

  // A foto é escolhida antes de o produto existir, então fica guardada aqui e sobe depois
  // que o POST devolve o id. Não dá para inverter: o upload é por produto.
  const [foto, setFoto] = useState<FotoEscolhida | null>(null);
  const [avisoFoto, setAvisoFoto] = useState<string | null>(null);

  const gerarCodigo = useMutation({
    mutationFn: () => catalogo.gerarCodigoInterno(),
  });

  async function pedirCodigoInterno(chave: string) {
    try {
      const codigo = await gerarCodigo.mutateAsync();
      setGrade((linhas) =>
        linhas.map((l) => (l.chave === chave ? { ...l, codigo } : l)),
      );
    } catch (e) {
      Alert.alert('Não deu para gerar o código', mensagemDoErro(e));
    }
  }

  const salvar = useMutation({
    mutationFn: async () => {
      const variantes: VariantePayload[] = grade.map((linha) => ({
        tamanho: linha.tamanho,
        cor: linha.cor,
        codigo_barras: linha.codigo,
        preco_custo: paraDecimalString(paraCentavos(precoCusto)),
        preco_venda: paraDecimalString(paraCentavos(precoVenda)),
        estoque_minimo: Number(estoqueMinimo) || 0,
      }));
      const produto = await catalogo.criarProduto({
        categoria_id: categoriaId!,
        nome: nome.trim(),
        ...paraPayload(fiscais),
        variantes,
      });

      // A peça nasce ZERADA (ADR-29): mercadoria entra por uma porta só, a Entrada. Aqui
      // as duas chamadas acontecem juntas porque o cadastro do celular costuma ser o
      // cadastro rápido do PDV — a cliente está no balcão esperando, e mandar a vendedora
      // para outra tela no meio da venda seria pior do que a redundância que isto evita.
      // Mesmo assim o estoque entra pelo caminho de verdade, com rastro no extrato.
      const itensParaEntrada = produto.variantes
        .map((v, i) => ({ variante_id: v.id, quantidade: Number(grade[i]?.estoque) || 0 }))
        .filter((i) => i.quantidade > 0);
      if (itensParaEntrada.length) {
        await estoque.registrarEntrada({
          client_uuid: gerarUuid(),
          fornecedor: null,
          observacao: 'Primeira compra, no cadastro da peça',
          itens: itensParaEntrada,
        });
      }

      if (foto) {
        // A peça já está cadastrada e vendável. Se a foto falhar (rede caindo, arquivo
        // recusado), o cadastro continua de pé e a pessoa tenta a foto de novo pelo
        // detalhe — desfazer o produto por causa de uma imagem seria bem pior.
        try {
          return await catalogo.enviarFoto(produto.id, foto);
        } catch {
          setAvisoFoto('A peça foi cadastrada, mas a foto não subiu. Tente pelo detalhe.');
        }
      }
      return produto;
    },
    onSuccess: (produto) => {
      invalidarAposMovimentoEstoque();
      if (avisoFoto) Alert.alert('Foto não enviada', avisoFoto);
      void queryClient.invalidateQueries({ queryKey: chaves.produtos });
      if (veioDoPdv) {
        // De volta ao PDV: o operador bipa a peça de novo, agora encontrada.
        Alert.alert('Peça cadastrada', 'Bipe a etiqueta de novo para colocar no carrinho.');
        router.back();
      } else {
        router.replace({ pathname: '/produto/[id]', params: { id: String(produto.id) } });
      }
    },
    onError: (e) => Alert.alert('Não deu para cadastrar', mensagemDoErro(e)),
  });

  function validarEEnviar() {
    if (nome.trim().length < 2) return setErro('Dê um nome para a peça.');
    if (!categoriaId) return setErro('Escolha uma categoria.');
    if (paraCentavos(precoVenda) <= 0) return setErro('Informe o preço de venda.');
    if (grade.length === 0) return setErro('Monte a grade de tamanhos.');
    // O estoque inicial é opcional em geral, mas obrigatório quando a venda está esperando.
    if (veioDoPdv && grade.every((l) => (Number(l.estoque) || 0) === 0)) {
      return setErro('Informe quantas peças você tem: a venda precisa de saldo.');
    }
    setErro(null);
    salvar.mutate();
  }

  if (categorias.isPending) return <Carregando />;

  const listaCategorias = categorias.data?.items ?? [];

  return (
    <KeyboardAvoidingView
      style={s.tela}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={s.conteudo} keyboardShouldPersistTaps="handled">
        {veioDoPdv && (
          <View style={s.avisoPdv}>
            <Text style={s.avisoPdvTexto}>
              Cadastro rápido para a venda em andamento. Informe o estoque para poder vender.
            </Text>
          </View>
        )}

        <Campo
          rotulo="Nome da peça"
          value={nome}
          onChangeText={setNome}
          placeholder={vocab.exemplo_produto}
          autoCapitalize="words"
        />

        <SeletorDeFoto uri={foto?.uri} aoEscolher={setFoto} />

        <CamposFiscais valores={fiscais} aoMudar={setFiscais} />

        <Text style={s.rotulo}>Categoria</Text>
        <View style={s.chips}>
          {listaCategorias.map((c) => (
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
          {/* O "+ Nova" fica na mesma fileira das outras: é ali que a pessoa já está
              olhando quando descobre que a categoria certa não existe. */}
          {podeCriarCategoria && <NovaCategoria aoCriar={(c) => setCategoriaId(c.id)} />}
        </View>
        {listaCategorias.length === 0 && !podeCriarCategoria && (
          <Text style={s.semCategoria}>
            Nenhuma categoria cadastrada ainda. Peça a quem cuida do catálogo para criar a
            primeira.
          </Text>
        )}

        {veDinheiro ? (
          <View style={s.duasColunas}>
            <View style={s.coluna}>
              <Campo
                rotulo="Custo (R$)"
                value={precoCusto}
                onChangeText={setPrecoCusto}
                keyboardType="decimal-pad"
                placeholder="22,50"
                ajuda="Quanto você pagou"
              />
            </View>
            <View style={s.coluna}>
              <Campo
                rotulo="Venda (R$)"
                value={precoVenda}
                onChangeText={setPrecoVenda}
                keyboardType="decimal-pad"
                placeholder="59,90"
                ajuda="Preço de etiqueta"
              />
            </View>
          </View>
        ) : (
          <Campo
            rotulo="Preço de venda (R$)"
            value={precoVenda}
            onChangeText={setPrecoVenda}
            keyboardType="decimal-pad"
            placeholder="59,90"
            ajuda="Preço de etiqueta"
          />
        )}

        {veDinheiro && paraCentavos(precoVenda) > 0 && paraCentavos(precoCusto) > 0 && (
          <Text style={s.margem}>
            Margem por peça: R${' '}
            {formatarSemSimbolo(paraCentavos(precoVenda) - paraCentavos(precoCusto))}
          </Text>
        )}

        <View style={s.duasColunas}>
          <View style={s.coluna}>
            <Campo
              rotulo={vocab.eixo2}
              value={cor}
              onChangeText={setCor}
              placeholder={vocab.eixo2_exemplos.split(", ")[0]}
            />
          </View>
          <View style={s.coluna}>
            <Campo
              rotulo="Estoque mínimo"
              value={estoqueMinimo}
              onChangeText={setEstoqueMinimo}
              keyboardType="number-pad"
              ajuda="Avisa quando chegar aqui"
            />
          </View>
        </View>

        <Text style={s.rotulo}>{vocab.eixo1}</Text>
        {TAMANHOS_RAPIDOS.length === 0 ? (
          <Campo
            rotulo=""
            value={eixo1Digitado}
            onChangeText={setEixo1Digitado}
            placeholder={vocab.eixo1_exemplos}
            ajuda={`Separe por vírgula para gerar várias de uma vez. Use "Único" se não varia.`}
          />
        ) : null}
        <View style={s.chips}>
          {TAMANHOS_RAPIDOS.map((t) => (
            <Pressable
              key={t}
              onPress={() => alternarTamanho(t)}
              style={[s.chip, tamanhosEscolhidos.includes(t) && s.chipAtivo]}
            >
              <Text
                style={[s.chipTexto, tamanhosEscolhidos.includes(t) && s.chipTextoAtivo]}
              >
                {t}
              </Text>
            </Pressable>
          ))}
        </View>
        <Botao
          titulo={grade.length ? 'Refazer grade' : 'Montar grade'}
          variante="secundario"
          onPress={gerarGrade}
        />

        {grade.length > 0 && (
          <View style={s.grade}>
            <Text style={s.gradeTitulo}>Peças da grade</Text>
            {grade.map((linha) => (
              <View key={linha.chave} style={s.linha}>
                <View style={s.linhaTopo}>
                  <Etiqueta texto={`${linha.tamanho} · ${linha.cor}`} />
                  <Campo
                    rotulo=""
                    value={linha.estoque}
                    onChangeText={(valor) =>
                      setGrade((linhas) =>
                        linhas.map((l) =>
                          l.chave === linha.chave ? { ...l, estoque: valor } : l,
                        ),
                      )
                    }
                    keyboardType="number-pad"
                    placeholder="qtd"
                    style={s.campoQtd}
                  />
                </View>

                {linha.codigo ? (
                  <Pressable
                    onPress={() =>
                      setGrade((linhas) =>
                        linhas.map((l) =>
                          l.chave === linha.chave ? { ...l, codigo: null } : l,
                        ),
                      )
                    }
                  >
                    <Text style={s.codigo}>
                      {linha.codigo} <Text style={s.trocar}>trocar</Text>
                    </Text>
                  </Pressable>
                ) : (
                  <View style={s.acoesCodigo}>
                    <Pressable
                      style={s.acaoCodigo}
                      onPress={() => setBipandoPara(linha.chave)}
                    >
                      <MaterialCommunityIcons
                        name="barcode-scan"
                        size={18}
                        color={cores.primaria}
                      />
                      <Text style={s.acaoTexto}>Bipar etiqueta</Text>
                    </Pressable>
                    <Pressable
                      style={s.acaoCodigo}
                      onPress={() => void pedirCodigoInterno(linha.chave)}
                    >
                      <MaterialCommunityIcons
                        name="auto-fix"
                        size={18}
                        color={cores.primaria}
                      />
                      <Text style={s.acaoTexto}>Gerar código</Text>
                    </Pressable>
                  </View>
                )}
              </View>
            ))}
            <Text style={s.gradeAjuda}>
              Peça sem código fica com um gerado automaticamente ao salvar.
            </Text>
          </View>
        )}

        {!!erro && <Text style={s.erro}>{erro}</Text>}
      </ScrollView>

      <View style={s.rodape}>
        <Botao
          titulo="Salvar peça"
          grande
          carregando={salvar.isPending}
          onPress={validarEEnviar}
        />
      </View>

      <Modal visible={!!bipandoPara} animationType="slide" onRequestClose={() => setBipandoPara(null)}>
        <Scanner
          modo="unico"
          dica="Bipe a etiqueta desta peça"
          aoLer={(codigo) => {
            setGrade((linhas) =>
              linhas.map((l) => (l.chave === bipandoPara ? { ...l, codigo } : l)),
            );
            setBipandoPara(null);
          }}
          rodape={
            <Botao
              titulo="Cancelar"
              variante="secundario"
              onPress={() => setBipandoPara(null)}
            />
          }
        />
      </Modal>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  tela: { flex: 1, backgroundColor: cores.fundo },
  conteudo: { padding: espaco.lg, paddingBottom: espaco.xxl },

  avisoPdv: {
    backgroundColor: cores.alertaFraco,
    padding: espaco.md,
    borderRadius: raio.md,
    marginBottom: espaco.lg,
  },
  avisoPdvTexto: { color: '#7A5A00', fontSize: fonte.pequena, fontWeight: '600' },

  rotulo: {
    fontSize: fonte.pequena,
    fontWeight: '600',
    color: cores.textoSuave,
    marginBottom: espaco.xs,
  },
  semCategoria: { color: cores.perigo, fontSize: fonte.pequena, marginBottom: espaco.lg },

  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: espaco.sm, marginBottom: espaco.lg },
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

  duasColunas: { flexDirection: 'row', gap: espaco.md },
  coluna: { flex: 1 },
  margem: {
    fontSize: fonte.pequena,
    color: cores.acaoEscura,
    fontWeight: '700',
    marginBottom: espaco.lg,
  },

  grade: { marginTop: espaco.lg, gap: espaco.sm },
  gradeTitulo: { fontSize: fonte.base, fontWeight: '700', color: cores.texto },
  gradeAjuda: { fontSize: fonte.micro, color: cores.textoFraco },
  linha: {
    backgroundColor: cores.superficie,
    borderRadius: raio.md,
    padding: espaco.md,
    gap: espaco.sm,
  },
  linhaTopo: { flexDirection: 'row', alignItems: 'center', gap: espaco.md },
  campoQtd: { width: 84, textAlign: 'center' },
  codigo: { fontSize: fonte.pequena, color: cores.textoSuave, fontVariant: ['tabular-nums'] },
  trocar: { color: cores.primaria, fontWeight: '700' },

  acoesCodigo: { flexDirection: 'row', gap: espaco.md },
  acaoCodigo: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: espaco.xs,
    minHeight: ALVO_TOQUE - 12,
    paddingHorizontal: espaco.md,
    borderRadius: raio.sm,
    backgroundColor: cores.primariaFraca,
  },
  acaoTexto: { fontSize: fonte.pequena, fontWeight: '700', color: cores.primaria },

  erro: { color: cores.perigo, fontWeight: '600', marginTop: espaco.lg },

  rodape: {
    padding: espaco.lg,
    backgroundColor: cores.superficie,
    borderTopWidth: 1,
    borderTopColor: cores.borda,
  },
});
