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
 * Com a resposta, ela só sai depois de o id do chamado estar guardado: o reenvio ainda pergunta
 * às outras abas quem cuida dele (até 300 ms), e o F5 nesse meio só acha o chamado pela chave.
 * Ela só vale enquanto descreve a aba: a aba que seguiu adiante (Cancelar, o QR, o chamado que
 * acabou, o leitor ligado) a esquece — reenviada depois a um servidor que nunca a recebeu, ela
 * criaria AGORA um chamado que ninguém pediu, e a aba largaria o leitor que tem.
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
  ASSUNTOS_DO_LEITOR,
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
/**
 * O F5 (ou a moldura redesenhada no login) retomando o leitor desta aba: até o servidor dizer o
 * que vale, a área fica travada. Um clique no meio criaria um chamado, e o leitor retomado
 * passaria por cima dele (ou o contrário) — um dos dois ficaria no servidor sem ninguém.
 */
let restaurando = false;
/** Como saiu a notificação do último chamado (`{ situacao, celulares }`): a dica da área. */
let ultimaNotificacao = null;
/** Quem mais mostra o leitor: a área do chamado de cada tela aberta (`aoMudarOLeitor`). */
const ouvintes = new Set();

/** Um pedido da área no ar, ou o F5 retomando: as ações esperam (e os botões apagam). */
const ocupada = () => pedindo || ocupado || abrindo || restaurando;

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
 * A pendência que ainda descreve esta aba: a que vale (`pendenciaQueVale`) e trocaria o MESMO
 * AGUARDANDO que a aba tem agora (`idAtual`; `null` quando não tem nenhum). A que não serve sai
 * do `sessionStorage`: a aba que seguiu adiante não reenvia a chave de antes.
 */
function pendenciaDaAba(idAtual) {
  const pendente = lerPendencia();
  if (pendente && pendenciaQueVale(pendente) && pendente.substitui_id === (idAtual ?? null)) return pendente;
  if (pendente) guardarPendencia(null);
  return null;
}

/**
 * A pendência desta aba, quando `p` (o AGUARDANDO dela, que acabou) foi trocado por ela: o POST
 * do chamado chegou ao servidor e a resposta se perdeu (a rede caiu na volta, ou o proxy cortou
 * enquanto a notificação saía — o chamado vai para o banco ANTES do push).
 */
function trocadoPelaPendencia(p) {
  if (p?.status !== 'ENCERRADO' || p.motivo_encerramento !== 'SUBSTITUIDO') return null;
  return pendenciaDaAba(p.id);
}

/**
 * O servidor respondeu e recusou (4xx): nada foi criado, a chave não serve mais. Sem resposta
 * (rede) ou com 5xx, o POST pode ter chegado — a chave fica, para o próximo clique ou o F5
 * reenviarem a MESMA e acharem o que ele criou.
 */
const recusaDefinitiva = (erro) => erro instanceof ErroApi && erro.status >= 400 && erro.status < 500;

// ----------------------------------------------------------------- estado

/** O leitor desta aba passa a ser `p`. Com ele, o F5 que estava retomando terminou. */
function adotar(p) {
  pareamento = p;
  restaurando = false;
  guardarId(p.id);
  // Ligado, a chave sem resposta não serve mais: o chamado dela trocaria este AGUARDANDO, e o
  // servidor não troca um leitor ligado (nem trocou: senão ele não teria ligado).
  if (p.status === 'ATIVO') guardarPendencia(null);
  pintarSelo();
}

/** Sem leitor na aba: o chamado ou o QR acabou, foi cancelado, ou o leitor foi desligado. */
function esquecer() {
  pareamento = null;
  restaurando = false;
  ultimaNotificacao = null;
  guardarId(null);
  // A chave sem resposta trocaria o que acabou de sair de cena: reenviada no F5, ela chamaria
  // o celular sem ninguém ter pedido — inclusive depois de a pessoa cancelar.
  guardarPendencia(null);
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
 * (`pedindo`), outro pedido no ar ou o F5 retomando (`ocupado`) e como saiu a notificação do
 * último chamado.
 */
export function estadoDoLeitor() {
  return { pareamento, pedindo, ocupado: ocupado || abrindo || restaurando, notificacao: ultimaNotificacao };
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
    else if (!trocando) void aguardandoAcabou(p);
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
  // A fila que já tiver bipe sai agora (ao fim desta rodada, se há uma girando), e a próxima
  // fica agendada: ligado pela resposta de um chamado, sem rodada nenhuma antes, a aba sem
  // canal nunca mais retiraria a fila.
  acordar();
}

/**
 * O AGUARDANDO desta aba acabou no servidor (`p`). Trocado pelo chamado da pendência desta aba
 * — "Chamar de novo" chegou e a resposta se perdeu —, o fim é a própria troca: a aba reenvia a
 * MESMA chave e acha o chamado novo pelo replay, em vez de avisar "há leitores demais" e deixá-lo
 * órfão. Sem essa pendência, ou com o reenvio recusado, foi por fora: o aviso de sempre.
 */
async function aguardandoAcabou(p) {
  const pendente = trocadoPelaPendencia(p);
  if (!pendente) {
    codigoVenceu(p);
    return;
  }
  const fim = await pedirChamado(pendente);
  if (fim.tipo === 'vivo') adotarChamado(fim);
  else if (fim.tipo === 'outra-aba') chamadoDeOutraAba(pendente, { avisar: true });
  else if (fim.tipo === 'acabou') codigoVenceu(fim.p);
  else if (fim.tipo === 'erro' && recusaDefinitiva(fim.erro)) codigoVenceu(p);
  // Sem resposta: a chave fica, e a próxima rodada tenta de novo (o aviso do clique já saiu).
  else if (fim.tipo === 'erro') pintarSelo();
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
  if (ocupada()) return;
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
  if (ocupada()) return;
  const p = pareamento;
  if (p?.status === 'ATIVO') {
    if (!(await apagarNoServidor(p.id))) return;
    if (pareamento?.id === p.id) esquecer();
  }
  await chamar();
}

/**
 * O clique. Chamado anterior sem resposta (a rede caiu no meio) que ainda descreve esta aba: vai
 * a MESMA chave — se ele chegou, o servidor devolve o que criou (e ignora o resto do pedido); se
 * não chegou, o chamado nasce agora. Senão, chave nova.
 */
async function chamar() {
  const substitui_id = pareamento?.status === 'AGUARDANDO' ? pareamento.id : null;
  const pendente = pendenciaDaAba(substitui_id);
  const fim = await pedirChamado(
    pendente ?? {
      client_uuid: novoClientUuid(),
      substitui_id,
      desde: Date.now(),
      usuario_id: sessao.get().usuario?.id ?? null,
    },
  );
  if (fim.tipo === 'vivo') adotarChamado(fim);
  else if (fim.tipo === 'outra-aba') chamadoDeOutraAba(fim.pedido, { avisar: true });
  // A chave reenviada era de um chamado que já acabou (ela saiu com a resposta): chama de novo,
  // com chave nova.
  else if (fim.tipo === 'acabou' && pendente) await chamar();
  else if (fim.tipo === 'erro') {
    pintarSelo();
    falhaDoChamado(fim.erro);
  } else if (fim.tipo !== 'saiu') pintarSelo();
}

/**
 * O POST do chamado com a chave de `pedido`, gravada no `sessionStorage` ANTES — o F5 no meio
 * (ou a rede que cai sem resposta) reenvia a MESMA. Devolve como terminou:
 * - `saiu`: a sessão saiu (ou a aba recomeçou) no meio — nada a adotar (`largarChamado`);
 * - `erro`: sem chamado. Recusado (4xx), a chave sai; sem resposta ou 5xx, ela fica: o POST pode
 *   ter chegado;
 * - `outra-aba`: o reenvio achou o chamado que outra aba já cuida (a cópia de "Duplicar aba"
 *   herda a pendência) — uma aba por leitor, e esta não o adota. A chave sai;
 * - `acabou`: o reenvio achou um chamado que já terminou. A chave sai;
 * - `vivo`: AGUARDANDO ou ATIVO, para `adotarChamado` — que tira a chave depois de guardar o id.
 */
async function pedirChamado(pedido) {
  const minha = geracao;
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
    if (minha !== geracao) return { tipo: 'saiu' };
    pedindo = false;
    trocando = false;
    return { tipo: 'erro', erro };
  }
  if (minha !== geracao) {
    largarChamado(r.pareamento, pedido);
    return { tipo: 'saiu' };
  }
  const p = r.pareamento;
  const vivo = p.status === 'AGUARDANDO' || p.status === 'ATIVO';
  // Só o replay (`notificacao` nula: a chave já tinha criado este chamado) pode ser de outra
  // aba; o chamado que nasce agora ninguém mais conhece. A chave continua na aba durante a
  // pergunta (até 300 ms quando nenhuma outra responde): o id ainda não está lá, e o F5 — ou a
  // aba fechada e reaberta — que caísse aqui sem ela acharia a aba livre, com o chamado no
  // servidor e na faixa do celular, sem ninguém retirando a fila. A sessão que sai no meio deixa
  // a chave para `largarChamado` decidir, como antes da pergunta.
  const deOutraAba = vivo && r.notificacao == null && (await dona().outraCuida(p.id));
  if (minha !== geracao) {
    if (!deOutraAba) largarChamado(p, pedido);
    return { tipo: 'saiu' };
  }
  pedindo = false;
  trocando = false;
  if (deOutraAba || !vivo) {
    // O chamado não é desta aba (outra cuida dele, ou ele já acabou): a chave não leva a nada.
    guardarPendencia(null);
    return { tipo: deOutraAba ? 'outra-aba' : 'acabou', p, pedido };
  }
  const notificacao = r.notificacao ? { situacao: r.notificacao, celulares: r.celulares ?? 0 } : null;
  // Vivo e desta aba: a chave sai em `adotarChamado`, depois de o id ir para o `sessionStorage`.
  return { tipo: 'vivo', p, notificacao };
}

/**
 * O chamado que chegou depois de a sessão sair: nada de adotar. Largado de vez — Sair leva a
 * pendência junto —, ele é encerrado no servidor com o token que ainda houver (o molde do
 * `gerarCodigo`); sem token, vence sozinho em 5 min. A pendência que ficou (a sessão caiu, e a
 * mesma pessoa pode entrar de novo e retomá-la) e o que esta aba já adotou outra vez são de quem
 * retomou: encerrar ali derrubaria o chamado que a aba acabou de achar.
 */
function largarChamado(p, pedido) {
  const vivo = p?.status === 'AGUARDANDO' || p?.status === 'ATIVO';
  if (!vivo || !acessoAtual() || pareamento?.id === p.id) return;
  if (lerPendencia()?.client_uuid === pedido.client_uuid) return;
  void api.delete(`/leitor/pareamentos/${p.id}`).catch(() => {});
}

/**
 * O chamado da resposta vira o leitor desta aba: o AGUARDANDO ("chamando") ou o já atendido. A
 * chave sem resposta sai só aqui, com o id dele já guardado (`adotar`): em momento nenhum a aba
 * fica sem as duas, e o F5 sempre acha o chamado — pelo id ou, até aqui, pela chave.
 */
function adotarChamado({ p, notificacao }) {
  janela?.fechar();
  if (p.status === 'ATIVO') {
    // O reenvio achou o chamado que o celular já atendeu: é o leitor desta aba (`adotar` de um
    // ligado guarda o id e tira a chave).
    ligou(p);
    return;
  }
  ultimaNotificacao = notificacao;
  adotar(p);
  guardarPendencia(null);
  // Já: o celular com o app aberto pode ter atendido enquanto a notificação saía.
  acordar();
}

/**
 * O reenvio achou o chamado que outra aba cuida: esta não o adota. O AGUARDANDO que ele trocou
 * (o da pendência, se esta aba ainda o tem) também já não vale no servidor.
 */
function chamadoDeOutraAba(pedido, { avisar = false } = {}) {
  restaurando = false;
  if (pedido.substitui_id !== null && pareamento?.id === pedido.substitui_id) esquecer();
  else {
    if (pedido.substitui_id !== null && lerId() === pedido.substitui_id) guardarId(null);
    pintarSelo();
  }
  if (avisar) aviso('Este chamado já está aberto em outra aba.', 'alerta');
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
  if (ocupada()) return;
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
 * F5 (ou a aba reaberta) com a pendência desta aba (`pendenciaDaAba`): reenvia a MESMA chave. O
 * servidor devolve o chamado que já criou (200, sem notificar de novo) — ou o cria agora, se o
 * primeiro POST não chegou. Não deu (recusado, sem rede, já acabou): o leitor que a aba tinha
 * antes, se tinha (`id`).
 */
async function retomarChamado(pendente, id) {
  const minha = geracao;
  const fim = await pedirChamado(pendente);
  if (minha !== geracao || fim.tipo === 'saiu') return;
  if (fim.tipo === 'vivo') adotarChamado(fim);
  // Cópia de "Duplicar aba": a aba de origem já cuida deste chamado.
  else if (fim.tipo === 'outra-aba') chamadoDeOutraAba(pendente);
  else if (id) void restaurar(id);
  else {
    restaurando = false;
    pintarSelo();
  }
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
  // O QR troca o que o chamado sem resposta trocaria: a chave dele não descreve mais esta aba.
  guardarPendencia(null);
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
  if (janela || ocupada()) return;
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
  if (p?.status !== 'ATIVO' || ocupada()) return;
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

/**
 * O leitor guardado na aba (F5), se ainda vale. A área fica travada (`restaurando`) até o
 * servidor responder; `adotar` e `esquecer` destravam.
 */
async function restaurar(id) {
  const minha = geracao;
  // Uma resposta que chega depois de a aba seguir adiante não passa por cima de nada.
  const desistiu = () => minha !== geracao || pareamento !== null;
  // Cópia de "Duplicar aba": se a aba de origem ainda cuida deste leitor, esta não o retoma.
  const deOutraAba = await dona().outraCuida(id);
  if (desistiu()) return;
  if (deOutraAba) {
    guardarId(null);
    restaurando = false;
    pintarSelo();
    return;
  }
  let p;
  try {
    p = await api.get(`/leitor/pareamentos/${id}`);
  } catch (erro) {
    if (desistiu()) return;
    if (erro instanceof ErroApi && erro.status === 404) esquecer();
    // Sem resposta: de novo daqui a pouco, com a área ainda travada — o leitor guardado pode
    // estar vivo, e um chamado criado agora passaria por cima dele.
    else setTimeout(() => !desistiu() && restaurar(id), 5000);
    return;
  }
  if (desistiu()) return;
  if (p.status === 'ATIVO' || p.status === 'AGUARDANDO') {
    adotar(p);
    acordar();
    return;
  }
  // Trocado pelo chamado da pendência desta aba: o reenvio do F5 ficou sem resposta, e o POST de
  // antes tinha chegado. A mesma chave de novo, com folga — sem martelar um servidor que falha.
  const pendente = trocadoPelaPendencia(p);
  if (pendente) setTimeout(() => !desistiu() && retomarChamado(pendente, id), ESPERA_DO_ACEITE_MS);
  else esquecer();
}

/** Liga o botão e o selo da moldura recém-desenhada e retoma o leitor desta aba (F5). */
export function ligarLeitorCelular(raizDaMoldura) {
  pararLeitorCelular({ esquecerAba: false });
  moldura = raizDaMoldura;
  moldura.querySelector('[data-leitor-celular]')?.addEventListener('click', () => void abrirJanela());
  moldura.querySelector('[data-leitor-selo]')?.addEventListener('click', () => void oferecerDesligar());
  // Na hora, sem a espera da rodada: o bipe ("leitor") tem de cair no carrinho já, e o
  // atendimento do chamado ou o aceite do QR ("leitor_pareamento") tem de acender a área já.
  pararDeOuvir = ouvirNaHora(ASSUNTOS_DO_LEITOR, acordar);
  document.addEventListener('rota-trocada', soltarJanelaSumida);
  dona();
  const id = lerId();
  // A chave sem resposta só volta se ainda descreve a aba (a de outra pessoa, velha ou de um
  // estado que a aba já deixou sai aqui, sem reenviar).
  const pendente = pendenciaDaAba(id);
  if (!pendente && !id) return;
  restaurando = true;
  pintarSelo();
  if (pendente) void retomarChamado(pendente, id);
  else void restaurar(id);
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
  restaurando = false;
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
