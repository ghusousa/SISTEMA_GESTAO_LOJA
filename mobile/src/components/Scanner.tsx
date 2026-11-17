/**
 * Leitor de código de barras.
 *
 * A câmera dispara `onBarcodeScanned` a cada frame em que enxerga o código — um único bipe
 * do operador vira dezenas de eventos. Quem decide o que passa é `lib/leitura.ts`, testado
 * à parte; aqui só ficam a câmera, a moldura e o estado que alimenta aquela decisão.
 */

import { CameraView, useCameraPermissions, type BarcodeType } from 'expo-camera';
import * as Haptics from 'expo-haptics';
import { useCallback, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Botao } from '@/components/ui';
import { decidirLeitura } from '@/lib/leitura';
import { ALVO_TOQUE, cores, espaco, fonte, raio } from '@/lib/tema';

/** EAN-13/EAN-8 cobrem etiqueta de fornecedor; Code 128 e UPC aparecem em peças importadas. */
const TIPOS: BarcodeType[] = ['ean13', 'ean8', 'code128', 'upc_a', 'upc_e'];

/**
 * Só QR: o convite do celular-leitor (ADR-43). Fora das etiquetas de propósito — com QR
 * ligado no PDV, um Pix na bancada viraria "código não cadastrado".
 */
export const SO_QR: BarcodeType[] = ['qr'];

export interface ScannerRef {
  /** Libera uma nova leitura no modo 'unico' (ex.: o código bipado não existia). */
  reativar: () => void;
  /**
   * Para de ler enquanto existe um diálogo na frente da câmera.
   *
   * `Alert.alert` não bloqueia nada: a câmera continua enxergando a mesma etiqueta e,
   * passados os 1,5 s da trava, dispara outra leitura — o iOS empilha os alertas e a
   * pessoa fecha o mesmo aviso cinco vezes seguidas.
   */
  pausar: () => void;
  /** Volta a ler mantendo a trava do último código, senão o diálogo reabre sozinho. */
  retomar: () => void;
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
  /**
   * Que códigos a câmera procura. Padrão: as etiquetas de peça. Passe uma constante de
   * módulo (como `SO_QR`): array novo a cada render reconfiguraria a câmera.
   */
  tipos?: BarcodeType[];
}

export function Scanner({
  aoLer,
  modo = 'continuo',
  ativo = true,
  ocupado = false,
  rodape,
  dica = 'Aponte para o código de barras da peça',
  controle,
  tipos = TIPOS,
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
      pausar: () => {
        pausado.current = true;
      },
      retomar: () => {
        pausado.current = false;
        // As travas recomeçam a contar agora, e não no instante da leitura que abriu o
        // diálogo: o operador precisa desses 1,5 s para afastar o celular da etiqueta.
        const agora = Date.now();
        instanteUltimoCodigo.current = agora;
        instanteQualquer.current = agora;
      },
    };
  }

  const tratarLeitura = useCallback(
    ({ data }: { data: string }) => {
      if (!ativo) return;

      const agora = Date.now();
      const decisao = decidirLeitura(
        {
          ultimoCodigo: ultimoCodigo.current,
          instanteUltimoCodigo: instanteUltimoCodigo.current,
          instanteQualquer: instanteQualquer.current,
          pausado: pausado.current,
          ocupado: ocupadoRef.current,
        },
        data,
        agora,
      );

      if (decisao === 'ignorar') return;

      if (decisao === 'avisar-ocupado') {
        // Avisa em vez de engolir: o operador precisa saber que precisa bipar de novo.
        instanteQualquer.current = agora;
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
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
          É com ela que o app lê o código de barras das peças. Sem a câmera, use
          "Digitar código" para buscar a peça pelo número da etiqueta.
        </Text>
        <Botao titulo="Permitir câmera" onPress={() => void pedirPermissao()} />
        {/* O rodapé vem junto — é ele que traz o "Digitar código" que o texto acima
            promete, e o "Voltar". Sem isto, a tela de ajuste (que É o scanner, dentro de
            um Modal sem cabeçalho) virava beco sem saída para quem negasse a câmera: nem
            digitava o código, nem saía. */}
        <View style={s.avisoRodape}>{rodape}</View>
      </View>
    );
  }

  return (
    <View style={s.container}>
      <CameraView
        style={StyleSheet.absoluteFill}
        facing="back"
        enableTorch={lanterna}
        barcodeScannerSettings={{ barcodeTypes: tipos }}
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

  // `flex: 1` em vez de altura fixa: a moldura ocupa o que sobra entre a lanterna e a
  // dica. Com `aspectRatio` ela estourava a área da câmera em tela curta e empurrava o
  // rodapé — junto com o botão de digitar o código — para fora do alcance do dedo.
  moldura: {
    alignSelf: 'center',
    width: '82%',
    flex: 1,
    maxHeight: 240,
    marginVertical: espaco.sm,
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
  avisoRodape: { alignSelf: 'stretch', gap: espaco.sm, marginTop: espaco.sm },
  avisoTitulo: { fontSize: fonte.media, fontWeight: '700', color: cores.texto },
  avisoTexto: { fontSize: fonte.base, color: cores.textoSuave, textAlign: 'center' },
});
