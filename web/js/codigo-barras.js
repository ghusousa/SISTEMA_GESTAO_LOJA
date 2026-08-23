/**
 * Desenha o código de barras EAN-13 em SVG, para a tela e para a etiqueta impressa.
 *
 * SVG e não imagem: a etiqueta sai na resolução da impressora, e barra de código de barras
 * lida por leitor óptico não perdoa borda borrada. Uma imagem de 300 px esticada para 5 cm
 * vira uma escada de pixels que o leitor recusa.
 *
 * O que faz um EAN-13 ser lido (e o que o quebra):
 *
 * - **Dígito verificador certo.** Leitor confere a conta e recusa o código inteiro se ela
 *   não fechar. Código de barras com verificador errado imprime bonito e não lê nunca.
 * - **Zona de silêncio.** 11 módulos em branco antes e 7 depois. É o erro mais comum, e o
 *   sintoma engana: o código parece perfeito e o leitor não acha o começo dele.
 * - **Módulo largo o bastante.** O padrão aceita 0,33 mm; usamos 0,33 como mínimo e 0,40
 *   como padrão, porque impressora jato de tinta borra e câmera de celular antigo perde
 *   resolução.
 */

// Tabelas do padrão. Cada dígito vira 7 módulos; qual tabela usar depende da posição e do
// primeiro dígito, que não é desenhado — ele fica codificado na PARIDADE da metade
// esquerda. É por isso que treze dígitos cabem em 95 módulos, e não em 91.
const CODIGOS_L = [
  '0001101', '0011001', '0010011', '0111101', '0100011',
  '0110001', '0101111', '0111011', '0110111', '0001011',
];
const CODIGOS_G = [
  '0100111', '0110011', '0011011', '0100001', '0011101',
  '0111001', '0000101', '0010001', '0001001', '0010111',
];
const CODIGOS_R = [
  '1110010', '1100110', '1101100', '1000010', '1011100',
  '1001110', '1010000', '1000100', '1001000', '1110100',
];
const PARIDADE = [
  'LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG',
  'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL',
];

const SILENCIO_ESQUERDA = 11;
const SILENCIO_DIREITA = 7;
const MODULOS = 95;
/** Guardas de início, centro e fim descem além das outras barras, como manda o padrão. */
const GUARDAS = new Set([
  0, 1, 2,
  45, 46, 47, 48, 49,
  92, 93, 94,
]);

/** Mesma conta de `api/app/modules/catalogo/barcode.py`: pesos 1 e 3, complemento de 10. */
export function digitoVerificador(payload) {
  const soma = [...payload].reduce((t, d, i) => t + Number(d) * (i % 2 === 0 ? 1 : 3), 0);
  return String((10 - (soma % 10)) % 10);
}

export function ean13Valido(codigo) {
  return (
    typeof codigo === 'string' &&
    /^\d{13}$/.test(codigo) &&
    digitoVerificador(codigo.slice(0, 12)) === codigo[12]
  );
}

/** Os 95 módulos ('1' = barra), sem as zonas de silêncio. */
function modulos(codigo) {
  const paridade = PARIDADE[Number(codigo[0])];
  let esquerda = '';
  for (let i = 0; i < 6; i += 1) {
    const digito = Number(codigo[i + 1]);
    esquerda += paridade[i] === 'L' ? CODIGOS_L[digito] : CODIGOS_G[digito];
  }
  let direita = '';
  for (let i = 7; i < 13; i += 1) direita += CODIGOS_R[Number(codigo[i])];
  return `101${esquerda}01010${direita}101`;
}

/**
 * SVG do código, em milímetros — a unidade da etiqueta física.
 *
 * @param {string} codigo EAN-13 completo, com verificador.
 * @param {{modulo?: number, altura?: number, texto?: boolean}} opcoes
 *   `modulo` é a largura da barra fina em mm (mínimo do padrão: 0,33).
 */
export function svgEan13(codigo, { modulo = 0.4, altura = 18, texto = true } = {}) {
  if (!ean13Valido(codigo)) return null;

  const sobra = 5 * modulo; // o quanto as guardas descem
  const alturaTexto = texto ? 3.2 : 0;
  const largura = (SILENCIO_ESQUERDA + MODULOS + SILENCIO_DIREITA) * modulo;
  const alturaTotal = altura + sobra + alturaTexto;
  const inicio = SILENCIO_ESQUERDA * modulo;

  const barras = [];
  const desenho = modulos(codigo);
  let i = 0;
  while (i < desenho.length) {
    if (desenho[i] === '0') {
      i += 1;
      continue;
    }
    let largo = 1;
    while (i + largo < desenho.length && desenho[i + largo] === '1') largo += 1;
    const desce = GUARDAS.has(i) ? sobra : 0;
    barras.push(
      `<rect x="${(inicio + i * modulo).toFixed(3)}" y="0" ` +
        `width="${(largo * modulo).toFixed(3)}" height="${(altura + desce).toFixed(3)}"/>`,
    );
    i += largo;
  }

  const yTexto = (altura + sobra + 2.6).toFixed(2);
  const tamanhoTexto = (modulo * 6.5).toFixed(2);
  const legenda = texto
    ? `<g font-family="monospace" font-size="${tamanhoTexto}" fill="#000">` +
      `<text x="${(modulo * 1.5).toFixed(2)}" y="${yTexto}">${codigo[0]}</text>` +
      `<text x="${(inicio + 24 * modulo).toFixed(2)}" y="${yTexto}" text-anchor="middle" ` +
      `letter-spacing="${(modulo * 0.6).toFixed(2)}">${codigo.slice(1, 7)}</text>` +
      `<text x="${(inicio + 71 * modulo).toFixed(2)}" y="${yTexto}" text-anchor="middle" ` +
      `letter-spacing="${(modulo * 0.6).toFixed(2)}">${codigo.slice(7)}</text>` +
      '</g>'
    : '';

  // O retângulo branco do fundo É a zona de silêncio: sem ele, a etiqueta colada sobre
  // tecido escuro ou papel colorido deixa de ser lida.
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${largura}mm" height="${alturaTotal}mm" ` +
    `viewBox="0 0 ${largura.toFixed(3)} ${alturaTotal.toFixed(3)}" role="img" ` +
    `aria-label="Código de barras ${codigo}">` +
    `<rect x="0" y="0" width="${largura.toFixed(3)}" height="${alturaTotal.toFixed(3)}" fill="#fff"/>` +
    `<g fill="#000">${barras.join('')}</g>${legenda}</svg>`
  );
}
