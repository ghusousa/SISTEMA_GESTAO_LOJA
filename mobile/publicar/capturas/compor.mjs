#!/usr/bin/env node
/**
 * Monta a arte de cada captura: fundo da marca, título, subtítulo e a foto do app dentro de
 * um celular — renderizada pelo próprio Chrome (Playwright) no tamanho EXATO que a Apple pede.
 *
 *   node compor.mjs              # .brutas/ → media/app-store/iphone-6.5 e iphone-6.9
 *   node compor.mjs --conferir   # só confere as duas pastas (tamanho, RGB sem alfa, nomes)
 *
 * 6,5" (1242 × 2688) é o conjunto obrigatório; 6,9" (1320 × 2868) é o extra. A composição é
 * a mesma nos dois: tudo é medido numa régua de 1242 de largura e escalado.
 *
 * A barra de status (9:41, sinal, Wi-Fi, bateria) e o indicador de início são desenhados
 * aqui, por cima da foto, nas áreas seguras que o app já deixou livres (o `gerar.mjs` as
 * declara ao navegador): o export web não desenha nenhum dos dois. A cor de cada um vem da
 * própria foto — clara sobre o cabeçalho azul, escura sobre o fundo claro do PDV.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { CENAS } from './cenas.mjs';
import { conferirPng, corMedia, escreverPngRgb, lerPng, luminancia, paraRgb } from './png.mjs';

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = resolve(AQUI, '..', '..', '..');

/** O celular, em pontos (pt) do iPhone: tela de 428 × 926, como o de 6,7"/6,5" grande. */
export const APARELHO = {
  largura: 428,
  altura: 926,
  /** Área segura de cima: a barra de status. O app desenha o cabeçalho por baixo dela. */
  status: 47,
  /** Área segura de baixo: o indicador de início, por cima do que o app desenhar ali. */
  indicador: 34,
  /** A foto do app sai a 3x (1284 × 2778 px). */
  escala: 3,
  raioDaTela: 54,
  /** Moldura preta em volta da tela e o aro de metal por fora dela. */
  moldura: 13,
  aro: 3,
};

/** As duas pastas da Apple: 6,5" é o conjunto obrigatório, 6,9" o extra (mesmos nomes). */
export const TAMANHOS = [
  { pasta: 'iphone-6.5', largura: 1242, altura: 2688 },
  { pasta: 'iphone-6.9', largura: 1320, altura: 2868 },
];

/** A régua da arte, em unidades de uma tela de 1242 de largura. */
const REGUA = {
  base: 1242,
  margem: 80,
  tituloTopo: 150,
  tituloFonte: 100,
  tituloEntrelinha: 1.06,
  subtituloEspaco: 30,
  subtituloFonte: 46,
  subtituloEntrelinha: 1.3,
  aparelhoEspaco: 84,
  /** Quantas unidades da régua cabem em 1 pt do aparelho. */
  porPonto: 2.1,
};

const MARCA = { azul: '#1E3A5F', claro: '#2C5383', escuro: '#162D4B' };

const BRUTAS = process.env.CAPTURAS_BRUTAS || join(AQUI, '.brutas');
const DESTINO = process.env.CAPTURAS_DESTINO || join(RAIZ, 'media', 'app-store');
/** Com CAPTURAS_SO (ex.: 01-vender,07-caixa), refaz só essas artes e deixa as outras. */
const SO = (process.env.CAPTURAS_SO || '').split(',').filter(Boolean);

function arco(cx, cy, r, inicio, fim) {
  const ponto = (graus) => [cx + r * Math.cos((graus * Math.PI) / 180), cy + r * Math.sin((graus * Math.PI) / 180)];
  const [x0, y0] = ponto(inicio);
  const [x1, y1] = ponto(fim);
  return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${r} ${r} 0 0 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

/** Sinal, Wi-Fi e bateria, desenhados em pt (o SVG escala com a tela). */
function iconesDeStatus(pt) {
  const sinal = [4, 6.2, 8.4, 10.8]
    .map((h, i) => `<rect x="${i * 4.6}" y="${(10.8 - h).toFixed(1)}" width="3.2" height="${h}" rx="1"/>`)
    .join('');
  const wifi = [arco(8, 10.6, 9.4, -135, -45), arco(8, 10.6, 5.9, -135, -45)]
    .map((d) => `<path d="${d}" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"/>`)
    .join('');
  return `
    <svg style="width:${pt(17.2)};height:${pt(10.8)}" viewBox="0 0 17.2 10.8" fill="currentColor">${sinal}</svg>
    <svg style="width:${pt(16)};height:${pt(11.4)}" viewBox="0 0 16 11.4">${wifi}<circle cx="8" cy="9.7" r="1.7" fill="currentColor"/></svg>
    <svg style="width:${pt(27.4)};height:${pt(13)}" viewBox="0 0 27.4 13">
      <rect x="0.5" y="0.5" width="24" height="12" rx="3.8" fill="none" stroke="currentColor" stroke-opacity="0.4"/>
      <rect x="2.5" y="2.5" width="20" height="8" rx="2" fill="currentColor"/>
      <path d="M26 4.6v3.8c.8-.3 1.4-1.1 1.4-1.9s-.6-1.6-1.4-1.9z" fill="currentColor" fill-opacity="0.45"/>
    </svg>`;
}

/** A cor do que vai por cima da foto: barra de status e indicador de início. */
function coresDaFoto(arquivo) {
  const foto = lerPng(readFileSync(arquivo));
  const esperado = [APARELHO.largura * APARELHO.escala, APARELHO.altura * APARELHO.escala];
  if (foto.largura !== esperado[0] || foto.altura !== esperado[1]) {
    throw new Error(`${arquivo} tem ${foto.largura}x${foto.altura}; esperado ${esperado.join('x')}`);
  }
  // O que importa é o fundo logo atrás de cada desenho: a hora, os ícones e o indicador.
  const e = APARELHO.escala;
  const L = APARELHO.largura;
  const area = (x0, y0, x1, y1) => corMedia(foto, x0 * e, y0 * e, x1 * e, y1 * e);
  const tinta = (...cores) => (cores.every((c) => luminancia(c) > 0.45) ? '#000000' : '#FFFFFF');
  return {
    status: tinta(area(28, 15, 108, 43), area(L - 100, 15, L - 30, 43)),
    indicador: tinta(area(L / 2 - 70, APARELHO.altura - 15, L / 2 + 70, APARELHO.altura - 6)),
  };
}

function paginaDaArte(cena, foto, tamanho, cores) {
  const u = tamanho.largura / REGUA.base;
  const px = (v) => `${(v * u).toFixed(2)}px`;
  const pt = (v) => px(v * REGUA.porPonto);
  const { largura: L, altura: A, status, raioDaTela, moldura, aro } = APARELHO;
  const fora = moldura + aro;

  const subtituloTopo = REGUA.tituloTopo + 2 * REGUA.tituloFonte * REGUA.tituloEntrelinha + REGUA.subtituloEspaco;
  const aparelhoTopo = subtituloTopo + REGUA.subtituloFonte * REGUA.subtituloEntrelinha + REGUA.aparelhoEspaco;
  const escapar = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;');

  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><style>
  html, body { margin: 0; width: ${tamanho.largura}px; height: ${tamanho.altura}px; overflow: hidden; }
  body {
    position: relative;
    background:
      radial-gradient(70% 38% at 50% 64%, rgba(86, 146, 214, 0.20), rgba(86, 146, 214, 0) 72%),
      radial-gradient(140% 80% at 50% 0%, ${MARCA.claro} 0%, ${MARCA.azul} 56%, ${MARCA.escuro} 100%);
    -webkit-font-smoothing: antialiased;
    text-rendering: geometricPrecision;
  }
  .texto { position: absolute; left: ${px(REGUA.margem)}; right: ${px(REGUA.margem)}; text-align: center; color: #fff; margin: 0; }
  .titulo {
    top: ${px(REGUA.tituloTopo)};
    font: 800 ${px(REGUA.tituloFonte)}/${REGUA.tituloEntrelinha} 'Inter Display', 'Inter', sans-serif;
    letter-spacing: -0.018em; white-space: pre;
  }
  .subtitulo {
    top: ${px(subtituloTopo)};
    font: 500 ${px(REGUA.subtituloFonte)}/${REGUA.subtituloEntrelinha} 'Inter', sans-serif;
    letter-spacing: -0.006em; color: rgba(226, 235, 246, 0.86); white-space: nowrap;
  }
  .aparelho {
    position: absolute; top: ${px(aparelhoTopo)}; left: 50%; transform: translateX(-50%);
    width: ${pt(L + 2 * fora)}; height: ${pt(A + 2 * fora)}; box-sizing: border-box;
    padding: ${pt(aro)}; border-radius: ${pt(raioDaTela + fora)};
    background: linear-gradient(150deg, #6B7585 0%, #2A313C 26%, #171B22 52%, #2B323D 78%, #5E6878 100%);
    box-shadow: 0 ${px(46)} ${px(110)} rgba(3, 10, 22, 0.55), 0 ${px(14)} ${px(34)} rgba(3, 10, 22, 0.35);
  }
  .moldura {
    width: 100%; height: 100%; box-sizing: border-box; padding: ${pt(moldura)};
    border-radius: ${pt(raioDaTela + moldura)}; background: #05070A;
  }
  .tela {
    position: relative; width: ${pt(L)}; height: ${pt(A)}; overflow: hidden;
    border-radius: ${pt(raioDaTela)}; background: #fff;
  }
  .tela img { position: absolute; top: 0; left: 0; width: ${pt(L)}; height: ${pt(A)}; }
  .indicador {
    position: absolute; left: 50%; bottom: ${pt(8)}; transform: translateX(-50%);
    width: ${pt(134)}; height: ${pt(5)}; border-radius: ${pt(2.5)}; background: ${cores.indicador};
  }
  .ilha {
    position: absolute; top: ${pt(11)}; left: 50%; transform: translateX(-50%);
    width: ${pt(122)}; height: ${pt(35)}; border-radius: ${pt(17.5)}; background: #000;
  }
  .status { position: absolute; top: 0; left: 0; width: 100%; height: ${pt(status)}; color: ${cores.status}; }
  .hora {
    position: absolute; left: ${pt(28)}; width: ${pt(80)}; top: ${pt(15)}; height: ${pt(28)};
    font: 600 ${pt(17)}/${pt(28)} 'Inter', sans-serif; letter-spacing: -0.01em; text-align: center;
  }
  .icones {
    position: absolute; right: ${pt(30)}; top: ${pt(15)}; height: ${pt(28)};
    display: flex; align-items: center; gap: ${pt(5.4)};
  }
</style></head><body>
  <h1 class="texto titulo">${escapar(cena.titulo)}</h1>
  <p class="texto subtitulo">${escapar(cena.subtitulo)}</p>
  <div class="aparelho"><div class="moldura"><div class="tela">
    <img src="${foto}" alt="">
    <div class="indicador"></div>
    <div class="status"><div class="hora">9:41</div><div class="icones">${iconesDeStatus(pt)}</div></div>
    <div class="ilha"></div>
  </div></div></div>
</body></html>`;
}

/** O texto coube como foi escrito? Título em exatamente 2 linhas, subtítulo em 1, sem vazar. */
async function conferirTextos(page) {
  return page.evaluate(() => {
    const problemas = [];
    const linhas = (el) => {
      const faixa = document.createRange();
      faixa.selectNodeContents(el);
      return new Set([...faixa.getClientRects()].map((r) => Math.round(r.top))).size;
    };
    const titulo = document.querySelector('.titulo');
    const subtitulo = document.querySelector('.subtitulo');
    if (titulo.scrollWidth > titulo.clientWidth) problemas.push('o título passa da margem');
    if (linhas(titulo) !== 2) problemas.push(`o título tem ${linhas(titulo)} linha(s), e não 2`);
    if (subtitulo.scrollWidth > subtitulo.clientWidth) problemas.push('o subtítulo passa da margem');
    if (linhas(subtitulo) !== 1) problemas.push('o subtítulo não cabe numa linha');
    // Fonte que falta não dá erro no navegador: ele troca por outra em silêncio. Medida
    // igual à da monoespaçada de reserva = a fonte não existe nesta máquina.
    const largura = (fonte) => {
      const ctx = document.createElement('canvas').getContext('2d');
      ctx.font = fonte;
      return ctx.measureText('Gestão de Loja 0123').width;
    };
    for (const [peso, familia] of [['800', "'Inter Display'"], ['500', 'Inter']]) {
      if (largura(`${peso} 100px ${familia}, monospace`) === largura(`${peso} 100px monospace`)) {
        problemas.push(`a fonte ${familia} não está instalada (fc-list | grep Inter)`);
      }
    }
    return problemas;
  });
}

export async function compor({
  cenas = SO.length ? CENAS.filter((c) => SO.includes(c.arquivo)) : CENAS,
  brutas = BRUTAS,
  destino = DESTINO,
} = {}) {
  const parcial = cenas.length < CENAS.length;
  const require = createRequire(import.meta.url);
  const { chromium } = require('playwright');

  for (const cena of cenas) {
    if (!existsSync(join(brutas, `${cena.arquivo}.png`))) {
      throw new Error(`falta a foto do app de ${cena.arquivo} em ${brutas} — rode o gerar.sh`);
    }
  }
  const navegador = await chromium.launch();
  try {
    for (const tamanho of TAMANHOS) {
      const pasta = join(destino, tamanho.pasta);
      mkdirSync(pasta, { recursive: true });
      // Rodada inteira recomeça a pasta: captura que saiu do roteiro não pode ir para a
      // Apple por engano. Na parcial, só as escolhidas são trocadas.
      if (!parcial) {
        for (const velho of readdirSync(pasta).filter((a) => a.endsWith('.png'))) rmSync(join(pasta, velho));
      }

      const pagina = await navegador.newPage({
        viewport: { width: tamanho.largura, height: tamanho.altura },
        deviceScaleFactor: 1,
      });
      for (const cena of cenas) {
        const foto = join(brutas, `${cena.arquivo}.png`);
        const html = join(brutas, `arte-${tamanho.pasta}-${cena.arquivo}.html`);
        writeFileSync(html, paginaDaArte(cena, pathToFileURL(foto).href, tamanho, coresDaFoto(foto)));
        await pagina.goto(pathToFileURL(html).href);
        await pagina.evaluate(async () => {
          await document.fonts.ready;
          await document.querySelector('img').decode();
        });
        const problemas = await conferirTextos(pagina);
        if (problemas.length) throw new Error(`${cena.arquivo} (${tamanho.pasta}): ${problemas.join('; ')}`);
        const png = await pagina.screenshot({ type: 'png' });
        writeFileSync(join(pasta, `${cena.arquivo}.png`), escreverPngRgb(paraRgb(lerPng(png))));
        process.stdout.write(`  ${tamanho.pasta}/${cena.arquivo}.png\n`);
      }
      await pagina.close();
    }
  } finally {
    await navegador.close();
  }
}

/** A régua da Apple, conferida nos bytes: devolve a lista do que estiver fora. */
export function conferir({ cenas = CENAS, destino = DESTINO } = {}) {
  const erros = [];
  const esperados = cenas.map((c) => `${c.arquivo}.png`).sort();
  for (const tamanho of TAMANHOS) {
    const pasta = join(destino, tamanho.pasta);
    const achados = existsSync(pasta) ? readdirSync(pasta).filter((a) => a.endsWith('.png')).sort() : [];
    if (achados.join() !== esperados.join()) {
      erros.push(`${tamanho.pasta}: esperava ${esperados.length} capturas (${esperados.join(', ')}), achei ${achados.length}`);
    }
    for (const nome of achados) {
      const info = conferirPng(readFileSync(join(pasta, nome)));
      const onde = `${tamanho.pasta}/${nome}`;
      if (!info.valido) erros.push(`${onde}: não é PNG`);
      else {
        if (info.largura !== tamanho.largura || info.altura !== tamanho.altura) {
          erros.push(`${onde}: ${info.largura}x${info.altura}, e não ${tamanho.largura}x${tamanho.altura}`);
        }
        if (info.tipoDeCor !== 2) erros.push(`${onde}: tipo de cor ${info.tipoDeCor} (precisa ser 2, RGB sem alfa)`);
        if (info.profundidade !== 8 || info.entrelacado !== 0) erros.push(`${onde}: precisa ser 8 bits, sem entrelaçamento`);
      }
    }
  }
  return erros;
}

const direto = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (direto) {
  try {
    if (!process.argv.includes('--conferir')) {
      process.stdout.write('Montando a arte (1242 × 2688 e 1320 × 2868):\n');
      await compor();
    }
    const erros = conferir();
    if (erros.length) {
      process.stderr.write(`\n✗ Capturas fora da régua da Apple:\n  - ${erros.join('\n  - ')}\n`);
      process.exit(1);
    }
    process.stdout.write(
      `\n✓ ${TAMANHOS.map((t) => `${t.pasta}: ${CENAS.length} × ${t.largura}x${t.altura}`).join(' · ')} — RGB sem alfa\n`,
    );
  } catch (erro) {
    process.stderr.write(`\n✗ ${erro.message}\n`);
    process.exit(1);
  }
}
