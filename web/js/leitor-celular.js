/**
 * Celular como leitor do computador (ADR-43): o botão da moldura, o modal do QR, o selo
 * "📱 Celular de Fulana" e a busca dos bipes.
 *
 * O ciclo: o botão cria um pareamento (AGUARDANDO) e mostra o QR do convite e o código;
 * o app aceita (ATIVO), o modal fecha e o selo aparece. Daí em diante cada bipe da câmera
 * vira uma linha na fila do servidor, e esta aba a esvazia com `retirar` — na hora do aviso
 * "leitor" do tempo real (sem a espera da rodada), quando o canal volta e, de rede de
 * segurança, de 2 em 2 s sem canal ou de 10 em 10 s com ele. Cada código retirado vai ao
 * leitor da tela aberta por `entregarCodigoDeFora` (`leitor.js`), como o leitor USB.
 *
 * O que o `retirar` traz passa pela fila de entrega (`criarEntrega`, `leitor-remoto.js`):
 * código que encontra a tela ocupada (gravando, alguém digitando na lista) espera a vez, e a
 * retirada segue sem esperar a tela. Leitura descartada pelo servidor (mais de 2 min) vira
 * aviso, porque o celular mostrou "enviado" para ela.
 *
 * O id do pareamento fica no `sessionStorage` (por aba; não é credencial: sem a sessão do
 * mesmo login ele não serve para nada) para o F5 não desligar o leitor. "Duplicar aba" copia
 * o `sessionStorage`; a cópia pergunta antes (`criarDonaDaAba`) e não retoma o leitor que a
 * aba de origem ainda cuida. Sair do sistema desliga no servidor ANTES de a sessão ir embora.
 *
 * O aviso de tempo real só diz o assunto: o código lido nunca passa pelo WebSocket.
 */

import { acessoAtual, api, ErroApi } from './api.js';
import { entregarCodigoDeFora } from './leitor.js';
import { mostrarConvite } from './leitor-celular-janela.js';
import {
  avisoDoFimNoComputador,
  avisoDosDescartados,
  criarDonaDaAba,
  criarEntrega,
  intervaloDaBusca,
  umaPorVez,
} from './leitor-remoto.js';
import { nomeNaRaiz } from './raiz.js';
import { canalConectado, ouvirNaHora } from './tempo-real.js';
import { aviso, avisarErro, confirmar } from './ui.js';

/**
 * O nome da chave do `sessionStorage` e do `BroadcastChannel`. Com a raiz (ADR-46): loja e
 * demo dividem a origem, e a aba que vai da loja para a demo não pode retomar lá o leitor
 * pareado aqui, nem as abas de uma responder pelas da outra. Na loja, o de sempre.
 */
const CHAVE = nomeNaRaiz('leitor-celular');
/** Enquanto o código espera o celular, a aba pergunta a cada 2 s se alguém aceitou. */
const ESPERA_DO_ACEITE_MS = 2000;
/** O `retirar` entrega no máximo 50 bipes por vez; veio cheio, pode ter sobrado. */
const LOTE_DO_SERVIDOR = 50;

let moldura = null;
/** O pareamento desta aba, AGUARDANDO ou ATIVO; `null` quando não há leitor. */
let pareamento = null;
let timer = null;
let pararDeOuvir = null;
/** O modal do QR, quando aberto: `{ fechar(), vencer(), naTela(), fechou }` (`leitor-celular-janela.js`). */
let janela = null;
/** Sobe a cada desligar: resposta que chega de uma sessão que já saiu é descartada. */
let geracao = 0;

/** O caminho do código retirado até a tela (espera a tela ocupada, avisa o que não entrou). */
const entrega = criarEntrega({
  entregar: entregarCodigoDeFora,
  avisar: (texto) => aviso(texto, 'alerta'),
  aoErro: avisarErro,
});

/** Uma aba por leitor: a cópia de "Duplicar aba" pergunta antes de retomar. */
let donaDaAba = null;
function dona() {
  donaDaAba ??= criarDonaDaAba({
    canal: typeof BroadcastChannel === 'function' ? new BroadcastChannel(CHAVE) : null,
    meu: () => pareamento?.id ?? null,
  });
  return donaDaAba;
}

// ----------------------------------------------------------------- sessionStorage

function lerId() {
  try {
    const id = Number(sessionStorage.getItem(CHAVE));
    return Number.isInteger(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
}

function guardarId(id) {
  try {
    if (id) sessionStorage.setItem(CHAVE, String(id));
    else sessionStorage.removeItem(CHAVE);
  } catch {
    // Navegação privada sem storage: o leitor funciona, só não sobrevive ao F5.
  }
}

// ----------------------------------------------------------------- estado

function adotar(p) {
  pareamento = p;
  guardarId(p.id);
  pintarSelo();
}

function esquecer() {
  pareamento = null;
  guardarId(null);
  clearTimeout(timer);
  timer = null;
  pintarSelo();
}

function pintarSelo() {
  const botao = moldura?.querySelector('[data-leitor-celular]');
  const selo = moldura?.querySelector('[data-leitor-selo]');
  if (!botao || !selo) return;
  const ativo = pareamento?.status === 'ATIVO';
  botao.hidden = ativo;
  selo.hidden = !ativo;
  // textContent: o nome vem do servidor e não vira HTML.
  if (ativo) {
    selo.querySelector('[data-leitor-nome]').textContent =
      `Celular de ${pareamento.aparelho_nome ?? '…'}`;
  }
}

function agendar() {
  clearTimeout(timer);
  timer = null;
  if (!pareamento) return;
  const espera =
    pareamento.status === 'ATIVO' ? intervaloDaBusca(canalConectado()) : ESPERA_DO_ACEITE_MS;
  timer = setTimeout(acordar, espera);
}

// ----------------------------------------------------------------- busca

const rodar = umaPorVez(umaRodada, {
  aoErro(erro) {
    // 404: o pareamento não existe mais para este login (a conta do celular foi excluída,
    // a faxina levou). Outro erro (rede, 5xx) não diz nada: a próxima rodada tenta.
    if (!(erro instanceof ErroApi && erro.status === 404) || !pareamento) return;
    if (pareamento.status === 'AGUARDANDO') codigoVenceu();
    else terminou(null);
  },
});

/** Pede uma rodada já (aviso, canal de volta, timer) e reagenda a seguinte. */
function acordar() {
  if (!pareamento) return;
  void rodar().finally(agendar);
}

async function umaRodada() {
  const atual = pareamento;
  const minha = geracao;
  if (!atual) return;
  const mudou = () => minha !== geracao || pareamento?.id !== atual.id;

  if (atual.status === 'AGUARDANDO') {
    const p = await api.get(`/leitor/pareamentos/${atual.id}`);
    if (mudou()) return;
    if (p.status === 'ATIVO') ligou(p);
    else if (p.status === 'AGUARDANDO') pareamento = p;
    else codigoVenceu();
    return;
  }

  const lote = await api.post(`/leitor/pareamentos/${atual.id}/retirar`);
  if (mudou()) return;
  const descartes = avisoDosDescartados(lote.descartados, lote.pareamento.status);
  if (descartes) aviso(descartes, 'alerta');
  if (lote.pareamento.status !== 'ATIVO') {
    terminou(lote.pareamento);
    return;
  }
  pareamento = lote.pareamento;
  // Lote cheio: pode ter sobrado fila. Pede mais uma rodada (roda ao fim desta).
  if (lote.items.length >= LOTE_DO_SERVIDOR) void rodar();
  // Sem esperar a tela: código que espera a vez (tela ocupada) não segura a próxima retirada.
  void entrega.receber(lote.items.map((item) => item.codigo));
}

function ligou(p) {
  adotar(p);
  janela?.fechar();
  aviso(`Celular de ${p.aparelho_nome ?? 'alguém'} ligado como leitor.`);
  void rodar(); // a fila que já tiver bipe sai agora (roda ao fim desta rodada)
}

function codigoVenceu() {
  esquecer();
  janela?.vencer();
}

function terminou(p) {
  const estava = pareamento?.status === 'ATIVO';
  esquecer();
  if (estava) aviso(avisoDoFimNoComputador(p), 'alerta');
}

// ----------------------------------------------------------------- modal do QR

let abrindo = false;

async function gerarCodigo() {
  const minha = geracao;
  const substitui = pareamento?.status === 'AGUARDANDO' ? pareamento.id : null;
  const p = await api.post('/leitor/pareamentos', { substitui_id: substitui });
  if (minha !== geracao) {
    // A sessão saiu enquanto o código nascia: nada de adotar nem de abrir o QR por cima da
    // tela de entrada (um celular ainda aceitaria o código, para um computador sem ninguém).
    // Com token ainda, encerra no servidor; de outro login, o 404 não faz mal.
    if (acessoAtual()) void api.delete(`/leitor/pareamentos/${p.id}`).catch(() => {});
    return null;
  }
  // O prazo conta do relógio do SERVIDOR (criado + 5 min); aqui vale a duração, contada
  // do relógio desta máquina — que pode estar adiantado ou atrasado.
  const venceEm = Date.now() + (Date.parse(p.codigo_expira_em) - Date.parse(p.criado_em));
  adotar(p);
  agendar();
  return { p, venceEm };
}

/**
 * O roteador tira o modal da tela ao trocar de rota sem passar pelo ✕ (`router.js`), e a
 * promessa dele nunca resolve: a janela que não está mais no documento fecha de vez aqui —
 * senão o botão ficaria morto até um F5, e o relógio do QR girando sobre um nó solto.
 */
function soltarJanelaSumida() {
  if (janela && !janela.naTela()) {
    janela.fechar();
    janela = null;
  }
}

async function abrirJanela() {
  soltarJanelaSumida();
  if (abrindo || janela) return;
  if (pareamento?.status === 'ATIVO') {
    void oferecerDesligar();
    return;
  }
  abrindo = true;
  let primeiro;
  try {
    primeiro = await gerarCodigo();
  } catch (erro) {
    avisarErro(erro);
    return;
  } finally {
    abrindo = false;
  }
  if (!primeiro) return;
  const esta = mostrarConvite({ primeiro, gerarOutro: gerarCodigo });
  janela = esta;
  await esta.fechou;
  // Fechou (aceite, ✕, Esc): o código que ainda vale segue esperando em segundo plano até
  // vencer — o celular pode já ter lido o QR. Desligar no servidor aqui gravaria um
  // "Desligou o celular-leitor" no diário por um código que ninguém usou.
  if (janela === esta) janela = null;
}

async function oferecerDesligar() {
  const p = pareamento;
  if (p?.status !== 'ATIVO') return;
  const sim = await confirmar({
    titulo: 'Celular como leitor',
    mensagem: `O celular de ${p.aparelho_nome ?? 'alguém'} está lendo códigos para este computador. Desligar?`,
    confirmarTexto: 'Desligar',
    perigo: true,
  });
  if (!sim || pareamento?.id !== p.id) return;
  try {
    await api.delete(`/leitor/pareamentos/${p.id}`);
  } catch (erro) {
    if (!(erro instanceof ErroApi && erro.status === 404)) {
      avisarErro(erro);
      return;
    }
  }
  esquecer();
  aviso('Leitor do celular desligado.');
}

// ----------------------------------------------------------------- ciclo de vida

async function restaurar(id) {
  const minha = geracao;
  // Cópia de "Duplicar aba": se a aba de origem ainda cuida deste leitor, esta não o retoma.
  if (await dona().outraCuida(id)) {
    if (minha === geracao) guardarId(null);
    return;
  }
  if (minha !== geracao) return;
  try {
    const p = await api.get(`/leitor/pareamentos/${id}`);
    if (minha !== geracao) return;
    if (p.status === 'ATIVO' || p.status === 'AGUARDANDO') {
      adotar(p);
      acordar();
    } else {
      esquecer();
    }
  } catch (erro) {
    if (minha !== geracao) return;
    if (erro instanceof ErroApi && erro.status === 404) esquecer();
    else setTimeout(() => minha === geracao && !pareamento && restaurar(id), 5000);
  }
}

/** Liga o botão e o selo da moldura recém-desenhada e retoma o leitor desta aba (F5). */
export function ligarLeitorCelular(raizDaMoldura) {
  pararLeitorCelular({ esquecerAba: false });
  moldura = raizDaMoldura;
  moldura.querySelector('[data-leitor-celular]')?.addEventListener('click', () => void abrirJanela());
  moldura.querySelector('[data-leitor-selo]')?.addEventListener('click', () => void oferecerDesligar());
  // Na hora, sem a espera da rodada: o bipe tem de cair no carrinho já.
  pararDeOuvir = ouvirNaHora(['leitor', 'reconectado'], acordar);
  document.addEventListener('rota-trocada', soltarJanelaSumida);
  dona();
  const id = lerId();
  if (id) void restaurar(id);
}

/** Para tudo nesta aba, sem falar com o servidor (a sessão caiu: não há mais token). */
export function pararLeitorCelular({ esquecerAba = true } = {}) {
  geracao += 1;
  pararDeOuvir?.();
  pararDeOuvir = null;
  document.removeEventListener('rota-trocada', soltarJanelaSumida);
  // O que esperava a vez era do turno que saiu: não cai na tela de quem entrar depois.
  entrega.limpar();
  janela?.fechar();
  pareamento = null;
  clearTimeout(timer);
  timer = null;
  if (esquecerAba) guardarId(null);
  pintarSelo();
}

/**
 * Sair do sistema: desliga no servidor (melhor esforço, no máximo 3 s) ANTES de a sessão
 * ir embora — depois do logout não há mais token para isso, e o celular ficaria bipando
 * para um computador que ninguém está olhando.
 */
export async function desligarLeitorCelular() {
  const id = pareamento?.id ?? lerId();
  pararLeitorCelular();
  if (!id) return;
  const desistir = new Promise((r) => setTimeout(r, 3000));
  await Promise.race([api.delete(`/leitor/pareamentos/${id}`).catch(() => {}), desistir]);
}
