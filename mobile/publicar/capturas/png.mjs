/**
 * PNG em Node puro (zlib), sem dependência nova: ler o que o Chrome grava e regravar do
 * jeito que a App Store aceita.
 *
 * A Apple recusa captura com canal alfa ("images can't contain alpha channels or
 * transparencies"), e o Chrome pode gravar a tela em RGBA mesmo com a página toda opaca.
 * Aqui a imagem é relida e escrita de novo em RGB puro (tipo de cor 2, 8 bits, sem
 * entrelaçamento) — o byte 25 do IHDR é a prova, e `conferirPng` o confere.
 */

import { deflateSync, inflateSync } from 'node:zlib';

const ASSINATURA = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

const TABELA_CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(...partes) {
  let c = 0xffffffff;
  for (const parte of partes) for (const byte of parte) c = TABELA_CRC[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pedaco(tipo, dados) {
  const cabeca = Buffer.alloc(8);
  cabeca.writeUInt32BE(dados.length, 0);
  cabeca.write(tipo, 4, 'ascii');
  const fim = Buffer.alloc(4);
  fim.writeUInt32BE(crc32(cabeca.subarray(4), dados), 0);
  return Buffer.concat([cabeca, dados, fim]);
}

/** Preditor de Paeth (especificação do PNG, 9.4). */
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/**
 * Lê um PNG de 8 bits, RGB ou RGBA, sem entrelaçamento — o que o Chrome grava.
 * Devolve os pixels já sem os filtros, linha após linha (`largura * canais` bytes cada).
 */
export function lerPng(dados) {
  if (!dados.subarray(0, 8).equals(ASSINATURA)) throw new Error('não é um PNG');
  let largura = 0;
  let altura = 0;
  let profundidade = 0;
  let tipoDeCor = 0;
  let entrelacado = 0;
  const idat = [];
  for (let pos = 8; pos < dados.length; ) {
    const tamanho = dados.readUInt32BE(pos);
    const tipo = dados.toString('ascii', pos + 4, pos + 8);
    const corpo = dados.subarray(pos + 8, pos + 8 + tamanho);
    if (tipo === 'IHDR') {
      largura = corpo.readUInt32BE(0);
      altura = corpo.readUInt32BE(4);
      profundidade = corpo[8];
      tipoDeCor = corpo[9];
      entrelacado = corpo[12];
    } else if (tipo === 'IDAT') {
      idat.push(corpo);
    } else if (tipo === 'IEND') {
      break;
    }
    pos += 12 + tamanho;
  }
  const canais = { 2: 3, 6: 4 }[tipoDeCor];
  if (profundidade !== 8 || !canais || entrelacado !== 0) {
    throw new Error(`PNG fora do esperado (bits ${profundidade}, cor ${tipoDeCor}, entrelaçado ${entrelacado})`);
  }
  const bruto = inflateSync(Buffer.concat(idat));
  const passo = largura * canais;
  const pixels = Buffer.alloc(passo * altura);
  for (let y = 0; y < altura; y += 1) {
    const filtro = bruto[y * (passo + 1)];
    const origem = bruto.subarray(y * (passo + 1) + 1, (y + 1) * (passo + 1));
    const linha = pixels.subarray(y * passo, (y + 1) * passo);
    const acima = y > 0 ? pixels.subarray((y - 1) * passo, y * passo) : null;
    for (let x = 0; x < passo; x += 1) {
      const a = x >= canais ? linha[x - canais] : 0;
      const b = acima ? acima[x] : 0;
      const c = acima && x >= canais ? acima[x - canais] : 0;
      const v = origem[x];
      linha[x] =
        filtro === 0 ? v
        : filtro === 1 ? v + a
        : filtro === 2 ? v + b
        : filtro === 3 ? v + ((a + b) >> 1)
        : filtro === 4 ? v + paeth(a, b, c)
        : (() => { throw new Error(`filtro PNG desconhecido: ${filtro}`); })();
    }
  }
  return { largura, altura, canais, pixels };
}

/**
 * Tira o canal alfa. Pixel que não for totalmente opaco é erro de composição (um buraco
 * na arte), e não algo a esconder: a função recusa em vez de misturar com uma cor qualquer.
 */
export function paraRgb({ largura, altura, canais, pixels }) {
  if (canais === 3) return { largura, altura, rgb: pixels };
  const rgb = Buffer.alloc(largura * altura * 3);
  for (let i = 0, j = 0; i < pixels.length; i += 4, j += 3) {
    if (pixels[i + 3] !== 255) {
      const n = i / 4;
      throw new Error(`pixel transparente em x=${n % largura}, y=${Math.floor(n / largura)}`);
    }
    rgb[j] = pixels[i];
    rgb[j + 1] = pixels[i + 1];
    rgb[j + 2] = pixels[i + 2];
  }
  return { largura, altura, rgb };
}

/**
 * Grava RGB de 8 bits. Cada linha leva o filtro que deixa os bytes menores (a heurística
 * da própria especificação), o que corta o arquivo pela metade em relação a "sem filtro".
 */
export function escreverPngRgb({ largura, altura, rgb }) {
  const passo = largura * 3;
  const saida = Buffer.alloc((passo + 1) * altura);
  const candidatos = Array.from({ length: 5 }, () => Buffer.alloc(passo));
  for (let y = 0; y < altura; y += 1) {
    const linha = rgb.subarray(y * passo, (y + 1) * passo);
    const acima = y > 0 ? rgb.subarray((y - 1) * passo, y * passo) : null;
    let melhor = 0;
    let menorSoma = Infinity;
    for (let f = 0; f < 5; f += 1) {
      const destino = candidatos[f];
      let soma = 0;
      for (let x = 0; x < passo; x += 1) {
        const a = x >= 3 ? linha[x - 3] : 0;
        const b = acima ? acima[x] : 0;
        const c = acima && x >= 3 ? acima[x - 3] : 0;
        const previsto = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : paeth(a, b, c);
        const v = (linha[x] - previsto) & 0xff;
        destino[x] = v;
        soma += v < 128 ? v : 256 - v;
      }
      if (soma < menorSoma) {
        menorSoma = soma;
        melhor = f;
      }
    }
    saida[y * (passo + 1)] = melhor;
    candidatos[melhor].copy(saida, y * (passo + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(largura, 0);
  ihdr.writeUInt32BE(altura, 4);
  ihdr[8] = 8; // bits por canal
  ihdr[9] = 2; // RGB, sem alfa
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0; // sem entrelaçamento
  return Buffer.concat([
    ASSINATURA,
    pedaco('IHDR', ihdr),
    pedaco('IDAT', deflateSync(saida, { level: 9 })),
    pedaco('IEND', Buffer.alloc(0)),
  ]);
}

/** O que importa para a Apple, lido direto do IHDR (bytes 16 a 28 do arquivo). */
export function conferirPng(dados) {
  if (!dados.subarray(0, 8).equals(ASSINATURA) || dados.toString('ascii', 12, 16) !== 'IHDR') {
    return { valido: false };
  }
  return {
    valido: true,
    largura: dados.readUInt32BE(16),
    altura: dados.readUInt32BE(20),
    profundidade: dados[24],
    tipoDeCor: dados[25],
    entrelacado: dados[28],
  };
}

/** Cor média de um retângulo, em pixels da imagem lida por `lerPng`. */
export function corMedia({ largura, canais, pixels }, x0, y0, x1, y1) {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const i = (y * largura + x) * canais;
      r += pixels[i];
      g += pixels[i + 1];
      b += pixels[i + 2];
      n += 1;
    }
  }
  return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
}

/** Luminância relativa (0 a 1) para decidir se o que vai por cima é claro ou escuro. */
export function luminancia([r, g, b]) {
  const canal = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * canal(r) + 0.7152 * canal(g) + 0.0722 * canal(b);
}
