/**
 * O ícone do app (2.3.8 da Apple: nada de ícone de exemplo): uma etiqueta de loja com código de
 * barras, pendurada pelo cordão âmbar, sobre o azul do app (`cores.primaria` de `src/lib/tema.ts`).
 * Esta é a FONTE: os PNGs de `mobile/assets/` saem daqui. Mudou o desenho? Rode de novo:
 *
 *   node assets/icone/desenhar.mjs        (dentro de mobile/; precisa do Playwright com o Chromium)
 *
 * Saem o `icon.png` (iPhone e a ficha da App Store: quadrado cheio, que o iOS arredonda, e em RGB
 * puro — a Apple recusa ícone com canal alfa), o Android adaptativo (frente na zona segura, fundo
 * e o monocromático do Android 13+), a etiqueta da tela de abertura (sobre o #1E3A5F do
 * `expo-splash-screen`) e o `favicon.png` do export web. O guarda é `publicar/teste/icone.test.mjs`.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { escreverPngRgb, lerPng, paraRgb } from '../../publicar/capturas/png.mjs';

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  process.stderr.write('✖ Falta o Playwright para o Node (npm i -g playwright && npx playwright install chromium).\n');
  process.exit(1);
}
const ASSETS = join(dirname(fileURLToPath(import.meta.url)), '..');

const NAVY = '#1E3A5F';
const NAVY_CLARO = '#2C5282';
const AMBAR = '#E8A317';

// Geometria da etiqueta deitada, ponta à esquerda; o centro visual fica em (530, 512).
const CONTORNO = `M 238 512 L 352 386 Q 362 376 376 376 L 792 376 Q 822 376 822 406
  L 822 618 Q 822 648 792 648 L 376 648 Q 362 648 352 638 Z`;
const FURO = { cx: 318, cy: 512, r: 30 };
const LARGURAS = [18, 9, 28, 11, 18, 32, 11, 20, 9, 26];
const VAOS = [13, 13, 11, 15, 13, 11, 15, 11, 13];

function barras(cor) {
  let x = 430;
  return LARGURAS.map((l, i) => {
    const r = `<rect x="${x}" y="436" width="${l}" height="152" rx="3" fill="${cor}"/>`;
    x += l + (VAOS[i] ?? 0);
    return r;
  }).join('');
}

/**
 * A etiqueta girada (a ponta para cima, como pendurada) e o cordão saindo do furo para cima.
 * `escala` encolhe em torno do centro do quadro; `deslocar` acerta o centro visual.
 */
function etiqueta({ id, corpo = '#FFFFFF', corBarras = NAVY, cordao = AMBAR, sombra = true, escala = 1, recortar = false }) {
  const giro = 'rotate(62 530 512)';
  const mascara = `<mask id="m-${id}"><rect width="1024" height="1024" fill="white"/>
      <g transform="${giro}"><circle cx="${FURO.cx}" cy="${FURO.cy}" r="${FURO.r}" fill="black"/>${recortar ? barras('black') : ''}</g></mask>`;
  const sombraSvg = sombra
    ? `<g transform="translate(8 20)" opacity="0.30" filter="url(#borrao-${id})"><path d="${CONTORNO}" fill="#08162A" transform="${giro}"/></g>`
    : '';
  // O cordão sai do furo (já girado) e sobe numa curva até perto da borda de cima.
  const furoGirado = girar(FURO.cx, FURO.cy, 62, 530, 512);
  const cordaoSvg = cordao
    ? `<path d="M ${furoGirado.x} ${furoGirado.y} C ${furoGirado.x - 30} ${furoGirado.y - 80}, ${furoGirado.x + 60} ${furoGirado.y - 130}, ${furoGirado.x + 10} ${furoGirado.y - 215}"
         stroke="${cordao}" stroke-width="24" stroke-linecap="round" fill="none"/>`
    : '';
  return `
    <defs>${mascara}
      <filter id="borrao-${id}" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="16"/></filter>
    </defs>
    <g transform="translate(512 512) scale(${escala}) translate(-554 -470)">
      ${sombraSvg}
      <g mask="url(#m-${id})">
        <path d="${CONTORNO}" fill="${corpo}" transform="${giro}"/>
        ${recortar ? '' : `<g transform="${giro}">${barras(corBarras)}</g>`}
      </g>
      ${cordaoSvg}
    </g>`;
}

function girar(x, y, graus, cx, cy) {
  const a = (graus * Math.PI) / 180;
  const dx = x - cx;
  const dy = y - cy;
  return { x: +(cx + dx * Math.cos(a) - dy * Math.sin(a)).toFixed(1), y: +(cy + dx * Math.sin(a) + dy * Math.cos(a)).toFixed(1) };
}

const fundo = `
  <defs><linearGradient id="fundo" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="${NAVY_CLARO}"/><stop offset="1" stop-color="${NAVY}"/>
  </linearGradient></defs>
  <rect width="1024" height="1024" fill="url(#fundo)"/>`;

const svg = (c) => `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">${c}</svg>`;

const pecas = {
  'icon.svg': svg(fundo + etiqueta({ id: 'ios', escala: 1.0 })),
  'android-icon-foreground.svg': svg(etiqueta({ id: 'fg', escala: 0.66 })),
  'android-icon-background.svg': svg(fundo),
  'android-icon-monochrome.svg': svg(etiqueta({ id: 'mono', corpo: '#FFFFFF', cordao: '#FFFFFF', sombra: false, escala: 0.66, recortar: true })),
  'splash-icon.svg': svg(etiqueta({ id: 'splash', escala: 0.9 })),
};

const navegador = await chromium.launch();
const pagina = await navegador.newPage({ viewport: { width: 1024, height: 1024 }, deviceScaleFactor: 1 });

async function rasterizar(conteudo, lado, destino, { rgb = false } = {}) {
  const ajustado = conteudo.replace('width="1024" height="1024"', `width="${lado}" height="${lado}"`);
  await pagina.setViewportSize({ width: lado, height: lado });
  await pagina.setContent(`<html><body style="margin:0;background:transparent">${ajustado}</body></html>`);
  await pagina.screenshot({ path: destino, omitBackground: !rgb, clip: { x: 0, y: 0, width: lado, height: lado } });
  // O Chrome grava RGBA mesmo com a página opaca: o ícone do iPhone e os fundos saem em RGB puro.
  if (rgb) writeFileSync(destino, escreverPngRgb(paraRgb(lerPng(readFileSync(destino)))));
}

await rasterizar(pecas['icon.svg'], 1024, join(ASSETS, 'icon.png'), { rgb: true });
await rasterizar(pecas['icon.svg'], 48, join(ASSETS, 'favicon.png'), { rgb: true });
await rasterizar(pecas['android-icon-background.svg'], 1024, join(ASSETS, 'android-icon-background.png'), { rgb: true });
await rasterizar(pecas['android-icon-foreground.svg'], 1024, join(ASSETS, 'android-icon-foreground.png'));
await rasterizar(pecas['android-icon-monochrome.svg'], 1024, join(ASSETS, 'android-icon-monochrome.png'));
await rasterizar(pecas['splash-icon.svg'], 1024, join(ASSETS, 'splash-icon.png'));
await navegador.close();
console.log('✔ ícones gravados em mobile/assets/');
