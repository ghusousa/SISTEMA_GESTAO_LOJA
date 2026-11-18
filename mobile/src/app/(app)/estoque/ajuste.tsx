/**
 * Ajuste manual de saldo (admin). Motivo é obrigatório: ajuste sem explicação vira
 * buraco no estoque que ninguém consegue reconstituir depois.
 */

import { useMutation } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { Alert, Modal, ScrollView, StyleSheet, Text, View } from 'react-native';

import { codigoDoErro, mensagemDoErro } from '@/api/client';
import { catalogo, estoque } from '@/api/endpoints';
import type { VarianteLookup } from '@/api/tipos';
import { CodigoManual } from '@/components/CodigoManual';
import { Scanner, type ScannerRef } from '@/components/Scanner';
import { Botao, Campo, Cartao } from '@/components/ui';
import { invalidarAposMovimentoEstoque } from '@/lib/queryClient';
import { cores, espaco, fonte } from '@/lib/tema';

export default function AjusteEstoque() {
  const router = useRouter();
  const [peca, setPeca] = useState<VarianteLookup | null>(null);
  const [quantidade, setQuantidade] = useState('');
  const [motivo, setMotivo] = useState('');
  const [scanner, setScanner] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  // Sem isto, o scanner em modo único ficaria pausado para sempre após um código
  // desconhecido: a câmera segue ligada e nenhuma outra etiqueta é lida.
  const controle = useRef<ScannerRef | null>(null);

  async function buscar(codigo: string) {
    try {
      const encontrada = await catalogo.porCodigoBarras(codigo);
      setPeca(encontrada);
      setScanner(false);
      setErro(null);
    } catch (e) {
      setErro(
        codigoDoErro(e) === 'NAO_ENCONTRADO'
          ? `Código ${codigo} não cadastrado. Bipe outra peça.`
          : mensagemDoErro(e),
      );
      controle.current?.reativar();
    }
  }

  const ajustar = useMutation({
    mutationFn: () =>
      estoque.ajustar({
        variante_id: peca!.variante_id,
        quantidade: Number(quantidade),
        motivo: motivo.trim(),
      }),
    onSuccess: (movimento) => {
      invalidarAposMovimentoEstoque();
      Alert.alert('Ajuste registrado', `Novo saldo: ${movimento.saldo_apos} peça(s).`, [
        { text: 'Pronto', onPress: () => router.back() },
      ]);
    },
    onError: (e) => Alert.alert('Não deu para ajustar', mensagemDoErro(e)),
  });

  function enviar() {
    const valor = Number(quantidade);
    if (!Number.isInteger(valor) || valor === 0) {
      return setErro('Informe quantas peças entram (+) ou saem (−). Zero não ajusta nada.');
    }
    if (motivo.trim().length < 3) return setErro('Explique o motivo do ajuste.');
    setErro(null);
    ajustar.mutate();
  }

  if (scanner) {
    return (
      <Modal visible animationType="none">
        <Scanner
          modo="unico"
          encosta="em-cima-e-embaixo"
          controle={controle}
          dica="Bipe a peça que precisa de ajuste"
          aoLer={(codigo) => void buscar(codigo)}
          rodape={
            <>
              {!!erro && <Text style={s.erroScanner}>{erro}</Text>}
              <CodigoManual aoConfirmar={(codigo) => void buscar(codigo)} />
              <Botao titulo="Voltar" variante="secundario" onPress={() => router.back()} />
            </>
          }
        />
      </Modal>
    );
  }

  return (
    <ScrollView contentContainerStyle={s.conteudo} keyboardShouldPersistTaps="handled">
      <Cartao>
        <Text style={s.nome}>{peca?.produto}</Text>
        <Text style={s.detalhe}>
          {peca?.tamanho} · {peca?.cor}
        </Text>
        <Text style={s.saldo}>Saldo atual: {peca?.saldo}</Text>
      </Cartao>

      <Campo
        rotulo="Quantidade a ajustar"
        value={quantidade}
        onChangeText={setQuantidade}
        keyboardType="numbers-and-punctuation"
        placeholder="-2 para tirar, 3 para somar"
        ajuda="Use o sinal de menos para retirar peças"
      />

      <Campo
        rotulo="Motivo"
        value={motivo}
        onChangeText={setMotivo}
        placeholder="peça manchada, erro de contagem…"
        multiline
      />

      {!!erro && <Text style={s.erro}>{erro}</Text>}

      <Botao
        titulo="Registrar ajuste"
        grande
        carregando={ajustar.isPending}
        onPress={enviar}
      />
      <Botao
        titulo="Bipar outra peça"
        variante="secundario"
        onPress={() => {
          setPeca(null);
          setQuantidade('');
          setMotivo('');
          setScanner(true);
        }}
      />
    </ScrollView>
  );
}

const s = StyleSheet.create({
  conteudo: { padding: espaco.lg, gap: espaco.sm },
  nome: { fontSize: fonte.media, fontWeight: '800', color: cores.texto },
  detalhe: { fontSize: fonte.base, color: cores.textoSuave, marginTop: 2 },
  saldo: { fontSize: fonte.grande, fontWeight: '800', color: cores.primaria, marginTop: espaco.sm },
  erro: { color: cores.perigo, fontWeight: '600' },
  erroScanner: {
    color: '#FFF',
    backgroundColor: cores.perigo,
    padding: espaco.sm,
    borderRadius: 8,
    textAlign: 'center',
    fontWeight: '600',
  },
});
