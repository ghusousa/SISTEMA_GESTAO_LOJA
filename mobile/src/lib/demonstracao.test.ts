import assert from 'node:assert/strict';
import test from 'node:test';

import { ehLojaDeDemonstracao, FRASE_DA_DEMONSTRACAO } from './demonstracao';

test('a faixa diz o que é, com a frase do web (ADR-46)', () => {
  assert.equal(FRASE_DA_DEMONSTRACAO, 'Loja de demonstração — os dados são fictícios.');
});

test('só a demonstração que o servidor declara ganha faixa', () => {
  assert.equal(ehLojaDeDemonstracao({ demonstracao: true }), true);
});

test('servidor antigo (sem o campo), Vercel e loja real: sem faixa', () => {
  assert.equal(ehLojaDeDemonstracao({}), false);
  assert.equal(ehLojaDeDemonstracao({ demonstracao: false }), false);
  // Antes da resposta (ou com o servidor fora do ar), a tela desenha com o padrão.
  assert.equal(ehLojaDeDemonstracao(undefined), false);
  assert.equal(ehLojaDeDemonstracao(null), false);
});

test('só `true` conta: texto ou número não liga a faixa', () => {
  for (const valor of ['true', 'sim', 1, 'false', 0, null]) {
    assert.equal(ehLojaDeDemonstracao({ demonstracao: valor }), false, String(valor));
  }
});
