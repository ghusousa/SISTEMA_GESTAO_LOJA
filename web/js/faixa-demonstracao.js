/**
 * A faixa "Loja de demonstração — os dados são fictícios." no topo de toda tela (ADR-46).
 *
 * A demonstração sobe com a loja, no mesmo domínio (`/demo`) e com as mesmas telas: sem um
 * aviso que não sai da vista, quem tem as duas abas abertas lança a venda de verdade na
 * demo — e ela some na renovação da madrugada. Quem diz se é demo é o servidor
 * (`demonstracao` de `GET /configuracao`, que responde sem login: a faixa já aparece na
 * tela de entrada). A raiz da página não serve de sinal: a demo da Vercel mora na raiz do
 * domínio dela e, lá, nada muda (ADR-42).
 *
 * A faixa mora FORA de `#raiz`, que a moldura reescreve inteira ao entrar e ao sair, e não
 * vai para o papel (`@media print` em `css/estilo.css`): a folha de etiquetas é medida em
 * milímetros a partir do topo.
 */

import { aoMudarLoja, loja } from './loja.js';

export const FRASE_DA_DEMONSTRACAO = 'Loja de demonstração — os dados são fictícios.';

/**
 * Põe ou tira a faixa. Chamar de novo com o mesmo valor não duplica nada.
 * @param {boolean} ligada
 * @param {Document} [doc]
 */
export function pintarFaixaDaDemonstracao(ligada, doc = document) {
  const pagina = doc.documentElement;
  let faixa = doc.getElementById('faixa-demonstracao');
  if (!ligada) {
    faixa?.remove();
    pagina.removeAttribute('data-demonstracao');
    return;
  }
  if (!faixa) {
    faixa = doc.createElement('div');
    faixa.id = 'faixa-demonstracao';
    faixa.className = 'faixa-demonstracao';
    faixa.setAttribute('role', 'note');
    faixa.textContent = FRASE_DA_DEMONSTRACAO;
    doc.body.prepend(faixa);
  }
  // A marca no <html> é o que desce a página a altura da faixa (`--faixa`, no CSS).
  pagina.setAttribute('data-demonstracao', '');
}

/** Liga a faixa ao que o servidor disser: agora e a cada leitura da configuração. */
export function ligarFaixaDaDemonstracao() {
  pintarFaixaDaDemonstracao(loja().demonstracao === true);
  return aoMudarLoja((config) => pintarFaixaDaDemonstracao(config.demonstracao === true));
}
