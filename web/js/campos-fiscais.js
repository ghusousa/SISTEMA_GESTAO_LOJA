/**
 * Dados fiscais do produto (ADR-41): NCM, CEST, origem e CFOP. Usado no cadastro e na
 * edição. Espelho de `mobile/src/lib/fiscal.ts` — mudou um, mude o outro.
 *
 * Nada aqui é obrigatório: a peça nasce sem NCM e a emissão da NFC-e é quem recusa,
 * dizendo o que falta. Quem sabe o NCM e o CFOP de cada peça é o contador da loja.
 * O servidor aceita "6109.10.00" e guarda só os dígitos.
 */

import { cru, html } from './ui.js';

export const CFOP_PADRAO = '5102';

export const ORIGENS = [
  [0, '0 — Nacional'],
  [1, '1 — Estrangeira, importação direta'],
  [2, '2 — Estrangeira, comprada no mercado interno'],
  [3, '3 — Nacional, mais de 40% importado'],
  [4, '4 — Nacional, processo produtivo básico'],
  [5, '5 — Nacional, até 40% importado'],
  [6, '6 — Estrangeira direta, sem similar nacional'],
  [7, '7 — Estrangeira interna, sem similar nacional'],
  [8, '8 — Nacional, mais de 70% importado'],
];

/** "61091000" → "6109.10.00", como vem no papel do contador. */
export const ncmFormatado = (ncm) => (ncm ? ncm.replace(/^(\d{4})(\d{2})(\d{2})$/, '$1.$2.$3') : '');
export const cestFormatado = (cest) => (cest ? cest.replace(/^(\d{2})(\d{3})(\d{2})$/, '$1.$2.$3') : '');

/** Os campos, dentro de um bloco que abre sozinho quando a peça ainda não tem NCM. */
export function camposFiscais(produto = {}, { aberto = false } = {}) {
  return html`
    <details class="campo" ${cru(aberto ? 'open' : '')}>
      <summary>Dados fiscais (NFC-e) <span class="campo__dica">opcional · o contador informa</span></summary>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px;margin-top:8px">
        <label class="campo">
          <span>NCM <span class="campo__dica">8 dígitos</span></span>
          <input data-fiscal="ncm" value="${ncmFormatado(produto.ncm)}" maxlength="12" inputmode="numeric" placeholder="6109.10.00" />
        </label>
        <label class="campo">
          <span>CEST <span class="campo__dica">só com ST</span></span>
          <input data-fiscal="cest" value="${cestFormatado(produto.cest)}" maxlength="12" inputmode="numeric" placeholder="28.038.00" />
        </label>
        <label class="campo">
          <span>CFOP</span>
          <input data-fiscal="cfop" value="${produto.cfop || CFOP_PADRAO}" maxlength="5" inputmode="numeric" />
        </label>
        <label class="campo">
          <span>Origem</span>
          <select data-fiscal="origem">
            ${ORIGENS.map(([v, rotulo]) => html`<option value="${v}" ${cru(Number(produto.origem ?? 0) === v ? 'selected' : '')}>${rotulo}</option>`)}
          </select>
        </label>
      </div>
    </details>
  `;
}

/** O que mandar no POST/PATCH. Vazio vira `null` (apaga), e o servidor valida o formato. */
export function lerCamposFiscais(raiz) {
  const valor = (campo) => raiz.querySelector(`[data-fiscal="${campo}"]`)?.value.trim() ?? '';
  return {
    ncm: valor('ncm') || null,
    cest: valor('cest') || null,
    cfop: valor('cfop') || CFOP_PADRAO,
    origem: Number(valor('origem') || 0),
  };
}

/** Uma linha para o detalhe do produto. Sem NCM, avisa: a nota desta peça não sai. */
export function resumoFiscal(produto) {
  if (!produto.ncm) return 'Sem NCM: a NFC-e com esta peça não sai até o contador informar.';
  const partes = [`NCM ${ncmFormatado(produto.ncm)}`, `CFOP ${produto.cfop}`, `origem ${produto.origem}`];
  if (produto.cest) partes.splice(1, 0, `CEST ${cestFormatado(produto.cest)}`);
  return partes.join(' · ');
}
