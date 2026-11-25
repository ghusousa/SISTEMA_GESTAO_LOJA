/**
 * "Abrir no app o leitor de código" (ADR-47): a área acima do campo de leitura das telas que
 * leem código — PDV, Devolução, Entrada, Inventário e Condicional nova. Cada tela liga a sua
 * (`ligarBotaoDoCelular`) e a solta ao sair; o estado é um só, o da aba (`leitor-celular.js`),
 * e o que mostrar em cada estado sai de `oQueMostrar` (`leitor-remoto.js`, que tem teste).
 *
 * Nada aqui é modal, de propósito: com uma janela aberta o leitor USB e a entrega do celular
 * param (`leitor.js`), e o "Chamando…" pode durar minutos enquanto a vendedora segue bipando
 * pelo leitor do balcão. Os cliques vão por delegação em `data-acao` — a CSP é `script-src
 * 'self'`, sem atributo `onclick` — e o foco volta sozinho ao campo de leitura (`manterFoco`).
 */

import {
  aoMudarOLeitor,
  cancelarEspera,
  chamarCelular,
  chamarDeNovo,
  desligarLeitorDaTela,
  estadoDoLeitor,
  mostrarQrDoLeitor,
} from './leitor-celular.js';
import { estadoDoChamado, oQueMostrar } from './leitor-remoto.js';
import { aoMudarLoja, loja } from './loja.js';
import { avisarErro, html } from './ui.js';

/** O `data-acao` de cada botão e o que ele faz. */
const ACOES = {
  chamar: chamarCelular,
  'chamar-de-novo': chamarDeNovo,
  qr: mostrarQrDoLeitor,
  'mostrar-qr': mostrarQrDoLeitor,
  cancelar: cancelarEspera,
  desligar: desligarLeitorDaTela,
};

// Botão secundário de propósito: o principal da tela continua sendo o da venda (ou da entrada).
const CLASSES = {
  principal: 'botao botao--neutro botao--pequeno',
  botao: 'botao botao--neutro botao--pequeno',
  link: 'botao botao--fantasma botao--pequeno',
};

/** Os botões de um estado. Só rótulos nossos, fixos: nada do servidor passa por esta marcação. */
const marcacaoDosBotoes = (acoes) =>
  String(
    html`${acoes.map(
      (a) =>
        html`<button type="button" class="${CLASSES[a.jeito]}" data-acao="${a.acao}">${
          a.jeito === 'principal' ? html`<span aria-hidden="true">📱</span>` : ''
        }<span>${a.rotulo}</span></button>`,
    )}`,
  );

/** Um pedaço da frase: texto solto, ou o sinal em destaque — os dois por `textContent`. */
function pedaco(doc, trecho) {
  if (typeof trecho === 'string') return doc.createTextNode(trecho);
  const sinal = doc.createElement('strong');
  sinal.className = 'leitor-chamado__sinal';
  sinal.textContent = trecho.sinal;
  return sinal;
}

/**
 * Liga a área `[data-leitor-chamado]` de uma tela: pinta agora e a cada mudança do leitor da
 * aba. Devolve o soltar, que a tela chama na limpeza.
 */
export function ligarBotaoDoCelular(caixa) {
  if (!caixa) return () => {};
  const doc = caixa.ownerDocument;
  caixa.innerHTML = html`
    <span class="leitor-chamado__texto" data-texto aria-live="polite" hidden></span>
    <span class="leitor-chamado__acoes" data-acoes></span>
    <span class="leitor-chamado__dica" data-dica aria-live="polite" hidden></span>
  `;
  const texto = caixa.querySelector('[data-texto]');
  const botoes = caixa.querySelector('[data-acoes]');
  const dica = caixa.querySelector('[data-dica]');
  let fraseAtual = null;
  let botoesAtuais = null;

  function pintar() {
    const leitor = estadoDoLeitor();
    const estado = estadoDoChamado(leitor);
    // A dica do chamado sem situação (F5, replay) depende de o servidor mandar notificação: com o
    // push desligado (o padrão), a área não promete uma notificação que não vem.
    const m = oQueMostrar(estado, { ...leitor, pushLigado: loja().notificacoes_push === true });
    caixa.dataset.estado = estado;
    // Só o que mudou: repintar igual faria o leitor de tela repetir a frase, e refazer os
    // botões tiraria o foco de quem usa o teclado.
    if (m.texto !== fraseAtual) {
      fraseAtual = m.texto;
      texto.replaceChildren(...m.trechos.map((t) => pedaco(doc, t)));
      texto.hidden = !m.texto;
    }
    if ((m.dica ?? '') !== dica.textContent) dica.textContent = m.dica ?? '';
    dica.hidden = !m.dica;
    const marcacao = marcacaoDosBotoes(m.acoes);
    if (marcacao !== botoesAtuais) {
      botoesAtuais = marcacao;
      botoes.innerHTML = marcacao;
    }
    for (const botao of botoes.querySelectorAll('button')) botao.disabled = m.travado;
  }

  function aoClicar(evento) {
    const botao = evento.target?.closest?.('[data-acao]');
    if (!botao || !caixa.contains(botao) || botao.disabled) return;
    const fazer = ACOES[botao.dataset.acao];
    if (fazer) Promise.resolve().then(() => fazer()).catch(avisarErro);
  }

  caixa.addEventListener('click', aoClicar);
  const pararDeOuvir = aoMudarOLeitor(pintar);
  // `GET /configuracao` (com o `notificacoes_push`) pode chegar depois da área pintada.
  const pararDeOuvirALoja = aoMudarLoja(pintar);
  pintar();
  return () => {
    pararDeOuvir();
    pararDeOuvirALoja();
    caixa.removeEventListener('click', aoClicar);
  };
}
