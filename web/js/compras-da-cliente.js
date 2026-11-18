/**
 * O histórico de compras de uma cliente — TODAS, não só as do fiado (ADR-36).
 *
 * Sai de `GET /vendas?cliente_id=`, com o escopo de sempre da lista de vendas: quem vê as
 * vendas da equipe vê todas as dela; a vendedora, só as que ela mesma fez. É o que deixa
 * a loja dizer "da última vez você levou M" sem ninguém precisar lembrar.
 */

import { api } from './api.js';
import { formatar, paraCentavos } from './dinheiro.js';
import { FORMAS, avisarErro, dataHora, html, numero } from './ui.js';

const TAMANHO = 10;

const linha = (v) => html`
  <tr>
    <td><a href="#/vendas/${v.id}">Venda #${v.id}</a>${v.status === 'CANCELADA' ? ' (cancelada)' : ''}</td>
    <td>${dataHora(v.vendida_em)}</td>
    <td>${numero(v.quantidade_pecas)} pç · ${v.formas_pagamento.map((f) => FORMAS[f] || f).join(' + ')}</td>
    <td class="direita dinheiro">${formatar(paraCentavos(v.total))}</td>
  </tr>`;

/** Desenha as compras dentro de `area`, com "carregar mais" paginando no servidor. */
export async function mostrarCompras(area, clienteId) {
  let pagina = 0;
  area.innerHTML = html`
    <table><tbody data-compras></tbody></table>
    <p class="texto-suave" data-nada hidden>Nenhuma compra com o nome dela ainda.</p>
    <button class="botao botao--neutro botao--largo" style="margin-top:8px;display:none" data-mais-compras>Mais compras</button>
  `;
  const corpo = area.querySelector('[data-compras]');
  const mais = area.querySelector('[data-mais-compras]');

  async function proxima() {
    mais.disabled = true;
    try {
      pagina += 1;
      const resp = await api.get('/vendas', { cliente_id: clienteId, page: pagina, size: TAMANHO });
      corpo.insertAdjacentHTML('beforeend', resp.items.map(linha).join(''));
      area.querySelector('[data-nada]').hidden = resp.total > 0;
      // `style`, não `hidden`: a classe do botão tem `display` e ganharia do atributo.
      mais.style.display = pagina * TAMANHO >= resp.total ? 'none' : '';
    } catch (erro) {
      avisarErro(erro);
    } finally {
      mais.disabled = false;
    }
  }

  mais.addEventListener('click', () => void proxima());
  await proxima();
}
