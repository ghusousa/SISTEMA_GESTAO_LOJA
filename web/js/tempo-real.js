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
 */

import { acessoAtual } from './api.js';

const ESPERA_INICIAL = 1000;
const ESPERA_MAXIMA = 30_000;

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

function distribuir(assunto) {
  for (const inscrito of [...inscritos]) {
    if (!inscrito.assuntos.has(assunto)) continue;
    try {
      inscrito.aoMudar(assunto);
    } catch {
      // Uma tela que quebra ao se atualizar não pode derrubar as outras nem o canal.
    }
  }
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
      distribuir('reconectado');
      return;
    }
    if (assunto === 'ping') return;
    distribuir(assunto);
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
  const atual = socket;
  socket = null;
  atual?.close();
}

// Aba que estava em segundo plano perde avisos quando o navegador congela o timer da
// reconexão. Voltar ao foco é a hora de tentar de novo, sem esperar a espera crescente.
//
// A guarda de `document` deixa este módulo importável fora do navegador — sem ela, quatro
// telas que dependem dele não davam para conferir por linha de comando, e o erro que
// aparecia era "document is not defined", que não diz nada sobre a tela.
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !ligado) return;
    if (socket && socket.readyState === WebSocket.OPEN) {
      distribuir('reconectado');
      return;
    }
    clearTimeout(religar);
    religar = null;
    tentativas = 0;
    abrir();
  });
}
