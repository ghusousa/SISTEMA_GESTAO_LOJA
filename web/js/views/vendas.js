/**
 * Histórico de vendas.
 *
 * O vendedor só enxerga as próprias vendas — quem filtra é o servidor, não esta tela.
 * Aqui o filtro de vendedor nem aparece para ele.
 */

import { api } from '../api.js';
import { formatar, paraCentavos, somar } from '../dinheiro.js';
import { ir, trocarConsulta } from '../router.js';
import { PODE, pode } from '../permissoes.js';
import {
  FORMAS,
  carregando,
  cru,
  dataHora,
  diasAtrasISO,
  erroBloco,
  etiqueta,
  hojeISO,
  html,
  ligarPaginacao,
  numero,
  paginacao,
  plural,
  vazio,
} from '../ui.js';

const TAMANHO = 25;

export async function render(raiz, _params, consulta) {
  const veTodas = pode(PODE.VER_VENDAS_DE_TODOS);
  // O seletor de vendedor é alimentado por GET /usuarios, que exige GERIR_USUARIOS.
  // A supervisora enxerga de quem é cada venda na lista, mas não ganha o filtro:
  // mostrá-lo renderia um 403 e um <select> vazio.
  const filtraPorVendedor = pode(PODE.GERIR_USUARIOS);
  const filtros = {
    inicio: consulta.inicio || diasAtrasISO(7),
    fim: consulta.fim || hojeISO(),
    status: consulta.status || '',
    vendedor_id: consulta.vendedor_id || '',
    page: Number(consulta.page) || 1,
  };

  raiz.innerHTML = html`
    <div class="pagina">
      <div class="pagina__topo">
        <div>
          <h1>Vendas</h1>
          <p class="texto-suave">
            ${veTodas ? 'Todas as vendas da loja.' : 'As vendas que você registrou.'}
          </p>
        </div>
        <div class="pagina__acoes">
          <a class="botao" href="#/pdv">Nova venda</a>
        </div>
      </div>

      <div class="filtros">
        <label class="campo">
          <span>De</span>
          <input data-inicio type="date" value="${filtros.inicio}" />
        </label>
        <label class="campo">
          <span>Até</span>
          <input data-fim type="date" value="${filtros.fim}" />
        </label>
        <label class="campo">
          <span>Situação</span>
          <select data-status>
            <option value="">Todas</option>
            <option value="CONCLUIDA" ${cru(filtros.status === 'CONCLUIDA' ? 'selected' : '')}>Concluídas</option>
            <option value="CANCELADA" ${cru(filtros.status === 'CANCELADA' ? 'selected' : '')}>Canceladas</option>
          </select>
        </label>
        ${filtraPorVendedor
          ? cru(html`
              <label class="campo">
                <span>Vendedor</span>
                <select data-vendedor><option value="">Todos</option></select>
              </label>
            `)
          : ''}
      </div>

      <div data-resumo></div>
      <div data-lista></div>
    </div>
  `;

  const areaLista = raiz.querySelector('[data-lista]');
  const areaResumo = raiz.querySelector('[data-resumo]');
  const seletorVendedor = raiz.querySelector('[data-vendedor]');

  if (filtraPorVendedor) {
    api
      .get('/usuarios', { size: 100 })
      .then(({ items }) => {
        seletorVendedor.innerHTML =
          '<option value="">Todos</option>' +
          items.map((u) => html`<option value="${u.id}">${u.nome}</option>`).join('');
        seletorVendedor.value = filtros.vendedor_id;
      })
      .catch(() => {});
  }

  async function carregar() {
    areaLista.innerHTML = carregando();
    trocarConsulta(filtros);
    try {
      const pagina = await api.get('/vendas', { ...filtros, size: TAMANHO });
      desenhar(pagina);
    } catch (erro) {
      areaLista.innerHTML = erroBloco(erro.textoAmigavel);
    }
  }

  function desenhar(pagina) {
    const concluidas = pagina.items.filter((v) => v.status === 'CONCLUIDA');
    const faturado = somar(concluidas.map((v) => paraCentavos(v.total)));

    areaResumo.innerHTML = html`
      <div class="grade-cartoes">
        <div class="indicador">
          <div class="indicador__rotulo">Vendas nesta página</div>
          <div class="indicador__valor">${numero(concluidas.length)}</div>
          <div class="indicador__nota">de ${numero(pagina.total)} no período</div>
        </div>
        <div class="indicador">
          <div class="indicador__rotulo">Somam</div>
          <div class="indicador__valor dinheiro">${formatar(faturado)}</div>
          <div class="indicador__nota">só as concluídas desta página</div>
        </div>
      </div>
    `;

    if (!pagina.items.length) {
      areaLista.innerHTML = vazio('Nenhuma venda no período', 'Aumente o intervalo de datas ou tire os filtros.');
      return;
    }

    areaLista.innerHTML = html`
      <div class="tabela-rolagem">
        <table>
          <thead>
            <tr>
              <th>Venda</th>
              <th>Quando</th>
              ${veTodas ? cru('<th>Vendedor</th>') : ''}
              <th>Peças</th>
              <th>Pagamento</th>
              <th class="direita">Total</th>
            </tr>
          </thead>
          <tbody>
            ${pagina.items.map(
              (v) => html`
                <tr class="clicavel" data-abrir="${v.id}" tabindex="0">
                  <td>
                    <span class="celula-principal">#${numero(v.id)}</span>
                    ${v.status === 'CANCELADA' ? cru(html`<span class="celula-secundaria">${etiqueta('Cancelada', 'perigo')}</span>`) : ''}
                  </td>
                  <td class="texto-suave" style="white-space:nowrap">${dataHora(v.vendida_em)}</td>
                  ${veTodas ? cru(html`<td class="texto-suave">${v.vendedor}</td>`) : ''}
                  <td class="texto-suave">${plural(v.quantidade_pecas, 'peça', 'peças')}</td>
                  <td class="texto-suave">${v.formas_pagamento.map((f) => FORMAS[f] || f).join(' + ')}</td>
                  <td class="direita dinheiro celula-principal ${cru(v.status === 'CANCELADA' ? 'texto-fraco' : '')}">
                    ${formatar(paraCentavos(v.total))}
                  </td>
                </tr>
              `,
            )}
          </tbody>
        </table>
      </div>
      ${paginacao({ total: pagina.total, page: pagina.page, size: pagina.size })}
    `;

    areaLista.querySelectorAll('[data-abrir]').forEach((tr) => {
      tr.addEventListener('click', () => ir(`/vendas/${tr.dataset.abrir}`));
      tr.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') ir(`/vendas/${tr.dataset.abrir}`);
      });
    });
    ligarPaginacao(areaLista, (p) => {
      filtros.page = p;
      carregar();
    });
  }

  ['inicio', 'fim', 'status', 'vendedor'].forEach((nome) => {
    const elemento = raiz.querySelector(`[data-${nome}]`);
    elemento?.addEventListener('change', () => {
      filtros[nome === 'vendedor' ? 'vendedor_id' : nome] = elemento.value;
      filtros.page = 1;
      carregar();
    });
  });

  await carregar();
}
