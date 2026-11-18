#!/usr/bin/env node
/**
 * Gera o guia em PDF para o revisor da Apple (app-review-guide.pdf, nesta pasta) a partir do
 * texto de guia.mjs, com o Playwright (page.pdf), e grava a impressão digital das entradas
 * (app-review-guide.entradas.json). O PDF vai para o git; o publicador o anexa à revisão.
 *
 *   node publicar/revisao/gerar-guia.mjs        (de dentro de mobile/)
 *
 * Rode de novo — e faça commit — quando mudar o texto (guia.mjs), a lista de aparelhos
 * testados (ficha/aparelhos-testados.txt) ou os prints (media/app-store/iphone-6.5): o teste
 * do CI e o `--enviar` do publicador recusam o PDF desatualizado. O capturas/gerar.sh já chama
 * este script no fim.
 *
 * Precisa do Playwright com o Chromium (npm i -g playwright && npx playwright install
 * chromium) e, para a letra sair igual à dos prints, da fonte Inter (fonts-inter).
 */

import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { relative } from 'node:path';
import { aparelhosDoGuia, IMPRESSAO, impressaoAtual, montarHtml, PDF, printsDoGuia } from './guia.mjs';

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  process.stderr.write('✖ Falta o Playwright para o Node (npm i -g playwright && npx playwright install chromium).\n');
  process.exit(1);
}

const LARGURA_DO_PRINT = 640; // px: o PDF fica leve e o print continua legível

const aparelhos = aparelhosDoGuia();
const prints = printsDoGuia().map((p) => ({ ...p, src: `data:image/png;base64,${readFileSync(p.caminho).toString('base64')}` }));
const html = montarHtml({ aparelhos, prints });

const navegador = await chromium.launch();
try {
  const pagina = await navegador.newPage();
  await pagina.setContent(html, { waitUntil: 'load' });
  // Os prints entram como JPEG reduzido: 10 PNGs de 1242×2688 deixariam o PDF com ~7 MB.
  await pagina.evaluate(async (largura) => {
    for (const img of document.querySelectorAll('figure img')) {
      await img.decode();
      const altura = Math.round((img.naturalHeight * largura) / img.naturalWidth);
      const tela = document.createElement('canvas');
      tela.width = largura;
      tela.height = altura;
      tela.getContext('2d').drawImage(img, 0, 0, largura, altura);
      img.src = tela.toDataURL('image/jpeg', 0.82);
      await img.decode();
    }
    await document.fonts.ready;
  }, LARGURA_DO_PRINT);
  await pagina.pdf({
    path: PDF,
    format: 'A4',
    printBackground: true,
    margin: { top: '15mm', bottom: '17mm', left: '16mm', right: '16mm' },
    displayHeaderFooter: true,
    headerTemplate: '<span></span>',
    footerTemplate:
      '<div style="width:100%;padding:0 16mm;font:7.5pt Inter,Arial,sans-serif;color:#7a8794;display:flex;' +
      'justify-content:space-between"><span>Gestão de Loja — guide for App Review</span>' +
      '<span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>',
  });
} finally {
  await navegador.close();
}

writeFileSync(
  IMPRESSAO,
  `${JSON.stringify({ gerado_por: 'mobile/publicar/revisao/gerar-guia.mjs', entradas: impressaoAtual() }, null, 2)}\n`,
);
const kb = Math.round(statSync(PDF).size / 1024);
process.stdout.write(
  `✔ ${relative(process.cwd(), PDF)}: ${kb} KB, ${prints.length} prints, ` +
    `${aparelhos.length ? `${aparelhos.length} aparelho(s) testado(s)` : 'sem a lista de aparelhos (o guia remete às notas)'}.\n` +
    '  Confira o PDF com os olhos e faça commit dele junto com app-review-guide.entradas.json.\n',
);
