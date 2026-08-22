/**
 * Gráficos em SVG escrito à mão.
 *
 * Sem biblioteca e sem CDN: a loja roda numa VPS pequena e a tela do dono precisa abrir
 * mesmo com a internet ruim. São duas formas — barras por dia e proporção por categoria —
 * e ambas cabem em cem linhas. Os dados já vêm agregados pela API; aqui só se desenha.
 */

import { escapar, html, cru } from './ui.js';

const LARGURA = 760;
const ALTURA = 190;
const MARGEM = { topo: 12, direita: 8, baixo: 26, esquerda: 56 };

/**
 * Barras verticais.
 * @param {{rotulo: string, valor: number, dica?: string}[]} dados valor em centavos.
 * @param {(centavos: number) => string} formatarValor rótulo do eixo e da dica.
 */
export function barrasPorDia(dados, formatarValor) {
  if (!dados.length) return cru('');

  const maximo = Math.max(...dados.map((d) => d.valor), 1);
  const areaLargura = LARGURA - MARGEM.esquerda - MARGEM.direita;
  const areaAltura = ALTURA - MARGEM.topo - MARGEM.baixo;
  const passo = areaLargura / dados.length;
  const larguraBarra = Math.max(2, Math.min(passo * 0.66, 42));

  // Um rótulo a cada N dias: com 30 barras, trinta datas viram uma mancha preta.
  const saltoRotulo = Math.ceil(dados.length / 12);

  const grade = [0, 0.5, 1].map((fracao) => {
    const y = MARGEM.topo + areaAltura * (1 - fracao);
    return html`
      <line class="grafico__eixo" x1="${MARGEM.esquerda}" y1="${y}" x2="${LARGURA - MARGEM.direita}" y2="${y}" />
      <text class="grafico__rotulo" x="${MARGEM.esquerda - 8}" y="${y + 3}" text-anchor="end">
        ${formatarValor(Math.round(maximo * fracao))}
      </text>
    `;
  });

  const barras = dados.map((d, i) => {
    const altura = Math.max(d.valor > 0 ? 2 : 0, (d.valor / maximo) * areaAltura);
    const x = MARGEM.esquerda + i * passo + (passo - larguraBarra) / 2;
    const y = MARGEM.topo + areaAltura - altura;
    const rotulo =
      i % saltoRotulo === 0
        ? html`<text class="grafico__rotulo" x="${x + larguraBarra / 2}" y="${ALTURA - 8}" text-anchor="middle">${d.rotulo}</text>`
        : '';
    return html`
      <g>
        <rect class="grafico__barra" x="${x}" y="${y}" width="${larguraBarra}" height="${altura}" rx="2">
          <title>${d.dica || `${d.rotulo}: ${formatarValor(d.valor)}`}</title>
        </rect>
        ${rotulo}
      </g>
    `;
  });

  return cru(html`
    <svg class="grafico" viewBox="0 0 ${LARGURA} ${ALTURA}" role="img"
      aria-label="Gráfico de barras com ${dados.length} colunas">
      ${grade}
      ${barras}
    </svg>
  `);
}

/**
 * Lista com barra de proporção — para "para onde o dinheiro foi".
 * Lê melhor que pizza quando os rótulos são textos, e não precisa de legenda.
 */
export function proporcoes(itens) {
  const maximo = Math.max(...itens.map((i) => i.valor), 1);
  return cru(
    itens
      .map(
        (item) => html`
          <div style="margin-bottom:12px">
            <div style="display:flex;justify-content:space-between;gap:12px;margin-bottom:4px">
              <span class="celula-principal">${item.rotulo}</span>
              <span class="dinheiro">${cru(escapar(item.texto))}</span>
            </div>
            <div class="barra-proporcao">
              <i style="width:${Math.round((item.valor / maximo) * 100)}%"></i>
            </div>
            ${item.nota ? cru(html`<span class="texto-fraco">${item.nota}</span>`) : ''}
          </div>
        `,
      )
      .join(''),
  );
}
