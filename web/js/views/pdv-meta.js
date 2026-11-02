/**
 * "Hoje: R$ X de R$ meta", no PDV de quem está logado (ADR-37).
 *
 * O número vem de `GET /relatorios/meu-dia`: cada um vê só o PRÓPRIO dia (o id sai do token)
 * e a resposta não tem custo, lucro nem comissão — é o placar do balcão. O vendido já vem
 * com as devoluções de hoje abatidas, a mesma conta do relatório de comissão do dono.
 *
 * Sem meta definida a régua não aparece. Ela se atualiza sozinha quando sai uma venda (desta
 * ou de outra tela) e quando o dono muda a meta — só ESTE pedaço, nunca o PDV inteiro, que
 * apagaria o carrinho no meio de uma venda.
 */

import { api } from '../api.js';
import { formatar, paraCentavos } from '../dinheiro.js';
import { ouvir } from '../tempo-real.js';
import { html } from '../ui.js';

/** Liga a régua em `area` e devolve a função de desligar. */
export function ligarMetaDoDia(area) {
  let vivo = true;

  async function atualizar() {
    let dia;
    try {
      dia = await api.get('/relatorios/meu-dia');
    } catch {
      // A régua é conforto, não operação: sem ela o PDV continua vendendo.
      return;
    }
    if (!vivo) return;
    if (dia.meta === null || dia.meta === undefined) {
      area.hidden = true;
      area.innerHTML = '';
      return;
    }
    const vendido = paraCentavos(dia.vendido);
    const meta = paraCentavos(dia.meta);
    const falta = paraCentavos(dia.falta);
    const pct = meta > 0 ? Math.min(100, Math.max(0, Math.round((vendido / meta) * 100))) : 0;
    area.hidden = false;
    area.innerHTML = html`
      <div class="pdv__linha">
        <span class="texto-suave">Hoje</span>
        <span><strong class="dinheiro">${formatar(vendido)}</strong>
          <span class="texto-fraco">de ${formatar(meta)}</span></span>
      </div>
      <div class="barra-proporcao" title="${pct}% da meta do dia">
        <i style="width:${pct}%"></i>
      </div>
      <span class="texto-fraco" style="font-size:12px">
        ${falta > 0 ? `faltam ${formatar(falta)} para a meta` : 'meta do dia batida'}
      </span>
    `;
  }

  atualizar();
  const desouvir = ouvir(['vendas', 'usuarios', 'reconectado'], () => void atualizar());
  return {
    atualizar,
    desligar() {
      vivo = false;
      desouvir();
    },
  };
}
