/**
 * QR code desenhado como SVG pelo DOM (o convite do celular-leitor, ADR-43).
 *
 * Quem calcula os módulos é o `qrcode-generator` vendorizado (`vendor/qrcode.js`). Daqui
 * sai um `<svg>` montado com `createElementNS`: nada de `data:` URI, nada de `innerHTML`
 * — o texto do convite nunca vira marcação, e a CSP (`script-src 'self'`) não reclama.
 */

import qrcode from './vendor/qrcode.js';

const SVG = 'http://www.w3.org/2000/svg';

/**
 * Os módulos escuros do QR como um único `path` (um quadrado de 1×1 por módulo), com a
 * margem branca de `margem` módulos em volta — sem ela a câmera não acha o QR num fundo
 * escuro. Correção de erro M: aguenta uma tela com reflexo sem engordar demais o QR.
 * @returns {{ lado: number, d: string }}
 */
export function caminhoDoQr(texto, margem = 4) {
  const qr = qrcode(0, 'M');
  qr.addData(texto);
  qr.make();
  const n = qr.getModuleCount();
  const partes = [];
  for (let linha = 0; linha < n; linha += 1) {
    for (let coluna = 0; coluna < n; coluna += 1) {
      if (qr.isDark(linha, coluna)) partes.push(`M${coluna + margem} ${linha + margem}h1v1h-1z`);
    }
  }
  return { lado: n + margem * 2, d: partes.join('') };
}

/** O `<svg>` pronto para pendurar na tela. O tamanho vem do CSS (escala sem borrar). */
export function desenharQr(texto, { rotulo = 'QR code', margem = 4 } = {}) {
  const { lado, d } = caminhoDoQr(texto, margem);
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', `0 0 ${lado} ${lado}`);
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', rotulo);

  const fundo = document.createElementNS(SVG, 'rect');
  fundo.setAttribute('width', String(lado));
  fundo.setAttribute('height', String(lado));
  fundo.setAttribute('fill', '#fff');

  const modulos = document.createElementNS(SVG, 'path');
  modulos.setAttribute('d', d);
  modulos.setAttribute('fill', '#000');

  svg.append(fundo, modulos);
  return svg;
}
