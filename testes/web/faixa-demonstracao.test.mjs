/**
 * A faixa "Loja de demonstração — os dados são fictícios." (ADR-46).
 *
 * A demonstração mora no mesmo domínio da loja, com as mesmas telas; a faixa no topo é o
 * que impede uma venda de verdade de ser lançada nela. Quem decide é o servidor
 * (`demonstracao` de `GET /configuracao`): na loja e na Vercel o campo é falso e nada muda.
 *
 * Roda sem navegador: `node --test testes/web/*.test.mjs`, com um `document` de mentira só
 * com o que a faixa toca. Mora FORA de `web/` de propósito: tudo lá é servido em `/app`.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

// Antes do `document` de mentira: o `ui.js` só liga ouvintes globais quando há um.
const { FRASE_DA_DEMONSTRACAO, ligarFaixaDaDemonstracao, pintarFaixaDaDemonstracao } = await import(
  '../../web/js/faixa-demonstracao.js'
);
const { definirLoja } = await import('../../web/js/loja.js');

/** O mínimo de `document`: o <html> com atributos, o <body> e a busca por id. */
function documentoFalso() {
  const atributos = new Map();
  const porId = new Map();
  const filhos = [];
  return {
    title: '',
    filhos,
    documentElement: {
      setAttribute: (nome, valor) => atributos.set(nome, String(valor)),
      removeAttribute: (nome) => atributos.delete(nome),
      hasAttribute: (nome) => atributos.has(nome),
    },
    body: {
      prepend(el) {
        filhos.unshift(el);
        if (el.id) porId.set(el.id, el);
      },
    },
    getElementById: (id) => porId.get(id) ?? null,
    createElement(tag) {
      const el = {
        tag,
        id: '',
        className: '',
        textContent: '',
        atributos: new Map(),
        setAttribute(nome, valor) {
          this.atributos.set(nome, String(valor));
        },
        remove() {
          filhos.splice(filhos.indexOf(el), 1);
          porId.delete(el.id);
        },
      };
      return el;
    },
  };
}

test('pintarFaixaDaDemonstracao põe a faixa no topo do <body> uma vez só, e tira', () => {
  const doc = documentoFalso();
  pintarFaixaDaDemonstracao(true, doc);
  assert.equal(doc.filhos.length, 1);
  const [faixa] = doc.filhos;
  assert.equal(faixa.textContent, 'Loja de demonstração — os dados são fictícios.');
  assert.equal(faixa.textContent, FRASE_DA_DEMONSTRACAO);
  assert.equal(faixa.className, 'faixa-demonstracao');
  assert.equal(faixa.atributos.get('role'), 'note');
  // A marca no <html> é o que desce a página (o `--faixa` do CSS).
  assert.ok(doc.documentElement.hasAttribute('data-demonstracao'));

  pintarFaixaDaDemonstracao(true, doc);
  assert.equal(doc.filhos.length, 1, 'chamar de novo não duplica a faixa');

  pintarFaixaDaDemonstracao(false, doc);
  assert.equal(doc.filhos.length, 0);
  assert.ok(!doc.documentElement.hasAttribute('data-demonstracao'));
});

test('ligarFaixaDaDemonstracao segue o que o servidor diz em cada leitura da configuração', () => {
  const doc = documentoFalso();
  globalThis.document = doc;
  try {
    const parar = ligarFaixaDaDemonstracao();
    assert.equal(doc.filhos.length, 0, 'antes da resposta, sem faixa');

    definirLoja({ nome: 'Loja de Demonstração', segmento: 'ROUPAS', demonstracao: true });
    assert.equal(doc.getElementById('faixa-demonstracao')?.textContent, FRASE_DA_DEMONSTRACAO);

    // A leitura completa (com a sessão) chega depois e repete o campo: continua uma faixa.
    definirLoja({ nome: 'Loja de Demonstração', segmento: 'ROUPAS', demonstracao: true, documento: null });
    assert.equal(doc.filhos.length, 1);

    // A loja, e a Vercel (ADR-42), dizem que não: nada no topo.
    definirLoja({ nome: 'Loja Real', segmento: 'ROUPAS', demonstracao: false });
    assert.equal(doc.filhos.length, 0);
    assert.ok(!doc.documentElement.hasAttribute('data-demonstracao'));
    definirLoja({ nome: 'Loja Real', segmento: 'ROUPAS' });
    assert.equal(doc.filhos.length, 0, 'sem o campo também não é demonstração');

    parar();
    definirLoja({ nome: 'Loja de Demonstração', segmento: 'ROUPAS', demonstracao: true });
    assert.equal(doc.filhos.length, 0, 'depois de parar, a faixa não segue mais a configuração');
  } finally {
    delete globalThis.document;
  }
});
