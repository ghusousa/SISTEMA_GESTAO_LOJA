/**
 * Notificações do chamado do leitor (ADR-47) — a parte que fala com o sistema e com a API. As
 * regras (quando pedir, o que mandar, o que a tela diz) moram em `lib/notificacoes.ts`, com
 * teste; aqui só se liga uma coisa à outra.
 *
 * Três trabalhos:
 * 1. REGISTRAR esta instalação para o login (`PUT /notificacoes/aparelho`) a cada sessão. Com
 *    token só se o servidor manda push (`GET /configuracao` → `notificacoes_push`, que nasce
 *    desligado) e o iPhone deixou; sem isso, registra do mesmo jeito, sem token — e nem chega
 *    a perguntar ao sistema pela permissão ou pelo token da Expo.
 * 2. PEDIR a permissão: só no toque em "Abrir o leitor" e na abertura da tela do leitor (sem
 *    câmera montada), só no iPhone, só com o servidor mandando push e só se nunca decidida.
 *    Nunca na abertura do app. É o alerta do sistema, direto, sem tela do app antes (5.1.1).
 * 3. ESQUECER na saída (`DELETE` sem sessão), com uma limpeza pendente se faltar rede.
 *
 * O token da Expo é credencial ao portador: nunca vai para log, e só fica na memória o que
 * basta para saber se ele mudou. Nenhum erro daqui sobe: o chamado continua chegando pela
 * faixa, com o app aberto, haja o que houver com o push.
 */

import axios from 'axios';
import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

import { baseAtual } from '@/api/client';
import { notificacoes, sistema } from '@/api/endpoints';
import { lerRefreshToken } from '@/api/sessao';
import type { ConfiguracaoPublica } from '@/api/tipos';
import { idDaInstalacao } from '@/lib/instalacao';
import {
  comoRegistrar,
  comportamentoNoPrimeiroPlano,
  ehChamadoDoLeitor,
  lerPermissao,
  lerPushDoServidor,
  podeReceberPush,
  precisaRegistrarDeNovo,
  pushDoServidor,
  situacaoNaTela,
  tokenValido,
  trocaDoTokenDoAparelho,
  type Permissao,
  type PushDoServidor,
  type SituacaoNaTela,
  type UltimoRegistro,
} from '@/lib/notificacoes';
import { ehExpoGo, modulo, type ModuloDeNotificacoes } from '@/lib/notificacoesNativas';
import { chaves, queryClient } from '@/lib/queryClient';

/** Teto para conseguir o token: o pedido sai do aparelho para a Apple e para a Expo. */
const TETO_DO_TOKEN_MS = 10_000;
/** O mesmo frescor do `useLoja`: o modo do push não muda de minuto em minuto. */
const FRESCOR_DA_CONFIGURACAO_MS = 10 * 60_000;
/** A limpeza que não saiu por falta de rede: `{base, instalacao}`, só a do último servidor. */
const CHAVE_DA_LIMPEZA = 'limpeza-de-notificacao';
/** O mínimo que o DELETE da saída tem para responder, mesmo depois de esperar um registro. */
const MINIMO_DO_ESQUECIMENTO_MS = 1000;
/** Alerta e som; sem selo no ícone: o chamado vale 5 min, um número parado ali mentiria. */
const OPCOES_DO_PEDIDO = { ios: { allowAlert: true, allowSound: true, allowBadge: false } };

function aparelho() {
  return { plataforma: Platform.OS, expoGo: ehExpoGo() };
}

function comTeto<T>(promessa: Promise<T>, ms: number): Promise<T> {
  let relogio: ReturnType<typeof setTimeout> | undefined;
  const teto = new Promise<never>((_, rejeitar) => {
    relogio = setTimeout(() => rejeitar(new Error('tempo esgotado')), ms);
  });
  return Promise.race([promessa, teto]).finally(() => clearTimeout(relogio));
}

const esperar = (ms: number) => new Promise<void>((resolver) => setTimeout(resolver, ms));

/** O servidor respondeu (qualquer status)? Sem resposta é rede, tempo esgotado ou servidor fora. */
function respondeu(erro: unknown): boolean {
  return axios.isAxiosError(erro) && !!erro.response;
}

// ------------------------------------------------------------------ o servidor manda push?

/** `null`: não deu para saber agora (sem rede, servidor fora do ar). */
async function modoNoServidor(): Promise<PushDoServidor | null> {
  try {
    const configuracao = await queryClient.fetchQuery({
      queryKey: chaves.configuracao,
      queryFn: sistema.configuracao,
      staleTime: FRESCOR_DA_CONFIGURACAO_MS,
      retry: false,
    });
    return lerPushDoServidor(configuracao);
  } catch {
    return null;
  }
}

async function pushNoServidor(): Promise<boolean | null> {
  const modo = await modoNoServidor();
  return modo === null ? null : modo === 'ligado';
}

/**
 * O mesmo, sem ir à rede quando o app já tem a configuração (a faixa e as telas a mantêm, e o
 * tempo real a refaz a cada volta ao app): o toque em "Abrir o leitor" não pode ficar esperando.
 */
async function modoPeloCache(): Promise<PushDoServidor | null> {
  const emCache = queryClient.getQueryData<ConfiguracaoPublica>(chaves.configuracao);
  return emCache ? lerPushDoServidor(emCache) : modoNoServidor();
}

async function pushPeloCache(): Promise<boolean | null> {
  const modo = await modoPeloCache();
  return modo === null ? null : modo === 'ligado';
}

// ------------------------------------------------------------------ registro

/** O último registro que deu certo nesta sessão (só na memória, sem o token). */
let ultimo: UltimoRegistro | null = null;
let emAndamento: Promise<void> | null = null;
let deNovo = false;
/** Sobe a cada esquecimento: o registro que começou antes da saída não grava depois dela. */
let rodada = 0;
/**
 * O esquecimento (ou a limpeza pendente) que ainda está no ar. O registro de um login novo
 * espera por ele: um DELETE que chegasse ao servidor DEPOIS do PUT apagaria o registro novo
 * (a sessão que caiu esquece sem esperar, e a pessoa pode entrar de novo em seguida).
 */
let esquecendo: Promise<void> | null = null;
let limpando: Promise<void> | null = null;
/** O último token do APARELHO (o da Apple) que o sistema entregou — só para ver se mudou. */
let tokenDoAparelho: string | null = null;

async function permissaoDoSistema(N: ModuloDeNotificacoes): Promise<Permissao | null> {
  try {
    return lerPermissao(await N.getPermissionsAsync());
  } catch {
    return null;
  }
}

/** O token da Expo, ou `undefined` (não deu agora: o registro sai SEM o campo). */
async function tokenDaExpo(N: ModuloDeNotificacoes): Promise<string | undefined> {
  try {
    const projectId = Constants.expoConfig?.extra?.eas?.projectId as string | undefined;
    const resposta = await comTeto(N.getExpoPushTokenAsync(projectId ? { projectId } : undefined), TETO_DO_TOKEN_MS);
    return tokenValido(resposta.data) ?? undefined;
  } catch {
    return undefined;
  }
}

async function registrarUmaVez(): Promise<void> {
  const minha = rodada;
  try {
    // Sem sessão não há para quem registrar — e o 401 faria o interceptor "encerrar" uma
    // sessão que nem existe.
    if (!(await lerRefreshToken())) return;
    const push = await pushNoServidor();
    if (push === null) return; // sem servidor agora: a volta ao app tenta de novo
    const base = baseAtual();
    const instalacao = await idDaInstalacao();
    const daqui = { ...aparelho(), pushNoServidor: push };
    const N = modulo();
    // A API de permissão só é tocada quando o push pode existir aqui (o servidor manda e é iPhone).
    const permissao = N && podeReceberPush(daqui) ? await permissaoDoSistema(N) : null;
    const como = comoRegistrar({ ...daqui, permissao });
    if (como === 'nao-registra') return;
    // `null`: este aparelho não recebe push (o servidor apaga o que tinha). `undefined`: o
    // token não veio agora — o campo sai do corpo e o servidor fica com o que já tinha.
    const token = como === 'com-token' && N ? await tokenDaExpo(N) : null;
    // A sessão saiu no meio: vale o esquecimento (e ele pode estar esperando este registro).
    if (minha !== rodada) return;
    // O esquecimento de ANTES deste registro ainda no ar: o PUT vai depois do DELETE.
    await Promise.all([esquecendo, limpando]);
    if (minha !== rodada) return;
    await notificacoes.registrar({
      instalacao,
      plataforma: Platform.OS === 'ios' ? 'ios' : 'android',
      token,
    });
    if (minha === rodada) ultimo = { base, push, permissao, hora: Date.now() };
  } catch {
    // 404 (servidor de antes da ADR-47), rede, 5xx: em silêncio. A volta ao app tenta de novo.
  }
}

/**
 * Registra esta instalação para o login da sessão. O que chega com um registro no ar vira UMA
 * rodada a mais no fim: o motivo pode ser novo (a permissão acabou de mudar).
 */
export function registrarAparelho(): Promise<void> {
  if (Platform.OS === 'web') return Promise.resolve();
  if (emAndamento) {
    deNovo = true;
    return emAndamento;
  }
  emAndamento = (async () => {
    do {
      deNovo = false;
      await registrarUmaVez();
    } while (deNovo);
  })().finally(() => {
    emAndamento = null;
  });
  return emAndamento;
}

/** A sessão abriu (entrar, ou restaurar com sessão): a limpeza pendente ANTES do registro. */
export async function prepararNotificacoes(): Promise<void> {
  // Na ordem: a limpeza pendente pode ser desta mesma instalação neste mesmo servidor, e
  // chegando depois do registro apagaria o registro novo.
  await tentarLimpezaPendente();
  await registrarAparelho();
}

/** O app voltou ao ativo, com sessão: registra de novo só quando há motivo. */
export async function registrarNaVolta(): Promise<void> {
  if (Platform.OS === 'web' || emAndamento) return;
  try {
    const emCache = queryClient.getQueryData<ConfiguracaoPublica>(chaves.configuracao);
    const push = emCache ? pushDoServidor(emCache) : null;
    const N = modulo();
    const permissao =
      N && push !== null && podeReceberPush({ ...aparelho(), pushNoServidor: push }) ? await permissaoDoSistema(N) : null;
    if (precisaRegistrarDeNovo({ ultimo, agora: Date.now(), base: baseAtual(), push, permissao })) {
      await registrarAparelho();
    }
  } catch {
    // Fica para a próxima volta.
  }
}

/**
 * O sistema trocou o token do aparelho: registra de novo — mas não o eco do próprio registro
 * (`trocaDoTokenDoAparelho`, com teste).
 */
function aoTrocarOTokenDoAparelho(token: { data?: unknown }): void {
  const { valor, registrar } = trocaDoTokenDoAparelho({
    anterior: tokenDoAparelho,
    recebido: token.data,
    registrando: emAndamento !== null,
  });
  tokenDoAparelho = valor;
  if (registrar) void registrarAparelho();
}

// ------------------------------------------------------------------ permissão

let pedindo: Promise<Permissao | null> | null = null;

/**
 * O alerta do sistema, UM só mesmo com dois pedidos juntos: a tela do leitor que abre pelo
 * "Abrir o leitor" da faixa pergunta na abertura E antes do atender. Respondido, o registro
 * vai de novo (com o token, se a pessoa deixou).
 */
function pedirAoSistema(N: ModuloDeNotificacoes): Promise<Permissao | null> {
  pedindo ??= N.requestPermissionsAsync(OPCOES_DO_PEDIDO)
    .then(
      (lida) => lerPermissao(lida),
      () => null,
    )
    .finally(() => {
      pedindo = null;
      void registrarAparelho();
    });
  return pedindo;
}

/**
 * O "Abrir o leitor" (da faixa, já na tela do leitor, ou do cartão), ANTES do atender: o
 * alerta do sistema sai uma vez, e depois vem a câmera — um depois do outro, nunca
 * empilhados. Só no iPhone, só com o servidor mandando push, só com a permissão nunca
 * decidida. Nunca impede o atender.
 */
export async function pedirPermissaoNoToque(): Promise<void> {
  try {
    const N = modulo();
    if (!N) return;
    const push = await pushPeloCache();
    if (!push || !podeReceberPush({ ...aparelho(), pushNoServidor: push })) return;
    if ((await permissaoDoSistema(N)) !== 'indefinida') return;
    await pedirAoSistema(N);
  } catch {
    // O leitor liga com ou sem notificação.
  }
}

/**
 * A linha das notificações na tela do leitor. Com `pedir`, pergunta ao sistema antes (a tela
 * abriu sem leitor ligado e sem câmera) — só nas mesmas condições do toque.
 */
export async function situacaoNoLeitor({ pedir }: { pedir: boolean }): Promise<SituacaoNaTela> {
  try {
    // O modo inteiro: o servidor antigo (sem o campo) não ganha linha nenhuma na tela.
    const modo = await modoPeloCache();
    const push = modo === 'ligado';
    const N = modulo();
    if (modo === null || !N || !podeReceberPush({ ...aparelho(), pushNoServidor: push })) {
      return situacaoNaTela({ ...aparelho(), push: modo, permissao: null });
    }
    let permissao = await permissaoDoSistema(N);
    if (pedir && permissao === 'indefinida') permissao = (await pedirAoSistema(N)) ?? permissao;
    return situacaoNaTela({ ...aparelho(), push: modo, permissao });
  } catch {
    return 'lendo';
  }
}

// ------------------------------------------------------------------ na frente, e o toque

function refazerChamados(): void {
  // Sem cancelar a busca que já está no ar: o aviso do sistema e o do listener chegam juntos.
  void queryClient.invalidateQueries({ queryKey: chaves.chamadosDoLeitor }, { cancelRefetch: false });
}

/**
 * Uma vez, na raiz do app, e só onde o módulo nativo existe. Com o app NA FRENTE, o chamado
 * não vira banner (quem mostra é a faixa, que tem o botão) e a lista é refeita na hora.
 */
export function configurarNotificacoes(): () => void {
  const N = modulo();
  if (!N) return () => undefined;
  try {
    N.setNotificationHandler({
      handleNotification: async (notificacao) => {
        const dados = notificacao.request.content.data;
        if (ehChamadoDoLeitor(dados)) refazerChamados();
        return comportamentoNoPrimeiroPlano(dados);
      },
    });
    const recebida = N.addNotificationReceivedListener((notificacao) => {
      if (ehChamadoDoLeitor(notificacao.request.content.data)) refazerChamados();
    });
    const troca = N.addPushTokenListener(aoTrocarOTokenDoAparelho);
    return () => {
      recebida.remove();
      troca.remove();
      N.setNotificationHandler(null);
    };
  } catch {
    return () => undefined;
  }
}

/** Tira da central os avisos de chamado (atendido, ou a sessão saiu): tocar neles não liga nada. */
export async function tirarDaCentral(): Promise<void> {
  const N = modulo();
  if (!N) return;
  try {
    const apresentadas = await N.getPresentedNotificationsAsync();
    await Promise.all(
      apresentadas
        .filter((n) => ehChamadoDoLeitor(n.request.content.data))
        .map((n) => N.dismissNotificationAsync(n.request.identifier)),
    );
  } catch {
    // Ficam lá; o toque numa velha só abre o app (passou dos 5 min, ou o chamado acabou).
  }
}

// ------------------------------------------------------------------ esquecer

interface Limpeza {
  base: string;
  instalacao: string;
}

async function guardarLimpeza(limpeza: Limpeza): Promise<void> {
  try {
    await SecureStore.setItemAsync(CHAVE_DA_LIMPEZA, JSON.stringify(limpeza));
  } catch {
    // Sem cofre, sobra a faxina de 30 dias do servidor.
  }
}

async function lerLimpeza(): Promise<Limpeza | null> {
  try {
    const texto = await SecureStore.getItemAsync(CHAVE_DA_LIMPEZA);
    if (!texto) return null;
    const lida = JSON.parse(texto) as Partial<Limpeza> | null;
    return typeof lida?.base === 'string' && typeof lida.instalacao === 'string'
      ? { base: lida.base, instalacao: lida.instalacao }
      : null;
  } catch {
    return null;
  }
}

async function apagarLimpeza(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(CHAVE_DA_LIMPEZA);
  } catch {
    // Na próxima abertura tenta de novo: o DELETE repetido é inofensivo (204 sempre).
  }
}

/**
 * A sessão acabou neste aparelho: o servidor esquece esta instalação (`DELETE` sem sessão), e
 * o próximo login do aparelho não herda os chamados do anterior. Sem rede, fica UMA limpeza
 * pendente — a deste servidor — para a próxima abertura. Nunca falha nem demora mais que
 * `timeout` (fora a espera, limitada, de um registro que já estava no ar).
 */
export function esquecerAparelho({ timeout = 10_000 }: { timeout?: number } = {}): Promise<void> {
  if (Platform.OS === 'web') return Promise.resolve();
  rodada += 1;
  ultimo = null;
  // A rodada a mais que estava na fila era da sessão que acabou.
  deNovo = false;
  const fim = Date.now() + timeout;
  const base = baseAtual();
  const esta = (async () => {
    try {
      const instalacao = await idDaInstalacao();
      // Um registro que já estava no ar chega ANTES do esquecimento, não depois dele.
      const noAr = emAndamento;
      if (noAr) await Promise.race([noAr, esperar(Math.max(0, fim - Date.now()))]);
      try {
        await notificacoes.esquecer(base, instalacao, {
          timeout: Math.max(MINIMO_DO_ESQUECIMENTO_MS, fim - Date.now()),
        });
      } catch (erro) {
        if (!respondeu(erro)) await guardarLimpeza({ base, instalacao });
      }
    } catch {
      // Melhor esforço: o servidor esquece sozinho em 30 dias sem uso.
    }
  })().finally(() => {
    if (esquecendo === esta) esquecendo = null;
  });
  esquecendo = esta;
  return esta;
}

/**
 * A limpeza que ficou para trás (a saída foi sem rede), tentada a cada abertura do app — uma
 * por vez. Sai com qualquer resposta HTTP — até o 404 de um servidor de antes da ADR-47, que
 * nunca soube deste aparelho.
 */
export function tentarLimpezaPendente(): Promise<void> {
  if (Platform.OS === 'web') return Promise.resolve();
  limpando ??= (async () => {
    const pendente = await lerLimpeza();
    if (!pendente) return;
    try {
      await notificacoes.esquecer(pendente.base, pendente.instalacao, { timeout: 10_000 });
      await apagarLimpeza();
    } catch (erro) {
      if (respondeu(erro)) await apagarLimpeza();
    }
  })().finally(() => {
    limpando = null;
  });
  return limpando;
}
