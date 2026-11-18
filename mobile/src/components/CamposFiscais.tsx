/**
 * Dados fiscais do produto (ADR-41): NCM, CEST, CFOP e origem. Espelho de
 * `web/js/campos-fiscais.js`.
 *
 * Nada é obrigatório: a peça nasce sem NCM e a emissão da NFC-e é quem recusa, dizendo o
 * que falta. Quem sabe o NCM e o CFOP de cada peça é o contador. O servidor aceita
 * "6109.10.00" e guarda só os dígitos — e recusa o formato errado com a mensagem certa.
 */

import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';

import { mensagemDoErro } from '@/api/client';
import { catalogo, type DadosFiscais } from '@/api/endpoints';
import type { Produto } from '@/api/tipos';
import { Botao, Campo, Cartao } from '@/components/ui';
import { CFOP_PADRAO, ORIGENS, cestFormatado, lerCodigo, ncmFormatado } from '@/lib/fiscal';
import { chaves, queryClient } from '@/lib/queryClient';
import { cores, espaco, fonte, raio } from '@/lib/tema';

export interface ValoresFiscais {
  ncm: string;
  cest: string;
  cfop: string;
  origem: number;
}

export const valoresIniciais = (p?: Partial<Produto>): ValoresFiscais => ({
  ncm: ncmFormatado(p?.ncm),
  cest: cestFormatado(p?.cest),
  cfop: p?.cfop ?? CFOP_PADRAO,
  origem: p?.origem ?? 0,
});

/** O que vai no POST/PATCH: vazio vira `null` (apaga), CFOP vazio volta ao padrão. */
export const paraPayload = (v: ValoresFiscais): DadosFiscais => ({
  ncm: lerCodigo(v.ncm),
  cest: lerCodigo(v.cest),
  cfop: lerCodigo(v.cfop) ?? CFOP_PADRAO,
  origem: v.origem,
});

export function CamposFiscais({
  valores,
  aoMudar,
}: {
  valores: ValoresFiscais;
  aoMudar: (v: ValoresFiscais) => void;
}) {
  const [aberto, setAberto] = useState(false);
  return (
    <View style={s.bloco}>
      <Pressable onPress={() => setAberto((a) => !a)} hitSlop={8}>
        <Text style={s.titulo}>
          {aberto ? '▾' : '▸'} Dados fiscais (NFC-e) — opcional, o contador informa
        </Text>
      </Pressable>
      {aberto && (
        <View style={s.campos}>
          <CamposFiscaisAbertos valores={valores} aoMudar={aoMudar} />
        </View>
      )}
    </View>
  );
}

/** No detalhe do produto: o resumo fiscal e, para quem edita o catálogo, a edição. */
export function CartaoFiscalDoProduto({ produto, podeEditar }: { produto: Produto; podeEditar: boolean }) {
  const [editando, setEditando] = useState(false);
  const [valores, setValores] = useState(() => valoresIniciais(produto));
  const salvar = useMutation({
    mutationFn: () => catalogo.atualizarProduto(produto.id, paraPayload(valores)),
    onSuccess: (atualizado) => {
      queryClient.setQueryData(chaves.produto(produto.id), atualizado);
      setEditando(false);
    },
    onError: (e) => Alert.alert('Não deu para salvar', mensagemDoErro(e)),
  });

  return (
    <Cartao>
      <Text style={s.rotulo}>Dados fiscais (NFC-e)</Text>
      <Text style={produto.ncm ? s.resumo : s.semNcm}>
        {produto.ncm
          ? `NCM ${ncmFormatado(produto.ncm)}${produto.cest ? ` · CEST ${cestFormatado(produto.cest)}` : ''} · CFOP ${produto.cfop} · origem ${produto.origem}`
          : 'Sem NCM: a NFC-e com esta peça não sai até o contador informar.'}
      </Text>
      {podeEditar && !editando && (
        <Botao
          titulo="Editar dados fiscais"
          variante="texto"
          onPress={() => {
            setValores(valoresIniciais(produto));
            setEditando(true);
          }}
        />
      )}
      {editando && (
        <View style={s.campos}>
          <CamposFiscaisAbertos valores={valores} aoMudar={setValores} />
          <Botao titulo="Salvar" carregando={salvar.isPending} onPress={() => salvar.mutate()} />
          <Botao titulo="Cancelar" variante="texto" onPress={() => setEditando(false)} />
        </View>
      )}
    </Cartao>
  );
}

function CamposFiscaisAbertos({
  valores,
  aoMudar,
}: {
  valores: ValoresFiscais;
  aoMudar: (v: ValoresFiscais) => void;
}) {
  return (
    <>
      <Campo
        rotulo="NCM (8 dígitos)"
        value={valores.ncm}
        onChangeText={(ncm) => aoMudar({ ...valores, ncm })}
        keyboardType="numbers-and-punctuation"
        placeholder="6109.10.00"
      />
      <Campo
        rotulo="CEST (só com substituição tributária)"
        value={valores.cest}
        onChangeText={(cest) => aoMudar({ ...valores, cest })}
        keyboardType="numbers-and-punctuation"
        placeholder="28.038.00"
      />
      <Campo
        rotulo="CFOP"
        value={valores.cfop}
        onChangeText={(cfop) => aoMudar({ ...valores, cfop })}
        keyboardType="number-pad"
      />
      <Text style={s.rotulo}>Origem</Text>
      <View style={s.origens}>
        {ORIGENS.map(([valor, rotulo]) => (
          <Pressable
            key={valor}
            onPress={() => aoMudar({ ...valores, origem: valor })}
            style={[s.origem, valores.origem === valor && s.origemAtiva]}
          >
            <Text style={[s.origemTexto, valores.origem === valor && s.origemTextoAtivo]}>{rotulo}</Text>
          </Pressable>
        ))}
      </View>
    </>
  );
}

const s = StyleSheet.create({
  bloco: { gap: espaco.sm },
  titulo: { fontSize: fonte.base, fontWeight: '700', color: cores.primaria },
  campos: { gap: espaco.sm, marginTop: espaco.sm },
  rotulo: { fontSize: fonte.pequena, fontWeight: '700', color: cores.textoSuave },
  resumo: { fontSize: fonte.pequena, color: cores.texto, marginTop: espaco.xs },
  semNcm: { fontSize: fonte.pequena, color: cores.perigo, marginTop: espaco.xs },
  origens: { gap: espaco.xs },
  origem: {
    borderWidth: 1,
    borderColor: cores.borda,
    borderRadius: raio.md,
    padding: espaco.sm,
    backgroundColor: cores.superficie,
  },
  origemAtiva: { borderColor: cores.primaria, backgroundColor: cores.primariaFraca },
  origemTexto: { fontSize: fonte.pequena, color: cores.texto },
  origemTextoAtivo: { color: cores.primaria, fontWeight: '600' },
});
