/**
 * A barra de status escura nas telas claras sem cabeçalho, e a anotação que as capturas leem.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { anotarNoHtml, criarPilhaDaBarra, ESTILO_PADRAO } from './barraDeStatus';

test('vale o último pedido em pé; saindo todos, volta a clara da raiz', () => {
  const html = { dataset: {} as Record<string, string | undefined> };
  const pedir = criarPilhaDaBarra(anotarNoHtml(html));
  const sairDaEntrada = pedir('escura');
  assert.equal(html.dataset.barraDeStatus, 'escura');
  // O servidor abre por cima da entrada (modal): também escura.
  const sairDoServidor = pedir('escura');
  sairDoServidor();
  assert.equal(html.dataset.barraDeStatus, 'escura', 'a entrada ainda está embaixo');
  sairDaEntrada();
  assert.equal(html.dataset.barraDeStatus, ESTILO_PADRAO);
  assert.equal(ESTILO_PADRAO, 'clara');
});

test('fora de ordem (a aba que sai depois da que entrou) não troca a cor errada', () => {
  const anotadas: string[] = [];
  const pedir = criarPilhaDaBarra((e) => anotadas.push(e));
  const pdv = pedir('escura');
  const outra = pedir('clara');
  pdv(); // o foco do PDV some depois de a outra tela ter entrado
  assert.equal(anotadas.at(-1), 'clara');
  outra();
  assert.equal(anotadas.at(-1), 'clara');
  pdv(); // desfazer duas vezes não quebra nada
  assert.equal(anotadas.at(-1), 'clara');
});

test('sem <html> (no aparelho) a pilha só não anota', () => {
  const pedir = criarPilhaDaBarra(anotarNoHtml(undefined));
  assert.doesNotThrow(() => pedir('escura')());
});
