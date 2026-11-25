/**
 * Celular como leitor do computador (ADR-43): o pareamento ligado e a fila de bipes.
 *
 * Rascunho de sessão, como o carrinho: vive só na memória do aparelho, sem persistir.
 * Quem manda no pareamento é o servidor — ele o encerra pelo computador, pelo aceite de
 * outro código neste celular (TROCOU) ou pelas 12 h. O logout desliga e limpa
 * (`authStore`), senão o próximo usuário biparia para o computador do anterior.
 *
 * Como os bipes saem (um por vez, em ordem, reenvio com o mesmo `client_uuid`, prazo de
 * dois minutos) mora em `lib/filaDoLeitor.ts`, com teste; aqui só se liga a fila à API.
 *
 * O chamado do computador (ADR-47) também passa por aqui: os chamados que a pessoa dispensou
 * na faixa, e o "sim" a um chamado (o toque na notificação, ou o "Abrir o leitor" da faixa)
 * que fica para a tela do leitor atender.
 */

import axios from 'axios';
import { create } from 'zustand';

import { leitor } from '@/api/endpoints';
import type { ErroApi, Pareamento, StatusPareamento } from '@/api/tipos';
import {
  criarFila,
  dormirDeVerdade,
  estadoDeQuemNaoSaiu,
  type BipeDaFila,
  type Falha,
} from '@/lib/filaDoLeitor';
import { idDaInstalacao } from '@/lib/instalacao';
import { avisoDoFim } from '@/lib/leitorRemoto';
import { gerarUuid } from '@/lib/uuid';

export type { BipeDaFila, EstadoDoBipe } from '@/lib/filaDoLeitor';

/** Quantos bipes já resolvidos ficam para a lista da tela. Os pendentes ficam todos. */
export const HISTORICO_DE_BIPES = 10;

/** A fila cheia no servidor (409 `LEITOR_FILA_CHEIA`), se a resposta não trouxer a frase. */
const FILA_CHEIA =
  'O computador não está recebendo as leituras. Confira se a tela dele está aberta.';

/**
 * Quanto tempo o pedido do toque espera a tela do leitor: abrir o app a frio e restaurar a
 * sessão leva segundos, não minutos — pedido mais velho que isto é de outra situação.
 */
const VALIDADE_DO_PEDIDO_MS = 60_000;

interface OpcoesDesligar {
  /** Curto no logout: sair do app não espera servidor que não responde. */
  timeout?: number;
}

export interface PedidoDeAtendimento {
  sinal: string;
  /** O chamado, quando quem pediu já o conhece (a faixa); sem ele, a tela procura pelo sinal. */
  id?: number;
  /** Perguntar antes a permissão de notificação (o toque em "Abrir o leitor" da faixa). */
  pedirPermissao: boolean;
  em: number;
}

interface LeitorState {
  pareamento: Pareamento | null;
  /**
   * Em ordem de leitura (o mais novo no fim). Quando o leitor para sem a pessoa pedir, os
   * que não saíram ficam aqui (com o `aviso`) até ela dispensar: a tela mostra quais refazer.
   */
  bipes: BipeDaFila[];
  /** Por que o leitor parou sem a pessoa pedir; a tela mostra e a pessoa dispensa. */
  aviso: string | null;
  /** Com o leitor ligado: algo a saber sem parar de bipar (a fila cheia no servidor). */
  alerta: string | null;
  /**
   * Sobe a cada logout (`limpar`). O aceite que responde depois de a sessão sair não liga
   * leitor nenhum: compare com o valor de quando o pedido saiu.
   */
  sessao: number;
  /**
   * Chamados do computador (ADR-47) que a pessoa dispensou na faixa (✕). Só na memória: um
   * chamado novo aparece de novo, e o logout esquece.
   */
  chamadosDispensados: number[];
  /**
   * Um "sim" a um chamado, para a tela do leitor atender: o toque numa notificação (só o sinal,
   * que a tela procura entre os chamados abertos) ou o "Abrir o leitor" da faixa (com o id, e
   * pedindo antes a permissão de notificação — lá, numa tela sem câmera). Vale
   * `VALIDADE_DO_PEDIDO_MS`.
   */
  pedido: PedidoDeAtendimento | null;
  /**
   * O servidor não tem a rota dos chamados (de antes da ADR-47, 404 sem `code`): ninguém
   * pergunta de novo até a próxima sessão.
   */
  servidorSemChamados: boolean;

  /**
   * O aceite deu certo: daqui em diante as leituras vão para este computador. Com `sessao`
   * (a de quando o aceite saiu), não liga se a sessão saiu no meio.
   */
  ligar: (pareamento: Pareamento, sessao?: number) => void;
  /** Resposta da consulta periódica. Fora de ATIVO, o leitor para. */
  atualizar: (pareamento: Pareamento) => void;
  /** O servidor disse que acabou (404, `LEITOR_DESLIGADO`). */
  encerrar: (aviso: string) => void;
  /** Uma leitura da câmera: entra na fila e sai assim que der. */
  ler: (codigo: string) => void;
  /** "Desligar" na tela, ou o logout. `false` se o servidor não ficou sabendo. */
  desligar: (opcoes?: OpcoesDesligar) => Promise<boolean>;
  /** Dispensa o aviso — e a lista do que não saiu, que vinha com ele. */
  esquecerAviso: () => void;
  /** Esquece tudo sem falar com o servidor (sessão perdida). */
  limpar: () => void;
  /** ✕ na faixa: esconde estes chamados (os que estavam nela). */
  dispensarChamados: (ids: number[]) => void;
  /** O "sim" ao chamado deste sinal: a tela do leitor atende. */
  pedirAtendimento: (sinal: string, extra?: { id?: number; pedirPermissao?: boolean }) => void;
  /** A tela do leitor pega o pedido (uma vez só); vencido, `null`. */
  consumirPedido: () => Omit<PedidoDeAtendimento, 'em'> | null;
  marcarServidorSemChamados: () => void;
  /** O servidor ganhou o chamado (a configuração mostrou): a lista volta a ser consultada. */
  desmarcarServidorSemChamados: () => void;
}

const estadoInicial = () => ({
  pareamento: null as Pareamento | null,
  bipes: [] as BipeDaFila[],
  aviso: null as string | null,
  alerta: null as string | null,
});

/** Mantém todo pendente e só os `HISTORICO_DE_BIPES` mais novos entre os resolvidos. */
function podar(bipes: BipeDaFila[]): BipeDaFila[] {
  const corte = bipes.length - HISTORICO_DE_BIPES;
  return bipes.filter((b, i) => b.estado === 'enviando' || i >= corte);
}

/**
 * O que sobrou na fila não sai mais: fica na lista como "não enviado" (ou "sem confirmação").
 * Sem podar: a tela de ligar mostra TODOS os que não saíram — é a lista do que bipar de novo.
 */
function pendentesNaoEnviados(bipes: BipeDaFila[]): BipeDaFila[] {
  return bipes.map((b) => (b.estado === 'enviando' ? { ...b, estado: estadoDeQuemNaoSaiu(b) } : b));
}

function lerFalha(erro: unknown): Falha {
  if (!axios.isAxiosError<ErroApi>(erro)) return {};
  const corpo = erro.response?.data;
  const status = corpo?.detail?.status;
  return {
    status: erro.response?.status,
    codigo: corpo?.code ?? null,
    statusDoLeitor: typeof status === 'string' ? status : null,
    mensagem: corpo?.message ?? null,
  };
}

/**
 * O 409 do bipe só diz o status; o MOTIVO de um ENCERRADO (o computador desligou? este login
 * ligou outro leitor?) vem da consulta. Troca o aviso se ele ainda for o deste fim.
 */
function explicarFim(pareamentoId: number, avisoDoMomento: string): void {
  const { sessao } = useLeitorStore.getState();
  leitor
    .consultar(pareamentoId)
    .then((p) => {
      const agora = useLeitorStore.getState();
      if (agora.sessao !== sessao || agora.pareamento || agora.aviso !== avisoDoMomento) return;
      useLeitorStore.setState({ aviso: avisoDoFim(p) });
    })
    .catch(() => {
      // Sem rede, fica o aviso genérico: o leitor parou do mesmo jeito.
    });
}

const fila = criarFila({
  estado: () => {
    const { pareamento, bipes } = useLeitorStore.getState();
    return { pareamentoId: pareamento?.id ?? null, bipes };
  },
  marcar: (uuid, mudanca) =>
    useLeitorStore.setState((e) => ({
      bipes: podar(e.bipes.map((b) => (b.uuid === uuid ? { ...b, ...mudanca } : b))),
    })),
  // A instalação (ADR-47): o servidor recusa o bipe de outro aparelho do mesmo login.
  enviar: async (bipe, pareamentoId) =>
    leitor.enviarBipe({
      client_uuid: bipe.uuid,
      pareamento_id: pareamentoId,
      codigo: bipe.codigo,
      instalacao: await idDaInstalacao(),
    }),
  lerFalha,
  aoDesligar: (statusDoLeitor) => {
    const id = useLeitorStore.getState().pareamento?.id;
    const aviso = avisoDoFim(statusDoLeitor ? { status: statusDoLeitor as StatusPareamento } : null);
    useLeitorStore.getState().encerrar(aviso);
    if (id != null && statusDoLeitor === 'ENCERRADO') explicarFim(id, aviso);
  },
  aoTentar: (falha) => {
    if (!falha) {
      if (useLeitorStore.getState().alerta) useLeitorStore.setState({ alerta: null });
    } else if (falha.codigo === 'LEITOR_FILA_CHEIA') {
      useLeitorStore.setState({ alerta: falha.mensagem || FILA_CHEIA });
    }
  },
  agora: () => Date.now(),
  dormir: dormirDeVerdade,
});

export const useLeitorStore = create<LeitorState>((set, get) => ({
  ...estadoInicial(),
  sessao: 0,
  chamadosDispensados: [],
  pedido: null,
  servidorSemChamados: false,

  ligar(pareamento, sessao) {
    // O aceite que voltou depois do logout: o celular não liga para o computador de ninguém.
    if (sessao !== undefined && sessao !== get().sessao) return;
    const anterior = get().pareamento;
    // A resposta repetida do mesmo leitor (o reenvio do atender): é o mesmo, a fila segue.
    if (anterior && anterior.id === pareamento.id && pareamento.status === 'ATIVO') {
      set({ pareamento });
      return;
    }
    fila.interromper();
    if (pareamento.status !== 'ATIVO') {
      set({ ...estadoInicial(), aviso: avisoDoFim(pareamento) });
      return;
    }
    // Trocar de computador com o leitor ligado (ADR-47): o que ainda não tinha saído do
    // anterior fica na lista como "não enviado". Não pode seguir na fila — ela manda com o
    // pareamento ATUAL, e as peças bipadas para um computador cairiam no outro.
    const bipes = anterior ? pendentesNaoEnviados(get().bipes) : [];
    set({ pareamento, bipes, aviso: null, alerta: null });
  },

  atualizar(pareamento) {
    // Resposta atrasada de um pareamento que já foi trocado não mexe no atual.
    if (get().pareamento?.id !== pareamento.id) return;
    if (pareamento.status === 'ATIVO') {
      set({ pareamento });
      return;
    }
    get().encerrar(avisoDoFim(pareamento));
  },

  encerrar(aviso) {
    fila.interromper();
    set((e) => ({
      pareamento: null,
      bipes: pendentesNaoEnviados(e.bipes),
      aviso,
      alerta: null,
    }));
  },

  ler(codigo) {
    if (!get().pareamento) return;
    const bipe: BipeDaFila = {
      uuid: gerarUuid(),
      codigo,
      lidoEm: Date.now(),
      estado: 'enviando',
      tentativas: 0,
    };
    set((e) => ({ bipes: podar([...e.bipes, bipe]) }));
    // Fila parada esperando a rede: quem está bipando quer ver sair, tenta já.
    fila.acordar();
    void fila.esvaziar();
  },

  async desligar(opcoes = {}) {
    const pareamento = get().pareamento;
    fila.interromper();
    set({ ...estadoInicial() });
    if (!pareamento) return true;
    try {
      // `ponta`: com o mesmo login nas duas pontas, o diário diz que foi o CELULAR que desligou.
      await leitor.desligar(pareamento.id, { ...opcoes, ponta: 'celular' });
      return true;
    } catch (erro) {
      // Já desligado do outro lado (404) também é desligado.
      if (axios.isAxiosError(erro) && erro.response?.status === 404) return true;
      // Só avisa se ninguém ligou outro leitor enquanto o DELETE esperava.
      if (!get().pareamento) {
        set({
          aviso:
            'Desligado neste celular, mas o servidor não respondeu: o computador pode ' +
            'mostrar o leitor ligado até alguém desligar por lá.',
        });
      }
      return false;
    }
  },

  esquecerAviso() {
    // Sem leitor ligado, a lista é a do que não saiu e vinha com o aviso: vai junto.
    set((e) => ({ aviso: null, bipes: e.pareamento ? e.bipes : [] }));
  },

  limpar() {
    fila.interromper();
    set((e) => ({
      ...estadoInicial(),
      chamadosDispensados: [],
      pedido: null,
      servidorSemChamados: false,
      sessao: e.sessao + 1,
    }));
  },

  dispensarChamados(ids) {
    set((e) => ({ chamadosDispensados: [...new Set([...e.chamadosDispensados, ...ids])] }));
  },

  pedirAtendimento(sinal, { id, pedirPermissao = false } = {}) {
    set({ pedido: { sinal, id, pedirPermissao, em: Date.now() } });
  },

  consumirPedido() {
    const { pedido } = get();
    if (!pedido) return null;
    set({ pedido: null });
    if (Date.now() - pedido.em > VALIDADE_DO_PEDIDO_MS) return null;
    const { em: _em, ...resto } = pedido;
    return resto;
  },

  marcarServidorSemChamados() {
    if (!get().servidorSemChamados) set({ servidorSemChamados: true });
  },

  desmarcarServidorSemChamados() {
    if (get().servidorSemChamados) set({ servidorSemChamados: false });
  },
}));
