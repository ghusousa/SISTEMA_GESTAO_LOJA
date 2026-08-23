/**
 * Folha de etiquetas de um produto, pronta para imprimir e colar na peça.
 *
 * O que se imprime aqui é o que o PDV vai bipar depois, então a etiqueta carrega o mínimo
 * que o balcão precisa: nome, tamanho e cor, preço, e o código de barras de verdade — em
 * barras, não só o número. Peça sem EAN-13 válido fica de fora com aviso, porque desenhar
 * uma barra que nenhum leitor lê seria pior do que não desenhar.
 *
 * Duas portas de entrada, e a diferença está na QUANTIDADE:
 *
 * - `#/produtos/:id/etiquetas` — a grade de um produto, começando com o saldo de cada peça
 *   (quem acabou de cadastrar 5 blusas P quer 5 etiquetas P, não uma);
 * - `#/etiquetas` logo depois de uma entrada — só o que ACABOU de chegar, na quantidade que
 *   chegou. Aqui o saldo seria a conta errada: ele soma o que já estava na arara etiquetado,
 *   e a pessoa colaria etiqueta em peça que já tem.
 */

import { api } from '../api.js';
import { svgEan13, ean13Valido } from '../codigo-barras.js';
import { formatar, paraCentavos } from '../dinheiro.js';
import { conferencia } from '../store.js';
import { avisarErro, cru, html, plural } from '../ui.js';

/** 0,35 mm de módulo: acima do mínimo do padrão (0,33) para aguentar jato de tinta. */
const MODULO = 0.35;
const ALTURA_BARRAS = 10;
const MAX_POR_PECA = 50;

export async function render(raiz, params) {
  raiz.innerHTML = '<div class="carregando">Carregando…</div>';

  const daEntrada = !params.id;
  /** @type {{id:number, produto:string, tamanho:string, cor:string, codigo_barras:string, preco_venda:string, quantas:number}[]} */
  let pecas = [];
  let titulo = 'Etiquetas para imprimir';
  let voltar = null;

  if (daEntrada) {
    // A entrada acabou de gravar e deixou aqui o que chegou. Recarregar a página perde a
    // lista — e tudo bem: a folha se imprime na hora, e o caminho por produto continua.
    pecas = (conferencia.get().etiquetas || []).map((i) => ({
      id: i.variante_id,
      produto: i.produto,
      tamanho: i.tamanho,
      cor: i.cor,
      codigo_barras: i.codigo_barras,
      preco_venda: i.preco_venda,
      quantas: Math.min(i.quantidade, MAX_POR_PECA),
    }));
    titulo = 'Etiquetas da mercadoria que chegou';
    voltar = { href: '#/estoque/entrada', texto: 'Entrada' };
  } else {
    let produto;
    try {
      produto = await api.get(`/produtos/${params.id}`);
    } catch (erro) {
      avisarErro(erro);
      raiz.innerHTML =
        '<div class="vazio"><p class="vazio__titulo">Produto não encontrado</p></div>';
      return;
    }
    pecas = produto.variantes.map((v) => ({
      id: v.id,
      produto: produto.nome,
      tamanho: v.tamanho,
      cor: v.cor,
      codigo_barras: v.codigo_barras,
      preco_venda: v.preco_venda,
      // Peça zerada entra com 1, para quem está etiquetando o que ainda vai dar entrada.
      quantas: Math.min(Math.max(v.saldo, 1), MAX_POR_PECA),
    }));
    voltar = { href: `#/produtos/${produto.id}`, texto: produto.nome };
  }

  const comCodigo = pecas.filter((v) => ean13Valido(v.codigo_barras));
  const semCodigo = pecas.filter((v) => !ean13Valido(v.codigo_barras));
  const quantidades = new Map(comCodigo.map((v) => [v.id, v.quantas]));

  raiz.innerHTML = html`
    <div class="pagina">
      <div class="folha-topo">
        <div class="pagina__topo">
          <div>
            <a class="botao botao--fantasma botao--pequeno" href="${voltar.href}">
              ← ${voltar.texto}
            </a>
            <h1>${titulo}</h1>
            <p class="texto-suave">
              Confira as quantidades e mande imprimir. Cada folha A4 leva 36 etiquetas de
              50 × 30 mm.
            </p>
          </div>
          <div class="pagina__acoes">
            <button class="botao" data-imprimir>Imprimir</button>
          </div>
        </div>

        ${semCodigo.length
          ? cru(html`
              <p class="texto-suave">
                ${plural(semCodigo.length, 'peça ficou de fora', 'peças ficaram de fora')}
                por não ter código de barras no padrão EAN-13:
                ${semCodigo.map((v) => `${v.tamanho} ${v.cor}`).join(', ')}. Gere o código
                interno na tela do produto e volte aqui.
              </p>
            `)
          : ''}

        ${comCodigo.length
          ? cru(html`
              <div class="cartao" style="margin:12px 0">
                <div class="cartao__topo"><h2>Quantas de cada</h2></div>
                <div class="cartao__corpo">
                  <div class="linha-campos" data-quantidades>
                    ${comCodigo.map(
                      (v) => html`
                        <label class="campo">
                          <span>${v.produto} ${v.tamanho} · ${v.cor}</span>
                          <input
                            type="number"
                            min="0"
                            max="${MAX_POR_PECA}"
                            value="${quantidades.get(v.id)}"
                            data-qtd="${v.id}"
                          />
                        </label>
                      `,
                    )}
                  </div>
                  <p class="texto-fraco" style="margin:8px 0 0">
                    Total: <strong data-total>0</strong> etiquetas ·
                    <span data-folhas>0</span>
                  </p>
                </div>
              </div>
            `)
          : cru(
              '<div class="vazio"><p class="vazio__titulo">Nada para imprimir</p>' +
                '<p class="texto-suave">Nenhuma destas peças tem código de barras no padrão EAN-13.</p></div>',
            )}
      </div>

      <div class="folha" data-folha></div>
    </div>
  `;

  const areaFolha = raiz.querySelector('[data-folha]');
  const areaTotal = raiz.querySelector('[data-total]');
  const areaFolhas = raiz.querySelector('[data-folhas]');

  function etiqueta(variante) {
    const svg = svgEan13(variante.codigo_barras, {
      modulo: MODULO,
      altura: ALTURA_BARRAS,
    });
    return html`
      <div class="etiqueta-peca">
        <span class="etiqueta-peca__nome">${variante.produto}</span>
        <span class="etiqueta-peca__linha">
          <span>${variante.tamanho} · ${variante.cor}</span>
          <span class="etiqueta-peca__preco">${formatar(paraCentavos(variante.preco_venda))}</span>
        </span>
        <span class="etiqueta-peca__barras">${cru(svg)}</span>
      </div>
    `;
  }

  function redesenhar() {
    const pedacos = [];
    let total = 0;
    for (const v of comCodigo) {
      const quantas = quantidades.get(v.id) ?? 0;
      total += quantas;
      // Uma etiqueta por unidade: são etiquetas físicas, coladas uma a uma na peça.
      for (let i = 0; i < quantas; i += 1) pedacos.push(etiqueta(v));
    }
    areaFolha.innerHTML = pedacos.join('');
    if (areaTotal) areaTotal.textContent = String(total);
    if (areaFolhas) {
      const folhas = Math.ceil(total / 36) || 0;
      areaFolhas.textContent = folhas
        ? plural(folhas, 'folha A4', 'folhas A4')
        : 'nenhuma folha';
    }
  }

  raiz.querySelectorAll('[data-qtd]').forEach((campo) => {
    campo.addEventListener('input', () => {
      const bruto = Number(campo.value);
      // Trava aqui e não só no `max`: digitar 900 no campo travaria o navegador montando
      // novecentos SVGs, e ninguém etiqueta novecentas peças de uma vez.
      const limpo = Number.isFinite(bruto) ? Math.min(Math.max(Math.trunc(bruto), 0), MAX_POR_PECA) : 0;
      if (String(limpo) !== campo.value) campo.value = String(limpo);
      quantidades.set(Number(campo.dataset.qtd), limpo);
      redesenhar();
    });
  });

  raiz.querySelector('[data-imprimir]')?.addEventListener('click', () => window.print());

  redesenhar();
}
