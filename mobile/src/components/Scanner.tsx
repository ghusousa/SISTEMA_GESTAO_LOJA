/**
 * Leitor de código de barras.
 *
 * A câmera dispara `onBarcodeScanned` a cada frame em que enxerga o código — um único bipe
 * do operador vira dezenas de eventos. Sem defesa, uma peça entraria dez vezes no carrinho.
 * Por isso há duas travas: o mesmo código só passa de novo depois de 1,5 s (tempo de afastar
 * e reaproximar a etiqueta) e qualquer código respeita 400 ms de intervalo entre leituras.
 */

import { CameraView, useCameraPermissions, type BarcodeType } from 'expo-camera';
import * as Haptics from 'expo-haptics';
import { useCallback, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Botao } from '@/components/ui';
import { ALVO_TOQUE, cores, espaco, fonte, raio } from '@/lib/tema';

/** EAN-13/EAN-8 cobrem etiqueta de fornecedor; Code 128 e UPC aparecem em peças importadas. */
const TIPOS: BarcodeType[] = ['ean13', 'ean8', 'code128', 'upc_a', 'upc_e'];

const ESPERA_MESMO_CODIGO = 1500;
const ESPERA_QUALQUER = 400;

export interface ScannerRef {
  /** Libera uma nova leitura no modo 'unico' (ex.: o código bipado não existia). */
  reativar: () => void;
}

interface Props {
  aoLer: (codigo: string) => void;
  /** 'continuo' mantém a leitura ativa (bipar vários); 'unico' para após o primeiro código. */
  modo?: 'unico' | 'continuo';
  ativo?: boolean;
  /**
   * A tela ainda está consultando o bipe anterior. Sem isso, com rede lenta o operador bipa
   * a segunda peça, ouve o "sucesso" e ela é descartada — no inventário, isso vira peça
   * sumindo do estoque.
   */
  ocupado?: boolean;
  rodape?: React.ReactNode;
  dica?: string;
  /** Recebe o controle para reativar a leitura depois de um erro. */
  controle?: React.MutableRefObject<ScannerRef | null>;
}

export function Scanner({
  aoLer,
  modo = 'continuo',
  ativo = true,
  ocupado = false,
  rodape,
  dica = 'Aponte para o código de barras da peça',
  controle,
}: Props) {
  const [permissao, pedirPermissao] = useCameraPermissions();
  const [lanterna, setLanterna] = useState(false);
  const [ultimoLido, setUltimoLido] = useState<string | null>(null);

  const ultimoCodigo = useRef<string | null>(null);
  const instanteUltimoCodigo = useRef(0);
  const instanteQualquer = useRef(0);
  const pausado = useRef(false);
  // Em ref, não em dep do callback: o valor muda a cada consulta e recriar o handler
  // faria a câmera reconfigurar no meio da leitura.
  const ocupadoRef = useRef(ocupado);
  ocupadoRef.current = ocupado;

  if (controle) {
    controle.current = {
      reativar: () => {
        pausado.current = false;
        ultimoCodigo.current = null;
        instanteUltimoCodigo.current = 0;
        instanteQualquer.current = 0;
        setUltimoLido(null);
      },
    };
  }

  const tratarLeitura = useCallback(
    ({ data }: { data: string }) => {
      if (!ativo || pausado.current) return;

      if (ocupadoRef.current) {
        // Avisa em vez de engolir: o operador precisa saber que precisa bipar de novo.
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
        return;
      }

      const agora = Date.now();
      if (agora - instanteQualquer.current < ESPERA_QUALQUER) return;
      if (
        data === ultimoCodigo.current &&
        agora - instanteUltimoCodigo.current < ESPERA_MESMO_CODIGO
      ) {
        return;
      }

      instanteQualquer.current = agora;
      ultimoCodigo.current = data;
      instanteUltimoCodigo.current = agora;

      if (modo === 'unico') pausado.current = true;

      setUltimoLido(data);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      aoLer(data);
    },
    [ativo, aoLer, modo],
  );

  if (!permissao) {
    return <View style={s.preto} />;
  }

  if (!permissao.granted) {
    return (
      <View style={s.aviso}>
        <Text style={s.avisoTitulo}>A câmera precisa de permissão</Text>
        <Text style={s.avisoTexto}>
          É com ela que o app lê o código de barras das peças. Sem isso, dá para buscar
          digitando o código.
        </Text>
        <Botao titulo="Permitir câmera" onPress={() => void pedirPermissao()} />
      </View>
    );
  }

  return (
    <View style={s.container}>
      <CameraView
        style={StyleSheet.absoluteFill}
        facing="back"
        enableTorch={lanterna}
        barcodeScannerSettings={{ barcodeTypes: TIPOS }}
        onBarcodeScanned={ativo ? tratarLeitura : undefined}
      />

      <View style={s.sobreposicao} pointerEvents="box-none">
        <View style={s.topo} pointerEvents="box-none">
          <Pressable
            onPress={() => setLanterna((l) => !l)}
            style={[s.lanterna, lanterna && s.lanternaAtiva]}
            accessibilityRole="button"
            accessibilityLabel="Lanterna"
          >
            <Text style={s.lanternaTexto}>{lanterna ? 'Lanterna ligada' : 'Lanterna'}</Text>
          </Pressable>
        </View>

        <View style={s.moldura} pointerEvents="none">
          <View style={s.miraLinha} />
        </View>

        <View style={s.base} pointerEvents="box-none">
          <Text style={s.dica}>{dica}</Text>
          {!!ultimoLido && <Text style={s.ultimo}>Último: {ultimoLido}</Text>}
          {rodape}
        </View>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  preto: { flex: 1, backgroundColor: '#000' },

  sobreposicao: { flex: 1, justifyContent: 'space-between' },
  topo: { alignItems: 'flex-end', padding: espaco.md },
  lanterna: {
    minHeight: ALVO_TOQUE,
    justifyContent: 'center',
    paddingHorizontal: espaco.lg,
    borderRadius: raio.redondo,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  lanternaAtiva: { backgroundColor: cores.alerta },
  lanternaTexto: { color: '#FFF', fontWeight: '700', fontSize: fonte.pequena },

  moldura: {
    alignSelf: 'center',
    width: '82%',
    aspectRatio: 1.6,
    borderWidth: 3,
    borderColor: 'rgba(255,255,255,0.9)',
    borderRadius: raio.lg,
    justifyContent: 'center',
  },
  miraLinha: { height: 2, backgroundColor: cores.perigo, opacity: 0.85 },

  base: { padding: espaco.lg, gap: espaco.sm, backgroundColor: 'rgba(0,0,0,0.45)' },
  dica: { color: '#FFF', fontSize: fonte.base, textAlign: 'center', fontWeight: '600' },
  ultimo: { color: '#C9D3DE', fontSize: fonte.pequena, textAlign: 'center' },

  aviso: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: espaco.xl,
    gap: espaco.md,
    backgroundColor: cores.fundo,
  },
  avisoTitulo: { fontSize: fonte.media, fontWeight: '700', color: cores.texto },
  avisoTexto: { fontSize: fonte.base, color: cores.textoSuave, textAlign: 'center' },
});
