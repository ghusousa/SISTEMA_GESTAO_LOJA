/**
 * Escolher e preparar a foto de uma peça, pela câmera ou pela galeria.
 *
 * O preparo não é enfeite. A câmera de um celular atual entrega de 4 a 12 MB por foto, e a
 * API recusa acima de 5 MB (4 MB na Vercel, ADR-42) — a pessoa fotografaria a peça,
 * esperaria o upload e levaria "imagem muito grande" depois de gastar o dado móvel.
 * Reduzimos para 1200 px e JPEG a 70%, que dá algo entre 100 e 300 KB: passa folgado no
 * limite, sobe rápido no 4G da loja e ainda é mais resolução do que a tela precisa para
 * mostrar uma blusa.
 */

import * as ImageManipulator from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';

/** Lado maior da imagem final. Acima disso é peso sem ganho na tela. */
const LADO_MAXIMO = 1200;
const QUALIDADE = 0.7;

export interface FotoEscolhida {
  uri: string;
  nome: string;
  tipo: string;
}

export type Origem = 'camera' | 'galeria';

export class PermissaoNegada extends Error {
  constructor(public readonly origem: Origem) {
    super(
      origem === 'camera'
        ? 'O app precisa da câmera para fotografar a peça. Autorize nos ajustes do celular.'
        : 'O app precisa acessar suas fotos para escolher a imagem. Autorize nos ajustes do celular.',
    );
    this.name = 'PermissaoNegada';
  }
}

async function garantirPermissao(origem: Origem): Promise<void> {
  const pedir =
    origem === 'camera'
      ? ImagePicker.requestCameraPermissionsAsync
      : ImagePicker.requestMediaLibraryPermissionsAsync;
  const { granted } = await pedir();
  if (!granted) throw new PermissaoNegada(origem);
}

async function encolher(uri: string): Promise<FotoEscolhida> {
  const contexto = ImageManipulator.ImageManipulator.manipulate(uri);
  // `resize` só com a largura mantém a proporção — nada de peça achatada.
  contexto.resize({ width: LADO_MAXIMO });
  const imagem = await contexto.renderAsync();
  const salva = await imagem.saveAsync({
    compress: QUALIDADE,
    format: ImageManipulator.SaveFormat.JPEG,
  });
  return { uri: salva.uri, nome: 'peca.jpg', tipo: 'image/jpeg' };
}

/**
 * Abre a câmera ou a galeria e devolve a foto já reduzida.
 *
 * `null` quer dizer que a pessoa desistiu — cancelar não é erro e não merece alerta.
 * Permissão negada, sim: lança `PermissaoNegada`, com o texto pronto para a tela.
 */
export async function escolherFoto(origem: Origem): Promise<FotoEscolhida | null> {
  await garantirPermissao(origem);

  const opcoes: ImagePicker.ImagePickerOptions = {
    mediaTypes: ['images'],
    // Recorte quadrado: a lista de produtos mostra miniaturas quadradas, e deixar a
    // pessoa enquadrar é melhor do que o app cortar a peça pela metade depois.
    allowsEditing: true,
    aspect: [1, 1],
    quality: 1, // a compressão real acontece no `encolher`, depois do recorte
  };

  const resultado =
    origem === 'camera'
      ? await ImagePicker.launchCameraAsync(opcoes)
      : await ImagePicker.launchImageLibraryAsync(opcoes);

  if (resultado.canceled || !resultado.assets?.length) return null;
  return encolher(resultado.assets[0].uri);
}
