/**
 * A permissão da câmera no leitor: o alerta do sistema vem primeiro, sem tela do app antes.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { avisoDaCamera, situacaoDaCamera } from './permissaoDaCamera';

const nunca = { granted: false, status: 'undetermined', canAskAgain: true };
const negadaNoIos = { granted: false, status: 'denied', canAskAgain: false };
const negadaPerguntavel = { granted: false, status: 'denied', canAskAgain: true };
const liberada = { granted: true, status: 'granted', canAskAgain: true };

test('primeira abertura: pede ao sistema na hora, sem a tela do app na frente do alerta', () => {
  assert.equal(situacaoDaCamera(nunca, false), 'pedir-ao-sistema');
  // Enquanto o hook lê a permissão, nada aparece por cima (o fundo do leitor é preto).
  assert.equal(situacaoDaCamera(null, false), 'lendo');
});

test('o alerta foi dispensado sem resposta: não pede em laço, mostra "Continuar"', () => {
  assert.equal(situacaoDaCamera(nunca, true), 'pedir-de-novo');
  assert.equal(avisoDaCamera('pedir-de-novo').botao, 'Continuar');
});

test('negada no iOS (o sistema não pergunta mais): o botão abre os Ajustes', () => {
  assert.equal(situacaoDaCamera(negadaNoIos, true), 'abrir-ajustes');
  assert.equal(situacaoDaCamera(negadaNoIos, false), 'abrir-ajustes', 'negada em outra abertura: não pede ao sistema');
  const aviso = avisoDaCamera('abrir-ajustes');
  assert.equal(aviso.botao, 'Abrir Ajustes');
  assert.match(aviso.texto, /Ajustes › Gestão de Loja › Câmera/);
  assert.match(aviso.texto, /Digitar código/);
});

test('negada mas o sistema ainda pergunta (Android): "Continuar" chama o alerta de novo', () => {
  assert.equal(situacaoDaCamera(negadaPerguntavel, true), 'pedir-de-novo');
});

test('liberada: o leitor abre direto', () => {
  assert.equal(situacaoDaCamera(liberada, false), 'liberada');
});

test('nenhum botão da tela do app tem cara de "Permitir" (Apple 5.1.1)', () => {
  for (const s of ['pedir-de-novo', 'abrir-ajustes'] as const) {
    assert.doesNotMatch(avisoDaCamera(s).botao, /permitir|allow|autorizar/i);
  }
});
