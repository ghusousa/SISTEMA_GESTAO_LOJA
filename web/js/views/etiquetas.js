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
import { nomeNaRaiz } from '../raiz.js';
import { conferencia } from '../store.js';
import { ajuda, avisarErro, cru, html, plural } from '../ui.js';

/**
 * Os formatos de impressão. A diferença não é estética: uma folha adesiva A4 sai numa
 * impressora comum, com 36 etiquetas por página; uma térmica de rolo (Elgin L42, Zebra
 * ZD220) imprime UMA etiqueta por página, do tamanho exato do rolo. Mandar a folha A4
 * para a térmica sai encavalado, e mandar o rolo para a A4 desperdiça a folha inteira.
 *
 * `modulo` é a largura da barra mais fina, em mm — e é o número que decide se o leitor
 * lê ou não:
 *
 * - Jato/laser: 0,35 mm. Acima do mínimo do padrão EAN (0,33) para aguentar a tinta
 *   espalhar no papel.
 * - Térmica de 203 dpi: um ponto mede 25,4/203 = 0,125 mm. Um módulo que não seja
 *   múltiplo disso cai "entre pontos" e a impressora arredonda cada barra para um lado
 *   diferente — as barras saem com larguras desiguais e o leitor recusa. 0,375 mm são
 *   exatamente 3 pontos, e continua acima do mínimo do padrão.
 *
 * Largura que o EAN-13 ocupa: 113 módulos (95 do código + 18 das zonas de silêncio).
 * A 0,375 mm dá 42,4 mm — cabe nos 50 mm com folga; nos 40 mm cabe raspando, por isso
 * o formato de 40 mm usa 0,25 mm (2 pontos), que dá 28,3 mm.
 */
const FORMATOS = {
  a4: {
    rotulo: 'Folha adesiva A4 — 36 etiquetas de 50 × 30 mm',
    largura: 50,
    altura: 30,
    modulo: 0.35,
    alturaBarras: 10,
    porFolha: 36,
    rolo: false,
  },
  't50x30': {
    rotulo: 'Rolo térmico 50 × 30 mm (o mais comum)',
    largura: 50,
    altura: 30,
    modulo: 0.375,
    alturaBarras: 10,
    rolo: true,
  },
  't40x25': {
    rotulo: 'Rolo térmico 40 × 25 mm',
    largura: 40,
    altura: 25,
    modulo: 0.25,
    alturaBarras: 8,
    rolo: true,
  },
  't60x30': {
    rotulo: 'Rolo térmico 60 × 30 mm',
    largura: 60,
    altura: 30,
    modulo: 0.375,
    alturaBarras: 10,
    rolo: true,
  },
};

/**
 * Lembrado no aparelho: a loja escolhe o formato uma vez e não toda vez que imprime. Com a
 * raiz no nome (ADR-46): a escolha feita na demo não muda a impressora da loja.
 */
const CHAVE_FORMATO = nomeNaRaiz('loja.etiqueta.formato');
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
            <p class="texto-suave" data-explicacao></p>
          </div>
          <div class="pagina__acoes">
            <label class="campo" style="margin:0;min-width:280px">
              <span>Formato ${ajuda('Folha A4 é papel adesivo em impressora comum, várias etiquetas por página. Rolo é a etiquetadora térmica, uma por vez. Trocado, sai encavalado.')}</span>
              <select data-formato>
                ${Object.entries(FORMATOS).map(
                  ([chave, f]) => html`<option value="${chave}">${f.rotulo}</option>`,
                )}
              </select>
            </label>
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
                <div class="cartao__topo">
                  <h2>
                    Quantas de cada
                    ${ajuda('Sai uma etiqueta por unidade, no máximo 50 de cada peça. O número já vem preenchido: confira, para não colar etiqueta em peça que já tem.')}
                  </h2>
                </div>
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

  /**
   * O `@page` não é estilizável por classe: o tamanho do papel é global e só existe numa
   * regra `@page`. Por isso a folha injeta a sua no `<head>` e troca quando o formato muda.
   *
   * É este `size` que faz a térmica funcionar: sem ele, o navegador manda A4 para uma
   * impressora cujo papel tem 5 cm, e cada etiqueta sai encavalada na seguinte.
   */
  function aplicarFormato(chave) {
    const f = FORMATOS[chave] ?? FORMATOS.a4;
    let estilo = document.getElementById('folha-formato');
    if (!estilo) {
      estilo = document.createElement('style');
      estilo.id = 'folha-formato';
      document.head.appendChild(estilo);
    }
    estilo.textContent = f.rolo
      ? `
        @media print {
          @page { size: ${f.largura}mm ${f.altura}mm; margin: 0; }
          /* Uma etiqueta por página, do tamanho exato do rolo. O corte é da impressora. */
          .folha { display: block; }
          .etiqueta-peca {
            width: ${f.largura}mm;
            height: ${f.altura}mm;
            break-after: page;
            page-break-after: always;
          }
          .etiqueta-peca:last-child { break-after: auto; page-break-after: auto; }
        }
        .etiqueta-peca { width: ${f.largura}mm; height: ${f.altura}mm; }
        .folha { grid-template-columns: repeat(auto-fill, ${f.largura}mm); }
      `
      : `
        @media print {
          @page { size: A4 portrait; margin: 5mm; }
        }
        .etiqueta-peca { width: ${f.largura}mm; height: ${f.altura}mm; }
        .folha { grid-template-columns: repeat(4, ${f.largura}mm); }
      `;

    const explicacao = raiz.querySelector('[data-explicacao]');
    if (explicacao) {
      explicacao.textContent = f.rolo
        ? `Confira as quantidades e mande imprimir. Sai uma etiqueta por vez, de ${f.largura} × ${f.altura} mm — escolha a impressora térmica na janela de impressão.`
        : `Confira as quantidades e mande imprimir. Cada folha A4 leva ${f.porFolha} etiquetas de ${f.largura} × ${f.altura} mm.`;
    }
  }

  let formatoAtual = 'a4';
  try {
    const guardado = localStorage.getItem(CHAVE_FORMATO);
    if (guardado && FORMATOS[guardado]) formatoAtual = guardado;
  } catch {
    // Navegador em modo privado: segue no padrão, sem lembrar a escolha.
  }
  const areaTotal = raiz.querySelector('[data-total]');
  const areaFolhas = raiz.querySelector('[data-folhas]');

  function etiqueta(variante) {
    const f = FORMATOS[formatoAtual];
    const svg = svgEan13(variante.codigo_barras, {
      modulo: f.modulo,
      altura: f.alturaBarras,
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
      const f = FORMATOS[formatoAtual];
      if (f.rolo) {
        // No rolo não existe "folha": o que a pessoa quer saber é quanto de rolo vai.
        const centimetros = Math.ceil((total * (f.altura + 2)) / 10);
        areaFolhas.textContent = total ? `cerca de ${centimetros} cm de rolo` : 'nada a imprimir';
      } else {
        const folhas = Math.ceil(total / f.porFolha) || 0;
        areaFolhas.textContent = folhas
          ? plural(folhas, 'folha A4', 'folhas A4')
          : 'nenhuma folha';
      }
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

  const seletor = raiz.querySelector('[data-formato]');
  if (seletor) {
    seletor.value = formatoAtual;
    seletor.addEventListener('change', () => {
      formatoAtual = seletor.value;
      try {
        localStorage.setItem(CHAVE_FORMATO, formatoAtual);
      } catch {
        // sem persistência não é motivo para não imprimir
      }
      aplicarFormato(formatoAtual);
      redesenhar(); // o módulo do código de barras muda com o formato
    });
  }
  aplicarFormato(formatoAtual);

  raiz.querySelector('[data-imprimir]')?.addEventListener('click', () => window.print());

  redesenhar();
}
