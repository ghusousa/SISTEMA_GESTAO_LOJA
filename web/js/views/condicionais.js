/**
 * Condicionais: quem está com o quê, e quem já devia ter devolvido (ADR-39).
 *
 * A peça na casa da cliente não está na arara nem no saldo. Esta lista é o único lugar que
 * diz onde ela está — e a aba "Vencidas" é a lista de ligações do dia: prazo passado no
 * dia da loja, a que venceu primeiro em cima.
 */

import { api } from '../api.js';
import { textoDoPrazo } from '../condicional.js';
import { formatar, paraCentavos } from '../dinheiro.js';
import { ir, trocarConsulta } from '../router.js';
import { ouvir } from '../tempo-real.js';
import {
  ajuda,
  carregando,
  cru,
  data as formatarData,
  erroBloco,
  etiqueta,
  html,
  ligarPaginacao,
  numero,
  paginacao,
  vazio,
} from '../ui.js';

const TAMANHO = 25;

const ABAS = [
  ['abertas', 'Abertas'],
  ['vencidas', 'Vencidas'],
  ['fechadas', 'Fechadas'],
  ['todas', 'Todas'],
];

export async function render(raiz, _params, consulta) {
  const filtros = {
    situacao: consulta.situacao || 'abertas',
    cliente_id: consulta.cliente_id || '',
    page: Number(consulta.page) || 1,
  };

  raiz.innerHTML = html`
    <div class="pagina">
      <div class="pagina__topo">
        <div>
          <h1>Condicional ${ajuda('A peça que a cliente leva para provar em casa. Enquanto está com ela, sai do saldo: ninguém vende de novo no balcão. Quando ela volta, o que voltou entra no estoque e o que ficou vira uma venda comum, com recibo e caixa.')}</h1>
          <p class="texto-suave">Peças na casa da cliente, com prazo para voltar ou virar venda.</p>
        </div>
        <div class="pagina__acoes">
          <button class="botao" data-nova>Nova condicional</button>
        </div>
      </div>

      <div class="filtros" role="tablist">
        ${ABAS.map(
          ([valor, texto]) => html`
            <button class="botao ${cru(filtros.situacao === valor ? '' : 'botao--neutro')} botao--pequeno"
              data-aba="${valor}" role="tab" aria-selected="${filtros.situacao === valor}">${texto}</button>
          `,
        )}
        ${filtros.cliente_id
          ? html`<button class="botao botao--neutro botao--pequeno" data-sem-cliente>Só desta cliente ✕</button>`
          : ''}
      </div>

      <div data-lista></div>
    </div>
  `;

  const areaLista = raiz.querySelector('[data-lista]');

  async function carregar() {
    areaLista.innerHTML = carregando();
    trocarConsulta(filtros);
    try {
      const pagina = await api.get('/condicionais', {
        situacao: filtros.situacao,
        page: filtros.page,
        size: TAMANHO,
        ...(filtros.cliente_id ? { cliente_id: filtros.cliente_id } : {}),
      });
      desenhar(pagina);
    } catch (erro) {
      areaLista.innerHTML = erroBloco(erro.textoAmigavel);
    }
  }

  function desenhar(pagina) {
    if (!pagina.items.length) {
      areaLista.innerHTML = vazio(
        filtros.situacao === 'vencidas' ? 'Nenhuma condicional vencida' : 'Nenhuma condicional aqui',
        filtros.situacao === 'vencidas'
          ? 'Toda peça que saiu está no prazo.'
          : 'Bipe as peças que a cliente vai levar em "Nova condicional".',
      );
      return;
    }
    areaLista.innerHTML = html`
      <div class="tabela-rolagem">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Cliente</th>
              <th class="direita">Peças</th>
              <th class="direita">Valor ${ajuda('Pelo preço de venda de hoje: é por ele que o que ficar com a cliente será cobrado.')}</th>
              <th>Prazo</th>
              <th>Quem atendeu</th>
              <th></th>
            </tr>
          </thead>
          <tbody>${pagina.items.map(linha)}</tbody>
        </table>
      </div>
      ${paginacao({ total: pagina.total, page: pagina.page, size: pagina.size })}
    `;
    areaLista.querySelectorAll('[data-abrir]').forEach((tr) =>
      tr.addEventListener('click', () => ir(`/condicionais/${tr.dataset.abrir}`)),
    );
    ligarPaginacao(areaLista, (p) => {
      filtros.page = p;
      carregar();
    });
  }

  function linha(c) {
    const situacao =
      c.status === 'FECHADA'
        ? etiqueta(c.venda_id ? `Fechada · venda #${c.venda_id}` : 'Fechada · tudo voltou', 'neutro')
        : etiqueta(textoDoPrazo(c.dias_para_vencer), c.vencida ? 'perigo' : 'info');
    return html`
      <tr data-abrir="${c.id}" style="cursor:pointer">
        <td class="texto-suave">#${c.id}</td>
        <td>
          <span class="celula-principal">${c.cliente}</span>
          ${c.cliente_telefone ? cru(html`<span class="celula-secundaria">${c.cliente_telefone}</span>`) : ''}
        </td>
        <td class="direita">${numero(c.total_pecas)}</td>
        <td class="direita dinheiro">${formatar(paraCentavos(c.valor_pecas))}</td>
        <td>
          <span class="celula-principal">${formatarData(c.prazo)}</span>
          <span class="celula-secundaria">${situacao}</span>
        </td>
        <td>${c.vendedora}</td>
        <td class="direita"><a href="#/condicionais/${c.id}">${c.status === 'ABERTA' ? 'Fechar' : 'Ver'}</a></td>
      </tr>
    `;
  }

  raiz.querySelector('[data-nova]').addEventListener('click', () => ir('/condicionais/nova'));
  // Aba e cliente vão pela URL: o roteador redesenha a tela (e desliga o tempo real dela),
  // e o F5 volta na mesma aba.
  const navegar = (mudanca) => {
    const proximo = { ...filtros, ...mudanca, page: 1 };
    const busca = new URLSearchParams({ situacao: proximo.situacao });
    if (proximo.cliente_id) busca.set('cliente_id', proximo.cliente_id);
    ir(`/condicionais?${busca}`);
  };
  raiz.querySelectorAll('[data-aba]').forEach((b) =>
    b.addEventListener('click', () => navegar({ situacao: b.dataset.aba })),
  );
  raiz.querySelector('[data-sem-cliente]')?.addEventListener('click', () => navegar({ cliente_id: '' }));

  await carregar();
  return ouvir(['condicionais', 'reconectado'], () => void carregar());
}
