/**
 * "Precisa repor", o cartão de baixo da tela de Relatórios.
 *
 * A lista é paginada NO SERVIDOR: numa loja de anos, só as peças esgotadas passam de sete
 * mil, e baixar e desenhar todas de uma vez (1,5 MB) travava a tela. O cartão é a situação
 * de agora, não do período — por isso mora fora da área que a troca de datas redesenha, e
 * sua página vai para a URL (`?repor=`) para o F5 não voltar ao começo.
 */

import { api } from '../api.js';
import { formatar, paraCentavos } from '../dinheiro.js';
import {
  ajuda,
  carregando,
  cru,
  erroBloco,
  etiqueta,
  grade,
  html,
  ligarPaginacao,
  numero,
  paginacao,
  plural,
  vazio,
} from '../ui.js';

const POR_PAGINA = 20;

const cartao = (nota, corpo) => html`
  <div class="cartao" style="margin-top:16px">
    <div class="cartao__topo">
      <h2>Precisa repor ${ajuda('Peças cujo saldo chegou no estoque mínimo que você definiu no cadastro. Peça sem mínimo só aparece quando zera. As mais urgentes vêm primeiro.')}</h2>
      <span class="texto-fraco">${nota}</span>
    </div>
    ${corpo}
  </div>
`;

const linha = (e) => html`
  <tr>
    <td>
      <span class="celula-principal">${e.produto}</span>
      <span class="celula-secundaria">${grade(e.tamanho, e.cor)}</span>
    </td>
    <td class="dinheiro texto-suave">${e.codigo_barras}</td>
    <td class="direita">
      ${e.saldo === 0 ? etiqueta('Zerado', 'perigo') : cru(html`<span class="dinheiro">${numero(e.saldo)}</span>`)}
    </td>
    <td class="direita dinheiro texto-suave">${numero(e.estoque_minimo)}</td>
    <td class="direita dinheiro celula-principal">${numero(e.faltam)}</td>
    <td class="direita dinheiro texto-suave">${formatar(paraCentavos(e.preco_custo) * e.faltam)}</td>
  </tr>
`;

/** Busca e desenha a página `pagina`; `aoMudarPagina(n)` é chamado pelos botões. */
export async function desenharRepor(area, pagina, aoMudarPagina) {
  const situacao = 'situação de agora, não do período';
  area.innerHTML = cartao(situacao, carregando('Conferindo o estoque…'));
  let dados;
  try {
    dados = await api.get('/relatorios/estoque-baixo', { page: pagina, size: POR_PAGINA });
  } catch (erro) {
    area.innerHTML = cartao(situacao, erroBloco(erro.textoAmigavel));
    return;
  }
  // A página guardada na URL pode ter ficado para trás: repuseram peças desde então.
  if (!dados.items.length && dados.total > 0 && pagina > 1) {
    aoMudarPagina(1);
    return;
  }
  if (!dados.total) {
    area.innerHTML = cartao(situacao, cru(`<div class="cartao__corpo">${vazio('Estoque em dia', 'Nenhuma peça no mínimo.')}</div>`));
    return;
  }
  area.innerHTML = cartao(
    `${plural(dados.total, 'peça', 'peças')} · ${situacao}`,
    html`
      <div class="tabela-rolagem" style="border:0;box-shadow:none;border-radius:0">
        <table>
          <thead>
            <tr>
              <th>Peça</th>
              <th>Código</th>
              <th class="direita">Saldo</th>
              <th class="direita">Mínimo</th>
              <th class="direita">Faltam</th>
              <th class="direita">Custo para repor</th>
            </tr>
          </thead>
          <tbody>${dados.items.map(linha)}</tbody>
        </table>
      </div>
      ${paginacao({ total: dados.total, page: dados.page, size: dados.size })}
    `,
  );
  ligarPaginacao(area, aoMudarPagina);
}
