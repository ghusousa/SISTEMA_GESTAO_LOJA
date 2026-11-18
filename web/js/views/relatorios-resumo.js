/**
 * Os cartões do resumo na tela de Relatórios: faturamento, devoluções, custo, lucro bruto,
 * despesas, taxas de cartão, resultado e ticket médio do período.
 *
 * As contas são as da API (`RelatorioService.resumo`), e a tela mostra cada parcela delas —
 * quem somar os cartões chega no número do cartão seguinte:
 *   lucro bruto = faturamento − devoluções − custo da mercadoria + custo do que voltou ao estoque
 *   resultado   = lucro bruto − despesas (− taxas de cartão, quando o servidor as calcula)
 * Sem o cartão de devoluções, faturamento − custo não dava o lucro bruto. O app mostra as
 * mesmas linhas no Financeiro (`mobile/src/lib/resumoFinanceiro.ts`).
 */

import { formatar, formatarPercentual, paraCentavos } from '../dinheiro.js';
import { ajuda, cru, html, plural } from '../ui.js';

export function cartoesDoResumo(resumo) {
  const resultado = paraCentavos(resumo.resultado);
  // Taxa da maquininha: o servidor que a calcula manda o campo e já a tira do resultado.
  // Servidor sem o cálculo não manda, e o cartão some — nada de "R$ 0,00" que engana.
  const temTaxas = resumo.taxas_cartao !== undefined && resumo.taxas_cartao !== null;
  // Devolução é exceção: o cartão só aparece no período que teve uma.
  const devolvido = paraCentavos(resumo.devolucoes ?? '0');
  const custoQueVoltou = paraCentavos(resumo.cmv_devolvido ?? '0');

  return html`
  <div class="grade-cartoes">
    <div class="indicador indicador--destaque">
      <div class="indicador__rotulo">Faturamento ${ajuda('Tudo que foi vendido no período, inclusive o que saiu no fiado e ainda não foi recebido. Venda cancelada fica de fora.')}</div>
      <div class="indicador__valor dinheiro">${formatar(paraCentavos(resumo.faturamento))}</div>
      <div class="indicador__nota">
        ${plural(resumo.quantidade_vendas, 'venda', 'vendas')} ·
        ${plural(resumo.quantidade_pecas, 'peça', 'peças')}
      </div>
    </div>
    ${devolvido > 0
      ? cru(html`
          <div class="indicador">
            <div class="indicador__rotulo">Devoluções ${ajuda('O que voltou para as clientes no período (em dinheiro, no cartão ou em vale), contado no dia em que a peça voltou. Sai do faturamento; e a peça que voltou ao estoque devolve também o custo dela.')}</div>
            <div class="indicador__valor dinheiro">${formatar(devolvido)}</div>
            <div class="indicador__nota">
              ${custoQueVoltou > 0
                ? `${formatar(custoQueVoltou)} de custo voltou com as peças ao estoque`
                : plural(resumo.pecas_devolvidas ?? 0, 'peça devolvida', 'peças devolvidas')}
            </div>
          </div>
        `)
      : ''}
    <div class="indicador">
      <div class="indicador__rotulo">Custo da mercadoria ${ajuda('O que você pagou ao fornecedor pelas peças que saíram. O custo fica congelado na venda: mudar o preço de compra hoje não mexe no lucro de ontem.')}</div>
      <div class="indicador__valor dinheiro">${formatar(paraCentavos(resumo.custo_mercadoria_vendida))}</div>
      <div class="indicador__nota">o que a loja pagou pelas peças vendidas</div>
    </div>
    <div class="indicador">
      <div class="indicador__rotulo">Lucro bruto ${ajuda('Faturamento − devoluções − custo da mercadoria + o custo das peças devolvidas que voltaram ao estoque. As despesas ficam de fora.')}</div>
      <div class="indicador__valor dinheiro">${formatar(paraCentavos(resumo.lucro_bruto))}</div>
      <div class="indicador__nota">margem de ${formatarPercentual(resumo.margem_bruta_pct)}</div>
    </div>
    <div class="indicador">
      <div class="indicador__rotulo">Despesas</div>
      <div class="indicador__valor dinheiro">${formatar(paraCentavos(resumo.despesas))}</div>
      <div class="indicador__nota">lançadas no período</div>
    </div>
    ${temTaxas
      ? cru(html`
          <div class="indicador">
            <div class="indicador__rotulo">Taxas de cartão ${ajuda('O que a maquininha ficou das vendas no débito e no crédito do período. Já sai do resultado ao lado.')}</div>
            <div class="indicador__valor dinheiro">${formatar(paraCentavos(resumo.taxas_cartao))}</div>
            <div class="indicador__nota">descontadas do resultado</div>
          </div>
        `)
      : ''}
    <div class="indicador">
      <div class="indicador__rotulo">Resultado</div>
      <div class="indicador__valor dinheiro ${cru(resultado < 0 ? 'negativo' : 'positivo')}">
        ${formatar(resultado)}
      </div>
      <div class="indicador__nota">${temTaxas ? 'lucro bruto menos despesas e taxas de cartão' : 'lucro bruto menos despesas'}</div>
    </div>
    <div class="indicador">
      <div class="indicador__rotulo">Ticket médio ${ajuda('Quanto cada venda trouxe, em média: o faturamento dividido pelo número de vendas do período.')}</div>
      <div class="indicador__valor dinheiro">${formatar(paraCentavos(resumo.ticket_medio))}</div>
      <div class="indicador__nota">
        ${resumo.vendas_canceladas
          ? `${plural(resumo.vendas_canceladas, 'venda cancelada', 'vendas canceladas')} fora da conta`
          : 'nenhuma venda cancelada'}
      </div>
    </div>
  </div>
  `;
}
