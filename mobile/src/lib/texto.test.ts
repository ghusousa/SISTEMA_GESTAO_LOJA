import assert from 'node:assert/strict';
import test from 'node:test';

import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';

import { plural, primeiraMaiuscula } from './texto';

test('só a primeira letra da frase sobe (o capitalize subia todas)', () => {
  assert.equal(primeiraMaiuscula('novembro de 2026'), 'Novembro de 2026');
  assert.equal(primeiraMaiuscula('últimos 30 dias'), 'Últimos 30 dias');
  assert.equal(primeiraMaiuscula('terça-feira, 17 de novembro'), 'Terça-feira, 17 de novembro');
});

test('as datas das telas, como o date-fns as escreve', () => {
  const dia = new Date(2026, 10, 17, 12);
  assert.equal(
    primeiraMaiuscula(format(dia, "MMMM 'de' yyyy", { locale: ptBR })),
    'Novembro de 2026',
  );
  assert.equal(
    primeiraMaiuscula(format(dia, "EEEE, dd 'de' MMMM", { locale: ptBR })),
    'Terça-feira, 17 de novembro',
  );
});

test('texto vazio ou já em maiúscula fica como está', () => {
  assert.equal(primeiraMaiuscula(''), '');
  assert.equal(primeiraMaiuscula('PIX'), 'PIX');
  assert.equal(primeiraMaiuscula('7 dias'), '7 dias');
});

test('plural: só 1 é singular, e o número leva ponto de milhar', () => {
  assert.equal(plural(1, 'peça', 'peças'), '1 peça');
  assert.equal(plural(0, 'peça', 'peças'), '0 peças');
  assert.equal(plural(12, 'peça', 'peças'), '12 peças');
  assert.equal(plural(1250, 'peça', 'peças'), '1.250 peças');
  assert.equal(plural(2, 'venda concluída', 'vendas concluídas'), '2 vendas concluídas');
});
