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
 */

import axios from 'axios';
import { create } from 'zustand';

import { leitor } from '@/api/endpoints';
import type { ErroApi, Pareamento, StatusPareamento } from '@/api/tipos';
import {
  criarFila,
  dormirDeVerdade,
  type BipeDaFila,
  type Falha,
} from '@/lib/filaDoLeitor';
import { avisoDoFim } from '@/lib/leitorRemoto';
import { gerarUuid } from '@/lib/uuid';

export type { BipeDaFila, EstadoDoBipe } from '@/lib/filaDoLeitor';

/** Quantos bipes já resolvidos ficam para a lista da tela. Os pendentes ficam todos. */
export const HISTORICO_DE_BIPES = 10;

interface OpcoesDesligar {
  /** Curto no logout: sair do app não espera servidor que não responde. */
  timeout?: number;
}

interface LeitorState {
  pareamento: Pareamento | null;
  /** Em ordem de leitura (o mais novo no fim). */
  bipes: BipeDaFila[];
  /** Por que o leitor parou sem a pessoa pedir; a tela mostra e a pessoa dispensa. */
  aviso: string | null;

  /** O aceite deu certo: daqui em diante as leituras vão para este computador. */
  ligar: (pareamento: Pareamento) => void;
  /** Resposta da consulta periódica. Fora de ATIVO, o leitor para. */
  atualizar: (pareamento: Pareamento) => void;
  /** O servidor disse que acabou (404, `LEITOR_DESLIGADO`). */
  encerrar: (aviso: string) => void;
  /** Uma leitura da câmera: entra na fila e sai assim que der. */
  ler: (codigo: string) => void;
  /** "Desligar" na tela, ou o logout. `false` se o servidor não ficou sabendo. */
  desligar: (opcoes?: OpcoesDesligar) => Promise<boolean>;
  esquecerAviso: () => void;
  /** Esquece tudo sem falar com o servidor (sessão perdida). */
  limpar: () => void;
}

const estadoInicial = () => ({
  pareamento: null as Pareamento | null,
  bipes: [] as BipeDaFila[],
  aviso: null as string | null,
});

/** Mantém todo pendente e só os `HISTORICO_DE_BIPES` mais novos entre os resolvidos. */
function podar(bipes: BipeDaFila[]): BipeDaFila[] {
  const corte = bipes.length - HISTORICO_DE_BIPES;
  return bipes.filter((b, i) => b.estado === 'enviando' || i >= corte);
}

/** O que sobrou na fila não sai mais: fica na lista como "não enviado". */
function pendentesNaoEnviados(bipes: BipeDaFila[]): BipeDaFila[] {
  return podar(
    bipes.map((b) => (b.estado === 'enviando' ? { ...b, estado: 'nao-enviado' as const } : b)),
  );
}

function lerFalha(erro: unknown): Falha {
  if (!axios.isAxiosError<ErroApi>(erro)) return {};
  const corpo = erro.response?.data;
  const status = corpo?.detail?.status;
  return {
    status: erro.response?.status,
    codigo: corpo?.code ?? null,
    statusDoLeitor: typeof status === 'string' ? status : null,
  };
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
  enviar: (bipe, pareamentoId) =>
    leitor.enviarBipe({ client_uuid: bipe.uuid, pareamento_id: pareamentoId, codigo: bipe.codigo }),
  lerFalha,
  aoDesligar: (statusDoLeitor) =>
    useLeitorStore
      .getState()
      .encerrar(
        avisoDoFim(statusDoLeitor ? { status: statusDoLeitor as StatusPareamento } : null),
      ),
  agora: () => Date.now(),
  dormir: dormirDeVerdade,
});

export const useLeitorStore = create<LeitorState>((set, get) => ({
  ...estadoInicial(),

  ligar(pareamento) {
    fila.interromper();
    if (pareamento.status !== 'ATIVO') {
      set({ ...estadoInicial(), aviso: avisoDoFim(pareamento) });
      return;
    }
    set({ pareamento, bipes: [], aviso: null });
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
    set((e) => ({ pareamento: null, bipes: pendentesNaoEnviados(e.bipes), aviso }));
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
      await leitor.desligar(pareamento.id, opcoes);
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
    set({ aviso: null });
  },

  limpar() {
    fila.interromper();
    set({ ...estadoInicial() });
  },
}));
