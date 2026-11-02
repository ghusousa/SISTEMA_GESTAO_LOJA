/**
 * Comissão e meta do dia na tela de Usuários (ADR-37) — o pedaço que só o DONO edita.
 *
 * O gerente administra a equipe, mas também recebe comissão; quem recebe não decide
 * quanto. Por isso os campos só aparecem para quem tem `DEFINIR_COMISSAO` — e mesmo que
 * alguém os mande na mão, a API responde 403.
 *
 * A % é digitada como a pessoa fala ("2,5") e vai como a pessoa digitou, só com a vírgula
 * trocada por ponto ("2.5"). Quem confere é a API (0 a 100, até duas casas): passar pela
 * régua do dinheiro leria "0,005" como 5 reais — 5% de comissão em silêncio.
 * Meta zero não é meta: campo zerado manda `null`, e a régua some do PDV dela.
 */

import { formatar, formatarPercentual, paraCentavos, paraDecimalString } from '../dinheiro.js';
import { PODE, pode } from '../permissoes.js';
import { ajuda, html, ligarCampoDinheiro } from '../ui.js';

export const podeDefinirComissao = () => pode(PODE.DEFINIR_COMISSAO);

/** "5% · meta R$ 1.500,00" para a lista; vazio quando não há nenhum dos dois. */
export function resumoComissao(u) {
  const partes = [];
  if (paraCentavos(u.comissao_percentual) > 0) partes.push(formatarPercentual(u.comissao_percentual, 2));
  if (u.meta_diaria) partes.push(`meta ${formatar(paraCentavos(u.meta_diaria))}`);
  return partes.join(' · ');
}

/** Os dois campos do formulário. `usuario` ausente = cadastro novo. */
export function camposComissao(usuario = {}) {
  if (!podeDefinirComissao()) return '';
  const pct = paraCentavos(usuario.comissao_percentual ?? 0);
  return html`
    <div class="linha-campos">
      <label class="campo">
        <span>Comissão (%) ${ajuda('Sobre o que a pessoa vendeu menos o que voltou de devolução. A peça devolvida tira a comissão no mês em que voltou. Use 0 para quem não ganha comissão.')}</span>
        <input data-comissao inputmode="decimal" maxlength="6"
          value="${pct ? paraDecimalString(pct).replace('.', ',').replace(/,00$/, '') : '0'}" />
      </label>
      <label class="campo">
        <span>Meta do dia ${ajuda('Aparece no PDV dela como "hoje: R$ X de R$ meta". Deixe em 0,00 para não ter meta.')}</span>
        <input data-meta-diaria />
      </label>
    </div>
  `;
}

/**
 * Liga o campo de dinheiro da meta e devolve a função que lê os dois campos para o corpo
 * do pedido — `{}` quando quem está logado não define comissão (o campo nem existe).
 */
export function ligarCamposComissao(corpo, usuario = {}) {
  if (!podeDefinirComissao()) return () => ({});
  const meta = ligarCampoDinheiro(
    corpo.querySelector('[data-meta-diaria]'),
    paraCentavos(usuario.meta_diaria ?? 0),
  );
  return () => {
    const texto = corpo.querySelector('[data-comissao]').value.replace('%', '').trim();
    const metaCentavos = meta.valor();
    return {
      comissao_percentual: texto.replace(',', '.') || '0',
      meta_diaria: metaCentavos > 0 ? paraDecimalString(metaCentavos) : null,
    };
  };
}
