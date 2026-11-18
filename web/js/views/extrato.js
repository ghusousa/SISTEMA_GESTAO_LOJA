/**
 * Extrato de estoque: toda mudança de saldo, com autor e motivo.
 *
 * É a tela que responde "cadê a peça que sumiu": entrada, venda, estorno, ajuste e
 * inventário aparecem em ordem, cada um com o saldo que ficou depois.
 */

import { api } from '../api.js';
import { trocarConsulta } from '../router.js';
import {
  TIPOS_MOVIMENTO,
  ajuda,
  carregando,
  cru,
  dataHora,
  diasAtrasISO,
  erroBloco,
  etiqueta,
  grade,
  hojeISO,
  html,
  ligarPaginacao,
  numero,
  paginacao,
  vazio,
} from '../ui.js';

const TAMANHO = 30;

const TOM = {
  ENTRADA: 'ok',
  ESTORNO: 'info',
  DEVOLUCAO: 'info',
  VENDA: 'neutro',
  AJUSTE: 'alerta',
  INVENTARIO: 'alerta',
  CONDICIONAL_SAIDA: 'info',
  CONDICIONAL_RETORNO: 'info',
};

export async function render(raiz, _params, consulta) {
  const filtros = {
    tipo: consulta.tipo || '',
    inicio: consulta.inicio || diasAtrasISO(30),
    fim: consulta.fim || hojeISO(),
    page: Number(consulta.page) || 1,
  };

  raiz.innerHTML = html`
    <div class="pagina">
      <div class="pagina__topo">
        <div>
          <h1>Extrato de estoque</h1>
          <p class="texto-suave">Cada linha é uma mudança de saldo: quem fez, quando e por quê.</p>
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
          <span>Tipo ${ajuda('Venda é a baixa do PDV; Entrada é o que chegou do fornecedor; Ajuste e Inventário são acertos de contagem; Estorno é venda cancelada; Devolução é peça que a cliente trouxe de volta; Condicional é a peça que foi para a casa da cliente provar e a que voltou — o que ela ficou aparece logo depois como Venda.')}</span>
          <select data-tipo>
            <option value="">Todos</option>
            ${Object.entries(TIPOS_MOVIMENTO).map(
              ([valor, texto]) =>
                html`<option value="${valor}" ${cru(filtros.tipo === valor ? 'selected' : '')}>${texto}</option>`,
            )}
          </select>
        </label>
      </div>

      <div data-lista></div>
    </div>
  `;

  const areaLista = raiz.querySelector('[data-lista]');

  async function carregar() {
    areaLista.innerHTML = carregando();
    trocarConsulta(filtros);
    try {
      const pagina = await api.get('/estoque/movimentacoes', { ...filtros, size: TAMANHO });
      desenhar(pagina);
    } catch (erro) {
      areaLista.innerHTML = erroBloco(erro.textoAmigavel);
    }
  }

  function desenhar(pagina) {
    if (!pagina.items.length) {
      areaLista.innerHTML = vazio('Nenhuma movimentação no período', 'Aumente o intervalo de datas ou tire o filtro de tipo.');
      return;
    }

    areaLista.innerHTML = html`
      <div class="tabela-rolagem">
        <table>
          <thead>
            <tr>
              <th>Quando</th>
              <th>Peça</th>
              <th>Tipo</th>
              <th class="direita">Movimento</th>
              <th class="direita">Saldo depois ${ajuda('Quanto tinha daquela peça logo depois desse movimento. Não é o saldo de hoje: para o de agora, veja Estoque > Saldos.')}</th>
              <th>Quem / motivo</th>
            </tr>
          </thead>
          <tbody>
            ${pagina.items.map(linha)}
          </tbody>
        </table>
      </div>
      ${paginacao({ total: pagina.total, page: pagina.page, size: pagina.size })}
    `;

    ligarPaginacao(areaLista, (p) => {
      filtros.page = p;
      carregar();
    });
  }

  function linha(m) {
    const entrou = m.quantidade > 0;
    const referencia = m.venda_id
      ? `venda #${m.venda_id}`
      : m.entrada_id
        ? `entrada #${m.entrada_id}`
        : m.condicional_id
          ? `condicional #${m.condicional_id}`
          : '';
    return html`
      <tr>
        <td class="texto-suave" style="white-space:nowrap">${dataHora(m.criado_em)}</td>
        <td>
          <span class="celula-principal">${m.produto}</span>
          <span class="celula-secundaria">${grade(m.tamanho, m.cor)} · ${m.codigo_barras}</span>
        </td>
        <td>${etiqueta(TIPOS_MOVIMENTO[m.tipo] || m.tipo, TOM[m.tipo] || 'neutro')}</td>
        <td class="direita dinheiro celula-principal ${cru(entrou ? 'positivo' : 'negativo')}">
          ${entrou ? '+' : '−'}${numero(Math.abs(m.quantidade))}
        </td>
        <td class="direita dinheiro">${numero(m.saldo_apos)}</td>
        <td>
          <span>${m.usuario}</span>
          ${m.observacao || referencia
            ? cru(html`<span class="celula-secundaria">${m.observacao || referencia}</span>`)
            : ''}
          ${m.condicional_id
            ? cru(html`<a class="celula-secundaria" href="#/condicionais/${m.condicional_id}">Abrir a condicional</a>`)
            : ''}
        </td>
      </tr>
    `;
  }

  ['[data-inicio]', '[data-fim]', '[data-tipo]'].forEach((seletor) => {
    raiz.querySelector(seletor).addEventListener('change', (e) => {
      const chave = seletor.replace('[data-', '').replace(']', '');
      filtros[chave] = e.target.value;
      filtros.page = 1;
      carregar();
    });
  });

  await carregar();
}
