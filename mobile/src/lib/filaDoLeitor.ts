/**
 * A fila de bipes do celular-leitor (ADR-43), sem rede nem store — para dar para testar.
 *
 * Só existe no app: quem ENVIA bipe é o celular (o computador retira). Quem guarda os
 * bipes é `stores/leitorStore.ts`; aqui mora só o laço que os manda, com tudo de fora
 * (estado, envio, relógio, espera) entrando por parâmetro.
 *
 * As regras:
 * - UM bipe por vez, na ordem da leitura — o computador recebe as peças na ordem em que
 *   foram bipadas;
 * - falha de rede, timeout, 5xx e fila cheia: espera (`esperaDaTentativa`) e manda o MESMO
 *   bipe de novo, com o mesmo `client_uuid` (o servidor devolve 200 com o que já gravou);
 * - passou de `PRAZO_DO_BIPE_MS` sem sair: "não enviado", e o próximo segue;
 * - recusa deste bipe (422…): "não enviado", e o próximo segue;
 * - leitor desligado do outro lado (404, 409 `LEITOR_DESLIGADO`): para tudo e avisa.
 */

import { destinoDaFalha, esperaDaTentativa, venceu } from './leitorRemoto';

export type EstadoDoBipe = 'enviando' | 'enviado' | 'nao-enviado';

export interface BipeDaFila {
  /** Vai como `client_uuid`: nasce na leitura e é o mesmo em todo reenvio. */
  uuid: string;
  codigo: string;
  /** Instante da leitura (ms); o prazo conta daqui. */
  lidoEm: number;
  estado: EstadoDoBipe;
  tentativas: number;
}

/** O que a falha do envio disse, já tirado do erro HTTP. */
export interface Falha {
  status?: number | null;
  /** `code` do corpo de erro da API. */
  codigo?: string | null;
  /** `detail.status` do 409 `LEITOR_DESLIGADO` (EXPIRADO, ENCERRADO…). */
  statusDoLeitor?: string | null;
}

export interface DependenciasDaFila {
  /** O agora da store: pareamento ligado (ou null) e os bipes em ordem de leitura. */
  estado(): { pareamentoId: number | null; bipes: readonly BipeDaFila[] };
  marcar(uuid: string, mudanca: Partial<BipeDaFila>): void;
  enviar(bipe: BipeDaFila, pareamentoId: number): Promise<unknown>;
  lerFalha(erro: unknown): Falha;
  /** O leitor acabou do outro lado: a store desliga e mostra o aviso. */
  aoDesligar(statusDoLeitor: string | null): void;
  agora(): number;
  /** Espera `ms`; resolve antes se `acordar` for chamado. */
  dormir(ms: number, registrarAcordar: (acordar: () => void) => void): Promise<void>;
}

export interface Fila {
  /** Manda o que estiver pendente. Já rodando, não abre um segundo laço. */
  esvaziar(): Promise<void>;
  /** Corta o laço atual (desligar, logout, outro pareamento). */
  interromper(): void;
  /** Encurta a espera entre tentativas: bipe novo, a pessoa quer ver sair. */
  acordar(): void;
}

export function criarFila(dep: DependenciasDaFila): Fila {
  // Cada `interromper` abre uma geração nova: o laço antigo, parado num `await`, acorda,
  // vê que não é mais o dele e sai sem tocar em nada.
  let geracao = 0;
  let rodando = false;
  let acordarEspera: (() => void) | null = null;

  async function esvaziar(): Promise<void> {
    if (rodando) return;
    rodando = true;
    const minha = geracao;
    try {
      for (;;) {
        if (minha !== geracao) return;
        const { pareamentoId, bipes } = dep.estado();
        const proximo = bipes.find((b) => b.estado === 'enviando');
        if (pareamentoId === null || !proximo) return;

        if (venceu(proximo, dep.agora())) {
          dep.marcar(proximo.uuid, { estado: 'nao-enviado' });
          continue;
        }

        try {
          await dep.enviar(proximo, pareamentoId);
          if (minha !== geracao) return;
          dep.marcar(proximo.uuid, { estado: 'enviado' });
        } catch (erro) {
          if (minha !== geracao) return;
          const falha = dep.lerFalha(erro);
          const destino = destinoDaFalha(falha.status, falha.codigo);
          if (destino === 'leitor-desligado') {
            dep.aoDesligar(falha.statusDoLeitor ?? null);
            return;
          }
          if (destino === 'descartar') {
            dep.marcar(proximo.uuid, { estado: 'nao-enviado' });
            continue;
          }
          const tentativas = proximo.tentativas + 1;
          dep.marcar(proximo.uuid, { tentativas });
          let meu: (() => void) | null = null;
          await dep.dormir(esperaDaTentativa(tentativas), (acordar) => {
            meu = acordar;
            acordarEspera = acordar;
          });
          // Só solta o despertador se ainda for o desta espera (não o de um laço novo).
          if (acordarEspera === meu) acordarEspera = null;
        }
      }
    } finally {
      if (minha === geracao) rodando = false;
    }
  }

  return {
    esvaziar,
    interromper() {
      geracao += 1;
      rodando = false;
      acordarEspera?.();
    },
    acordar() {
      acordarEspera?.();
    },
  };
}

/** `dormir` de verdade, com `setTimeout`. */
export function dormirDeVerdade(
  ms: number,
  registrarAcordar: (acordar: () => void) => void,
): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    registrarAcordar(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}
