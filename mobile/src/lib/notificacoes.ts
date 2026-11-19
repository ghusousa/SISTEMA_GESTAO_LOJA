/**
 * Notificações do chamado do leitor (ADR-47) — as regras, sem tocar no sistema nem na rede,
 * para dar para testar. Quem fala com o iOS e com a API é `lib/pushDoLeitor.ts`.
 *
 * O computador chama o leitor no celular do MESMO login ("Abrir no app o leitor de código").
 * Com o app aberto, o chamado chega pela faixa (tempo real); com ele fechado, só por push — e o
 * push nasce DESLIGADO no servidor (`NOTIFICACOES_PUSH`): quem diz se ele funciona é o
 * `GET /configuracao` (`notificacoes_push`). Desligado, o app nunca pede a permissão nem busca
 * o token da Expo — ninguém vê um pedido de notificação que não vai funcionar —, mas se
 * registra do mesmo jeito, sem token: é o registro que faz o computador dizer a verdade
 * ("nenhum app atualizado com este login" só quando é isso mesmo).
 */

/** O `data.tipo` do push do chamado. O mesmo de `api/app/modules/notificacoes/expo.py`. */
export const TIPO_DO_CHAMADO = 'leitor-chamado';

/**
 * Dígito, letra, dígito — sem 0, 1, O nem I, que se confundem lidos de longe. O mesmo sorteio
 * do servidor: o sinal só escolhe entre os chamados abertos do login, e quem compara é gente.
 */
export const FORMATO_DO_SINAL = /^[2-9][A-HJ-NP-Z][2-9]$/;

/** O chamado vale 5 min no servidor; tocar depois disso numa notificação só abre o app. */
export const PRAZO_DA_RESPOSTA_MS = 5 * 60_000;

/** Folga para o relógio: a data da notificação vem do próprio aparelho, mas não custa nada. */
const FOLGA_DO_RELOGIO_MS = 60_000;

/** Fora da janela de registro: a volta ao app com mais tempo que isso registra de novo. */
export const UMA_HORA_MS = 60 * 60_000;

export function sinalValido(sinal: unknown): sinal is string {
  return typeof sinal === 'string' && FORMATO_DO_SINAL.test(sinal);
}

/**
 * A notificação é um chamado do leitor? Só com o tipo certo E um sinal no formato: o toque
 * liga o leitor, e nada que venha de fora com outra forma pode ganhar esse poder.
 */
export function ehChamadoDoLeitor(dados: unknown): dados is { tipo: typeof TIPO_DO_CHAMADO; sinal: string } {
  if (!dados || typeof dados !== 'object') return false;
  const { tipo, sinal } = dados as { tipo?: unknown; sinal?: unknown };
  return tipo === TIPO_DO_CHAMADO && sinalValido(sinal);
}

/**
 * O instante da notificação em ms. O iOS manda `date` em SEGUNDOS e o Android em ms; um número
 * abaixo de 1e11 só pode ser segundos (1e11 ms é 1973, 1e11 s é o ano 5138).
 */
export function instanteDaNotificacao(date: number): number {
  if (!Number.isFinite(date) || date <= 0) return Number.NaN;
  return date < 1e11 ? date * 1000 : date;
}

/** Dá para atender pelo toque? Só dentro dos 5 min do chamado; velha, o toque só abre o app. */
export function respostaAindaVale(instanteMs: number, agoraMs: number): boolean {
  if (!Number.isFinite(instanteMs) || !Number.isFinite(agoraMs)) return false;
  const idade = agoraMs - instanteMs;
  return idade <= PRAZO_DA_RESPOSTA_MS && idade >= -FOLGA_DO_RELOGIO_MS;
}

export interface Comportamento {
  shouldShowBanner: boolean;
  shouldShowList: boolean;
  shouldPlaySound: boolean;
  shouldSetBadge: boolean;
}

/**
 * O que o sistema faz com a notificação que chega com o app NA FRENTE. O chamado não aparece
 * como banner: quem mostra é a faixa do app, que tem o botão de atender — banner e faixa
 * juntos seriam o mesmo recado duas vezes. O resto (não há outro tipo hoje) aparece como
 * apareceria com o app fechado, sem som nem selo.
 */
export function comportamentoNoPrimeiroPlano(dados: unknown): Comportamento {
  if (ehChamadoDoLeitor(dados)) {
    return { shouldShowBanner: false, shouldShowList: false, shouldPlaySound: false, shouldSetBadge: false };
  }
  return { shouldShowBanner: true, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false };
}

/**
 * O servidor manda push? Só com `true` de verdade: servidor antigo não manda o campo, e na
 * dúvida o app não pede permissão para algo que não vai chegar.
 */
export function pushDoServidor(configuracao: { notificacoes_push?: unknown } | null | undefined): boolean {
  return configuracao?.notificacoes_push === true;
}

interface Aparelho {
  /** `Platform.OS`: 'ios', 'android' ou 'web'. */
  plataforma: string;
  /** No Expo Go o push deste app não existe (o token seria o do Expo Go). */
  expoGo: boolean;
  pushNoServidor: boolean;
}

/**
 * Este aparelho, neste servidor, pode receber o push? Decidido ANTES de tocar no módulo de
 * notificações: sem isto, nada de permissão nem de token. Android fica de fora nesta versão
 * (sem FCM): o chamado chega a ele com o app aberto.
 */
export function podeReceberPush({ plataforma, expoGo, pushNoServidor }: Aparelho): boolean {
  return plataforma === 'ios' && !expoGo && pushNoServidor;
}

/** A permissão de notificação do sistema, reduzida ao que importa aqui. */
export type Permissao = 'liberada' | 'negada' | 'indefinida';

/**
 * `granted` só vem com a permissão dada; `denied` é a recusa. O resto — nunca perguntada, e a
 * provisória do iOS — é "indefinida": o toque em "Abrir o leitor" ainda pergunta.
 */
export function lerPermissao(lida: { granted?: unknown; status?: unknown } | null | undefined): Permissao {
  if (lida?.granted === true) return 'liberada';
  if (lida?.status === 'denied') return 'negada';
  return 'indefinida';
}

/**
 * - `nao-registra`: o export web (não é o app de ninguém, e o chamado não teria quem atender);
 * - `sem-token`: o app está lá, o push não (`token: null` apaga o que o servidor tiver);
 * - `com-token`: iOS com a permissão dada e o servidor com push.
 */
export type ComoRegistrar = 'nao-registra' | 'sem-token' | 'com-token';

export function comoRegistrar({ permissao, ...aparelho }: Aparelho & { permissao: Permissao | null }): ComoRegistrar {
  if (aparelho.plataforma !== 'ios' && aparelho.plataforma !== 'android') return 'nao-registra';
  if (!podeReceberPush(aparelho)) return 'sem-token';
  return permissao === 'liberada' ? 'com-token' : 'sem-token';
}

/**
 * A linha das notificações na tela do leitor (Mais → Leitor do computador).
 * - `lendo`: ainda sem saber (a configuração ou a permissão não chegou) — nada na tela;
 * - `servidor-sem-push`: o servidor da loja não manda push — o chamado vem com o app aberto;
 * - `sem-suporte`: Android, Expo Go, web — idem, por causa do aparelho;
 * - `pedir`: o sistema já perguntou na abertura da tela; se a pessoa só fechou o alerta, a
 *   linha some até a próxima vez (sem tela do app com "Permitir": 5.1.1);
 * - `liberada` e `abrir-ajustes` (recusada: só os Ajustes do aparelho ligam de novo).
 */
export type SituacaoNaTela = 'lendo' | 'servidor-sem-push' | 'sem-suporte' | 'pedir' | 'liberada' | 'abrir-ajustes';

export function situacaoNaTela({
  pushNoServidor,
  permissao,
  ...aparelho
}: Omit<Aparelho, 'pushNoServidor'> & { pushNoServidor: boolean | null; permissao: Permissao | null }): SituacaoNaTela {
  if (pushNoServidor === null) return 'lendo';
  if (!pushNoServidor) return 'servidor-sem-push';
  if (!podeReceberPush({ ...aparelho, pushNoServidor })) return 'sem-suporte';
  if (permissao === null) return 'lendo';
  if (permissao === 'liberada') return 'liberada';
  return permissao === 'negada' ? 'abrir-ajustes' : 'pedir';
}

/** O texto da linha (e o botão, quando há o que fazer). `null`: nada a mostrar. */
export function avisoDasNotificacoes(situacao: SituacaoNaTela): { texto: string; botao: string | null } | null {
  switch (situacao) {
    case 'liberada':
      return { texto: 'O computador chama este celular mesmo com o app fechado.', botao: null };
    case 'abrir-ajustes':
      return {
        texto: 'Notificações desligadas: o chamado do computador só aparece com o app aberto.',
        botao: 'Abrir Ajustes',
      };
    case 'sem-suporte':
      return { texto: 'Neste aparelho o chamado só aparece com o app aberto.', botao: null };
    case 'servidor-sem-push':
      return { texto: 'O chamado do computador aparece aqui com o app aberto.', botao: null };
    default:
      return null;
  }
}

/** O teto do servidor para o token (a coluna); o da Expo tem uns 40 caracteres. */
export const MAX_TOKEN = 200;
const PREFIXOS_DO_TOKEN = ['ExponentPushToken[', 'ExpoPushToken['] as const;
/** Espaço ou caractere de controle (C0, DEL e C1): nunca num token de verdade. */
const ESPACO_OU_CONTROLE = /[\s\u0000-\u001F\u007F-\u009F]/u;

/**
 * O token aparado, ou `null` se o servidor o recusaria (espelho de `validar_token` em
 * `api/app/modules/notificacoes/schemas.py`, que espelha o `isExpoPushToken` da Expo). Token
 * que não passa não vai: o registro sai sem o campo, e o servidor fica com o que já tinha.
 * O tamanho conta caracteres, como o `len` do Python — não unidades de UTF-16.
 */
export function tokenValido(texto: unknown): string | null {
  if (typeof texto !== 'string') return null;
  const token = texto.trim();
  const tamanho = [...token].length;
  if (tamanho < 1 || tamanho > MAX_TOKEN) return null;
  if (!PREFIXOS_DO_TOKEN.some((p) => token.startsWith(p)) || !token.endsWith(']')) return null;
  if (ESPACO_OU_CONTROLE.test(token)) return null;
  return token;
}

/**
 * O sistema entregou um token do APARELHO (o evento `addPushTokenListener`): registrar de
 * novo? Só quando ele mudou e nenhum registro está no ar. O próprio registro pede o token ao
 * sistema — e o iOS responde com este MESMO evento, toda vez (`didRegister`, conferido no
 * pacote 0.32): sem a guarda, cada registro dispararia outro, num laço de PUTs.
 * `valor` é o que guardar como "o último visto".
 */
export function trocaDoTokenDoAparelho({
  anterior,
  recebido,
  registrando,
}: {
  anterior: string | null;
  recebido: unknown;
  registrando: boolean;
}): { valor: string; registrar: boolean } {
  const valor = typeof recebido === 'string' ? recebido : JSON.stringify(recebido ?? null);
  return { valor, registrar: valor !== anterior && !registrando };
}

/** O que o app lembra do último registro (só na memória: o token não é guardado em lugar nenhum). */
export interface UltimoRegistro {
  base: string;
  push: boolean;
  permissao: Permissao | null;
  hora: number;
}

/**
 * Na volta do app ao ativo, registra de novo? Sim quando nunca registrou nesta sessão (ou o
 * último falhou), quando o servidor ou o modo do push mudou, quando a permissão mudou (a
 * pessoa foi aos Ajustes) e depois de 1 h — é o que faz o servidor recuperar o aparelho depois
 * de um backup restaurado ou da faxina. Não a cada "conectado" do tempo real: na Vercel o
 * socket cai a cada `maxDuration`, e cada religação viraria um PUT.
 * `push` e `permissao` `null`: não se sabe agora — não é motivo, sozinho, para registrar.
 */
export function precisaRegistrarDeNovo({
  ultimo,
  agora,
  base,
  push,
  permissao,
}: {
  ultimo: UltimoRegistro | null;
  agora: number;
  base: string;
  push: boolean | null;
  permissao: Permissao | null;
}): boolean {
  if (!ultimo) return true;
  if (ultimo.base !== base) return true;
  if (agora - ultimo.hora > UMA_HORA_MS) return true;
  if (push !== null && push !== ultimo.push) return true;
  return permissao !== null && permissao !== ultimo.permissao;
}
