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
import {
  PAPEIS,
  PODE,
  papeisQuePossoDar,
  pode,
  possoMudarPapel,
  titulo,
  type Capacidade,
} from './permissoes';

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
  // O gerente também recebe comissão: quem recebe não decide quanto (ADR-37).
  [PODE.DEFINIR_COMISSAO, [DONO]],
  [PODE.VER_VENDAS_DE_TODOS, [DONO, GERENTE, SUPERVISORA]],
  [PODE.CORRIGIR_ESTOQUE, [DONO, GERENTE, SUPERVISORA]],
  [PODE.EDITAR_CATALOGO, [DONO, GERENTE, SUPERVISORA]],
  [PODE.FECHAR_CAIXA, [DONO, GERENTE, SUPERVISORA]],
  [PODE.GERIR_CREDIARIO, [DONO, GERENTE]],
  // Buscar e cadastrar cliente no balcão é de todo mundo; o fiado, não (ADR-36).
  [PODE.ATENDER_CLIENTE, [DONO, GERENTE, SUPERVISORA, VENDEDORA]],
  // A condicional é atendimento de balcão: da vendedora em diante (ADR-39).
  [PODE.FAZER_CONDICIONAL, [DONO, GERENTE, SUPERVISORA, VENDEDORA]],
];

for (const [capacidade, quemPode] of TABELA) {
  test(`${capacidade}: só ${quemPode.join(', ')}`, () => {
    for (const papel of PAPEIS) {
      assert.equal(pode(papel, capacidade), quemPode.includes(papel), `${papel} x ${capacidade}`);
    }
  });
}

test('a vendedora só atende cliente e faz condicional além de vender e consultar', () => {
  for (const capacidade of Object.values(PODE)) {
    assert.equal(
      pode(VENDEDORA, capacidade),
      capacidade === PODE.ATENDER_CLIENTE || capacidade === PODE.FAZER_CONDICIONAL,
      capacidade,
    );
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

test('quem dá qual papel: só o dono dá "Dono"; o gerente dá os outros três', () => {
  assert.deepEqual(papeisQuePossoDar(DONO), ['VENDEDOR', 'SUPERVISORA', 'GERENTE', 'ADMIN']);
  assert.deepEqual(papeisQuePossoDar(GERENTE), ['VENDEDOR', 'SUPERVISORA', 'GERENTE']);
  assert.deepEqual(papeisQuePossoDar(undefined), ['VENDEDOR', 'SUPERVISORA', 'GERENTE']);
});

test('"Mudar papel" na equipe: nunca em si mesmo, dono só pelo dono, e só para quem administra', () => {
  const dona = { id: 1, papel: DONO };
  const outroDono = { id: 2, papel: DONO };
  const gerente = { id: 3, papel: GERENTE };
  const vendedora = { id: 4, papel: VENDEDORA };
  const supervisora = { id: 5, papel: SUPERVISORA };
  // O caminho do dono único que quer excluir a conta: passa o papel de dono à gerente.
  assert.equal(possoMudarPapel(dona, gerente), true);
  assert.equal(possoMudarPapel(dona, outroDono), true);
  assert.equal(possoMudarPapel(dona, dona), false, 'o próprio papel não se troca');
  assert.equal(possoMudarPapel(gerente, vendedora), true);
  assert.equal(possoMudarPapel(gerente, dona), false, 'gerente não mexe em dono');
  assert.equal(possoMudarPapel(supervisora, vendedora), false, 'supervisora não administra a equipe');
  assert.equal(possoMudarPapel(null, vendedora), false);
});
