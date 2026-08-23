/**
 * Preparo da foto da peça antes de subir. **Espelho de `mobile/src/lib/foto.ts`.**
 *
 * A API recusa acima de 5 MB, e foto de celular passa disso com facilidade — inclusive as
 * que chegam ao balcão por WhatsApp e cartão de memória. Encolher aqui, no navegador,
 * evita que a pessoa espere o upload inteiro para levar "imagem muito grande" no fim.
 *
 * 1200 px no lado maior e JPEG a 70% dão entre 100 e 300 KB: sobra resolução para a tela e
 * o envio termina rápido até numa internet ruim de loja.
 */

/** Lado maior da imagem final. Acima disso é peso sem ganho na tela. */
const LADO_MAXIMO = 1200;
const QUALIDADE = 0.7;

export const TIPOS_ACEITOS = 'image/jpeg,image/png,image/webp';

/**
 * Desenha a imagem num canvas do tamanho certo e devolve um JPEG.
 *
 * `createImageBitmap` com `imageOrientation: 'from-image'` respeita o EXIF — sem isso, foto
 * tirada com o celular de lado sobe deitada, e o pior é que ela aparece certa na hora de
 * escolher, porque a tag de orientação só é aplicada na exibição.
 */
export async function encolherImagem(arquivo) {
  if (!arquivo.type.startsWith('image/')) {
    throw new Error('O arquivo escolhido não é uma imagem.');
  }

  const bitmap = await criarBitmap(arquivo);
  const escala = Math.min(1, LADO_MAXIMO / Math.max(bitmap.width, bitmap.height));
  const largura = Math.round(bitmap.width * escala);
  const altura = Math.round(bitmap.height * escala);

  const canvas = document.createElement('canvas');
  canvas.width = largura;
  canvas.height = altura;
  const ctx = canvas.getContext('2d');
  // Fundo branco: PNG com transparência viraria preto ao converter para JPEG.
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, largura, altura);
  ctx.drawImage(bitmap, 0, 0, largura, altura);
  bitmap.close?.();

  const blob = await new Promise((ok) => canvas.toBlob(ok, 'image/jpeg', QUALIDADE));
  if (!blob) throw new Error('Não foi possível preparar a imagem.');
  return blob;
}

async function criarBitmap(arquivo) {
  if (globalThis.createImageBitmap) {
    try {
      return await createImageBitmap(arquivo, { imageOrientation: 'from-image' });
    } catch {
      // Safari antigo não aceita a opção; cai no <img>, que já orienta sozinho.
    }
  }
  const url = URL.createObjectURL(arquivo);
  try {
    const img = new Image();
    await new Promise((ok, falhou) => {
      img.onload = ok;
      img.onerror = () => falhou(new Error('Não foi possível ler a imagem.'));
      img.src = url;
    });
    return img;
  } finally {
    // Só depois do decode: revogar antes deixaria o canvas desenhar em branco.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

/** Monta o `FormData` que a rota `PUT /produtos/{id}/foto` espera. */
export function formDaFoto(blob) {
  const form = new FormData();
  // O nome do arquivo vira só a extensão para a API; o caminho real quem gera é o servidor.
  form.append('arquivo', blob, 'peca.jpg');
  return form;
}

/** Sobe a foto de um produto já existente. Devolve o produto atualizado. */
export async function enviarFoto(api, produtoId, arquivo) {
  const blob = await encolherImagem(arquivo);
  return api.upload(`/produtos/${produtoId}/foto`, formDaFoto(blob));
}
