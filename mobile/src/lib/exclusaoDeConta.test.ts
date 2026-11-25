/**
 * Excluir conta (ADR-45), a parte sem tela. São os MESMOS casos de
 * `testes/web/exclusao-de-conta.test.mjs`: o app e o web dizem o mesmo sobre o que some e o
 * que fica, e tratam a senha errada do mesmo jeito (no campo, sem derrubar a sessão).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  AVISO_CONTA_EXCLUIDA,
  depoisDaIncerta,
  podeExcluirDaEquipe,
  recusaDaExclusao,
  SEM_RESPOSTA,
  textosDaExclusao,
} from './exclusaoDeConta';

const DONO = { id: 1, papel: 'ADMIN' };
const OUTRO_DONO = { id: 2, papel: 'ADMIN' };
const GERENTE = { id: 3, papel: 'GERENTE' };
const VENDEDORA = { id: 4, papel: 'VENDEDOR' };

test('a própria conta diz o que some e o que fica, e que não tem volta', () => {
  const t = textosDaExclusao({ propria: true });
  assert.ok(t.some.some((l) => l.includes('e-mail e senha deixam de existir')));
  assert.ok(t.some.some((l) => l.includes('celular ligado como leitor')));
  assert.ok(t.fica.some((l) => l.includes('vendas')));
  assert.ok(t.fica.some((l) => l.includes('nome')));
  assert.match(t.fim, /^Não tem volta\./);
});

test('o registro do celular para as notificações some junto (ADR-47), com o texto do web', () => {
  // Espelho de web/js/exclusao-de-conta.js: as duas pontas dizem a MESMA frase.
  assert.ok(
    textosDaExclusao({ propria: true }).some.includes(
      'As sessões abertas em todos os aparelhos, o celular ligado como leitor e o registro dele para as notificações.',
    ),
  );
  assert.ok(
    textosDaExclusao({ propria: false, nome: 'Ana Paula' }).some.includes(
      'As sessões abertas em todos os aparelhos caem na hora, e o celular ligado como leitor e o registro dele para as notificações também.',
    ),
  );
});

test('a conta de outra pessoa leva o nome e aponta o Desativar para afastamento', () => {
  const t = textosDaExclusao({ propria: false, nome: 'Ana Paula' });
  assert.ok(t.some[0].includes('Ana Paula'));
  assert.ok(t.fica.length >= 2);
  assert.match(t.fim, /Desativar/);
});

test('a equipe mostra Excluir conta só onde o servidor aceitaria', () => {
  // A própria é em Minha conta, com a senha (a rota da equipe responde 409).
  assert.equal(podeExcluirDaEquipe(DONO, DONO), false);
  assert.equal(podeExcluirDaEquipe(GERENTE, GERENTE), false);
  // Dono exclui qualquer um; gerente não mexe em dono (403 no servidor).
  assert.equal(podeExcluirDaEquipe(DONO, VENDEDORA), true);
  assert.equal(podeExcluirDaEquipe(DONO, OUTRO_DONO), true);
  assert.equal(podeExcluirDaEquipe(GERENTE, VENDEDORA), true);
  assert.equal(podeExcluirDaEquipe(GERENTE, DONO), false);
  assert.equal(podeExcluirDaEquipe(null, VENDEDORA), false);
});

test('senha errada fica no campo, com a frase do servidor', () => {
  const r = recusaDaExclusao({
    status: 422,
    code: 'SENHA_INCORRETA',
    message: 'Senha incorreta. A conta continua como estava.',
  });
  assert.deepEqual(r, { onde: 'senha', texto: 'Senha incorreta. A conta continua como estava.' });
});

test('senha vazia (validação) também fica no campo', () => {
  const r = recusaDaExclusao({ status: 422, code: 'VALIDACAO', message: 'Dados inválidos.' });
  assert.deepEqual(r, { onde: 'senha', texto: 'Digite a sua senha para confirmar.' });
});

test('o dono único lê o caminho que o servidor manda', () => {
  const frase =
    'Você é o único dono da loja. Passe o papel de dono a outra pessoa em Usuários antes de excluir a sua conta.';
  const r = recusaDaExclusao({ status: 409, code: 'OPERACAO_INVALIDA', message: frase });
  assert.deepEqual(r, { onde: 'geral', texto: frase });
});

test('sem resposta, NÃO afirma que a conta continua: o pedido pode ter chegado', () => {
  // Tempo esgotado ou conexão que caiu depois do envio: o servidor pode ter excluído.
  for (const falha of [{ status: 0, code: 'SEM_REDE', message: 'x' }, {}]) {
    const r = recusaDaExclusao(falha);
    assert.deepEqual(r, { onde: 'geral', texto: SEM_RESPOSTA, incerta: true });
    assert.match(r.texto, /pode ter sido excluída ou não/);
    assert.doesNotMatch(r.texto, /não foi excluída|continua como estava/);
  }
  // As recusas de verdade não são incertas: o servidor respondeu.
  assert.equal(recusaDaExclusao({ status: 422, code: 'SENHA_INCORRETA', message: 'x' }).incerta, undefined);
  assert.equal(recusaDaExclusao({ status: 409, code: 'OPERACAO_INVALIDA', message: 'x' }).incerta, undefined);
});

test('depois de uma tentativa sem resposta, o 401 é desempatado pela renovação', () => {
  // O servidor recusou o refresh: a exclusão levou as sessões — a entrada diz "Conta excluída".
  assert.equal(depoisDaIncerta(false), 'excluida');
  // Renovou: era só o crachá vencido, e a conta continua — pede a exclusão de novo.
  assert.equal(depoisDaIncerta(true), 'pedir-de-novo');
});

test('erro sem frase do servidor não fica mudo', () => {
  const r = recusaDaExclusao({ status: 500, code: 'ERRO', message: '' });
  assert.deepEqual(r, { onde: 'geral', texto: 'Não deu para excluir a conta. Ela continua como estava.' });
});

test('a entrada confirma que a conta foi excluída', () => {
  assert.match(AVISO_CONTA_EXCLUIDA, /^Conta excluída\./);
});
