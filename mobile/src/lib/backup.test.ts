import assert from 'node:assert/strict';
import test from 'node:test';

import { backupPrecisaDeAtencao, situacaoDoBackup, trocaPedeSenha } from './backup';

const funcionando = {
  configurado: true,
  ativo: true,
  ultimo_ok: true,
  ultimo_em: '2026-11-02T10:00:00Z',
  atrasado: false,
};

test('cópia que deu certo, mas velha demais, é Atrasado — não Funcionando', () => {
  assert.equal(situacaoDoBackup(funcionando).texto, 'Funcionando');
  const parado = { ...funcionando, atrasado: true };
  assert.deepEqual(situacaoDoBackup(parado), { texto: 'Atrasado', tom: 'alerta' });
  assert.equal(backupPrecisaDeAtencao(parado), true);
  assert.equal(backupPrecisaDeAtencao(funcionando), false);
});

test('ligado e nunca copiou: deixa de ser "ainda não rodou" quando passa da hora', () => {
  const nunca = { ...funcionando, ultimo_ok: null, ultimo_em: null };
  assert.equal(situacaoDoBackup(nunca).tom, 'info');
  assert.equal(situacaoDoBackup({ ...nunca, atrasado: true }).texto, 'Atrasado: nenhuma cópia ainda');
});

test('falha vence o atraso, e desligado nunca chama atenção', () => {
  assert.equal(situacaoDoBackup({ ...funcionando, ultimo_ok: false, atrasado: true }).tom, 'perigo');
  assert.equal(backupPrecisaDeAtencao({ ...funcionando, ativo: false, atrasado: true }), false);
});

test('senha só para trocar o destino de um backup já conectado', () => {
  const atual = { configurado: true, pasta: 'backups-loja' };
  assert.equal(trocaPedeSenha(atual, { token: '', pasta: 'backups-loja' }), false);
  assert.equal(trocaPedeSenha(atual, { token: '{"refresh_token":"x"}', pasta: 'backups-loja' }), true);
  assert.equal(trocaPedeSenha(atual, { token: '', pasta: 'outra' }), true);
  // primeira conexão: não há destino a desviar ainda
  assert.equal(trocaPedeSenha({ configurado: false, pasta: 'backups-loja' }, { token: '{}', pasta: 'x' }), false);
});
