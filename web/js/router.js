/**
 * Roteador por hash (#/pdv, #/produtos/12).
 *
 * Hash e não History API de propósito: assim a página funciona servida de qualquer lugar —
 * pelo FastAPI, por um Nginx, ou aberta de uma pasta — sem precisar de regra de reescrita
 * no servidor. Recarregar em `#/produtos/12` continua caindo no mesmo index.html.
 *
 * Cada view é um módulo carregado sob demanda (`import()`): quem só usa o PDV nunca baixa
 * o código dos relatórios.
 */

import { papelPode } from './permissoes.js';
import { sessao } from './store.js';

const rotas = [];
let obterRaiz = null;
let limparAnterior = null;
let renderizacaoAtual = 0;

/**
 * @param {string} padrao caminho com parâmetros nomeados: "/produtos/:id".
 * @param {() => Promise<{render: Function}>} carregar import dinâmico da view.
 * @param {string|undefined} pode capacidade exigida (ver `permissoes.js`). A API também
 *   barra — isto aqui é conveniência, para a pessoa não bater numa tela que daria 403.
 */
export function rota(padrao, carregar, { pode: capacidade } = {}) {
  const nomes = [];
  const regex = new RegExp(
    '^' +
      padrao.replace(/\/:([A-Za-z_]+)/g, (_, nome) => {
        nomes.push(nome);
        return '/([^/]+)';
      }) +
      '$',
  );
  rotas.push({ regex, nomes, carregar, capacidade, padrao });
}

export function caminhoAtual() {
  const bruto = location.hash.replace(/^#/, '') || '/';
  return bruto.split('?')[0];
}

export function consultaAtual() {
  const [, query = ''] = location.hash.replace(/^#/, '').split('?');
  return Object.fromEntries(new URLSearchParams(query));
}

export function ir(caminho, substituir = false) {
  const destino = `#${caminho}`;
  if (location.hash === destino) {
    aplicar();
    return;
  }
  if (substituir) location.replace(destino);
  else location.hash = destino;
}

/** Troca só a query da rota atual, sem empilhar histórico (filtros de lista). */
export function trocarConsulta(params) {
  const busca = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') busca.set(k, String(v));
  }
  const texto = busca.toString();
  history.replaceState(null, '', `#${caminhoAtual()}${texto ? `?${texto}` : ''}`);
}

async function aplicar() {
  const caminho = caminhoAtual();
  const { usuario, carregando } = sessao.get();

  if (carregando) return;

  if (!usuario) {
    if (caminho !== '/entrar') {
      ir('/entrar', true);
      return;
    }
  } else if (caminho === '/entrar' || caminho === '/') {
    ir('/pdv', true);
    return;
  }

  const encontrada = rotas
    .map((r) => ({ r, m: r.regex.exec(caminho) }))
    .find(({ m }) => m);

  // A limpeza da tela anterior vem primeiro: ela desliga timers e listeners de documento, e
  // precisa rodar enquanto o DOM dela ainda existe — a linha seguinte pode apagá-lo.
  limparAnterior?.();
  limparAnterior = null;

  // A moldura (barra lateral ou tela de login) é montada aqui, uma vez por troca de
  // contexto: navegar entre telas não redesenha o menu nem perde o foco de quem digita.
  const raiz = obterRaiz(caminho, usuario);

  if (!encontrada) {
    raiz.innerHTML =
      '<div class="vazio"><p class="vazio__titulo">Tela não encontrada</p>' +
      '<p class="texto-suave">O endereço digitado não existe neste sistema.</p></div>';
    return;
  }

  const { r, m } = encontrada;
  if (r.capacidade && !papelPode(usuario?.papel, r.capacidade)) {
    raiz.innerHTML =
      '<div class="vazio"><p class="vazio__titulo">Área restrita</p>' +
      '<p class="texto-suave">Seu acesso não alcança esta tela. Fale com quem administra o sistema.</p></div>';
    return;
  }

  const params = Object.fromEntries(r.nomes.map((nome, i) => [nome, decodeURIComponent(m[i + 1])]));

  // Uma navegação rápida pode terminar depois de outra começar: só a última pinta a tela.
  const minhaVez = ++renderizacaoAtual;

  const modulo = await r.carregar();
  if (minhaVez !== renderizacaoAtual) return;

  raiz.innerHTML = '';
  raiz.scrollTop = 0;
  document.documentElement.dataset.rota = r.padrao;
  limparAnterior = (await modulo.render(raiz, params, consultaAtual())) || null;
  document.dispatchEvent(new CustomEvent('rota-trocada', { detail: { caminho } }));
}

/** `fabricaDeRaiz(caminho, usuario)` devolve o elemento onde a view será pintada. */
export function iniciarRoteador(fabricaDeRaiz) {
  obterRaiz = fabricaDeRaiz;
  addEventListener('hashchange', aplicar);
  sessao.inscrever(aplicar);
  aplicar();
}

export const recarregarRota = aplicar;
