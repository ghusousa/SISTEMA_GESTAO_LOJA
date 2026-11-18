import assert from 'node:assert/strict';
import test from 'node:test';

import { ABA, medidasDaBarraDeAbas, respiroDeBaixo, respiroDeCima } from './areaSegura';

/**
 * A área segura de cada família de iPhone que o app atende (iOS 15.1+, retrato), em pt:
 * [aparelho, barra de status, indicador de início].
 */
const IPHONES: [string, number, number][] = [
  ['iPhone SE (2ª e 3ª geração), 375 × 667', 20, 0],
  ['iPhone 12/13/14, 390 × 844', 47, 34],
  ['iPhone 13 mini, 375 × 812', 50, 34],
  ['iPhone 14 Pro/15/16, 393 × 852', 59, 34],
  ['iPhone 16 Pro/17, 402 × 874', 62, 34],
  ['iPhone 14 Plus, 428 × 926', 47, 34],
  ['iPhone 15 Plus/16 Plus/Pro Max, 430 × 932', 59, 34],
  ['iPhone 16 Pro Max/17 Pro Max, 440 × 956', 62, 34],
];

/** Altura que o miolo da aba pede: respiro, ícone, linha do rótulo, respiro. */
const MIOLO = ABA.respiroDaAba + ABA.alturaDoIcone + ABA.linhaDoRotulo + ABA.respiroDaAba;

test('no SE (sem área segura) a barra fica com o respiro de sempre', () => {
  const barra = medidasDaBarraDeAbas(0);
  assert.equal(barra.paddingBottom, 8);
  assert.equal(barra.paddingTop, 6);
  assert.equal(barra.height, 6 + MIOLO + 8);
});

test('com indicador de início, a barra cresce pela área segura e o miolo não muda', () => {
  const se = medidasDaBarraDeAbas(0);
  const faceId = medidasDaBarraDeAbas(34);
  assert.equal(faceId.paddingBottom, 34);
  assert.equal(faceId.height, 6 + MIOLO + 34);
  // O que a altura fixa de antes (62, com paddingBottom 8) não fazia: a barra soma a área.
  assert.notEqual(faceId.height, 62);
  assert.equal(
    faceId.height - faceId.paddingTop - faceId.paddingBottom,
    se.height - se.paddingTop - se.paddingBottom,
  );
});

for (const [aparelho, , baixo] of IPHONES) {
  test(`${aparelho}: rótulo inteiro e fora da faixa do indicador`, () => {
    const barra = medidasDaBarraDeAbas(baixo);
    // O miolo cabe ícone + rótulo + respiros: nada é espremido (no web, era o rótulo
    // cortado pela metade com o miolo de 48 pt).
    assert.ok(barra.height - barra.paddingTop - barra.paddingBottom >= MIOLO);
    assert.equal(barra.lineHeight, ABA.linhaDoRotulo);
    // Do pé do rótulo até a borda da tela sobra pelo menos a área segura inteira.
    assert.ok(barra.paddingBottom + ABA.respiroDaAba >= baixo);
    assert.ok(barra.paddingBottom >= 8);
  });
}

test('área segura quebrada (Android) arredonda para cima: nunca invade a área', () => {
  assert.equal(medidasDaBarraDeAbas(23.636).paddingBottom, 24);
  assert.equal(respiroDeBaixo(47.5, 16), 48);
  assert.equal(respiroDeCima(24.2, 8), 33);
});

test('valor inválido conta como sem área segura', () => {
  for (const ruim of [Number.NaN, -5, Number.POSITIVE_INFINITY]) {
    assert.equal(respiroDeBaixo(ruim, 16), 16);
    assert.equal(respiroDeCima(ruim, 12), 12);
    assert.equal(medidasDaBarraDeAbas(ruim).paddingBottom, 8);
  }
});

test('rodapé: o maior entre o respiro e a área — nunca a soma', () => {
  assert.equal(respiroDeBaixo(0, 16), 16); // SE: como sempre foi
  assert.equal(respiroDeBaixo(34, 16), 34); // Face ID: acima do indicador
  assert.equal(respiroDeBaixo(48, 16), 48); // Android com a barra de três botões
});

test('topo sem cabeçalho: a barra de status inteira e mais a folga', () => {
  for (const [aparelho, cima] of IPHONES) {
    assert.equal(respiroDeCima(cima, 12), cima + 12, aparelho);
  }
});
