/**
 * Testes da camada de dinheiro. Rodam com `npm run test:money` (node --test + tsx),
 * sem precisar do ambiente React Native.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  apagarDigito,
  digitar,
  dividir,
  formatar,
  paraCentavos,
  paraDecimalString,
  percentual,
  somar,
} from './money';

test('converte string decimal da API em centavos', () => {
  assert.equal(paraCentavos('149.90'), 14990);
  assert.equal(paraCentavos('149.9'), 14990);
  assert.equal(paraCentavos('149'), 14900);
  assert.equal(paraCentavos('0.05'), 5);
  assert.equal(paraCentavos('-10.50'), -1050);
  assert.equal(paraCentavos(''), 0);
  assert.equal(paraCentavos(null), 0);
});

test('aceita vírgula, que é o que o usuário digita', () => {
  assert.equal(paraCentavos('149,90'), 14990);
  assert.equal(paraCentavos('1 234,56'), 123456);
});

test('separador de milhar não vira decimal', () => {
  // O placeholder do campo de despesa é literalmente "2.500,00": tratar o ponto como
  // decimal transformaria um aluguel de R$ 2.500 em R$ 2,50.
  assert.equal(paraCentavos('2.500,00'), 250000);
  assert.equal(paraCentavos('1.299,90'), 129990);
  assert.equal(paraCentavos('1.234.567,89'), 123456789);
  assert.equal(paraCentavos('2.500'), 250000); // três dígitos após o ponto: é milhar
  assert.equal(paraCentavos('1.000'), 100000);
});

test('ainda entende o ponto decimal que a API manda', () => {
  assert.equal(paraCentavos('149.90'), 14990);
  assert.equal(paraCentavos('149.9'), 14990);
  assert.equal(paraCentavos('0.05'), 5);
  assert.equal(paraCentavos('1000.00'), 100000);
});

test('ignora símbolo de moeda e lixo colado no número', () => {
  assert.equal(paraCentavos('R$ 149,90'), 14990);
  assert.equal(paraCentavos('  59,90  '), 5990);
  assert.equal(paraCentavos('abc'), 0);
  assert.equal(paraCentavos(','), 0);
  assert.equal(paraCentavos('.'), 0);
});

test('não perde centavo em valores que quebram em float', () => {
  // 0.1 + 0.2 em float dá 0.30000000000000004; em centavos, 30.
  assert.equal(paraCentavos('0.10') + paraCentavos('0.20'), 30);
  assert.equal(paraCentavos('149.90') * 3, 44970);
});

test('volta para string decimal no formato que a API espera', () => {
  assert.equal(paraDecimalString(14990), '149.90');
  assert.equal(paraDecimalString(5), '0.05');
  assert.equal(paraDecimalString(0), '0.00');
  assert.equal(paraDecimalString(-1050), '-10.50');
  assert.equal(paraDecimalString(100000), '1000.00');
});

test('ida e volta preserva o valor', () => {
  for (const valor of ['0.01', '9.99', '149.90', '1000.00', '12345.67']) {
    assert.equal(paraDecimalString(paraCentavos(valor)), valor);
  }
});

test('formata em real brasileiro', () => {
  // O Intl usa espaço não separável entre símbolo e número.
  assert.equal(formatar(14990).replace(/ /g, ' '), 'R$ 149,90');
  assert.equal(formatar(0).replace(/ /g, ' '), 'R$ 0,00');
});

test('digitação estilo caixa registradora empurra pela direita', () => {
  let valor = 0;
  for (const digito of ['1', '5', '0']) valor = digitar(valor, digito);
  assert.equal(valor, 150); // R$ 1,50
  assert.equal(apagarDigito(valor), 15); // R$ 0,15
  assert.equal(apagarDigito(0), 0);
});

test('desconto percentual arredonda meio-para-cima no centavo', () => {
  assert.equal(percentual(14990, 10), 1499);
  assert.equal(percentual(333, 50), 167); // 166,5 -> 167
});

test('divisão de pagamento não perde nem inventa centavo', () => {
  const partes = dividir(10000, 3);
  assert.deepEqual(partes, [3334, 3333, 3333]);
  assert.equal(somar(partes), 10000);

  for (const total of [1, 7, 99, 14990, 100001]) {
    for (const n of [2, 3, 4]) {
      assert.equal(somar(dividir(total, n)), total, `${total} em ${n} partes`);
    }
  }
});
