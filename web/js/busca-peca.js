/**
 * Achar a peça pelo nome, no mesmo campo em que se bipa.
 *
 * **Por que existe.** Quem gera o próprio código de barras cria a etiqueta DEPOIS de
 * cadastrar a peça. Então, quando chega reposição do fornecedor, não há o que bipar: as
 * vinte camisetas pretas M vêm sem a nossa etiqueta colada. Antes disto, a tela de entrada
 * só aceitava código — e a única saída era imprimir, colar e só então passar no leitor,
 * peça por peça, para conferir o que já se sabia.
 *
 * **Um campo, não dois.** Nada de "modo bipe" e "modo busca": o leitor USB digita em
 * rajada e fecha com Enter, o dedo humano digita devagar e com letras. Dá para distinguir
 * sem perguntar nada — quem digita letras vê a lista aparecer; quem bipa não vê lista
 * nenhuma e a peça entra direto. O `ignorarQuando` do leitor é o que impede o Enter de
 * "bipar" a palavra camiseta com a lista aberta.
 */

import { api } from './api.js';
import { formatar, paraCentavos } from './dinheiro.js';
import { cru, html, numero } from './ui.js';

const ESPERA_MS = 250; // Digitar "camiseta" são 8 teclas: sem espera, 8 consultas.
const MINIMO = 2;
const MAXIMO_RESULTADOS = 8;

/**
 * Rajada de dígitos é etiqueta, não nome de peça: não vale abrir lista.
 *
 * Quatro é o mesmo mínimo do leitor (`MINIMO_CARACTERES`), e nome de peça não é só dígito —
 * então nada de nome cai aqui por engano. Sem este corte, o meio de uma bipada ("78…")
 * chegaria a agendar uma busca por conta própria.
 */
function pareceCodigo(texto) {
  return /^\d{4,}$/.test(texto.trim());
}

/**
 * @param {object} opcoes
 * @param {HTMLInputElement} opcoes.campo campo de leitura (o mesmo do leitor).
 * @param {HTMLElement} opcoes.painel onde a lista é desenhada.
 * @param {(peca: object) => void} opcoes.aoEscolher recebe a peça escolhida.
 * @param {boolean} [opcoes.mostrarPreco] no balcão o preço decide a escolha; na entrada,
 *   não. O saldo aparece nos dois: vender o que não tem e recontar o que já entrou são
 *   erros que a lista pode evitar antes de acontecerem.
 */
export function ligarBuscaDePeca({ campo, painel, aoEscolher, mostrarPreco = false }) {
  let resultados = [];
  let marcado = 0;
  let timer = null;
  let consultaAtual = 0;

  function aberta() {
    return resultados.length > 0;
  }

  function fechar() {
    resultados = [];
    marcado = 0;
    painel.hidden = true;
    painel.innerHTML = '';
  }

  function pintar() {
    if (!resultados.length) {
      fechar();
      return;
    }
    painel.hidden = false;
    painel.innerHTML = resultados
      .map(
        (peca, i) => html`
          <button type="button" class="busca-peca__item ${i === marcado ? 'is-marcado' : ''}"
            data-indice="${i}">
            <span class="busca-peca__nome">${peca.produto}</span>
            <span class="busca-peca__grade">${peca.tamanho} · ${peca.cor}</span>
            ${mostrarPreco
              ? cru(html`<span class="busca-peca__saldo">${formatar(paraCentavos(peca.preco_venda))}</span>`)
              : ''}
            <span class="busca-peca__saldo ${peca.saldo <= 0 ? 'is-zerado' : ''}">
              ${peca.saldo > 0 ? `${numero(peca.saldo)} em estoque` : 'sem estoque'}
            </span>
          </button>
        `,
      )
      .join('');

    painel.querySelectorAll('[data-indice]').forEach((botao) => {
      // `mousedown` e não `click`: o clique tira o foco do campo antes de disparar, e o
      // `manterFoco` do balcão devolveria o cursor no meio do caminho, cancelando a escolha.
      botao.addEventListener('mousedown', (evento) => {
        evento.preventDefault();
        escolher(Number(botao.dataset.indice));
      });
    });
  }

  function escolher(indice) {
    const peca = resultados[indice];
    if (!peca) return;
    fechar();
    campo.value = '';
    aoEscolher(peca);
  }

  async function procurar(termo) {
    const minha = ++consultaAtual;
    try {
      const { items } = await api.get('/variantes', { q: termo, size: MAXIMO_RESULTADOS });
      // Resposta atrasada de uma busca antiga não pode sobrescrever a lista da atual:
      // digitar rápido faria a lista piscar resultados de "cam" sobre os de "camiseta".
      if (minha !== consultaAtual) return;
      resultados = items;
      marcado = 0;
      pintar();
    } catch {
      // Busca é conveniência: se a rede falhar, o leitor continua funcionando e um alerta
      // aqui só atrapalharia quem está bipando.
      fechar();
    }
  }

  function aoDigitar() {
    const termo = campo.value.trim();
    clearTimeout(timer);
    if (termo.length < MINIMO || pareceCodigo(termo)) {
      fechar();
      return;
    }
    timer = setTimeout(() => void procurar(termo), ESPERA_MS);
  }

  function aoTeclar(evento) {
    if (!aberta()) return;
    if (evento.key === 'ArrowDown' || evento.key === 'ArrowUp') {
      evento.preventDefault();
      const passo = evento.key === 'ArrowDown' ? 1 : -1;
      marcado = (marcado + passo + resultados.length) % resultados.length;
      pintar();
    } else if (evento.key === 'Enter') {
      evento.preventDefault();
      escolher(marcado);
    } else if (evento.key === 'Escape') {
      fechar();
    }
  }

  campo.addEventListener('input', aoDigitar);
  campo.addEventListener('keydown', aoTeclar);
  campo.addEventListener('blur', () => setTimeout(fechar, 150));

  return {
    /** O leitor pergunta isto antes de tratar o Enter como bipada. */
    aberta,
    fechar,
    desligar() {
      clearTimeout(timer);
      campo.removeEventListener('input', aoDigitar);
      campo.removeEventListener('keydown', aoTeclar);
      fechar();
    },
  };
}
