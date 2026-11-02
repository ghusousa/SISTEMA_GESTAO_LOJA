/**
 * A ligação que mantém a tela do balcão em dia. **Espelho de `mobile/src/lib/tempoReal.ts`.**
 *
 * Aqui não há cache de consultas como no app: a SPA busca ao desenhar cada tela. Então o
 * aviso vira um pedido de redesenho da tela ATUAL, e só quando o assunto interessa a ela
 * — recarregar o PDV porque alguém lançou uma despesa seria trabalho à toa, e pior:
 * redesenhar o PDV no meio de uma venda apagaria o carrinho.
 *
 * O que chega é um aviso ("estoque mudou"), nunca o dado. Quem busca é a rota REST de
 * sempre, com o filtro por papel inteiro.
 *
 * Avisos que chegam juntos viram UMA rodada (mesma regra de `mobile/src/lib/avisos.ts`):
 * uma venda publica `vendas` e `estoque` no mesmo commit, uma devolução publica três
 * assuntos, e a tela de Estoque ou a do Caixa — que ouvem mais de um — se redesenhava uma
 * vez por aviso, buscando tudo de novo para mostrar a mesma coisa.
 */

import { acessoAtual } from './api.js';

const ESPERA_INICIAL = 1000;
const ESPERA_MAXIMA = 30_000;

/** Silêncio que fecha a rodada. Espelho de `JANELA_RAJADA` em `mobile/src/lib/avisos.ts`. */
const JANELA_RAJADA = 1000;
/** Teto contado do primeiro aviso: venda atrás de venda não adia a tela para sempre. */
const TETO_RAJADA = 2000;

let socket = null;
let tentativas = 0;
let religar = null;
let ligado = false;

/** Quem quer saber. `{ assuntos: Set, aoMudar: fn }` */
const inscritos = new Set();

/**
 * Registra interesse nos assuntos e devolve a função de cancelar.
 *
 * Cancelar não é opcional: a view é trocada a cada navegação, e um inscrito esquecido
 * continuaria mandando redesenhar uma tela que já saiu de cena.
 */
export function ouvir(assuntos, aoMudar) {
  const inscrito = { assuntos: new Set(assuntos), aoMudar };
  inscritos.add(inscrito);
  return () => inscritos.delete(inscrito);
}

/**
 * Uma rodada: cada tela inscrita em QUALQUER dos assuntos redesenha uma vez só. `aoMudar`
 * recebe o primeiro assunto da rodada que interessa a ela — as telas de hoje nem olham.
 */
function distribuir(assuntos) {
  for (const inscrito of [...inscritos]) {
    const motivo = [...assuntos].find((a) => inscrito.assuntos.has(a));
    if (motivo === undefined) continue;
    try {
      inscrito.aoMudar(motivo);
    } catch {
      // Uma tela que quebra ao se atualizar não pode derrubar as outras nem o canal.
    }
  }
}

// ----------------------------------------------------------------------------- rajada
// Espelho de `criarAgrupador` em `mobile/src/lib/avisos.ts` (lá, com teste de tempo).

let pendentes = new Set();
let primeiroAviso = 0;
let rodada = null;

/** Aba escondida: ninguém está olhando, a rodada espera a volta (`visibilitychange`). */
const escondida = () =>
  typeof document !== 'undefined' && document.visibilityState === 'hidden';

function avisar(assunto) {
  const agora = Date.now();
  if (pendentes.size === 0) primeiroAviso = agora;
  pendentes.add(assunto);
  clearTimeout(rodada);
  const espera = Math.max(0, Math.min(JANELA_RAJADA, primeiroAviso + TETO_RAJADA - agora));
  rodada = setTimeout(vencerRodada, espera);
}

function vencerRodada() {
  rodada = null;
  if (escondida()) return;
  soltarRodada();
}

function soltarRodada() {
  clearTimeout(rodada);
  rodada = null;
  if (pendentes.size === 0) return;
  // Troca o conjunto antes de distribuir: tela que quebra não arrasta a rodada seguinte.
  const assuntos = pendentes;
  pendentes = new Set();
  distribuir(assuntos);
}

/** Fecha o buraco de quando não ouvimos: redesenha agora, junto com o que estava pendente. */
function redesenharTudo() {
  pendentes.add('reconectado');
  soltarRodada();
}

function urlDoCanal() {
  // Mesma origem da página: a API serve o /app, então não há segundo endereço a manter.
  const protocolo = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocolo}//${location.host}/api/v1/tempo-real`;
}

function agendarReconexao() {
  if (!ligado || religar) return;
  const espera = Math.min(ESPERA_INICIAL * 2 ** tentativas, ESPERA_MAXIMA);
  tentativas += 1;
  religar = setTimeout(() => {
    religar = null;
    abrir();
  }, espera);
}

function abrir() {
  if (!ligado || socket) return;

  const token = acessoAtual();
  if (!token) {
    // Entre o F5 e a renovação da sessão não há token ainda. Tentar de novo em seguida.
    agendarReconexao();
    return;
  }

  const ws = new WebSocket(urlDoCanal());
  socket = ws;

  ws.addEventListener('open', () => {
    // Token no primeiro quadro, nunca na URL: em query string ele entraria no log de
    // acesso do servidor, no do proxy e no histórico de qualquer intermediário.
    ws.send(JSON.stringify({ tipo: 'entrar', token }));
  });

  ws.addEventListener('message', (evento) => {
    let assunto;
    try {
      ({ assunto } = JSON.parse(evento.data));
    } catch {
      return;
    }
    if (assunto === 'conectado') {
      tentativas = 0; // só depois de o servidor aceitar, não ao abrir o socket
      // Ficamos um tempo sem ouvir: o que mudou nesse meio-tempo não gerou aviso para
      // esta aba. Redesenhar agora fecha o buraco da reconexão.
      redesenharTudo();
      return;
    }
    if (assunto === 'ping') return;
    avisar(assunto);
  });

  const encerrar = () => {
    if (socket === ws) socket = null;
    agendarReconexao();
  };
  ws.addEventListener('close', encerrar);
  ws.addEventListener('error', encerrar);
}

/** Liga o canal. Chamado quando a sessão abre. */
export function conectarTempoReal() {
  if (ligado) return;
  ligado = true;
  tentativas = 0;
  abrir();
}

/** Desliga de vez: logout. */
export function desconectarTempoReal() {
  ligado = false;
  clearTimeout(religar);
  religar = null;
  // Rodada pendente da sessão que saiu não redesenha a tela de quem entrar depois.
  clearTimeout(rodada);
  rodada = null;
  pendentes = new Set();
  const atual = socket;
  socket = null;
  atual?.close();
}

// Aba que estava em segundo plano perde avisos quando o navegador congela o timer da
// reconexão. Voltar ao foco é a hora de tentar de novo, sem esperar a espera crescente —
// e de soltar a rodada que ficou segurada enquanto ninguém olhava.
//
// A guarda de `document` deixa este módulo importável fora do navegador — sem ela, quatro
// telas que dependem dele não davam para conferir por linha de comando, e o erro que
// aparecia era "document is not defined", que não diz nada sobre a tela.
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !ligado) return;
    if (socket && socket.readyState === WebSocket.OPEN) {
      redesenharTudo();
      return;
    }
    // Canal caído: o que se ouviu antes e ficou segurado com a aba escondida vale agora,
    // sem esperar a reconexão.
    soltarRodada();
    clearTimeout(religar);
    religar = null;
    tentativas = 0;
    abrir();
  });
}
