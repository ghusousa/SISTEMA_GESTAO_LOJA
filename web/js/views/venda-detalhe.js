/**
 * Detalhe de uma venda, e o cancelamento.
 *
 * Cancelar não apaga nada: a venda fica com status CANCELADA e as peças voltam ao estoque
 * por uma movimentação de ESTORNO. O motivo é obrigatório e aparece aqui para sempre.
 */

import { api } from '../api.js';
import { formatar, paraCentavos } from '../dinheiro.js';
import { recarregarRota } from '../router.js';
import { PODE, pode } from '../permissoes.js';
import {
  FORMAS,
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
} from '../ui.js';

export async function render(raiz, { id }) {
  raiz.innerHTML = `<div class="pagina">${carregando()}</div>`;
  const veDinheiro = pode(PODE.VER_DINHEIRO);

  let venda;
  try {
    venda = await api.get(`/vendas/${id}`);
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
            ? cru(html`<a class="botao" href="#/vendas/devolucao?venda=${venda.id}">Devolver peça</a>`)
            : ''}
          ${!cancelada && pode(PODE.CANCELAR_VENDA)
            ? cru('<button class="botao botao--perigo" data-cancelar>Cancelar venda</button>')
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
          <div class="indicador__nota">${venda.pagamentos.map((p) => FORMAS[p.forma] || p.forma).join(' + ')}</div>
        </div>
        ${veDinheiro
          ? cru(html`
              <div class="indicador">
                <div class="indicador__rotulo">Custo das peças</div>
                <div class="indicador__valor dinheiro">${formatar(custo)}</div>
                <div class="indicador__nota">congelado no momento da venda</div>
              </div>
              <div class="indicador">
                <div class="indicador__rotulo">Lucro bruto</div>
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
                <strong>${FORMAS[p.forma] || p.forma}</strong>
                <span class="dinheiro">${formatar(paraCentavos(p.valor))}</span>
              </div>
            `,
          )}
          ${venda.observacao ? cru(html`<p class="texto-suave">Observação: ${venda.observacao}</p>`) : ''}
        </div>
      </div>
    </div>
  `;

  raiz.querySelector('[data-cancelar]')?.addEventListener('click', async (evento) => {
    const motivo = await perguntarTexto({
      titulo: `Cancelar a venda #${venda.id}`,
      rotulo: 'Por que esta venda está sendo cancelada?',
      placeholder: 'Ex.: cliente desistiu na hora do pagamento',
      confirmarTexto: 'Cancelar venda',
    });
    if (!motivo) return;

    const botao = evento.currentTarget;
    botao.disabled = true;
    botao.innerHTML = cru('<span class="giro" aria-hidden="true"></span> Cancelando…');
    try {
      await api.post(`/vendas/${venda.id}/cancelamento`, { motivo });
      aviso('Venda cancelada e peças devolvidas ao estoque.');
      recarregarRota();
    } catch (erro) {
      avisarErro(erro);
      botao.disabled = false;
      botao.textContent = 'Cancelar venda';
    }
  });
}
