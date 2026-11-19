/**
 * Celular como leitor do computador (ADR-43, ADR-47): o chamado do celular do mesmo login, o
 * modal do QR, o selo "📱 Celular de Fulana" e a busca dos bipes.
 *
 * Dois jeitos de ligar, o mesmo pareamento no fim:
 * - o CHAMADO (ADR-47, o caminho principal): "Abrir no app o leitor de código", na área acima do
 *   campo de leitura (`leitor-chamado.js`), pede à API que chame o celular do MESMO login — a
 *   notificação, ou a faixa do app aberto. O celular atende pelo SINAL de 3 caracteres que as
 *   duas telas mostram: com o mesmo login em dois caixas, é ele que diz qual computador chamou;
 * - o QR (ADR-43, a alternativa: o celular de outra pessoa, ou o app sem atualizar): cria um
 *   pareamento (AGUARDANDO) e mostra o QR do convite e o código; o app aceita.
 * Aceito (ATIVO), o modal fecha, a área diz "ligado" e o selo aparece. Daí em diante cada bipe
 * da câmera vira uma linha na fila do servidor, e esta aba a esvazia com `retirar` — na hora do
 * aviso "leitor" do tempo real (sem a espera da rodada), quando o canal volta e, de rede de
 * segurança, de 2 em 2 s sem canal ou de 10 em 10 s com ele. Cada código retirado vai ao
 * leitor da tela aberta por `entregarCodigoDeFora` (`leitor.js`), como o leitor USB. O aceite e
 * o atendimento chegam pelo aviso "leitor_pareamento" (e, de rede, pela pergunta de 2 em 2 s).
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
 * A chave do chamado (`client_uuid`) também vai ao `sessionStorage`, ANTES do POST: o F5 no meio
 * — ou a rede que cai sem resposta — reenvia a MESMA chave, e o servidor devolve o chamado que
 * já criou em vez de deixá-lo órfão (atendível pelo celular, sem nenhuma aba retirando a fila).
 *
 * O aviso de tempo real só diz o assunto: o código lido nunca passa pelo WebSocket.
 */

import { acessoAtual, api, ErroApi } from './api.js';
import { entregarCodigoDeFora } from './leitor.js';
import { mostrarConvite } from './leitor-celular-janela.js';
import {
  avisoDoChamadoQueAcabou,
  avisoDoFimNoComputador,
  avisoDosDescartados,
  criarDonaDaAba,
  criarEntrega,
  intervaloDaBusca,
  umaPorVez,
} from './leitor-remoto.js';
import { nomeNaRaiz } from './raiz.js';
import { novoClientUuid, sessao } from './store.js';
import { canalConectado, ouvirNaHora } from './tempo-real.js';
import { aviso, avisarErro, confirmar } from './ui.js';

/**
 * O nome da chave do `sessionStorage` e do `BroadcastChannel`. Com a raiz (ADR-46): loja e
 * demo dividem a origem, e a aba que vai da loja para a demo não pode retomar lá o leitor
 * pareado aqui, nem as abas de uma responder pelas da outra. Na loja, o de sempre.
 */
const CHAVE = nomeNaRaiz('leitor-celular');
/**
 * O chamado que saiu desta aba e ainda não teve resposta: `{ client_uuid, substitui_id, desde,
 * usuario_id }`. Com a raiz no nome pelo mesmo motivo da `CHAVE`.
 */
const CHAVE_DO_CHAMADO = nomeNaRaiz('leitor-celular-chamado');
/** Enquanto o código espera o celular, a aba pergunta a cada 2 s se alguém aceitou. */
const ESPERA_DO_ACEITE_MS = 2000;
/** O `retirar` entrega no máximo 50 bipes por vez; veio cheio, pode ter sobrado. */
const LOTE_DO_SERVIDOR = 50;
/**
 * A chave pendente vale enquanto o chamado que ela pode ter criado vale (5 min, o prazo do
 * código no servidor). Reenviar uma mais velha criaria um chamado de surpresa — a aba reaberta
 * horas depois chamaria o celular sem ninguém ter clicado agora.
 */
const PRAZO_DA_PENDENCIA_MS = 5 * 60_000;

let moldura = null;
/** O pareamento desta aba, AGUARDANDO ou ATIVO; `null` quando não há leitor. */
let pareamento = null;
let timer = null;
let pararDeOuvir = null;
/** O modal do QR, quando aberto: `{ fechar(), vencer(), naTela(), fechou }` (`leitor-celular-janela.js`). */
let janela = null;
/** Sobe a cada desligar: resposta que chega de uma sessão que já saiu é descartada. */
let geracao = 0;
/** O código do QR nascendo (o POST no ar). */
let abrindo = false;
/** O POST do chamado no ar: a área diz "Chamando…" desde o clique, antes da resposta. */
let pedindo = false;
/** Outro pedido da área no ar (cancelar, desligar): os botões apagam até a resposta. */
let ocupado = false;
/**
 * Um POST que SUBSTITUI o AGUARDANDO desta aba está no ar (o chamado, ou o QR novo). A rodada
 * que encontra esse AGUARDANDO encerrado no meio não conclui nada: o encerramento é a própria
 * troca, e quem decide é a resposta dela — senão "Chamar de novo" avisaria que o chamado
 * anterior acabou por "leitores demais".
 */
let trocando = false;
/** Como saiu a notificação do último chamado (`{ situacao, celulares }`): a dica da área. */
let ultimaNotificacao = null;
/** Quem mais mostra o leitor: a área do chamado de cada tela aberta (`aoMudarOLeitor`). */
const ouvintes = new Set();

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

function lerPendencia() {
  try {
    const salvo = JSON.parse(sessionStorage.getItem(CHAVE_DO_CHAMADO) ?? 'null');
    if (typeof salvo?.client_uuid !== 'string') return null;
    return {
      client_uuid: salvo.client_uuid,
      substitui_id: Number.isInteger(salvo.substitui_id) ? salvo.substitui_id : null,
      desde: Number(salvo.desde) || 0,
      usuario_id: salvo.usuario_id ?? null,
    };
  } catch {
    return null;
  }
}

function guardarPendencia(pendente) {
  try {
    if (pendente) sessionStorage.setItem(CHAVE_DO_CHAMADO, JSON.stringify(pendente));
    else sessionStorage.removeItem(CHAVE_DO_CHAMADO);
  } catch {
    // Sem storage: o chamado funciona, só não é retomado no F5.
  }
}

/**
 * A pendência pode ser reenviada? Só a desta pessoa (a de quem saiu, reenviada no login de
 * outra, chamaria o celular errado) e só enquanto o chamado dela pode estar vivo.
 */
function pendenciaQueVale(pendente) {
  const eu = sessao.get().usuario?.id ?? null;
  if (!pendente || eu === null || pendente.usuario_id !== eu) return false;
  const idade = Date.now() - pendente.desde;
  return idade >= 0 && idade < PRAZO_DA_PENDENCIA_MS;
}

/**
 * O servidor respondeu e recusou (4xx): nada foi criado, a chave não serve mais. Sem resposta
 * (rede) ou com 5xx, o POST pode ter chegado — a chave fica, para o próximo clique ou o F5
 * reenviarem a MESMA e acharem o que ele criou.
 */
const recusaDefinitiva = (erro) => erro instanceof ErroApi && erro.status >= 400 && erro.status < 500;

// ----------------------------------------------------------------- estado

function adotar(p) {
  pareamento = p;
  guardarId(p.id);
  pintarSelo();
}

function esquecer() {
  pareamento = null;
  ultimaNotificacao = null;
  guardarId(null);
  clearTimeout(timer);
  timer = null;
  pintarSelo();
}

/** Pinta o botão e o selo da moldura e avisa quem mais mostra o leitor (a área de cada tela). */
function pintarSelo() {
  const botao = moldura?.querySelector('[data-leitor-celular]');
  const selo = moldura?.querySelector('[data-leitor-selo]');
  if (botao && selo) {
    const ativo = pareamento?.status === 'ATIVO';
    botao.hidden = ativo;
    selo.hidden = !ativo;
    // textContent: o nome vem do servidor e não vira HTML.
    if (ativo) {
      selo.querySelector('[data-leitor-nome]').textContent =
        `Celular de ${pareamento.aparelho_nome ?? '…'}`;
    }
  }
  for (const ouvinte of [...ouvintes]) {
    try {
      ouvinte();
    } catch {
      // Uma tela que quebra ao se pintar não derruba o leitor nem as outras.
    }
  }
}

/**
 * O leitor desta aba, para a área do chamado: o pareamento, o POST do chamado no ar
 * (`pedindo`), outro pedido no ar (`ocupado`) e como saiu a notificação do último chamado.
 */
export function estadoDoLeitor() {
  return { pareamento, pedindo, ocupado: ocupado || abrindo, notificacao: ultimaNotificacao };
}

/** Chama `fn` a cada mudança do leitor desta aba; devolve o cancelar (a tela sai de cena). */
export function aoMudarOLeitor(fn) {
  ouvintes.add(fn);
  return () => ouvintes.delete(fn);
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
    if (pareamento.status !== 'AGUARDANDO') terminou(null);
    else if (!trocando) codigoVenceu(null);
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
    else if (!trocando) codigoVenceu(p);
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
  ultimaNotificacao = null;
  adotar(p);
  janela?.fechar();
  const quem = p.aparelho_nome ?? 'alguém';
  // O sinal diz QUAL chamado o celular atendeu: com o mesmo login em dois caixas, é ele que
  // confirma que foi o daqui.
  aviso(
    p.chamado && p.sinal
      ? `Celular de ${quem} ligado como leitor (sinal ${p.sinal}).`
      : `Celular de ${quem} ligado como leitor.`,
  );
  void rodar(); // a fila que já tiver bipe sai agora (roda ao fim desta rodada)
}

/** O AGUARDANDO não vale mais (`p`: como o servidor o mostrou; `null`: sumiu). */
function codigoVenceu(p) {
  const eraChamado = !!pareamento?.chamado;
  esquecer();
  janela?.vencer();
  const texto = eraChamado ? avisoDoChamadoQueAcabou(p) : null;
  if (texto) aviso(texto, 'alerta');
}

function terminou(p) {
  const estava = pareamento?.status === 'ATIVO';
  esquecer();
  if (estava) aviso(avisoDoFimNoComputador(p), 'alerta');
}

// ----------------------------------------------------------------- o chamado (ADR-47)

/**
 * "Abrir no app o leitor de código": chama o celular do MESMO login. O chamado substitui o
 * AGUARDANDO desta aba (o chamado anterior ou o QR), nunca um ATIVO — com leitor ligado, o
 * caminho é "Chamar de novo", que desliga o antigo antes (e isso entra no diário).
 */
export async function chamarCelular() {
  if (pedindo || ocupado || abrindo) return;
  if (pareamento?.status === 'ATIVO') {
    await chamarDeNovo();
    return;
  }
  await chamar();
}

/**
 * "Chamar de novo": o celular perdeu a notificação, ou o app perdeu o leitor (a memória dele
 * some quando o sistema fecha o app). Com leitor ligado, desliga no servidor antes — honesto:
 * o celular antigo é desligado, e o diário mostra.
 */
export async function chamarDeNovo() {
  if (pedindo || ocupado || abrindo) return;
  const p = pareamento;
  if (p?.status === 'ATIVO') {
    if (!(await apagarNoServidor(p.id))) return;
    if (pareamento?.id === p.id) esquecer();
  }
  await chamar();
}

async function chamar({ refazer = true } = {}) {
  const minha = geracao;
  const pendente = lerPendencia();
  // Chamado anterior sem resposta (a rede caiu no meio): vai a MESMA chave. Se ele chegou, o
  // servidor devolve o que criou (e ignora o resto do pedido); se não chegou, o chamado nasce
  // agora — e substitui o AGUARDANDO que esta aba tem AGORA, não o da primeira tentativa.
  const reenvio = pendenciaQueVale(pendente);
  const substitui_id = pareamento?.status === 'AGUARDANDO' ? pareamento.id : null;
  const pedido = reenvio
    ? { ...pendente, substitui_id }
    : {
        client_uuid: novoClientUuid(),
        substitui_id,
        desde: Date.now(),
        usuario_id: sessao.get().usuario?.id ?? null,
      };
  // ANTES do POST: o F5 no meio retoma pela chave (`retomarChamado`).
  guardarPendencia(pedido);
  pedindo = true;
  trocando = true;
  pintarSelo();
  let r;
  try {
    r = await api.post('/leitor/chamados', {
      client_uuid: pedido.client_uuid,
      substitui_id: pedido.substitui_id,
    });
  } catch (erro) {
    if (recusaDefinitiva(erro)) guardarPendencia(null);
    if (minha !== geracao) return;
    pedindo = false;
    trocando = false;
    pintarSelo();
    falhaDoChamado(erro);
    return;
  }
  guardarPendencia(null);
  if (minha !== geracao) {
    // A sessão saiu enquanto o celular era chamado (o molde do `gerarCodigo`): nada de adotar.
    // Com token ainda, encerra no servidor; sem, ele vence sozinho em 5 min.
    if (acessoAtual()) void api.delete(`/leitor/pareamentos/${r.pareamento.id}`).catch(() => {});
    return;
  }
  pedindo = false;
  trocando = false;
  const p = r.pareamento;
  if (p.status !== 'AGUARDANDO' && p.status !== 'ATIVO') {
    // A chave reenviada era de um chamado que já acabou: chama de novo, com chave nova.
    if (reenvio && refazer) await chamar({ refazer: false });
    else pintarSelo();
    return;
  }
  janela?.fechar();
  if (p.status === 'ATIVO') {
    // O reenvio achou o chamado que o celular já atendeu: é o leitor desta aba.
    ligou(p);
    return;
  }
  ultimaNotificacao = r.notificacao ? { situacao: r.notificacao, celulares: r.celulares ?? 0 } : null;
  adotar(p);
  // Já: o celular com o app aberto pode ter atendido enquanto a notificação saía.
  acordar();
}

function falhaDoChamado(erro) {
  if (erro instanceof ErroApi && erro.code === 'LEITOR_CHAMADO_RAPIDO') {
    aviso('Espere um instante antes de chamar de novo.', 'alerta');
  } else if (erro instanceof ErroApi && erro.code === 'LEITOR_JA_LIGADO') {
    // O AGUARDANDO desta aba virou ATIVO no meio (o celular atendeu): a rodada acha o ligado.
    void rodar();
  } else {
    avisarErro(erro);
  }
}

/**
 * "Cancelar": o chamado (ou o QR) que espera o celular sai de circulação. AGUARDANDO não é
 * leitor ligado: o DELETE fica fora do diário, pela regra de sempre.
 */
export async function cancelarEspera() {
  if (pedindo || ocupado || abrindo) return;
  janela?.fechar();
  const p = pareamento;
  if (p?.status !== 'AGUARDANDO') return;
  if (!(await apagarNoServidor(p.id))) return;
  if (pareamento?.id === p.id) esquecer();
  else pintarSelo();
}

/**
 * DELETE do pareamento com os botões da área apagados; o 404 (já tinha acabado) vale como
 * feito. `false` quando falhou (já avisado) ou a sessão saiu no meio.
 */
async function apagarNoServidor(id) {
  const minha = geracao;
  ocupado = true;
  pintarSelo();
  try {
    await api.delete(`/leitor/pareamentos/${id}`);
  } catch (erro) {
    if (!(erro instanceof ErroApi && erro.status === 404)) {
      if (minha === geracao) {
        ocupado = false;
        pintarSelo();
        avisarErro(erro);
      }
      return false;
    }
  }
  if (minha !== geracao) return false;
  ocupado = false;
  return true;
}

/**
 * F5 (ou a aba reaberta) com um chamado sem resposta: reenvia a MESMA chave. O servidor devolve
 * o chamado que já criou (200, sem notificar de novo) — ou o cria agora, se o primeiro POST não
 * chegou. Pendência de outra pessoa ou velha demais é esquecida sem reenviar.
 */
async function retomarChamado(pendente, id) {
  const minha = geracao;
  if (!pendenciaQueVale(pendente)) {
    guardarPendencia(null);
    if (id) void restaurar(id);
    return;
  }
  pedindo = true;
  pintarSelo();
  let r = null;
  try {
    r = await api.post('/leitor/chamados', {
      client_uuid: pendente.client_uuid,
      substitui_id: pendente.substitui_id,
    });
    guardarPendencia(null);
  } catch (erro) {
    if (recusaDefinitiva(erro)) guardarPendencia(null);
  }
  if (minha !== geracao) return;
  const p = r?.pareamento;
  const vivo = p?.status === 'AGUARDANDO' || p?.status === 'ATIVO';
  // Cópia de "Duplicar aba": a aba de origem já cuida deste chamado.
  const deOutraAba = vivo && (await dona().outraCuida(p.id));
  if (minha !== geracao) return;
  pedindo = false;
  if (!vivo || deOutraAba) {
    if (deOutraAba) guardarId(null);
    pintarSelo();
    // Não deu (recusado, sem rede, já acabou): o leitor que a aba tinha antes, se tinha.
    if (!vivo && id) void restaurar(id);
    return;
  }
  ultimaNotificacao = r.notificacao ? { situacao: r.notificacao, celulares: r.celulares ?? 0 } : null;
  adotar(p);
  acordar();
}

// ----------------------------------------------------------------- modal do QR

async function gerarCodigo() {
  const minha = geracao;
  const substitui = pareamento?.status === 'AGUARDANDO' ? pareamento.id : null;
  let p;
  trocando = true;
  try {
    p = await api.post('/leitor/pareamentos', { substitui_id: substitui });
  } catch (erro) {
    // O AGUARDANDO desta aba virou ATIVO (o celular atendeu o chamado agora): o servidor não
    // troca um leitor ligado por um QR. A rodada acha o ATIVO e pinta "ligado".
    if (minha === geracao && erro instanceof ErroApi && erro.code === 'LEITOR_JA_LIGADO') {
      void rodar();
      return null;
    }
    throw erro;
  } finally {
    if (minha === geracao) trocando = false;
  }
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
  ultimaNotificacao = null;
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
  if (abrindo || janela || pedindo || ocupado) return;
  if (pareamento?.status === 'ATIVO') {
    void oferecerDesligar();
    return;
  }
  abrindo = true;
  pintarSelo();
  let primeiro;
  try {
    primeiro = await gerarCodigo();
  } catch (erro) {
    avisarErro(erro);
    return;
  } finally {
    abrindo = false;
    pintarSelo();
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

/** "Ler o QR" / "Mostrar o QR" da área: o modal de sempre, que substitui o chamado que espera. */
export const mostrarQrDoLeitor = abrirJanela;

async function oferecerDesligar() {
  const p = pareamento;
  if (p?.status !== 'ATIVO' || pedindo || ocupado) return;
  const sim = await confirmar({
    titulo: 'Celular como leitor',
    mensagem: `O celular de ${p.aparelho_nome ?? 'alguém'} está lendo códigos para este computador. Desligar?`,
    confirmarTexto: 'Desligar',
    perigo: true,
  });
  if (!sim || pareamento?.id !== p.id) return;
  if (!(await apagarNoServidor(p.id))) return;
  if (pareamento?.id === p.id) esquecer();
  else pintarSelo();
  aviso('Leitor do celular desligado.');
}

/** "Desligar" da área: o mesmo do selo da lateral, com a confirmação. */
export const desligarLeitorDaTela = oferecerDesligar;

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
  // Na hora, sem a espera da rodada: o bipe ("leitor") tem de cair no carrinho já, e o
  // atendimento do chamado ou o aceite do QR ("leitor_pareamento") tem de acender a área já.
  pararDeOuvir = ouvirNaHora(['leitor', 'leitor_pareamento', 'reconectado'], acordar);
  document.addEventListener('rota-trocada', soltarJanelaSumida);
  dona();
  const id = lerId();
  const pendente = lerPendencia();
  if (pendente) void retomarChamado(pendente, id);
  else if (id) void restaurar(id);
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
  pedindo = false;
  ocupado = false;
  trocando = false;
  ultimaNotificacao = null;
  clearTimeout(timer);
  timer = null;
  if (esquecerAba) {
    guardarId(null);
    guardarPendencia(null);
  }
  pintarSelo();
}

/**
 * Sair do sistema: desliga no servidor (melhor esforço, no máximo 3 s) ANTES de a sessão
 * ir embora — depois do logout não há mais token para isso, e o celular ficaria bipando
 * para um computador que ninguém está olhando. Vale também para o chamado que espera.
 */
export async function desligarLeitorCelular() {
  const id = pareamento?.id ?? lerId();
  pararLeitorCelular();
  if (!id) return;
  const desistir = new Promise((r) => setTimeout(r, 3000));
  await Promise.race([api.delete(`/leitor/pareamentos/${id}`).catch(() => {}), desistir]);
}
