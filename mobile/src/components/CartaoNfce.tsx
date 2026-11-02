/**
 * O cartão da NFC-e no detalhe da venda (ADR-41): status, chave, link do DANFE e o botão
 * Emitir / Tentar de novo. Espelho de `web/js/nfce.js`; a lógica de o que mostrar mora em
 * `lib/fiscal.ts`, com teste.
 *
 * Emitir é idempotente no servidor: nota autorizada não sai duas vezes, por mais toques
 * que o balcão dê. O que falta para emitir (NCM, CNPJ, emissor) vem do servidor, em frase.
 */

import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Alert, Linking, StyleSheet, Text, View } from 'react-native';

import { detalheDoErro, mensagemDoErro } from '@/api/client';
import { fiscal } from '@/api/endpoints';
import { Botao, Cartao, Etiqueta } from '@/components/ui';
import { cartaoDaNfce, chaveFormatada, linkSeguro, rotuloDaNota, type Tom } from '@/lib/fiscal';
import { PODE, pode } from '@/lib/permissoes';
import { chaves, queryClient } from '@/lib/queryClient';
import { cores, espaco, fonte } from '@/lib/tema';
import { useAuthStore } from '@/stores/authStore';

const CORES: Record<Tom, [string, string]> = {
  ok: [cores.sucessoFraco, cores.acaoEscura],
  alerta: [cores.alertaFraco, cores.texto],
  perigo: [cores.perigoFraco, cores.perigo],
  neutro: [cores.superficieAlt, cores.textoSuave],
};

/** O `detail.faltando` de um 409 da emissão (NCM, CNPJ, regime...), se houver. */
function faltandoDoErro(erro: unknown): string[] {
  const faltando = detalheDoErro(erro)?.faltando;
  return Array.isArray(faltando) ? faltando.map(String) : [];
}

export function CartaoNfce({ vendaId, cancelada }: { vendaId: number; cancelada: boolean }) {
  const papel = useAuthStore((e) => e.usuario?.papel);
  const [faltando, setFaltando] = useState<string[]>([]);

  const consulta = useQuery({
    queryKey: chaves.nfce(vendaId),
    queryFn: () => fiscal.nfce(vendaId),
    // Sem a nota, o detalhe da venda segue igual: nada de tela de erro por causa dela.
    retry: false,
  });

  const emitir = useMutation({
    mutationFn: () => fiscal.emitir(vendaId),
    onSuccess: (nfce) => {
      setFaltando([]);
      queryClient.setQueryData(chaves.nfce(vendaId), nfce);
      const status = nfce.nota?.status;
      if (status === 'REJEITADA') Alert.alert('A SEFAZ recusou a nota', nfce.nota?.mensagem ?? '');
      else if (status === 'PENDENTE')
        Alert.alert('Sem resposta definitiva', 'Tente de novo em instantes.');
    },
    onError: (e) => {
      setFaltando(faltandoDoErro(e));
      Alert.alert('NFC-e não emitida', mensagemDoErro(e));
    },
  });

  const nfce = consulta.data;
  const cartao = cartaoDaNfce(nfce, cancelada, pode(papel, PODE.CONFIGURAR_LOJA));
  if (cartao.oculto || !nfce) return null;

  const nota = nfce.nota;
  const rotulo = nota ? rotuloDaNota(nota.status) : null;
  const danfe = linkSeguro(nota?.url_danfe);
  const lista = [...cartao.faltando, ...faltando];

  return (
    <Cartao>
      <Text style={s.secao}>NFC-e</Text>
      {!nota && !nfce.emissor.configurado && (
        <Text style={s.texto}>Emissor fiscal desligado: esta venda não tem NFC-e.</Text>
      )}
      {!nota && nfce.emissor.configurado && (
        <Text style={s.texto}>
          {cancelada ? 'Venda cancelada: não emite nota.' : 'NFC-e ainda não emitida.'}
        </Text>
      )}
      {nota && rotulo && (
        <View style={s.linha}>
          <Etiqueta texto={rotulo.texto} cor={CORES[rotulo.tom][0]} corTexto={CORES[rotulo.tom][1]} />
          {nota.ambiente === 'homologacao' && (
            <Etiqueta texto="homologação — sem valor fiscal" />
          )}
          {nota.numero != null && (
            <Text style={s.texto}>
              Nº {nota.numero}, série {nota.serie ?? '—'}
            </Text>
          )}
        </View>
      )}
      {!!nota?.chave && <Text style={s.chave}>{chaveFormatada(nota.chave)}</Text>}
      {!!cartao.mensagem && <Text style={s.mensagem}>{cartao.mensagem}</Text>}
      {lista.map((f) => (
        <Text key={f} style={s.falta}>
          • {f}
        </Text>
      ))}
      <View style={s.acoes}>
        {danfe && (
          <Botao titulo="Abrir DANFE" variante="secundario" onPress={() => void Linking.openURL(danfe)} />
        )}
        {cartao.botao && (
          <Botao titulo={cartao.botao} carregando={emitir.isPending} onPress={() => emitir.mutate()} />
        )}
      </View>
    </Cartao>
  );
}

const s = StyleSheet.create({
  secao: {
    fontSize: fonte.pequena,
    fontWeight: '700',
    color: cores.textoSuave,
    marginBottom: espaco.sm,
    textTransform: 'uppercase',
  },
  linha: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: espaco.sm },
  texto: { fontSize: fonte.pequena, color: cores.texto },
  chave: { fontSize: fonte.pequena, color: cores.texto, marginTop: espaco.sm, fontVariant: ['tabular-nums'] },
  mensagem: { fontSize: fonte.pequena, color: cores.perigo, marginTop: espaco.sm },
  falta: { fontSize: fonte.pequena, color: cores.textoSuave, marginTop: espaco.xs },
  acoes: { gap: espaco.sm, marginTop: espaco.sm },
});
