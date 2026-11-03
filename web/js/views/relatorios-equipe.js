/**
 * "Vendas por vendedora", o cartão da comissão na tela de Relatórios (ADR-37).
 *
 * Líquido = vendido − devolvido NO PERÍODO, e a devolução pesa para quem fez a venda
 * original (não para quem atendeu a troca). Por isso o líquido de alguém pode ficar
 * negativo num período só de devoluções: é o estorno da comissão já paga. A soma da equipe
 * fecha com o faturamento líquido do resumo. A comissão vai pela % de cada venda (a que
 * valia quando ela aconteceu); a coluna % é a de hoje — por isso líquido × % pode não dar
 * a comissão da linha num período em que o dono mudou a %.
 *
 * Paginado no servidor como toda listagem; os totais (líquido e comissão a pagar) vêm
 * prontos e valem para a equipe INTEIRA — é a folha do período, não a da página.
 */

import { api } from '../api.js';
import { formatar, formatarPercentual, paraCentavos } from '../dinheiro.js';
import {
  ajuda,
  carregando,
  cru,
  erroBloco,
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
      <h2>Vendas por vendedora ${ajuda('Vendido menos o que voltou de devolução no período, por quem fez a venda. A comissão é este líquido vezes a % que valia em CADA venda, quando ela aconteceu; a coluna % é a de hoje (definida pelo dono em Usuários), a que vale para as vendas novas. Venda cancelada não conta.')}</h2>
      <span class="texto-fraco">${nota}</span>
    </div>
    ${corpo}
  </div>
`;

const dinheiro = (valor, classe = '') => {
  const centavos = paraCentavos(valor);
  return cru(html`<span class="dinheiro ${cru(centavos < 0 ? 'negativo' : classe)}">${formatar(centavos)}</span>`);
};

const linha = (v) => html`
  <tr>
    <td><span class="celula-principal">${v.nome}</span></td>
    <td class="direita dinheiro">${numero(v.quantidade_vendas)}</td>
    <td class="direita dinheiro">${numero(v.pecas)}</td>
    <td class="direita">${dinheiro(v.faturamento)}</td>
    <td class="direita texto-suave">${paraCentavos(v.devolucoes) ? dinheiro(v.devolucoes) : '—'}</td>
    <td class="direita celula-principal">${dinheiro(v.faturamento_liquido)}</td>
    <td class="direita">${dinheiro(v.ticket_medio)}</td>
    <td class="direita texto-suave">${formatarPercentual(v.comissao_percentual, 2)}</td>
    <td class="direita">${dinheiro(v.comissao, 'positivo')}</td>
  </tr>
`;

/** Busca e desenha a página `pagina` do período; `aoMudarPagina(n)` vem dos botões. */
export async function desenharEquipe(area, periodo, pagina, aoMudarPagina) {
  area.innerHTML = cartao('', carregando('Somando a equipe…'));
  let dados;
  try {
    dados = await api.get('/relatorios/vendedoras', { ...periodo, page: pagina, size: POR_PAGINA });
  } catch (erro) {
    area.innerHTML = cartao('', erroBloco(erro.textoAmigavel));
    return;
  }
  if (!dados.items.length && dados.total > 0 && pagina > 1) {
    aoMudarPagina(1);
    return;
  }
  if (!dados.total) {
    area.innerHTML = cartao('', cru(`<div class="cartao__corpo">${vazio('Nenhuma venda no período', '')}</div>`));
    return;
  }
  area.innerHTML = cartao(
    `${plural(dados.total, 'pessoa', 'pessoas')} · comissão a pagar ${formatar(paraCentavos(dados.comissao_total))}`,
    html`
      <div class="tabela-rolagem" style="border:0;box-shadow:none;border-radius:0">
        <table>
          <thead>
            <tr>
              <th>Vendedora</th>
              <th class="direita">Vendas</th>
              <th class="direita">Peças</th>
              <th class="direita">Vendeu</th>
              <th class="direita">Voltou</th>
              <th class="direita">Líquido</th>
              <th class="direita">Ticket</th>
              <th class="direita">%</th>
              <th class="direita">Comissão</th>
            </tr>
          </thead>
          <tbody>${dados.items.map(linha)}</tbody>
          <tfoot>
            <tr>
              <td colspan="5" class="celula-principal">Equipe inteira no período</td>
              <td class="direita celula-principal">${dinheiro(dados.faturamento_liquido_total)}</td>
              <td colspan="2"></td>
              <td class="direita celula-principal">${dinheiro(dados.comissao_total, 'positivo')}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      ${paginacao({ total: dados.total, page: dados.page, size: dados.size })}
    `,
  );
  ligarPaginacao(area, aoMudarPagina);
}
