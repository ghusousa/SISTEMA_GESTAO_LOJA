import assert from 'node:assert/strict';
import test from 'node:test';

import type { EmissorFiscal, Nfce, NotaFiscal } from '../api/tipos';
import {
  cartaoDaNfce,
  cestFormatado,
  chaveFormatada,
  lerCodigo,
  linhaDoRecibo,
  linkSeguro,
  motivoMinimo,
  ncmFormatado,
} from './fiscal';

const CHAVE = '35261112345678000195650010000000011000000010';

const emissorLigado: EmissorFiscal = {
  nome: 'focusnfe',
  ambiente: 'homologacao',
  configurado: true,
  faltando: [],
  emitir_automatico: false,
};
const emissorDesligado: EmissorFiscal = {
  nome: 'desligado',
  ambiente: null,
  configurado: false,
  faltando: ['No .env do servidor: FISCAL_EMISSOR=focusnfe'],
  emitir_automatico: false,
};

function nota(parcial: Partial<NotaFiscal>): NotaFiscal {
  return {
    id: 1,
    venda_id: 7,
    status: 'AUTORIZADA',
    ambiente: 'homologacao',
    emissor: 'focusnfe',
    referencia: 'venda-7-abcd',
    numero: 1,
    serie: 1,
    chave: CHAVE,
    protocolo: null,
    url_danfe: 'https://homologacao.focusnfe.com.br/danfe.html',
    url_xml: null,
    mensagem: null,
    tentativas: 1,
    autorizada_em: null,
    cancelada_em: null,
    criada_em: '2026-11-02T10:00:00Z',
    atualizada_em: '2026-11-02T10:00:00Z',
    ...parcial,
  };
}

const com = (n: NotaFiscal | null, emissor = emissorLigado): Nfce => ({ venda_id: 7, emissor, nota: n });

test('códigos fiscais saem como no papel do contador', () => {
  assert.equal(ncmFormatado('61091000'), '6109.10.00');
  assert.equal(cestFormatado('2803800'), '28.038.00');
  assert.equal(ncmFormatado(null), '');
  assert.equal(chaveFormatada(CHAVE).split(' ').length, 11);
  assert.equal(lerCodigo('  '), null);
  assert.equal(lerCodigo(' 6109.10.00 '), '6109.10.00');
});

test('emissor desligado: só o dono vê o aviso, e ninguém vê botão', () => {
  assert.equal(cartaoDaNfce(com(null, emissorDesligado), false, false).oculto, true);
  const dono = cartaoDaNfce(com(null, emissorDesligado), false, true);
  assert.equal(dono.oculto, false);
  assert.equal(dono.botao, null);
  assert.deepEqual(dono.faltando, emissorDesligado.faltando);
});

test('sem nota: emite; venda cancelada não emite', () => {
  assert.equal(cartaoDaNfce(com(null), false, false).botao, 'Emitir NFC-e');
  assert.equal(cartaoDaNfce(com(null), true, false).botao, null);
});

test('autorizada não oferece emitir de novo; rejeitada e pendente oferecem', () => {
  assert.equal(cartaoDaNfce(com(nota({})), false, false).botao, null);
  const rejeitada = cartaoDaNfce(com(nota({ status: 'REJEITADA', chave: null, mensagem: 'NCM inexistente' })), false, false);
  assert.equal(rejeitada.botao, 'Tentar de novo');
  assert.equal(rejeitada.mensagem, 'NCM inexistente');
  assert.equal(cartaoDaNfce(com(nota({ status: 'PENDENTE', chave: null })), false, false).botao, 'Tentar de novo');
  assert.equal(cartaoDaNfce(com(nota({ status: 'CANCELADA' })), true, false).botao, null);
});

test('recibo diz a chave só com nota autorizada', () => {
  assert.equal(linhaDoRecibo(com(nota({}))), `NFC-e autorizada: ${chaveFormatada(CHAVE)}`);
  assert.equal(linhaDoRecibo(com(nota({ status: 'CANCELADA' }))), null);
  assert.equal(linhaDoRecibo(com(null)), null);
  assert.equal(linhaDoRecibo(null), null);
});

test('motivo do cancelamento com nota autorizada pede 15 letras', () => {
  assert.equal(motivoMinimo(com(nota({}))), 15);
  assert.equal(motivoMinimo(com(nota({ status: 'REJEITADA', chave: null }))), 3);
  assert.equal(motivoMinimo(null), 3);
});

test('link do DANFE só se for http(s)', () => {
  assert.equal(linkSeguro('https://x.com/a.html'), 'https://x.com/a.html');
  assert.equal(linkSeguro('javascript:alert(1)'), null);
  assert.equal(linkSeguro(null), null);
});
