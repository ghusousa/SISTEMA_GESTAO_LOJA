/**
 * O giro do estoque na tela de Relatórios (ADR-38): quanto vale a arara, o que está parado
 * e quais produtos sustentam a loja (curva ABC).
 *
 * Valor do estoque e estoque parado são a situação de AGORA, não do período — moram fora da
 * área que a troca de datas redesenha, como o "Precisa repor". A curva ABC é do período.
 * As listas são paginadas no servidor; os totais em destaque valem para a loja inteira.
 */

import { api } from '../api.js';
import { formatar, formatarPercentual, paraCentavos } from '../dinheiro.js';
import {
  ajuda,
  carregando,
  cru,
  data as formatarData,
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
export const DIAS_PARADO = [30, 60, 90, 180];

const cartao = (titulo, nota, corpo, estilo = 'margin-top:16px') => html`
  <div class="cartao" style="${estilo}">
    <div class="cartao__topo">
      <h2>${cru(titulo)}</h2>
      <span class="texto-fraco">${nota}</span>
    </div>
    ${corpo}
  </div>
`;

const semRolagem = 'border:0;box-shadow:none;border-radius:0';
const corpoVazio = (titulo, dica = '') => cru(`<div class="cartao__corpo">${vazio(titulo, dica)}</div>`);

/* ------------------------------------------------------------- valor do estoque */

const TITULO_VALOR = html`Valor do estoque ${ajuda('Tudo que está na arara agora, peça por peça: saldo vezes o custo da última entrada, e saldo vezes o preço de venda. É a loja inteira, não uma página.')}`;

export async function desenharValorEstoque(area) {
  area.innerHTML = cartao(TITULO_VALOR, 'agora', carregando('Somando a arara…'));
  let v;
  try {
    v = await api.get('/relatorios/valor-do-estoque');
  } catch (erro) {
    area.innerHTML = cartao(TITULO_VALOR, 'agora', erroBloco(erro.textoAmigavel));
    return;
  }
  area.innerHTML = cartao(
    TITULO_VALOR,
    `${plural(v.pecas, 'peça', 'peças')} em ${plural(v.variantes, 'variante', 'variantes')}`,
    html`
      <div class="cartao__corpo grade-cartoes" style="margin:0">
        <div class="indicador">
          <div class="indicador__rotulo">Em custo</div>
          <div class="indicador__valor dinheiro">${formatar(paraCentavos(v.valor_em_custo))}</div>
          <div class="indicador__nota">o que a loja pagou pelo que está na arara</div>
        </div>
        <div class="indicador">
          <div class="indicador__rotulo">Em preço de venda</div>
          <div class="indicador__valor dinheiro">${formatar(paraCentavos(v.valor_em_venda))}</div>
          <div class="indicador__nota">se tudo vendesse pelo preço cheio</div>
        </div>
      </div>
    `,
  );
}

/* ------------------------------------------------------------------ estoque parado */

const TITULO_PARADO = html`Estoque parado ${ajuda('Peças com saldo cuja última venda tem mais dias do que o escolhido. A que nunca vendeu conta desde a última entrada de mercadoria. As mais antigas primeiro: são as candidatas à liquidação.')}`;

const linhaParada = (p) => html`
  <tr>
    <td>
      <span class="celula-principal">${p.produto}</span>
      <span class="celula-secundaria">${grade(p.tamanho, p.cor)}</span>
    </td>
    <td class="direita dinheiro">${numero(p.saldo)}</td>
    <td class="texto-suave">${p.ultima_venda ? formatarData(p.ultima_venda) : 'nunca vendeu'}</td>
    <td class="direita dinheiro celula-principal">${numero(p.dias_parada)}</td>
    <td class="direita dinheiro">${formatar(paraCentavos(p.valor_em_custo))}</td>
    <td class="direita dinheiro texto-suave">${formatar(paraCentavos(p.valor_em_venda))}</td>
  </tr>
`;

/** `aoMudar({ pagina, dias })` é chamado pelos botões e pelo seletor de dias. */
export async function desenharEstoqueParado(area, dias, pagina, aoMudar) {
  const seletor = html`
    <label class="campo" style="margin:0 18px 12px;max-width:220px">
      <span>Sem vender há mais de</span>
      <select data-dias>
        ${DIAS_PARADO.map((d) => html`<option value="${d}" ${cru(d === dias ? 'selected' : '')}>${d} dias</option>`)}
      </select>
    </label>
  `;
  const desenharCom = (nota, corpo) => {
    area.innerHTML = cartao(TITULO_PARADO, nota, html`${seletor}${corpo}`);
    area.querySelector('[data-dias]').addEventListener('change', (e) =>
      aoMudar({ pagina: 1, dias: Number(e.target.value) }),
    );
  };

  desenharCom('situação de agora', carregando('Procurando o que não gira…'));
  let dados;
  try {
    dados = await api.get('/relatorios/estoque-parado', { dias, page: pagina, size: POR_PAGINA });
  } catch (erro) {
    desenharCom('situação de agora', erroBloco(erro.textoAmigavel));
    return;
  }
  if (!dados.items.length && dados.total > 0 && pagina > 1) {
    aoMudar({ pagina: 1, dias });
    return;
  }
  if (!dados.total) {
    desenharCom('situação de agora', corpoVazio('Nada parado', `Toda peça com saldo vendeu nos últimos ${dias} dias.`));
    return;
  }
  desenharCom(
    `${plural(dados.total, 'peça', 'peças')} · ${formatar(paraCentavos(dados.valor_em_custo_total))} em custo parados`,
    html`
      <div class="tabela-rolagem" style="${semRolagem}">
        <table>
          <thead>
            <tr>
              <th>Peça</th>
              <th class="direita">Saldo</th>
              <th>Última venda</th>
              <th class="direita">Dias parada</th>
              <th class="direita">Em custo</th>
              <th class="direita">Em venda</th>
            </tr>
          </thead>
          <tbody>${dados.items.map(linhaParada)}</tbody>
        </table>
      </div>
      ${paginacao({ total: dados.total, page: dados.page, size: dados.size })}
    `,
  );
  ligarPaginacao(area, (p) => aoMudar({ pagina: p, dias }));
}

/* ---------------------------------------------------------------------- curva ABC */

const TITULO_ABC = html`Curva ABC ${ajuda('Produtos do que mais faturou para o que menos, no período (vendido menos devolvido, com o desconto da venda repartido). A: os que juntos fazem os primeiros 80% do faturamento. B: até 95%. C: o resto. Quem cruza a linha dos 80% ainda é A.')}`;

const TOM = { A: 'ok', B: 'alerta', C: 'neutro' };

const linhaAbc = (p) => html`
  <tr>
    <td>${etiqueta(p.classe, TOM[p.classe] ?? 'neutro')}</td>
    <td><span class="celula-principal">${p.produto}</span></td>
    <td class="direita dinheiro">${numero(p.pecas)}</td>
    <td class="direita dinheiro">${formatar(paraCentavos(p.faturamento_liquido))}</td>
    <td class="direita dinheiro texto-suave">${formatarPercentual(p.percentual)}</td>
    <td class="direita dinheiro">${formatarPercentual(p.percentual_acumulado)}</td>
  </tr>
`;

export async function desenharCurvaAbc(area, periodo, pagina, aoMudarPagina) {
  area.innerHTML = cartao(TITULO_ABC, '', carregando('Ordenando os produtos…'));
  let dados;
  try {
    dados = await api.get('/relatorios/curva-abc', { ...periodo, page: pagina, size: POR_PAGINA });
  } catch (erro) {
    area.innerHTML = cartao(TITULO_ABC, '', erroBloco(erro.textoAmigavel));
    return;
  }
  if (!dados.items.length && dados.total > 0 && pagina > 1) {
    aoMudarPagina(1);
    return;
  }
  if (!dados.total) {
    area.innerHTML = cartao(TITULO_ABC, '', corpoVazio('Nenhuma venda no período'));
    return;
  }
  area.innerHTML = cartao(
    TITULO_ABC,
    plural(dados.total, 'produto', 'produtos'),
    html`
      <div class="tabela-rolagem" style="${semRolagem}">
        <table>
          <thead>
            <tr>
              <th>Classe</th>
              <th>Produto</th>
              <th class="direita">Peças</th>
              <th class="direita">Líquido</th>
              <th class="direita">Fatia</th>
              <th class="direita">Acumulado</th>
            </tr>
          </thead>
          <tbody>${dados.items.map(linhaAbc)}</tbody>
        </table>
      </div>
      ${paginacao({ total: dados.total, page: dados.page, size: dados.size })}
    `,
  );
  ligarPaginacao(area, aoMudarPagina);
}
