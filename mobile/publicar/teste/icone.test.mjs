/**
 * O ícone do app (diretriz 2.3.8 da Apple): a revisão do build 7 recusou o app porque o ícone era
 * o de exemplo da Expo (o "A" azul sobre a grade de construção), e a tela de abertura também.
 * Este teste reprova se algum deles voltar, e confere o que a App Store exige do ícone: 1024 x 1024,
 * quadrado cheio e SEM canal alfa. A fonte do desenho é `assets/icone/desenhar.mjs`.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { lerPng } from '../capturas/png.mjs';

const MOBILE = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ASSETS = join(MOBILE, 'assets');
const app = JSON.parse(readFileSync(join(MOBILE, 'app.json'), 'utf8')).expo;

/** SHA-256 dos arquivos de exemplo do modelo da Expo que já foram para a Apple no build 7. */
const EXEMPLOS_DA_EXPO = new Set([
  '119462bb78eb240a65c869fc067ee599639b3cb5a41953f25c07b17d2a8c7e0f', // icon.png
  '5f4c0a732b6325bf4071d9124d2ae67e037cb24fcc9c482ef82bea742109a3b8', // splash-icon.png
  '9e3d0315a33c6799de601dd34cd8bf8cc3a8d16f3bf75592baec2ceb7240b391', // android-icon-foreground.png
]);

const sha = (arquivo) => createHash('sha256').update(readFileSync(arquivo)).digest('hex');

function caminhoDoApp(relativo) {
  return join(MOBILE, relativo.replace(/^\.\//, ''));
}

test('o ícone, a abertura e o Android não são os de exemplo da Expo', () => {
  const splash = (app.plugins ?? []).find((p) => Array.isArray(p) && p[0] === 'expo-splash-screen')?.[1]?.image;
  const usados = {
    icon: app.icon,
    splash,
    'android (frente)': app.android?.adaptiveIcon?.foregroundImage,
  };
  for (const [nome, relativo] of Object.entries(usados)) {
    assert.ok(relativo, `o app.json não diz qual é o ${nome}`);
    assert.ok(
      !EXEMPLOS_DA_EXPO.has(sha(caminhoDoApp(relativo))),
      `${relativo} é o de exemplo da Expo: a Apple recusa (2.3.8). Rode node assets/icone/desenhar.mjs`,
    );
  }
});

test('o ícone do iPhone tem 1024 x 1024 e nenhum canal alfa (a App Store recusa ícone transparente)', () => {
  const png = lerPng(readFileSync(caminhoDoApp(app.icon)));
  assert.equal(png.largura, 1024);
  assert.equal(png.altura, 1024);
  assert.equal(png.canais, 3, `o ${app.icon} tem canal alfa (${png.canais} canais): grave em RGB`);
});

test('a fonte do ícone mora no repositório, ao lado dos PNGs', () => {
  const fonte = readFileSync(join(ASSETS, 'icone', 'desenhar.mjs'), 'utf8');
  assert.match(fonte, /icon\.png/);
  assert.match(fonte, /splash-icon\.png/);
});
