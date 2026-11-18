/**
 * "A receber do cartão" na tela de Relatórios: o que a maquininha ainda vai depositar, dia a
 * dia, bruto, taxa e líquido.
 *
 * A rota (`GET /relatorios/recebiveis`) nasce junto com o cálculo da taxa da maquininha. Um
 * servidor que ainda não a tem responde 404 — e então este cartão simplesmente não aparece,
 * em vez de pintar erro na tela do dono. Período sem nada a receber também some.
 */

import { api, ErroApi } from '../api.js';
import { formatar, paraCentavos } from '../dinheiro.js';
import {
  ajuda,
  carregando,
  data as formatarData,
  erroBloco,
  html,
  ligarPaginacao,
  paginacao,
  plural,
} from '../ui.js';

const POR_PAGINA = 20;

const cartao = (nota, corpo) => html`
  <div class="cartao" style="margin-top:16px">
    <div class="cartao__topo">
      <h2>A receber do cartão ${ajuda('O que a maquininha deposita em cada data, já sem a taxa. Débito cai em poucos dias; crédito parcelado, uma parcela por mês.')}</h2>
      <span class="texto-fraco">${nota}</span>
    </div>
    ${corpo}
  </div>
`;

export async function desenharRecebiveis(area, periodo, pagina, aoMudarPagina) {
  area.innerHTML = cartao('', carregando('Conferindo a agenda da maquininha…'));
  let dados;
  try {
    dados = await api.get('/relatorios/recebiveis', { ...periodo, page: pagina, size: POR_PAGINA });
  } catch (erro) {
    if (erro instanceof ErroApi && erro.status === 404) {
      area.innerHTML = '';
      return;
    }
    area.innerHTML = cartao('', erroBloco(erro.textoAmigavel));
    return;
  }
  if (!dados || !Array.isArray(dados.items) || !dados.total) {
    area.innerHTML = '';
    return;
  }
  if (!dados.items.length && pagina > 1) {
    aoMudarPagina(1);
    return;
  }
  area.innerHTML = cartao(
    plural(dados.total, 'data', 'datas'),
    html`
      <div class="tabela-rolagem" style="border:0;box-shadow:none;border-radius:0">
        <table>
          <thead>
            <tr>
              <th>Data</th>
              <th class="direita">Bruto</th>
              <th class="direita">Taxa</th>
              <th class="direita">Cai na conta</th>
            </tr>
          </thead>
          <tbody>
            ${dados.items.map(
              (d) => html`
                <tr>
                  <td>${formatarData(d.data)}</td>
                  <td class="direita dinheiro">${formatar(paraCentavos(d.bruto))}</td>
                  <td class="direita dinheiro negativo">${formatar(paraCentavos(d.taxa))}</td>
                  <td class="direita dinheiro celula-principal">${formatar(paraCentavos(d.liquido))}</td>
                </tr>
              `,
            )}
          </tbody>
        </table>
      </div>
      ${paginacao({ total: dados.total, page: dados.page, size: dados.size })}
    `,
  );
  ligarPaginacao(area, aoMudarPagina);
}
