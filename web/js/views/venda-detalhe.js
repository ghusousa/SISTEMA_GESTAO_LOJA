/**
 * Detalhe de uma venda, e o cancelamento.
 *
 * Cancelar não apaga nada: a venda fica com status CANCELADA e as peças voltam ao estoque
 * por uma movimentação de ESTORNO. O motivo é obrigatório e aparece aqui para sempre.
 *
 * Com NFC-e autorizada, o motivo vai para a SEFAZ (mínimo de 15 letras) e a nota é
 * cancelada ANTES da venda: se o emissor recusar, a venda não é cancelada (ADR-41).
 */

import { api } from '../api.js';
import { formatar, paraCentavos } from '../dinheiro.js';
import { cartaoNfce, situacaoDaNfce } from '../nfce.js';
import { recarregarRota } from '../router.js';
import { PODE, pode } from '../permissoes.js';
import {
  ajuda,
  aviso,
  avisarErro,
  carregando,
  cru,
  dataHora,
  erroBloco,
  etiqueta,
  grade,
  html,
  numero,
  perguntarTexto,
  plural,
  rotuloPagamento,
} from '../ui.js';

export async function render(raiz, { id }) {
  raiz.innerHTML = `<div class="pagina">${carregando()}</div>`;
  const veDinheiro = pode(PODE.VER_DINHEIRO);

  let venda;
  let nfce;
  try {
    // A nota vem junto e nunca derruba a tela: sem ela, o detalhe da venda segue igual.
    [venda, nfce] = await Promise.all([api.get(`/vendas/${id}`), situacaoDaNfce(id)]);
  } catch (erro) {
    raiz.innerHTML = `<div class="pagina">${erroBloco(erro.textoAmigavel)}</div>`;
    return;
  }

  const cancelada = venda.status === 'CANCELADA';
  const subtotal = paraCentavos(venda.subtotal);
  const desconto = paraCentavos(venda.desconto);
  const total = paraCentavos(venda.total);
  const custo = veDinheiro ? venda.itens.reduce((t, i) => t + paraCentavos(i.custo_unitario ?? 0) * i.quantidade, 0) : 0;
  const lucro = total - custo;

  raiz.innerHTML = html`
    <div class="pagina">
      <div class="pagina__topo">
        <div>
          <a class="botao botao--fantasma botao--pequeno" href="#/vendas">← Vendas</a>
          <h1>Venda #${numero(venda.id)} ${cancelada ? cru(etiqueta('Cancelada', 'perigo')) : ''}</h1>
          <p class="texto-suave">
            ${dataHora(venda.vendida_em)} · ${venda.vendedor} ·
            ${plural(venda.quantidade_pecas, 'peça', 'peças')}
            ${venda.cliente ? cru(html` · cliente <strong>${venda.cliente}</strong>`) : ''}
          </p>
        </div>
        <div class="pagina__acoes">
          <a class="botao botao--fantasma" href="#/vendas/${venda.id}/recibo">Recibo</a>
          ${!cancelada && pode(PODE.DEVOLVER_VENDA)
            ? cru(html`<a class="botao" href="#/vendas/devolucao?venda=${venda.id}">Devolver peça</a>${ajuda('O valor volta pelas mesmas formas em que a cliente pagou, e o que não couber vira vale. Troca é isto mais uma venda nova.')}`)
            : ''}
          ${!cancelada && pode(PODE.CANCELAR_VENDA)
            ? cru(html`<button class="botao botao--perigo" data-cancelar>Cancelar venda</button>${ajuda('Desfaz a venda inteira: as peças voltam ao estoque e o motivo fica guardado. Se alguma peça já foi devolvida, devolva o resto em vez de cancelar.')}`)
            : ''}
        </div>
      </div>

      ${cancelada
        ? cru(html`
            <div class="vazio vazio--erro" style="text-align:left;padding:16px">
              <p class="vazio__titulo">Venda cancelada em ${dataHora(venda.cancelada_em)}</p>
              <p class="texto-suave">Motivo: ${venda.motivo_cancelamento || '—'}</p>
              <p class="texto-suave">As peças voltaram ao estoque por uma movimentação de estorno.</p>
            </div>
          `)
        : ''}

      <div class="grade-cartoes" style="margin-top:16px">
        <div class="indicador indicador--destaque">
          <div class="indicador__rotulo">Total</div>
          <div class="indicador__valor dinheiro">${formatar(total)}</div>
          <div class="indicador__nota">${venda.pagamentos.map((p) => rotuloPagamento(p)).join(' + ')}</div>
        </div>
        ${veDinheiro
          ? cru(html`
              <div class="indicador">
                <div class="indicador__rotulo">Custo das peças ${ajuda('O que a loja pagou ao fornecedor por estas peças. Fica congelado: mudar o custo amanhã não altera esta venda. Vendedora e supervisora não veem este número.')}</div>
                <div class="indicador__valor dinheiro">${formatar(custo)}</div>
                <div class="indicador__nota">congelado no momento da venda</div>
              </div>
              <div class="indicador">
                <div class="indicador__rotulo">Lucro bruto ${ajuda('Total da venda menos o custo das peças. Não desconta as despesas da loja nem a taxa da maquininha — o Resultado dos relatórios desconta as duas.')}</div>
                <div class="indicador__valor dinheiro ${cru(lucro < 0 ? 'negativo' : 'positivo')}">${formatar(lucro)}</div>
                <div class="indicador__nota">
                  ${total > 0 ? `${numero(Math.round((lucro / total) * 100))}% do total` : '—'}
                </div>
              </div>
            `)
          : ''}
      </div>

      <div class="tabela-rolagem" style="margin-top:16px">
        <table>
          <thead>
            <tr>
              <th>Peça</th>
              <th class="direita">Preço</th>
              ${veDinheiro ? cru('<th class="direita">Custo</th>') : ''}
              <th class="centro">Qtd</th>
              <th class="direita">Total</th>
            </tr>
          </thead>
          <tbody>
            ${venda.itens.map(
              (i) => html`
                <tr>
                  <td>
                    <span class="celula-principal">${i.produto}</span>
                    <span class="celula-secundaria">${grade(i.tamanho, i.cor)} · ${i.codigo_barras}</span>
                  </td>
                  <td class="direita dinheiro">${formatar(paraCentavos(i.preco_unitario))}</td>
                  ${veDinheiro
                    ? cru(html`<td class="direita dinheiro texto-suave">${formatar(paraCentavos(i.custo_unitario ?? 0))}</td>`)
                    : ''}
                  <td class="centro dinheiro">
                    ${numero(i.quantidade)}
                    ${(i.quantidade_devolvida || 0) > 0
                      ? cru(html`<span class="celula-secundaria alerta">${numero(i.quantidade_devolvida)} devolvida(s)</span>`)
                      : ''}
                  </td>
                  <td class="direita dinheiro celula-principal">${formatar(paraCentavos(i.total_item))}</td>
                </tr>
              `,
            )}
          </tbody>
          <tfoot>
            <tr>
              <td colspan="${cru(veDinheiro ? 3 : 2)}" class="direita">Subtotal</td>
              <td colspan="2" class="direita dinheiro">${formatar(subtotal)}</td>
            </tr>
            ${desconto > 0
              ? cru(html`
                  <tr>
                    <td colspan="${cru(veDinheiro ? 3 : 2)}" class="direita">Desconto</td>
                    <td colspan="2" class="direita dinheiro negativo">− ${formatar(desconto)}</td>
                  </tr>
                `)
              : ''}
            <tr>
              <td colspan="${cru(veDinheiro ? 3 : 2)}" class="direita">Total</td>
              <td colspan="2" class="direita dinheiro">${formatar(total)}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      <div class="cartao" style="margin-top:16px">
        <div class="cartao__topo"><h2>Pagamento</h2></div>
        <div class="cartao__corpo">
          ${venda.pagamentos.map(
            (p) => html`
              <div class="pagamento-linha">
                <strong>${rotuloPagamento(p)}</strong>
                ${veDinheiro && paraCentavos(p.taxa) > 0
                  ? cru(html`<span class="texto-suave">maquininha ${formatar(paraCentavos(p.taxa))} (${p.taxa_percentual}%)</span>`)
                  : ''}
                <span class="dinheiro">${formatar(paraCentavos(p.valor))}</span>
              </div>
            `,
          )}
          ${venda.observacao ? cru(html`<p class="texto-suave">Observação: ${venda.observacao}</p>`) : ''}
        </div>
      </div>

      <div data-nfce></div>
    </div>
  `;

  cartaoNfce(raiz.querySelector('[data-nfce]'), venda, nfce);

  raiz.querySelector('[data-cancelar]')?.addEventListener('click', async (evento) => {
    const comNota = nfce?.nota?.status === 'AUTORIZADA';
    const motivo = await perguntarTexto({
      titulo: `Cancelar a venda #${venda.id}`,
      rotulo: comNota
        ? 'Por que esta venda está sendo cancelada? A NFC-e será cancelada junto, e o motivo vai para a SEFAZ (mínimo 15 letras).'
        : 'Por que esta venda está sendo cancelada?',
      placeholder: 'Ex.: cliente desistiu na hora do pagamento',
      minimo: comNota ? 15 : 3,
      confirmarTexto: 'Cancelar venda',
    });
    if (!motivo) return;

    const botao = evento.currentTarget;
    botao.disabled = true;
    botao.innerHTML = cru('<span class="giro" aria-hidden="true"></span> Cancelando…');
    try {
      await api.post(`/vendas/${venda.id}/cancelamento`, { motivo });
      aviso(comNota ? 'NFC-e e venda canceladas; peças de volta ao estoque.' : 'Venda cancelada e peças devolvidas ao estoque.');
      recarregarRota();
    } catch (erro) {
      avisarErro(erro);
      botao.disabled = false;
      botao.textContent = 'Cancelar venda';
    }
  });
}
