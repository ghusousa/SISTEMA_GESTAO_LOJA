/**
 * O canal de tempo real que cai e volta — a parte sem socket de verdade, para dar para testar.
 *
 * Cair é rotina, não exceção: o celular entra no elevador, troca de Wi-Fi para 4G, dorme no
 * bolso; e na Vercel o servidor FECHA o socket toda vez que a função chega ao `maxDuration`.
 * O canal religa sozinho, com espera crescente (1 s, 2 s, 4 s… até 30 s) para não martelar
 * um servidor fora do ar, e só zera a espera quando o servidor ACEITA ("conectado") — socket
 * que abre e é recusado na hora não pode virar uma tentativa por segundo.
 *
 * "conectado" é também a hora de refazer as consultas da tela (`aoConectar`): o que mudou
 * enquanto não ouvíamos não gerou aviso para este aparelho. O servidor só manda
 * "conectado" com a escuta do banco de pé (`api/app/core/escuta.py`), então dali em diante
 * nada que outra instância grave escapa desta tela.
 *
 * Espelho de `web/js/canal.js`. Mudou um, mude o outro.
 */

import type { Relogio } from './avisos';

export const ESPERA_INICIAL = 1000;
export const ESPERA_MAXIMA = 30_000;

/** Espera antes da tentativa `n` (0, 1, 2…): dobra a cada falha, com teto. */
export function esperaDaTentativa(n: number): number {
  return Math.min(ESPERA_INICIAL * 2 ** n, ESPERA_MAXIMA);
}

/** O que o canal usa de um socket aberto. */
export interface Ligacao {
  enviar(dados: string): void;
  fechar(): void;
  aberta(): boolean;
}

/** O que o socket conta ao canal. Quem cria o socket liga estes nos eventos dele. */
export interface Ouvidos {
  aoAbrir(): void;
  aoReceber(dados: unknown): void;
  /** `close` e `error`: os dois podem vir, e o canal religa uma vez só. */
  aoCair(): void;
}

export interface DependenciasDoCanal {
  abrirSocket(ouvidos: Ouvidos): Ligacao;
  lerToken(): Promise<string | null> | string | null;
  relogio: Pick<Relogio, 'agendar' | 'cancelar'>;
  /** O servidor aceitou: refaça o que está na tela. */
  aoConectar(): void;
  /** Um assunto mudou ("estoque", "vendas"…). `ping` não chega aqui. */
  aoAvisar(assunto: string): void;
}

export interface Canal {
  /** Liga (sessão aberta). Ligar duas vezes não abre dois sockets. */
  ligar(): void;
  /** Desliga de vez (logout): fecha e não religa. */
  desligar(): void;
  /** Tenta agora, sem esperar a espera crescente (o app voltou do fundo). */
  reabrirJa(): void;
  ligado(): boolean;
  aberto(): boolean;
}

export function criarCanal(dep: DependenciasDoCanal): Canal {
  let ligacao: Ligacao | null = null;
  let tentativas = 0;
  let religar: unknown = null;
  /** Enquanto for false, qualquer queda é definitiva: ninguém está logado. */
  let ligado = false;
  /** Um `abrir` esperando o token: outro não começa por cima. */
  let abrindo = false;

  function pararReligar(): void {
    if (religar !== null) {
      dep.relogio.cancelar(religar);
      religar = null;
    }
  }

  function agendarReconexao(): void {
    if (!ligado || religar !== null) return;
    const espera = esperaDaTentativa(tentativas);
    tentativas += 1;
    religar = dep.relogio.agendar(() => {
      religar = null;
      void abrir();
    }, espera);
  }

  async function abrir(): Promise<void> {
    if (!ligado || ligacao || abrindo) return;
    abrindo = true;
    let token: string | null;
    try {
      token = await dep.lerToken();
    } catch {
      token = null;
    } finally {
      abrindo = false;
    }
    if (!ligado || ligacao) return; // deslogou ou outro abriu enquanto esperávamos
    if (!token) {
      // Sem sessão ainda (entre o F5 e a renovação, ou entre logout e login): tenta depois.
      agendarReconexao();
      return;
    }

    let esta: Ligacao | null = null;
    const atual = () => esta !== null && ligacao === esta;
    esta = dep.abrirSocket({
      aoAbrir() {
        // O token vai no primeiro quadro, nunca na URL: em query string ele entraria no
        // log de acesso do servidor e no de qualquer proxy do caminho.
        if (atual()) esta?.enviar(JSON.stringify({ tipo: 'entrar', token }));
      },
      aoReceber(dados) {
        if (!atual()) return; // socket velho, de antes de uma religação ou do logout
        let assunto: unknown;
        try {
          ({ assunto } = JSON.parse(String(dados)) as { assunto?: unknown });
        } catch {
          return; // mensagem estranha não derruba o canal
        }
        if (typeof assunto !== 'string') return;
        if (assunto === 'conectado') {
          tentativas = 0;
          dep.aoConectar();
          return;
        }
        if (assunto === 'ping') return; // só sinal de vida
        dep.aoAvisar(assunto);
      },
      aoCair() {
        if (!atual()) return;
        ligacao = null;
        agendarReconexao();
      },
    });
    ligacao = esta;
  }

  return {
    ligar() {
      if (ligado) return;
      ligado = true;
      tentativas = 0;
      void abrir();
    },
    desligar() {
      ligado = false;
      pararReligar();
      const velha = ligacao;
      ligacao = null;
      velha?.fechar();
    },
    reabrirJa() {
      if (!ligado) return;
      pararReligar();
      tentativas = 0;
      void abrir();
    },
    ligado: () => ligado,
    aberto: () => ligacao?.aberta() ?? false,
  };
}
