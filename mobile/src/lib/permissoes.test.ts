/**
 * A mesma tabela de `api/tests/test_permissoes.py`, do lado do app.
 *
 * Não substitui o teste do servidor — quem recusa é ele. Serve para o espelho não sair do
 * lugar sem ninguém ver: se alguém mexer aqui e esquecer a API (ou o contrário), o app
 * passa a esconder o que devia mostrar, ou a oferecer o que vai dar 403.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import type { Papel } from '@/api/tipos';
import { PAPEIS, PODE, pode, titulo, type Capacidade } from './permissoes';

const DONO: Papel = 'ADMIN';
const GERENTE: Papel = 'GERENTE';
const SUPERVISORA: Papel = 'SUPERVISORA';
const VENDEDORA: Papel = 'VENDEDOR';

const TABELA: [Capacidade, Papel[]][] = [
  [PODE.VER_DINHEIRO, [DONO, GERENTE]],
  [PODE.LANCAR_DESPESA, [DONO, GERENTE]],
  [PODE.CANCELAR_VENDA, [DONO, GERENTE]],
  [PODE.GERIR_USUARIOS, [DONO, GERENTE]],
  [PODE.VER_AUDITORIA, [DONO]],
  [PODE.CONFIGURAR_LOJA, [DONO]],
  [PODE.GERIR_BACKUP, [DONO]],
  [PODE.VER_VENDAS_DE_TODOS, [DONO, GERENTE, SUPERVISORA]],
  [PODE.CORRIGIR_ESTOQUE, [DONO, GERENTE, SUPERVISORA]],
  [PODE.EDITAR_CATALOGO, [DONO, GERENTE, SUPERVISORA]],
  [PODE.FECHAR_CAIXA, [DONO, GERENTE, SUPERVISORA]],
];

for (const [capacidade, quemPode] of TABELA) {
  test(`${capacidade}: só ${quemPode.join(', ')}`, () => {
    for (const papel of PAPEIS) {
      assert.equal(pode(papel, capacidade), quemPode.includes(papel), `${papel} x ${capacidade}`);
    }
  });
}

test('a vendedora não tem capacidade nenhuma além de vender e consultar', () => {
  for (const capacidade of Object.values(PODE)) {
    assert.equal(pode(VENDEDORA, capacidade), false, capacidade);
  }
});

test('a hierarquia não tem buraco', () => {
  for (const capacidade of Object.values(PODE)) {
    if (pode(SUPERVISORA, capacidade)) assert.ok(pode(GERENTE, capacidade), capacidade);
    if (pode(GERENTE, capacidade)) assert.ok(pode(DONO, capacidade), capacidade);
  }
});

test('sem sessão ninguém pode nada', () => {
  // O instante entre abrir o app e o /auth/me responder: não é hora de mostrar Financeiro.
  for (const capacidade of Object.values(PODE)) {
    assert.equal(pode(undefined, capacidade), false, capacidade);
  }
});

test('todo papel tem um título legível', () => {
  for (const papel of PAPEIS) {
    assert.match(titulo(papel), /^[A-ZÀ-Ú]/);
  }
  assert.equal(titulo(undefined), '');
});
