/**
 * A faixa do chamado do computador (ADR-47), a parte sem tela: o que ela mostra em cada caso,
 * e a cor dela, que fica debaixo da barra de status clara OU escura.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  haQuantoTempo,
  naTelaDoLeitor,
  oQueAFaixaMostra,
  razaoDeContraste,
  ROTA_DO_LEITOR,
} from './chamadoDoLeitor';
import { cores } from './tema';

const UM = { id: 41, sinal: '7K3' };
const OUTRO = { id: 42, sinal: '2B9' };
const LIVRE = { dispensados: [], leitorLigado: false, naTelaDoLeitor: false };

test('um chamado: "O computador está chamando", com o sinal e o atender', () => {
  assert.deepEqual(oQueAFaixaMostra({ ...LIVRE, chamados: [UM] }), { tipo: 'um', chamado: UM, ids: [41] });
});

test('nenhum chamado: sem faixa', () => {
  assert.equal(oQueAFaixaMostra({ ...LIVRE, chamados: [] }), null);
});

test('na tela do leitor, quem mostra é ela: sem faixa', () => {
  assert.equal(oQueAFaixaMostra({ ...LIVRE, chamados: [UM], naTelaDoLeitor: true }), null);
  assert.equal(naTelaDoLeitor(ROTA_DO_LEITOR), true);
  assert.equal(naTelaDoLeitor('/mais/leitor'), true);
  assert.equal(naTelaDoLeitor('/'), false);
  assert.equal(naTelaDoLeitor('/mais/conta'), false);
  assert.equal(naTelaDoLeitor(null), false);
});

test('✕ dispensa os que estavam na faixa; um chamado novo aparece de novo', () => {
  assert.equal(oQueAFaixaMostra({ ...LIVRE, chamados: [UM], dispensados: [41] }), null);
  assert.deepEqual(oQueAFaixaMostra({ ...LIVRE, chamados: [UM, OUTRO], dispensados: [41] }), {
    tipo: 'um',
    chamado: OUTRO,
    ids: [42],
  });
});

test('com o leitor ligado neste celular, a faixa só avisa e leva à tela do leitor', () => {
  assert.deepEqual(oQueAFaixaMostra({ ...LIVRE, chamados: [UM], leitorLigado: true }), {
    tipo: 'leitor-ligado',
    ids: [41],
  });
  assert.deepEqual(oQueAFaixaMostra({ ...LIVRE, chamados: [UM, OUTRO], leitorLigado: true }), {
    tipo: 'leitor-ligado',
    ids: [41, 42],
  });
});

test('mais de um computador chamando (o mesmo login em dois caixas): "N computadores", e a tela escolhe', () => {
  assert.deepEqual(oQueAFaixaMostra({ ...LIVRE, chamados: [UM, OUTRO] }), {
    tipo: 'varios',
    quantidade: 2,
    ids: [41, 42],
  });
});

test('chamado com sinal fora do formato não aparece (não há como conferir com o computador)', () => {
  assert.equal(oQueAFaixaMostra({ ...LIVRE, chamados: [{ id: 9, sinal: '' }] }), null);
  assert.deepEqual(oQueAFaixaMostra({ ...LIVRE, chamados: [{ id: 9, sinal: 'ABC' }, UM] }), {
    tipo: 'um',
    chamado: UM,
    ids: [41],
  });
});

test('há quanto tempo o computador chamou', () => {
  const criado = '2026-11-19T18:00:00.000Z';
  const t0 = Date.parse(criado);
  assert.equal(haQuantoTempo(criado, t0 + 2_000), 'agora mesmo');
  assert.equal(haQuantoTempo(criado, t0 + 20_000), 'há 20 s');
  assert.equal(haQuantoTempo(criado, t0 + 59_999), 'há 59 s');
  assert.equal(haQuantoTempo(criado, t0 + 60_000), 'há 1 min');
  assert.equal(haQuantoTempo(criado, t0 + 4 * 60_000 + 30_000), 'há 4 min');
  assert.equal(haQuantoTempo(criado, t0 - 3_000), 'agora mesmo', 'relógio do celular atrás do servidor');
  assert.equal(haQuantoTempo('ontem', t0), '');
  assert.equal(haQuantoTempo(null, t0), '');
});

test('a cor da faixa lê com a hora PRETA e com a BRANCA da barra de status (≥ 4:1)', () => {
  // A faixa, quando é a primeira, fica debaixo da barra de status; a tela de baixo pede a barra
  // clara (cabeçalho azul) ou a escura (Vender, entrada): as duas têm de ler.
  assert.ok(razaoDeContraste(cores.chamadoDoLeitor, '#000000') >= 4, 'hora preta');
  assert.ok(razaoDeContraste(cores.chamadoDoLeitor, '#FFFFFF') >= 4, 'hora branca');
  // E o texto da própria faixa, branco, no mínimo do texto comum (AA).
  assert.ok(razaoDeContraste(cores.chamadoDoLeitor, cores.aoFundoEscuro) >= 4.5, 'texto da faixa');
});

test('a medida de contraste confere com os casos conhecidos', () => {
  assert.equal(razaoDeContraste('#000000', '#FFFFFF'), 21);
  assert.equal(razaoDeContraste('#FFFFFF', '#000000'), 21, 'a ordem não importa');
  assert.equal(razaoDeContraste('#777777', '#777777'), 1);
  // A da demonstração, cujos números estão escritos em tema.ts.
  assert.equal(razaoDeContraste(cores.demonstracao, '#FFFFFF').toFixed(1), '5.0');
  assert.equal(razaoDeContraste(cores.demonstracao, '#000000').toFixed(1), '4.2');
  assert.throws(() => razaoDeContraste('azul', '#FFFFFF'));
});
