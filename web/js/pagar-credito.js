/**
 * Crédito: em quantas vezes, e em que bandeira (ADR-35).
 *
 * Mora fora de `pdv-cobranca.js` pelo mesmo motivo do vale e do fiado: é uma pergunta que
 * vem ANTES do valor entrar na venda, e a cobrança já passou do teto de linhas.
 *
 * A tela não mostra a taxa: quem decide quanto a maquininha fica é a tabela do dono, e o
 * servidor fotografa a taxa no pagamento. A vendedora escolhe o que a cliente pediu — "3x
 * no Visa" — e é só isso que precisa caber aqui.
 */

import { formatar } from './dinheiro.js';
import { html, modal } from './ui.js';

/** O teto do balcão. Espelho de `MAX_PARCELAS` em `api/app/modules/taxas/models.py`. */
export const MAX_PARCELAS = 12;

/** Sugestões, não lista fechada: a bandeira é texto livre no servidor. */
export const BANDEIRAS = ['Visa', 'Mastercard', 'Elo', 'Hipercard', 'Amex'];

/**
 * Pergunta parcelas e bandeira. Resolve `{parcelas, bandeira}` ou `undefined`.
 * @param {number} valor o que vai no crédito, em centavos — para mostrar o valor da parcela.
 */
export function pedirParcelas(valor) {
  let bandeira = null;
  return modal({
    titulo: 'Crédito — em quantas vezes?',
    largura: '440px',
    // A bandeira vem primeiro porque tocar nas parcelas já confirma: o caso de sempre
    // ("à vista, tanto faz a bandeira") fecha num toque só.
    render: () => html`
      <p class="texto-suave">Bandeira (opcional)</p>
      <div class="formas" data-bandeiras>
        ${BANDEIRAS.map(
          (b) => html`<button class="forma" data-bandeira="${b}" aria-pressed="false">${b}</button>`,
        )}
      </div>
      <p class="texto-suave" style="margin-top:14px">Parcelas</p>
      <div class="formas" data-parcelas>
        ${Array.from({ length: MAX_PARCELAS }, (_, i) => i + 1).map(
          (n) => html`
            <button class="forma" data-n="${n}">
              <strong>${n}x</strong>
              <span class="texto-suave">${formatar(Math.floor(valor / n))}</span>
            </button>
          `,
        )}
      </div>
      <div class="modal__acoes">
        <button class="botao botao--neutro" data-nao>Cancelar</button>
      </div>
    `,
    aoAbrir: (corpo, fechar) => {
      corpo.querySelectorAll('[data-bandeira]').forEach((b) =>
        b.addEventListener('click', () => {
          // Tocar de novo na mesma desmarca: a bandeira é opcional.
          bandeira = bandeira === b.dataset.bandeira ? null : b.dataset.bandeira;
          corpo.querySelectorAll('[data-bandeira]').forEach((outro) =>
            outro.setAttribute('aria-pressed', String(outro.dataset.bandeira === bandeira)),
          );
        }),
      );
      corpo.querySelectorAll('[data-n]').forEach((b) =>
        b.addEventListener('click', () => fechar({ parcelas: Number(b.dataset.n), bandeira })),
      );
      corpo.querySelector('[data-nao]').addEventListener('click', () => fechar(undefined));
      corpo.querySelector('[data-n="1"]')?.focus();
    },
  });
}
