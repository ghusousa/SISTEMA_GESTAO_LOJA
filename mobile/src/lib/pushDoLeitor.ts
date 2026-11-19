/**
 * Notificações do chamado do leitor (ADR-47) — a parte que fala com o sistema e com a API. As
 * regras (quando pedir, o que mandar, o que a tela diz) moram em `lib/notificacoes.ts`, e a
 * ordem do registro, do esquecimento e da limpeza pendente em `lib/registroDoAparelho.ts`, as
 * duas com teste; aqui só se liga uma coisa à outra.
 *
 * Três trabalhos:
 * 1. REGISTRAR esta instalação para o login (`PUT /notificacoes/aparelho`) a cada sessão. Com
 *    token só se o servidor manda push (`GET /configuracao` → `notificacoes_push`, que nasce
 *    desligado) e o iPhone deixou; sem isso, registra do mesmo jeito, sem token — e nem chega
 *    a perguntar ao sistema pela permissão ou pelo token da Expo. A configuração que chega com
 *    OUTRO modo do push (o dono religou, e o tempo real a refez) registra de novo na hora.
 * 2. PEDIR a permissão: só no toque em "Abrir o leitor" e na abertura da tela do leitor (sem
 *    câmera montada), só no iPhone, só com o servidor mandando push e só se nunca decidida.
 *    Nunca na abertura do app. É o alerta do sistema, direto, sem tela do app antes (5.1.1).
 * 3. ESQUECER na saída (`DELETE` sem sessão), com uma limpeza pendente se faltar rede.
 *
 * O token da Expo é credencial ao portador: nunca vai para log, e só fica na memória o que
 * basta para saber se ele mudou. Nenhum erro daqui sobe: o chamado continua chegando pela
 * faixa, com o app aberto, haja o que houver com o push.
 */

import { hashKey } from '@tanstack/react-query';
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
  comportamentoNoPrimeiroPlano,
  ehChamadoDoLeitor,
  lerPermissao,
  lerPushDoServidor,
  podeReceberPush,
  pushDoServidor,
  situacaoNaTela,
  tokenValido,
  type Permissao,
  type PushDoServidor,
  type SituacaoNaTela,
} from '@/lib/notificacoes';
import { ehExpoGo, modulo, type ModuloDeNotificacoes } from '@/lib/notificacoesNativas';
import { chaves, queryClient } from '@/lib/queryClient';
import { criarRegistroDoAparelho } from '@/lib/registroDoAparelho';

/** Teto para conseguir o token: o pedido sai do aparelho para a Apple e para a Expo. */
const TETO_DO_TOKEN_MS = 10_000;
/** O mesmo frescor do `useLoja`: o modo do push não muda de minuto em minuto. */
const FRESCOR_DA_CONFIGURACAO_MS = 10 * 60_000;
/** A limpeza que não saiu por falta de rede: `{base, instalacao, em}`, só a do último servidor. */
const CHAVE_DA_LIMPEZA = 'limpeza-de-notificacao';
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

/**
 * O mesmo, sem ir à rede quando o app já tem a configuração (a faixa e as telas a mantêm, e o
 * tempo real a refaz a cada volta ao app): o toque em "Abrir o leitor" não pode ficar esperando.
 */
async function modoPeloCache(): Promise<PushDoServidor | null> {
  const emCache = queryClient.getQueryData<ConfiguracaoPublica>(chaves.configuracao);
  return emCache ? lerPushDoServidor(emCache) : modoNoServidor();
}

// ------------------------------------------------------------------ o sistema

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

// ------------------------------------------------------------------ registro e esquecimento

const registro = criarRegistroDoAparelho({
  plataforma: Platform.OS,
  expoGo: ehExpoGo(),
  temSessao: async () => !!(await lerRefreshToken()),
  pushNoServidor: async () => {
    const modo = await modoNoServidor();
    return modo === null ? null : modo === 'ligado';
  },
  pushEmCache: () => {
    const emCache = queryClient.getQueryData<ConfiguracaoPublica>(chaves.configuracao);
    return emCache ? pushDoServidor(emCache) : null;
  },
  base: baseAtual,
  instalacao: idDaInstalacao,
  permissao: async () => {
    const N = modulo();
    return N ? permissaoDoSistema(N) : null;
  },
  token: async () => {
    const N = modulo();
    return N ? tokenDaExpo(N) : undefined;
  },
  registrar: (corpo) => notificacoes.registrar(corpo),
  esquecer: (base, instalacao, opcoes) => notificacoes.esquecer(base, instalacao, opcoes),
  respondeu: (erro) => axios.isAxiosError(erro) && !!erro.response,
  cofre: {
    ler: () => SecureStore.getItemAsync(CHAVE_DA_LIMPEZA),
    gravar: (texto) => SecureStore.setItemAsync(CHAVE_DA_LIMPEZA, texto),
    apagar: () => SecureStore.deleteItemAsync(CHAVE_DA_LIMPEZA),
  },
  agora: () => Date.now(),
  esperar: (ms) => new Promise<void>((resolver) => setTimeout(resolver, ms)),
});

/**
 * Registra esta instalação para o login da sessão. O que chega com um registro no ar vira UMA
 * rodada a mais no fim: o motivo pode ser novo (a permissão acabou de mudar).
 */
export function registrarAparelho(): Promise<void> {
  return registro.registrar();
}

/** A sessão abriu (entrar, ou restaurar com sessão): a limpeza pendente do mesmo servidor ANTES do registro. */
export function prepararNotificacoes(): Promise<void> {
  return registro.preparar();
}

/** O app voltou ao ativo, com sessão: registra de novo só quando há motivo. */
export function registrarNaVolta(): Promise<void> {
  return registro.naVolta();
}

/**
 * A sessão acabou neste aparelho: o servidor esquece esta instalação (`DELETE` sem sessão), e
 * o próximo login do aparelho não herda os chamados do anterior. Sem rede, fica UMA limpeza
 * pendente — a deste servidor — para a próxima abertura. Nunca falha nem demora mais que
 * `timeout` (fora a espera, limitada, de um registro que já estava no ar).
 */
export function esquecerAparelho(opcoes: { timeout?: number } = {}): Promise<void> {
  return registro.esquecer(opcoes);
}

/**
 * A limpeza que ficou para trás (a saída foi sem rede), tentada a cada abertura do app. A do
 * servidor de agora segura o registro; a de outro servidor corre ao lado; passados 30 dias, sai.
 */
export function tentarLimpezaPendente(): Promise<void> {
  return registro.tentarLimpezaPendente();
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
 * decidida. Já decidida, confere o registro: o servidor que religou o push, com o iPhone já
 * liberado, recebe o token aqui, sem esperar o app ir ao fundo. Nunca impede o atender.
 */
export async function pedirPermissaoNoToque(): Promise<void> {
  try {
    const N = modulo();
    if (!N) return;
    const modo = await modoPeloCache();
    if (modo === null) return;
    const push = modo === 'ligado';
    if (!podeReceberPush({ ...aparelho(), pushNoServidor: push })) {
      registro.conferir({ push, permissao: null });
      return;
    }
    const permissao = await permissaoDoSistema(N);
    if (permissao === 'indefinida') await pedirAoSistema(N);
    else registro.conferir({ push, permissao });
  } catch {
    // O leitor liga com ou sem notificação.
  }
}

/**
 * A linha das notificações na tela do leitor. Com `pedir`, pergunta ao sistema antes (a tela
 * abriu sem leitor ligado e sem câmera) — só nas mesmas condições do toque. Sem perguntar,
 * confere o registro como o toque.
 */
export async function situacaoNoLeitor({ pedir }: { pedir: boolean }): Promise<SituacaoNaTela> {
  try {
    const modo = await modoPeloCache();
    const push = modo === 'ligado';
    const N = modulo();
    if (modo === null || !N || !podeReceberPush({ ...aparelho(), pushNoServidor: push })) {
      if (modo !== null) registro.conferir({ push, permissao: null });
      return situacaoNaTela({ ...aparelho(), push: modo, permissao: null });
    }
    let permissao = await permissaoDoSistema(N);
    if (pedir && permissao === 'indefinida') permissao = (await pedirAoSistema(N)) ?? permissao;
    else registro.conferir({ push, permissao });
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

const HASH_DA_CONFIGURACAO = hashKey(chaves.configuracao);

/**
 * Cada configuração que chega ao cache (o "conectado" do tempo real a refaz, a volta ao app
 * também) passa pelo registro: com OUTRO modo do push, registra de novo na hora.
 */
function vigiarAConfiguracao(): () => void {
  return queryClient.getQueryCache().subscribe((evento) => {
    if (evento.type !== 'updated' || evento.action.type !== 'success') return;
    if (evento.query.queryHash !== HASH_DA_CONFIGURACAO) return;
    registro.aoMudarAConfiguracao(pushDoServidor(evento.query.state.data as ConfiguracaoPublica | undefined));
  });
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
    const troca = N.addPushTokenListener((token) => registro.aoTrocarOToken(token.data));
    const pararDeVigiar = vigiarAConfiguracao();
    return () => {
      recebida.remove();
      troca.remove();
      pararDeVigiar();
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
