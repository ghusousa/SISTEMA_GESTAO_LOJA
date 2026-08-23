/** Catálogo: lista de produtos com busca, filtro por categoria e paginação no servidor. */

import { api } from '../api.js';
import { formatar, paraCentavos } from '../dinheiro.js';
import { ir, trocarConsulta } from '../router.js';
import { PODE, pode } from '../permissoes.js';
import {
  carregando,
  comAtraso,
  cru,
  erroBloco,
  etiqueta,
  html,
  ligarPaginacao,
  numero,
  paginacao,
  plural,
  vazio,
} from '../ui.js';

const TAMANHO = 20;

export async function render(raiz, _params, consulta) {
  const filtros = {
    q: consulta.q || '',
    categoria_id: consulta.categoria_id || '',
    page: Number(consulta.page) || 1,
  };

  raiz.innerHTML = html`
    <div class="pagina">
      <div class="pagina__topo">
        <div>
          <h1>Produtos</h1>
          <p class="texto-suave">Cada produto tem uma grade de peças (tamanho e cor), com código próprio.</p>
        </div>
        <div class="pagina__acoes">
          <a class="botao" href="#/produtos/novo">Novo produto</a>
        </div>
      </div>

      <div class="filtros">
        <label class="campo campo--busca">
          <span>Buscar</span>
          <input data-q type="search" placeholder="Nome do produto ou código de barras" value="${filtros.q}" />
        </label>
        <label class="campo">
          <span>Categoria</span>
          <select data-categoria><option value="">Todas</option></select>
        </label>
      </div>

      <div data-lista></div>
    </div>
  `;

  const areaLista = raiz.querySelector('[data-lista]');
  const campoBusca = raiz.querySelector('[data-q]');
  const seletor = raiz.querySelector('[data-categoria]');

  api
    .get('/categorias', { size: 100 })
    .then(({ items }) => {
      seletor.innerHTML =
        '<option value="">Todas</option>' +
        items.map((c) => html`<option value="${c.id}">${c.nome}</option>`).join('');
      seletor.value = filtros.categoria_id;
    })
    .catch(() => {
      /* Sem categorias o filtro fica só com "Todas": a lista continua funcionando. */
    });

  async function carregar() {
    areaLista.innerHTML = carregando();
    trocarConsulta(filtros);
    try {
      const pagina = await api.get('/produtos', { ...filtros, size: TAMANHO });
      desenhar(pagina);
    } catch (erro) {
      areaLista.innerHTML = erroBloco(erro.textoAmigavel);
    }
  }

  function desenhar(pagina) {
    if (!pagina.items.length) {
      areaLista.innerHTML = vazio(
        filtros.q || filtros.categoria_id ? 'Nenhum produto encontrado' : 'Nenhum produto cadastrado',
        filtros.q || filtros.categoria_id
          ? 'Tente outro termo ou tire o filtro de categoria.'
          : 'Cadastre o primeiro produto para começar a vender.',
        '<a class="botao" href="#/produtos/novo">Novo produto</a>',
      );
      return;
    }

    areaLista.innerHTML = html`
      <div class="tabela-rolagem">
        <table>
          <thead>
            <tr>
              <th>Produto</th>
              <th>Categoria</th>
              <th>Grade</th>
              <th class="direita">Preço</th>
              <th class="direita">Em estoque</th>
            </tr>
          </thead>
          <tbody>
            ${pagina.items.map(linha)}
          </tbody>
        </table>
      </div>
      ${paginacao({ total: pagina.total, page: pagina.page, size: pagina.size })}
    `;

    areaLista.querySelectorAll('[data-abrir]').forEach((tr) =>
      tr.addEventListener('click', () => ir(`/produtos/${tr.dataset.abrir}`)),
    );
    ligarPaginacao(areaLista, (p) => {
      filtros.page = p;
      carregar();
    });
  }

  function linha(produto) {
    // Grade vazia acontece quando todas as peças foram excluídas: sem a guarda,
    // Math.min de lista vazia é Infinity e a coluna de preço vira "R$ NaN".
    const precos = produto.variantes.map((v) => paraCentavos(v.preco_venda));
    const menor = precos.length ? Math.min(...precos) : 0;
    const maior = precos.length ? Math.max(...precos) : 0;
    const semEstoque = produto.saldo_total === 0;
    const baixo = produto.variantes.some((v) => v.saldo <= v.estoque_minimo && v.saldo > 0);

    return html`
      <tr class="clicavel" data-abrir="${produto.id}" tabindex="0">
        <td>
          <span style="display:flex;gap:10px;align-items:center">
            ${produto.foto_url
              ? cru(html`<img class="foto-peca" src="${produto.foto_url}" alt="" loading="lazy" />`)
              : ''}
            <span>
              <span class="celula-principal">${produto.nome}</span>
              ${pode(PODE.VER_DINHEIRO) && produto.variantes[0]?.preco_custo
                ? cru(html`<span class="celula-secundaria">custo ${formatar(paraCentavos(produto.variantes[0].preco_custo))}</span>`)
                : ''}
            </span>
          </span>
        </td>
        <td class="texto-suave">${produto.categoria}</td>
        <td class="texto-suave">${plural(produto.variantes.length, 'peça', 'peças')}</td>
        <td class="direita dinheiro">
          ${!precos.length
            ? cru('<span class="texto-fraco">sem peças</span>')
            : menor === maior
              ? formatar(menor)
              : `${formatar(menor)} – ${formatar(maior)}`}
        </td>
        <td class="direita">
          ${semEstoque
            ? etiqueta('Sem estoque', 'perigo')
            : baixo
              ? etiqueta(`${numero(produto.saldo_total)} · repor`, 'alerta')
              : cru(html`<span class="dinheiro">${numero(produto.saldo_total)}</span>`)}
        </td>
      </tr>
    `;
  }

  const buscar = comAtraso(() => {
    filtros.q = campoBusca.value.trim();
    filtros.page = 1;
    carregar();
  });
  campoBusca.addEventListener('input', buscar);
  seletor.addEventListener('change', () => {
    filtros.categoria_id = seletor.value;
    filtros.page = 1;
    carregar();
  });
  areaLista.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.dataset.abrir) ir(`/produtos/${e.target.dataset.abrir}`);
  });

  await carregar();
}
