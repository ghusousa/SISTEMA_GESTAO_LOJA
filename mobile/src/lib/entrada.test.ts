import assert from 'node:assert/strict';
import test from 'node:test';

import { notaDepoisDoDuplicado, tirarOQueJaEntrou } from './entrada';

const peca = (varianteId: number, quantidade: number) => ({ varianteId, quantidade, codigo: `c${varianteId}` });

test('o que a entrada gravada levou sai; o bipado depois fica', () => {
  // 10 P gravadas; depois a pessoa bipou mais 7 M e reenviou a lista com as duas.
  const lista = [peca(1, 10), peca(2, 7)];
  assert.deepEqual(tirarOQueJaEntrou(lista, [{ variante_id: 1, quantidade: 10 }]), [peca(2, 7)]);
});

test('peça bipada a mais depois da gravação fica só com a diferença', () => {
  const lista = [peca(1, 12)];
  assert.deepEqual(tirarOQueJaEntrou(lista, [{ variante_id: 1, quantidade: 10 }]), [peca(1, 2)]);
});

test('peça que a lista nem tem mais não inventa linha nem fica negativa', () => {
  const lista = [peca(2, 3)];
  assert.deepEqual(tirarOQueJaEntrou(lista, [{ variante_id: 1, quantidade: 10 }]), [peca(2, 3)]);
  assert.deepEqual(tirarOQueJaEntrou([peca(1, 4)], [{ variante_id: 1, quantidade: 10 }]), []);
});

const notaGravada = {
  numero: 'NF 4512',
  valor_total: '900.00',
  parcelas: [
    { vencimento: '2026-12-02', valor: '300.00' },
    { vencimento: '2027-01-01', valor: '300.00' },
    { vencimento: '2027-01-31', valor: '300.00' },
  ],
};
const umaParcela = (numero: string | null, valor: string) => ({
  numero,
  valor_total: valor,
  parcelas: [{ vencimento: '2026-12-02', valor }],
});

test('a gravada já levou a MESMA nota: ela sai do formulário e a pessoa fica sabendo', () => {
  // Sem isso o reenvio do que falta lançava as 3 parcelas de novo: R$ 1.800 a pagar.
  const r = notaDepoisDoDuplicado({ nota: notaGravada }, notaGravada, true);
  assert.equal(r.tirarNota, true);
  assert.match(r.frase, /A nota NF 4512 \(R\$\s900,00 em 3 parcelas\) já está em Contas a pagar/);
  assert.match(r.frase, /tirei a nota do formulário/);
});

test('mesmo número escrito de outro jeito ainda é a mesma nota', () => {
  const r = notaDepoisDoDuplicado({ nota: notaGravada }, { ...notaGravada, numero: ' nf-4512 ' }, true);
  assert.equal(r.tirarNota, true);
  // Mesmo número com outro valor: é a mesma nota corrigida, e a correção é em Contas a pagar.
  const corrigida = notaDepoisDoDuplicado({ nota: notaGravada }, umaParcela('NF 4512', '950.00'), true);
  assert.equal(corrigida.tirarNota, true);
  assert.match(corrigida.frase, /corrija em Contas a pagar/);
});

test('sem número para comparar, o mesmo valor diz que é a mesma nota', () => {
  const avulsa = umaParcela(null, '300.00');
  assert.equal(notaDepoisDoDuplicado({ nota: avulsa }, avulsa, true).tirarNota, true);
  // A pessoa só acrescentou o número depois: ainda é a mesma.
  assert.equal(notaDepoisDoDuplicado({ nota: avulsa }, umaParcela('123', '300.00'), true).tirarNota, true);
});

test('OUTRA nota no formulário (outro número) fica: a dívida dela ainda não entrou', () => {
  // A gravada levou a 123 de R$ 300; o formulário tem a 456 de R$ 500. Tirar a 456 deixava
  // Contas a pagar em R$ 300 e o boleto de R$ 500 vencia esquecido.
  const n123 = umaParcela('123', '300.00');
  const n456 = umaParcela('456', '500.00');
  const r = notaDepoisDoDuplicado({ nota: n123 }, n456, true);
  assert.equal(r.tirarNota, false);
  assert.match(r.frase, /A entrada gravada levou a nota 123 \(R\$\s300,00 em 1 parcela\)/);
  assert.match(r.frase, /A nota 456 do formulário tem outro número: fica e vai com o que falta/);
  assert.doesNotMatch(r.frase, /tirei a nota/);
  // Nada sobrou para levá-la: a frase manda lançar, não promete um envio que não vem.
  const semResto = notaDepoisDoDuplicado({ nota: n123 }, n456, false);
  assert.equal(semResto.tirarNota, false);
  assert.match(semResto.frase, /não sobrou peça para levá-la: lance-a em Contas a pagar/);
  assert.doesNotMatch(semResto.frase, /vai com o que falta/);
});

test('sem número e com outro valor não dá para saber: a nota fica e a pessoa decide', () => {
  const r = notaDepoisDoDuplicado({ nota: umaParcela(null, '300.00') }, umaParcela(null, '500.00'), true);
  assert.equal(r.tirarNota, false);
  assert.match(r.frase, /A do formulário é de R\$\s500,00 e ficou: se for a mesma nota, tire-a/);
  const semResto = notaDepoisDoDuplicado({ nota: umaParcela(null, '300.00') }, umaParcela(null, '500.00'), false);
  assert.equal(semResto.tirarNota, false);
  assert.match(semResto.frase, /se for outra nota, lance-a em Contas a pagar/);
});

test('a gravada foi sem nota: a do formulário fica e vai com o resto', () => {
  const r = notaDepoisDoDuplicado({ nota: null }, notaGravada, true);
  assert.equal(r.tirarNota, false);
  assert.match(r.frase, /foi sem nota: a nota do formulário fica e vai com o que falta/);
});

test('a gravada foi sem nota e não sobrou peça: manda lançar a nota em Contas a pagar', () => {
  // A lista zera, o botão Registrar desliga e a nota nunca sairia — prometer que ela "vai
  // com o que falta" deixava o boleto esquecido.
  const r = notaDepoisDoDuplicado({ nota: null }, notaGravada, false);
  assert.equal(r.tirarNota, false);
  assert.match(r.frase, /não sobrou peça para levar a do formulário: lance-a em Contas a pagar/);
  assert.doesNotMatch(r.frase, /vai com o que falta/);
});

test('formulário sem nota: nada a tirar; só avisa se a gravada tinha', () => {
  assert.deepEqual(notaDepoisDoDuplicado({ nota: null }, null, true), { tirarNota: false, frase: '' });
  const r = notaDepoisDoDuplicado({ nota: umaParcela(null, '300.00') }, null, true);
  assert.equal(r.tirarNota, false);
  assert.match(r.frase, /^A nota \(R\$\s300,00 em 1 parcela\) já está em Contas a pagar/);
});

test('servidor que não diz a nota (sem a chave): mantém e pede para conferir', () => {
  const r = notaDepoisDoDuplicado({}, notaGravada, true);
  assert.equal(r.tirarNota, false);
  assert.match(r.frase, /Confira em Contas a pagar se esta nota já entrou antes de registrar o que falta/);
  const semResto = notaDepoisDoDuplicado({}, notaGravada, false);
  assert.match(semResto.frase, /se não entrou, lance-a lá/);
});
