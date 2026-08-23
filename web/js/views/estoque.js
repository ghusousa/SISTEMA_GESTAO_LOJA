/** Saldos: quanto tem de cada peça agora, e o que já está no mínimo. */

import { ouvir } from '../tempo-real.js';
import { api } from '../api.js';
import { formatar, paraCentavos, somar } from '../dinheiro.js';
import { ir, trocarConsulta } from '../router.js';
import { PODE, pode } from '../permissoes.js';
import {
  carregando,
  comAtraso,
  cru,
  erroBloco,
  etiqueta,
  grade,
  html,
  ligarPaginacao,
  numero,
  paginacao,
  vazio,
} from '../ui.js';
import { ajustarEstoque } from './ajuste.js';

const TAMANHO = 25;

export async function render(raiz, _params, consulta) {
  const veDinheiro = pode(PODE.VER_DINHEIRO);
  const filtros = {
    q: consulta.q || '',
    categoria_id: consulta.categoria_id || '',
    somente_baixo: consulta.somente_baixo === 'true' ? 'true' : '',
    page: Number(consulta.page) || 1,
  };

  raiz.innerHTML = html`
    <div class="pagina">
      <div class="pagina__topo">
        <div>
          <h1>Saldos em estoque</h1>
          <p class="texto-suave">O saldo só muda junto com uma movimentação — tudo fica no extrato.</p>
        </div>
        <div class="pagina__acoes">
          <a class="botao botao--neutro" href="#/estoque/extrato">Ver extrato</a>
          <a class="botao" href="#/estoque/entrada">Registrar entrada</a>
        </div>
      </div>

      <div class="filtros">
        <label class="campo campo--busca">
          <span>Buscar</span>
          <input data-q type="search" placeholder="Produto ou código de barras" value="${filtros.q}" />
        </label>
        <label class="campo">
          <span>Categoria</span>
          <select data-categoria><option value="">Todas</option></select>
        </label>
        <label class="marcador" style="padding-bottom:9px">
          <input type="checkbox" data-baixo ${cru(filtros.somente_baixo ? 'checked' : '')} />
          <span>Só o que precisa repor</span>
        </label>
      </div>

      <div data-resumo></div>
      <div data-lista></div>
    </div>
  `;

  const areaLista = raiz.querySelector('[data-lista]');
  const areaResumo = raiz.querySelector('[data-resumo]');
  const campoBusca = raiz.querySelector('[data-q]');
  const seletor = raiz.querySelector('[data-categoria]');
  const marcadorBaixo = raiz.querySelector('[data-baixo]');

  api
    .get('/categorias', { size: 100 })
    .then(({ items }) => {
      seletor.innerHTML =
        '<option value="">Todas</option>' +
        items.map((c) => html`<option value="${c.id}">${c.nome}</option>`).join('');
      seletor.value = filtros.categoria_id;
    })
    .catch(() => {});

  async function carregar() {
    areaLista.innerHTML = carregando();
    trocarConsulta(filtros);
    try {
      const pagina = await api.get('/estoque/saldos', { ...filtros, size: TAMANHO });
      desenhar(pagina);
    } catch (erro) {
      areaLista.innerHTML = erroBloco(erro.textoAmigavel);
    }
  }

  function desenhar(pagina) {
    const pecas = somar(pagina.items.map((i) => i.saldo));
    const emCusto = veDinheiro ? somar(pagina.items.map((i) => paraCentavos(i.valor_em_custo))) : 0;
    const repor = pagina.items.filter((i) => i.estoque_baixo).length;

    areaResumo.innerHTML = html`
      <div class="grade-cartoes">
        <div class="indicador">
          <div class="indicador__rotulo">Peças nesta página</div>
          <div class="indicador__valor">${numero(pecas)}</div>
          <div class="indicador__nota">de ${numero(pagina.total)} itens de grade no filtro</div>
        </div>
        ${veDinheiro
          ? cru(html`
              <div class="indicador">
                <div class="indicador__rotulo">Valor em custo</div>
                <div class="indicador__valor dinheiro">${formatar(emCusto)}</div>
                <div class="indicador__nota">o que está parado nesta página</div>
              </div>
            `)
          : ''}
        <div class="indicador">
          <div class="indicador__rotulo">Precisam repor</div>
          <div class="indicador__valor">${numero(repor)}</div>
          <div class="indicador__nota">no estoque mínimo ou abaixo</div>
        </div>
      </div>
    `;

    if (!pagina.items.length) {
      areaLista.innerHTML = vazio(
        'Nada aqui',
        filtros.somente_baixo
          ? 'Nenhuma peça no estoque mínimo. Está tudo abastecido.'
          : 'Ajuste a busca ou registre uma entrada de mercadoria.',
      );
      return;
    }

    areaLista.innerHTML = html`
      <div class="tabela-rolagem">
        <table>
          <thead>
            <tr>
              <th>Peça</th>
              <th>Código</th>
              <th class="direita">Preço</th>
              ${veDinheiro ? cru('<th class="direita">Custo parado</th>') : ''}
              <th class="direita">Mínimo</th>
              <th class="direita">Saldo</th>
              ${veDinheiro ? cru('<th class="direita">Ajustar</th>') : ''}
            </tr>
          </thead>
          <tbody>
            ${pagina.items.map(linha)}
          </tbody>
        </table>
      </div>
      ${paginacao({ total: pagina.total, page: pagina.page, size: pagina.size })}
    `;

    areaLista.querySelectorAll('[data-produto]').forEach((el) =>
      el.addEventListener('click', () => ir(`/produtos/${el.dataset.produto}`)),
    );
    areaLista.querySelectorAll('[data-ajustar]').forEach((b) =>
      b.addEventListener('click', async () => {
        const item = pagina.items.find((i) => i.variante_id === Number(b.dataset.ajustar));
        if (await ajustarEstoque(item)) carregar();
      }),
    );
    ligarPaginacao(areaLista, (p) => {
      filtros.page = p;
      carregar();
    });
  }

  function linha(item) {
    return html`
      <tr>
        <td>
          <a class="celula-principal" href="#/produtos/${item.produto_id}" data-produto="${item.produto_id}"
             style="color:inherit;text-decoration:none">${item.produto}</a>
          <span class="celula-secundaria">${grade(item.tamanho, item.cor)} · ${item.categoria}</span>
        </td>
        <td class="dinheiro texto-suave">${item.codigo_barras}</td>
        <td class="direita dinheiro">${formatar(paraCentavos(item.preco_venda))}</td>
        ${veDinheiro
          ? cru(html`<td class="direita dinheiro texto-suave">${formatar(paraCentavos(item.valor_em_custo))}</td>`)
          : ''}
        <td class="direita dinheiro texto-suave">${numero(item.estoque_minimo)}</td>
        <td class="direita">
          ${item.saldo === 0
            ? etiqueta('Zerado', 'perigo')
            : item.estoque_baixo
              ? etiqueta(`${numero(item.saldo)} · repor`, 'alerta')
              : cru(html`<strong class="dinheiro">${numero(item.saldo)}</strong>`)}
        </td>
        ${veDinheiro
          ? cru(html`
              <td class="direita">
                <button class="botao-icone" data-ajustar="${item.variante_id}" title="Ajustar saldo"
                  aria-label="Ajustar saldo de ${item.produto} ${grade(item.tamanho, item.cor)}">⚖️</button>
              </td>
            `)
          : ''}
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
  marcadorBaixo.addEventListener('change', () => {
    filtros.somente_baixo = marcadorBaixo.checked ? 'true' : '';
    filtros.page = 1;
    carregar();
  });

  await carregar();

  // Alguém mexeu nisto de outro aparelho: a tela se refaz sozinha. O roteador
  // chama a função devolvida ao trocar de tela, e é ela que cancela a inscrição —
  // sem isso, telas antigas continuariam mandando recarregar o que saiu de cena.
  return ouvir(['estoque', 'catalogo', 'reconectado'], () => void carregar());
}
