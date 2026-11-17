/**
 * Leitor de código de barras USB.
 *
 * O leitor de balcão não é uma câmera: para o computador ele é um teclado. Ao bipar uma
 * etiqueta ele "digita" os dígitos em rajada e termina com Enter. Não existe API de
 * navegador para isso — o que existe é ouvir o teclado e reconhecer a rajada.
 *
 * São dois caminhos, de propósito:
 *
 * 1. Campo dedicado (`data-leitor`): quando o cursor está nele, o leitor digita ali e o
 *    Enter dispara a leitura. É o mesmo campo em que a pessoa digita o código à mão quando
 *    a etiqueta está rasgada — leitor e dedo entram pelo mesmo lugar.
 *
 * 2. Captura global: se o foco escapou para um botão ou para o corpo da página, os dígitos
 *    se perdiam. Aqui eles são acumulados e o Enter fecha a leitura do mesmo jeito. Campos
 *    de texto comuns são ignorados, senão digitar o nome de um produto viraria uma bipada.
 *
 * E uma terceira entrada, sem teclado: o celular como leitor (ADR-43, `leitor-celular.js`).
 * O bipe da câmera chega pela API e é entregue por `entregarCodigoDeFora` ao leitor da tela
 * aberta — o mesmo `aoLer` do leitor USB, então PDV, Devolução, Entrada, Inventário e
 * Condicional nova não sabem de onde veio o código.
 */

const SILENCIO_MAXIMO_MS = 300; // Leitor não pausa entre dígitos; dedo humano pausa.
const MINIMO_CARACTERES = 4;
const CARACTERE_VALIDO = /^[0-9A-Za-z]$/;

/** O leitor da tela aberta: o último que ligou e ainda não desligou. `{ aoLer, ocupadoQuando }` */
let leitorDaTela = null;

/** Modal aberto: a pessoa está resolvendo outra coisa (mesma regra do teclado e do foco). */
export const haJanelaAberta = () => document.querySelector('.modal-fundo') !== null;

function ehCampoDeTexto(elemento) {
  if (!elemento) return false;
  if (elemento.isContentEditable) return true;
  const tag = elemento.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/** Onde se DIGITA (texto, número, data): caixa de marcar e botão não contam. */
const SEM_DIGITACAO = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'range', 'color', 'image']);

/**
 * A pessoa está com o cursor num campo de digitar dentro de `area` — a quantidade e o custo da
 * lista da conferência, o motivo da devolução. Serve ao `ocupadoQuando` das telas: o código que
 * vem do celular redesenha a lista por baixo, e o que ela digitou e ainda não confirmou sumiria
 * (o campo novo nasce com o valor antigo). Com o leitor USB isso não acontecia: quem digita é
 * quem bipa.
 */
export function digitandoEm(area) {
  const atual = document.activeElement;
  if (!area || !atual || !area.contains(atual)) return false;
  if (atual.isContentEditable || atual.tagName === 'TEXTAREA') return true;
  return atual.tagName === 'INPUT' && !SEM_DIGITACAO.has(String(atual.type || 'text').toLowerCase());
}

/**
 * @param {(codigo: string) => void} aoLer chamado com o código lido, já limpo.
 * @param {number} repeticaoMs janela em que o mesmo código não dispara duas vezes.
 *   O leitor solta rajada dupla quando a etiqueta passa devagar; sem isso a peça entrava
 *   duas vezes no carrinho e ninguém percebia.
 * @param {() => boolean} [ignorarQuando] o Enter é de outra pessoa agora.
 *   O mesmo campo aceita bipe E nome digitado: com a lista de resultados aberta, o Enter
 *   escolhe da lista, e sem isto ele viraria uma bipada de "camiseta" — que não existe.
 * @param {() => boolean} [ocupadoQuando] a tela não pode receber código DE FORA agora (o
 *   celular, `entregarCodigoDeFora`): está gravando — a lista já foi copiada para o POST e
 *   será limpa quando a resposta chegar, levando junto o que entrasse no meio — ou a pessoa
 *   está digitando na lista que o código redesenharia (`digitandoEm`). Quem entrega guarda o
 *   código e tenta de novo. O leitor USB não passa por aqui: quem bipa é quem clicou.
 */
export function criarLeitor({ aoLer, repeticaoMs = 1200, ignorarQuando = null, ocupadoQuando = null }) {
  let buffer = '';
  let ultimoCaractere = 0;
  let ultimoCodigo = '';
  let ultimaLeitura = 0;
  let ligado = false;

  function disparar(codigo) {
    const limpo = codigo.trim();
    if (limpo.length < MINIMO_CARACTERES) return false;
    const agora = Date.now();
    if (limpo === ultimoCodigo && agora - ultimaLeitura < repeticaoMs) return false;
    ultimoCodigo = limpo;
    ultimaLeitura = agora;
    aoLer(limpo);
    return true;
  }

  function aoTeclar(evento) {
    if (!ligado) return;
    // Modal aberto quer dizer que a pessoa está resolvendo outra coisa: bipada não atropela.
    if (haJanelaAberta()) return;
    if (ignorarQuando?.()) return;

    const alvo = evento.target;
    const noCampoDoLeitor = alvo?.dataset?.leitor !== undefined;
    if (ehCampoDeTexto(alvo) && !noCampoDoLeitor) return;

    if (evento.key === 'Enter') {
      if (noCampoDoLeitor) {
        evento.preventDefault();
        if (disparar(alvo.value)) alvo.value = '';
        buffer = '';
        return;
      }
      if (buffer) {
        evento.preventDefault();
        disparar(buffer);
        buffer = '';
      }
      return;
    }

    if (noCampoDoLeitor) return; // O próprio campo acumula; o Enter acima resolve.
    if (evento.ctrlKey || evento.metaKey || evento.altKey) return;
    if (!CARACTERE_VALIDO.test(evento.key)) return;

    const agora = Date.now();
    if (agora - ultimoCaractere > SILENCIO_MAXIMO_MS) buffer = '';
    ultimoCaractere = agora;
    buffer += evento.key;
  }

  const registro = { aoLer, ocupadoQuando };

  return {
    ligar() {
      leitorDaTela = registro;
      if (ligado) return;
      ligado = true;
      document.addEventListener('keydown', aoTeclar, true);
    },
    desligar() {
      if (leitorDaTela === registro) leitorDaTela = null;
      ligado = false;
      buffer = '';
      document.removeEventListener('keydown', aoTeclar, true);
    },
    /** Permite bipar o mesmo código de novo já (usado ao limpar o carrinho). */
    esquecerUltimo() {
      ultimoCodigo = '';
    },
  };
}

/**
 * Mantém o cursor no campo do leitor.
 *
 * No balcão ninguém clica antes de bipar. Depois de fechar uma venda, de mexer numa
 * quantidade ou de clicar num botão, o foco precisa voltar sozinho — senão a próxima
 * bipada cai no vazio. Sai de cena enquanto a pessoa está usando outro campo ou um modal.
 */
export function manterFoco(input) {
  let ativo = true;

  const focar = () => {
    if (!ativo || !input.isConnected) return;
    if (haJanelaAberta()) return;
    const atual = document.activeElement;
    if (atual !== input && ehCampoDeTexto(atual)) return;
    input.focus();
  };

  const timer = setInterval(focar, 700);
  const aoClicar = () => setTimeout(focar, 0);
  document.addEventListener('click', aoClicar);
  focar();

  return () => {
    ativo = false;
    clearInterval(timer);
    document.removeEventListener('click', aoClicar);
  };
}

/**
 * Entrega um código que não veio do teclado (o celular como leitor) ao leitor da tela.
 *
 * Chama o `aoLer` DIRETO: sem a trava de repetição (duas peças iguais bipadas na câmera
 * são duas peças — quem filtra a leitura dupla é o celular) e sem esperar Enter. Espera o
 * `aoLer` terminar, para um lote de bipes cair na ordem em que foi lido — mas não espera a
 * PESSOA: se o `aoLer` abrir uma janela (a "peça ainda não cadastrada" da Entrada), o código
 * conta como entregue já, e os próximos encontram a janela aberta. Esperar a resposta dela
 * seguraria a fila inteira, que envelheceria no servidor e seria descartada calada.
 *
 * Devolve o que aconteceu, e quem chama avisa a pessoa: `'entregue'`; `'janela-aberta'` (um
 * modal na frente: o código não atropela o que a pessoa está resolvendo); `'tela-ocupada'` (o
 * `ocupadoQuando` da tela: gravando, ou alguém digitando na lista — guarde e tente de novo);
 * ou `'sem-leitor'` (nenhuma tela que lê código ligada — ainda, num F5, ou nesta tela).
 */
export async function entregarCodigoDeFora(codigo) {
  if (haJanelaAberta()) return 'janela-aberta';
  const alvo = leitorDaTela;
  if (!alvo) return 'sem-leitor';
  if (alvo.ocupadoQuando?.()) return 'tela-ocupada';
  piscarCampo();
  const janela = quandoAbrirJanela();
  try {
    const lendo = Promise.resolve(alvo.aoLer(codigo));
    // Se a janela ganhar, a leitura segue sozinha; a falha dela é da tela (que avisa).
    lendo.catch(() => {});
    await Promise.race([lendo, janela.abriu]);
  } finally {
    janela.parar();
  }
  return 'entregue';
}

/** Resolve quando um modal aparece na página; `parar()` solta o observador. */
function quandoAbrirJanela() {
  let observador = null;
  const abriu = new Promise((resolve) => {
    if (typeof MutationObserver !== 'function' || !document.body) return;
    observador = new MutationObserver(() => {
      if (haJanelaAberta()) resolve();
    });
    // O `modal` de `ui.js` pendura o fundo direto no `body`.
    observador.observe(document.body, { childList: true });
  });
  return { abriu, parar: () => observador?.disconnect() };
}

let fimDoPisca = null;

/** Retorno curto no campo do leitor: o código chegou de longe, sem ninguém digitar. */
function piscarCampo() {
  const campo = document.querySelector('[data-leitor]');
  if (!campo) return;
  campo.classList.remove('is-remoto');
  void campo.offsetWidth; // reinicia a animação quando dois bipes chegam juntos
  campo.classList.add('is-remoto');
  clearTimeout(fimDoPisca);
  fimDoPisca = setTimeout(() => campo.classList.remove('is-remoto'), 900);
}
