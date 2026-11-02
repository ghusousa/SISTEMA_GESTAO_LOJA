/**
 * A nota do fornecedor: valor, número e parcelas — vira Contas a pagar (ADR-40).
 *
 * Mora fora da tela de Entrada (que já está no teto de linhas) e serve também ao lançamento
 * avulso em Contas a pagar: é a mesma pergunta nas duas portas. Só aparece para quem vê
 * dinheiro — o servidor recusa a nota vinda de quem não vê, e a vendedora dá entrada sem.
 *
 * A sugestão 30/60/90 e a conta do centavo são de `parcelas.js`; o servidor confere a soma.
 */

import { formatar, paraDecimalString } from './dinheiro.js';
import { diferencaDaNota, notaFecha, sugerirParcelas } from './parcelas.js';
import { ajuda, cru, hojeISO, html, ligarCampoDinheiro } from './ui.js';

export const NOTA_VAZIA = Object.freeze({ ligada: false, numero: '', total: 0, quantidade: 3, parcelas: [] });

/**
 * Desenha a nota em `area`. `inicial` vem do store (a conferência sobrevive a ir cadastrar
 * uma peça e voltar); `aoMudar(estado)` devolve cada mudança para lá.
 * `opcional=false` é o lançamento avulso: lá a nota É o lançamento, não tem como desligar.
 */
export function ligarNotaFornecedor(area, { inicial, aoMudar, opcional = true }) {
  const estado = { ...NOTA_VAZIA, ...(inicial || {}), ligada: !opcional || !!inicial?.ligada };
  const mudou = () => aoMudar?.({ ...estado, parcelas: estado.parcelas.map((p) => ({ ...p })) });

  function sugerir() {
    estado.parcelas = sugerirParcelas(estado.total, estado.quantidade, hojeISO());
  }

  function pintar() {
    area.innerHTML = html`
      ${opcional
        ? html`<label class="marcador" style="margin:12px 0 8px">
            <input type="checkbox" data-ligar ${cru(estado.ligada ? 'checked' : '')} />
            Lançar a nota em Contas a pagar
            ${ajuda('O valor da nota e os vencimentos viram contas a pagar ligadas a esta entrada. Não entram no Resultado: o custo da mercadoria já entra pelo CMV quando a peça é vendida.')}
          </label>`
        : ''}
      ${estado.ligada ? corpo() : ''}
    `;
    if (opcional) {
      area.querySelector('[data-ligar]').addEventListener('change', (e) => {
        estado.ligada = e.target.checked;
        mudou();
        pintar();
      });
    }
    if (estado.ligada) ligarCorpo();
  }

  const corpo = () => html`
    <label class="campo">
      <span>Número da nota <span class="campo__dica">opcional</span></span>
      <input data-numero maxlength="40" value="${estado.numero}" placeholder="NF 4512" />
    </label>
    <div style="display:flex;gap:8px">
      <label class="campo" style="flex:1"><span>Valor da nota</span><input data-total /></label>
      <label class="campo" style="width:96px">
        <span>Parcelas</span>
        <select data-quantidade>
          ${[1, 2, 3, 4, 5, 6].map(
            (n) => html`<option value="${n}" ${cru(n === estado.quantidade ? 'selected' : '')}>${n}x</option>`,
          )}
        </select>
      </label>
    </div>
    <div data-parcelas>
      ${estado.parcelas.map(
        (p, i) => html`
          <div style="display:flex;gap:8px;align-items:flex-end">
            <label class="campo" style="flex:1">
              <span>${i + 1}ª vence em</span>
              <input type="date" data-vencimento="${i}" value="${p.vencimento}" />
            </label>
            <label class="campo" style="width:120px"><span>Valor</span><input data-valor="${i}" /></label>
          </div>
        `,
      )}
    </div>
    <p class="texto-suave" data-situacao style="font-size:13px"></p>
  `;

  function situacao() {
    const alvo = area.querySelector('[data-situacao]');
    if (!alvo) return;
    const diferenca = diferencaDaNota(estado.total, estado.parcelas);
    alvo.textContent = !estado.total
      ? 'Digite o valor da nota: as parcelas saem de 30 em 30 dias, e dá para mudar cada uma.'
      : diferenca === 0
        ? `${estado.parcelas.length}x — fecha com a nota.`
        : diferenca > 0
          ? `Faltam ${formatar(diferenca)} nas parcelas para fechar com a nota.`
          : `As parcelas passam da nota em ${formatar(-diferenca)}.`;
  }

  function ligarCorpo() {
    area.querySelector('[data-numero]').addEventListener('input', (e) => {
      estado.numero = e.target.value;
      mudou();
    });
    ligarCampoDinheiro(area.querySelector('[data-total]'), estado.total, (valor) => {
      estado.total = valor;
      sugerir();
      mudou();
      // Redesenha só as parcelas: redesenhar tudo tiraria o cursor do campo do valor.
      pintarParcelas();
    });
    area.querySelector('[data-quantidade]').addEventListener('change', (e) => {
      estado.quantidade = Number(e.target.value);
      sugerir();
      mudou();
      pintar();
    });
    ligarParcelas();
    situacao();
  }

  function pintarParcelas() {
    const lista = area.querySelector('[data-parcelas]');
    const temp = document.createElement('div');
    temp.innerHTML = corpo();
    lista.innerHTML = temp.querySelector('[data-parcelas]').innerHTML;
    ligarParcelas();
    situacao();
  }

  function ligarParcelas() {
    estado.parcelas.forEach((p, i) => {
      area.querySelector(`[data-vencimento="${i}"]`).addEventListener('change', (e) => {
        estado.parcelas[i].vencimento = e.target.value;
        mudou();
        situacao();
      });
      ligarCampoDinheiro(area.querySelector(`[data-valor="${i}"]`), p.valor, (valor) => {
        estado.parcelas[i].valor = valor;
        mudou();
        situacao();
      });
    });
  }

  pintar();

  return {
    /** A nota pronta para a API, `null` se desligada; lança Error com a frase se não fecha. */
    paraApi() {
      if (!estado.ligada) return null;
      if (!notaFecha(estado.total, estado.parcelas)) {
        throw new Error('A nota do fornecedor não fecha: confira o valor e as parcelas.');
      }
      return {
        numero: estado.numero.trim() || null,
        valor_total: paraDecimalString(estado.total),
        parcelas: estado.parcelas.map((p) => ({
          vencimento: p.vencimento,
          valor: paraDecimalString(p.valor),
        })),
      };
    },
    limpar() {
      Object.assign(estado, { ...NOTA_VAZIA, ligada: !opcional, parcelas: [] });
      mudou();
      pintar();
    },
  };
}
