/**
 * O "Voltar" do cabeçalho morria no iPhone com iOS 26 ou mais novo: o react-native-screens 4.16 (o que
 * o Expo SDK 54 fixa) desliga o botão ao sair de uma tela e só o religa no `didPopItem`. Como
 * a tela das abas não tem cabeçalho, o religar não acha o botão. O iOS então reaproveita o
 * botão desligado na tela seguinte, e daí em diante nenhuma tela volta pelo toque, só pelo
 * gesto da borda (software-mansion/react-native-screens#3294, corrigido na 4.17.0).
 *
 * A correção é o patch `patches/react-native-screens+4.16.0.patch`, aplicado pelo
 * `postinstall` (patch-package) em todo `npm install`/`npm ci`, inclusive no build da Expo.
 * Este teste reprova se o código nativo instalado voltar a desligar o botão (patch perdido,
 * reinstalação sem o postinstall) e lembra de apagar o patch quando o pacote subir de versão.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

// Mesma forma do areaSegura.test.ts (caminho por __dirname): o URL global dos tipos do React
// Native não é o do node:url, e o readFileSync não o aceita no typecheck.
const raiz = join(__dirname, '..', '..');
const SCREENS = join(raiz, 'node_modules', 'react-native-screens');
const pacote = JSON.parse(readFileSync(join(SCREENS, 'package.json'), 'utf8')) as { version: string };
const nativo = readFileSync(join(SCREENS, 'ios', 'RNSScreenStack.mm'), 'utf8');
const PATCH = join(raiz, 'patches', 'react-native-screens+4.16.0.patch');

/** O corpo do `navigationBar:shouldPopItem:` até o `didPopItem` (onde o 4.16 desliga o botão). */
function corpoDoShouldPopItem(fonte: string): string {
  const inicio = fonte.indexOf('shouldPopItem:(UINavigationItem *)item');
  if (inicio < 0) return '';
  const fim = fonte.indexOf('didPopItem:(UINavigationItem *)item', inicio);
  return fonte.slice(inicio, fim < 0 ? undefined : fim);
}

test('no iOS 26+, sair de uma tela não desliga o botão Voltar (o patch está aplicado)', () => {
  const corpo = corpoDoShouldPopItem(nativo);
  if (!corpo) return; // versão sem o handler (4.17+): nada a desligar
  assert.doesNotMatch(
    corpo,
    /userInteractionEnabled\s*=\s*false/,
    'o react-native-screens instalado volta a desligar o Voltar no iOS 26+: rode npm install (o postinstall aplica patches/) ou suba o pacote para 4.17+',
  );
  // A guarda contra dois pops seguidos continua: com uma transição no meio, não sai.
  assert.match(corpo, /transitionCoordinator == nil/);
});

test('o patch do Voltar vale só para a 4.16.0: subiu o pacote, apague o patch', () => {
  if (!existsSync(PATCH)) return;
  assert.equal(
    pacote.version,
    '4.16.0',
    `react-native-screens ${pacote.version} instalado com patches/react-native-screens+4.16.0.patch: a 4.17+ já traz a correção; apague o patch`,
  );
});
