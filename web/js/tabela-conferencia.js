/**
 * A tabela do que foi conferido, usada pela entrada de mercadoria.
 *
 * Mora fora da view por dois motivos: a tela de entrada passaria dos ~300 linhas do
 * CLAUDE.md com ela dentro, e desenhar linha de conferência é trabalho de componente, não
 * de tela. Devolve a lista inteira já alterada em vez de mandar "somou um na peça 7" —
 * assim quem chama continua dono do estado e não existe caminho por onde a tela e a
 * tabela discordarem sobre o que está na sacola.
 */

import { cru, grade, html, numero } from './ui.js';

/** Ninguém confere mil peças iguais de uma vez; o teto evita o zero a mais sem querer. */
export const MAX_POR_PECA = 999;

function limpar(valor) {
  return Math.max(1, Math.min(MAX_POR_PECA, Math.floor(Number(valor) || 1)));
}

function linha(item, veDinheiro) {
  return html`
    <tr>
      <td>
        <span class="celula-principal">${item.produto}</span>
        <span class="celula-secundaria">${grade(item.tamanho, item.cor)} · ${item.codigo_barras}</span>
      </td>
      ${veDinheiro
        ? cru(html`
            <td class="direita">
              <input data-custo-de="${item.variante_id}" style="width:110px;text-align:right"
                aria-label="Custo de ${item.produto}" />
            </td>
          `)
        : ''}
      <td class="centro">
        <span class="qtd">
          <button data-menos="${item.variante_id}" aria-label="Tirar uma de ${item.produto}">−</button>
          <input data-qtd-de="${item.variante_id}" type="number" min="1" max="${MAX_POR_PECA}"
            step="1" value="${item.quantidade}" aria-label="Quantidade de ${item.produto}" />
          <button data-mais="${item.variante_id}" aria-label="Somar uma de ${item.produto}">+</button>
        </span>
      </td>
      <td class="direita">
        <button class="botao-icone botao-icone--perigo" data-tirar="${item.variante_id}"
          aria-label="Tirar ${item.produto} da conferência">✕</button>
      </td>
    </tr>
  `;
}

const VAZIO = html`
  <div class="vazio" style="border:0;box-shadow:none">
    <p class="vazio__titulo">Diga o que chegou</p>
    <p class="texto-suave">
      <strong>Bipe</strong> a etiqueta, se a peça já tiver uma colada. Ou
      <strong>digite o nome</strong> — "camiseta preta" — e escolha da lista: é o caminho de
      sempre quando a mercadoria chega sem etiqueta, que é o normal de código gerado aqui.
    </p>
  </div>
`;

/**
 * @param {object} opcoes
 * @param {HTMLElement} opcoes.area onde desenhar.
 * @param {object[]} opcoes.itens conferência atual.
 * @param {boolean} opcoes.veDinheiro mostra (e edita) o custo unitário.
 * @param {(itens: object[]) => void} opcoes.aoMudar recebe a lista já alterada.
 * @param {(campo: HTMLInputElement, item: object) => void} opcoes.ligarCusto
 *   liga o campo de dinheiro; fica com quem chama porque o formato de moeda é da view.
 */
export function pintarConferencia({ area, itens, veDinheiro, aoMudar, ligarCusto }) {
  area.innerHTML = itens.length
    ? html`
        <table>
          <thead>
            <tr>
              <th>Peça</th>
              ${veDinheiro ? cru('<th class="direita">Custo unitário</th>') : ''}
              <th class="centro">Quantidade</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${itens.map((i) => linha(i, veDinheiro))}
          </tbody>
        </table>
      `
    : VAZIO;

  const mudarQuantidade = (varianteId, calcular) =>
    aoMudar(
      itens
        .map((i) => (i.variante_id === varianteId ? { ...i, quantidade: calcular(i.quantidade) } : i))
        .filter((i) => i.quantidade > 0),
    );

  area.querySelectorAll('[data-menos]').forEach((b) =>
    b.addEventListener('click', () => mudarQuantidade(Number(b.dataset.menos), (q) => q - 1)),
  );
  area.querySelectorAll('[data-mais]').forEach((b) =>
    b.addEventListener('click', () =>
      mudarQuantidade(Number(b.dataset.mais), (q) => Math.min(q + 1, MAX_POR_PECA)),
    ),
  );
  area.querySelectorAll('[data-tirar]').forEach((b) =>
    b.addEventListener('click', () =>
      aoMudar(itens.filter((i) => i.variante_id !== Number(b.dataset.tirar))),
    ),
  );
  // Digitar 20 em vez de clicar 20 vezes no "+": a sacola do fornecedor vem com dúzias da
  // mesma peça, e o teclado resolve numa tecla o que o botão cobra em vinte.
  area.querySelectorAll('[data-qtd-de]').forEach((campo) =>
    campo.addEventListener('change', () =>
      mudarQuantidade(Number(campo.dataset.qtdDe), () => limpar(campo.value)),
    ),
  );
  itens.forEach((item) => {
    const campo = area.querySelector(`[data-custo-de="${item.variante_id}"]`);
    if (campo) ligarCusto(campo, item);
  });

  return numero(itens.reduce((t, i) => t + i.quantidade, 0));
}
