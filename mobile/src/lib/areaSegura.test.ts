import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import {
  ABA,
  areaAbaixoDasFaixas,
  deslocamentoDoTeclado,
  medidasDaBarraDeAbas,
  respiroDeBaixo,
  respiroDeCima,
} from './areaSegura';

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

test('com faixa no topo, a navegação de baixo não soma a barra de status de novo', () => {
  for (const [aparelho, cima, baixo] of IPHONES) {
    const janela = { top: cima, right: 0, bottom: baixo, left: 0 };
    // A faixa cobriu a barra de status: o cabeçalho começa colado nela. A base é a do
    // aparelho: a barra de abas e os rodapés seguem acima do indicador de início.
    assert.deepEqual(areaAbaixoDasFaixas(janela, true), { top: 0, right: 0, bottom: baixo, left: 0 }, aparelho);
  }
});

test('sem faixa, a área é a MESMA (o mesmo objeto): nada redesenha à toa', () => {
  const janela = { top: 59, right: 0, bottom: 34, left: 0 };
  assert.equal(areaAbaixoDasFaixas(janela, false), janela);
  // Topo já zero (export web, aparelho sem recorte): nada a tirar.
  const semTopo = { top: 0, right: 0, bottom: 0, left: 0 };
  assert.equal(areaAbaixoDasFaixas(semTopo, true), semTopo);
});

test('teclado debaixo das faixas: o KeyboardAvoidingView desconta a altura delas (sem faixa, nada)', () => {
  // A conta do KeyboardAvoidingView do RN 0.81 (behavior 'padding'): o KAV medido em relação
  // ao PAI — que começa debaixo das faixas — e o topo do teclado medido na tela inteira.
  const acolchoa = (kav: { y: number; altura: number }, topoDoTeclado: number, deslocamento: number) =>
    Math.max(kav.y + kav.altura - (topoDoTeclado - deslocamento), 0);
  const tela = 667; // iPhone SE
  const teclado = 260; // com a barra de sugestões
  const faixa = 45; // a da demonstração: barra de status (20) + respiro + frase + respiro
  const entrada = { y: 0, altura: tela - faixa }; // a tela de entrada, debaixo da faixa
  assert.equal(acolchoa(entrada, tela - teclado, 0), teclado - faixa, 'sem desconto, a altura da faixa fica atrás do teclado');
  assert.equal(acolchoa(entrada, tela - teclado, deslocamentoDoTeclado(faixa)), teclado, 'com ele, o teclado inteiro');
  // Sem faixa (a loja de verdade, com conexão), o KAV fica como sempre foi.
  assert.equal(deslocamentoDoTeclado(0), 0);
  assert.equal(acolchoa({ y: 0, altura: tela }, tela - teclado, deslocamentoDoTeclado(0)), teclado);
  // Com o Texto Maior a frase quebra e a medida vem quebrada: para cima, nunca fica atrás.
  assert.equal(deslocamentoDoTeclado(44.2), 45);
  assert.equal(deslocamentoDoTeclado(Number.NaN), 0);
  assert.equal(deslocamentoDoTeclado(-1), 0);
});

/** Cada abertura `<KeyboardAvoidingView ...>` do arquivo — até o `>` fora de `{...}` —, sem comentário. */
function aberturasDoKav(fonte: string): string[] {
  const aberturas: string[] = [];
  for (let i = fonte.indexOf('<KeyboardAvoidingView'); i !== -1; i = fonte.indexOf('<KeyboardAvoidingView', i + 1)) {
    let chaves = 0;
    let fim = i;
    for (; fim < fonte.length && !(fonte[fim] === '>' && chaves === 0); fim += 1) {
      if (fonte[fim] === '{') chaves += 1;
      else if (fonte[fim] === '}') chaves -= 1;
    }
    aberturas.push(fonte.slice(i, fim + 1).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, ''));
  }
  return aberturas;
}

test('a entrada liga o desconto: o KeyboardAvoidingView de (auth)/login.tsx passa a altura medida das faixas', () => {
  // A conta de cima só vale se a tela a usar. Sem o offset na entrada, a demonstração volta a
  // esconder atrás do teclado a altura da faixa — e o resto da suíte e o tsc seguem verdes.
  // A tela "Conectar à loja" não entra: no iOS ela é folha modal nativa, fora das faixas.
  const login = readFileSync(join(__dirname, '..', 'app', '(auth)', 'login.tsx'), 'utf8');
  const kavs = aberturasDoKav(login);
  assert.ok(kavs.length > 0, 'a entrada não tem mais KeyboardAvoidingView: a guarda não provaria nada');
  for (const kav of kavs) {
    const offset = /\bkeyboardVerticalOffset=\{\s*deslocamentoDoTeclado\(\s*([A-Za-z_$][\w$]*)\s*\)\s*\}/.exec(kav);
    assert.ok(offset, `KeyboardAvoidingView da entrada sem keyboardVerticalOffset={deslocamentoDoTeclado(...)}:\n${kav}`);
    assert.match(
      login,
      new RegExp(`\\bconst\\s+${offset[1].replaceAll('$', '\\$')}\\s*=\\s*useAlturaDasFaixas\\(\\s*\\)`),
      `${offset[1]} não é a altura medida das faixas (useAlturaDasFaixas())`,
    );
  }
});
