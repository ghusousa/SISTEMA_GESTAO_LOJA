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
 */

const SILENCIO_MAXIMO_MS = 300; // Leitor não pausa entre dígitos; dedo humano pausa.
const MINIMO_CARACTERES = 4;
const CARACTERE_VALIDO = /^[0-9A-Za-z]$/;

function ehCampoDeTexto(elemento) {
  if (!elemento) return false;
  if (elemento.isContentEditable) return true;
  const tag = elemento.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/**
 * @param {(codigo: string) => void} aoLer chamado com o código lido, já limpo.
 * @param {number} repeticaoMs janela em que o mesmo código não dispara duas vezes.
 *   O leitor solta rajada dupla quando a etiqueta passa devagar; sem isso a peça entrava
 *   duas vezes no carrinho e ninguém percebia.
 */
export function criarLeitor({ aoLer, repeticaoMs = 1200 }) {
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
    if (document.querySelector('.modal-fundo')) return;

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

  return {
    ligar() {
      if (ligado) return;
      ligado = true;
      document.addEventListener('keydown', aoTeclar, true);
    },
    desligar() {
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
    if (document.querySelector('.modal-fundo')) return;
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
