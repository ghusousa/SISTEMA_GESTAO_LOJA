/**
 * O canal de tempo real que cai e volta — a parte sem socket de verdade, para dar para testar
 * (`node --test testes/web/*.test.mjs`). **Espelho de `mobile/src/lib/canal.ts`.** Mudou um, mude o outro.
 *
 * Cair é rotina, não exceção: a aba dorme, o Wi-Fi troca, e na Vercel o servidor FECHA o
 * socket toda vez que a função chega ao `maxDuration`. O canal religa sozinho, com espera
 * crescente (1 s, 2 s, 4 s… até 30 s) para não martelar um servidor fora do ar, e só zera a
 * espera quando o servidor ACEITA ("conectado") — socket que abre e é recusado na hora não
 * pode virar uma tentativa por segundo.
 *
 * "conectado" é também a hora de redesenhar a tela (`aoConectar`): o que mudou enquanto não
 * ouvíamos não gerou aviso para esta aba. O servidor só manda "conectado" com a escuta do
 * banco de pé (`api/app/core/escuta.py`), então dali em diante nada que outra instância
 * grave escapa desta tela.
 */

export const ESPERA_INICIAL = 1000;
export const ESPERA_MAXIMA = 30_000;

/** Espera antes da tentativa `n` (0, 1, 2…): dobra a cada falha, com teto. */
export function esperaDaTentativa(n) {
  return Math.min(ESPERA_INICIAL * 2 ** n, ESPERA_MAXIMA);
}

const relogioReal = {
  agendar: (fn, ms) => setTimeout(fn, ms),
  cancelar: (id) => clearTimeout(id),
};

/**
 * @param {object} dep
 * @param {(ouvidos: {aoAbrir(): void, aoReceber(dados: unknown): void, aoCair(): void}) =>
 *   {enviar(dados: string): void, fechar(): void, aberta(): boolean}} dep.abrirSocket
 *   cria o socket e liga os eventos dele nos `ouvidos` (`close` e `error` em `aoCair`).
 * @param {() => (string | null | Promise<string | null>)} dep.lerToken
 * @param {() => void} dep.aoConectar o servidor aceitou: redesenhe o que está na tela.
 * @param {(assunto: string) => void} dep.aoAvisar um assunto mudou (`ping` não chega aqui).
 * @param {{agendar(fn: () => void, ms: number): unknown, cancelar(id: unknown): void}} [dep.relogio]
 */
export function criarCanal({ abrirSocket, lerToken, aoConectar, aoAvisar, relogio = relogioReal }) {
  let ligacao = null;
  let tentativas = 0;
  let religar = null;
  /** Enquanto for false, qualquer queda é definitiva: ninguém está logado. */
  let ligado = false;
  /** Um `abrir` esperando o token: outro não começa por cima. */
  let abrindo = false;

  function pararReligar() {
    if (religar !== null) {
      relogio.cancelar(religar);
      religar = null;
    }
  }

  function agendarReconexao() {
    if (!ligado || religar !== null) return;
    const espera = esperaDaTentativa(tentativas);
    tentativas += 1;
    religar = relogio.agendar(() => {
      religar = null;
      void abrir();
    }, espera);
  }

  async function abrir() {
    if (!ligado || ligacao || abrindo) return;
    abrindo = true;
    let token;
    try {
      token = await lerToken();
    } catch {
      token = null;
    } finally {
      abrindo = false;
    }
    if (!ligado || ligacao) return; // deslogou ou outro abriu enquanto esperávamos
    if (!token) {
      // Entre o F5 e a renovação da sessão não há token ainda: tenta depois.
      agendarReconexao();
      return;
    }

    let esta = null;
    const atual = () => esta !== null && ligacao === esta;
    esta = abrirSocket({
      aoAbrir() {
        // Token no primeiro quadro, nunca na URL: em query string ele entraria no log de
        // acesso do servidor, no do proxy e no histórico de qualquer intermediário.
        if (atual()) esta.enviar(JSON.stringify({ tipo: 'entrar', token }));
      },
      aoReceber(dados) {
        if (!atual()) return; // socket velho, de antes de uma religação ou do logout
        let assunto;
        try {
          ({ assunto } = JSON.parse(String(dados)));
        } catch {
          return; // mensagem estranha não derruba o canal
        }
        if (typeof assunto !== 'string') return;
        if (assunto === 'conectado') {
          tentativas = 0;
          aoConectar();
          return;
        }
        if (assunto === 'ping') return; // só sinal de vida
        aoAvisar(assunto);
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
    /** Liga (sessão aberta). Ligar duas vezes não abre dois sockets. */
    ligar() {
      if (ligado) return;
      ligado = true;
      tentativas = 0;
      void abrir();
    },
    /** Desliga de vez (logout): fecha e não religa. */
    desligar() {
      ligado = false;
      pararReligar();
      const velha = ligacao;
      ligacao = null;
      velha?.fechar();
    },
    /** Tenta agora, sem esperar a espera crescente (a aba voltou ao foco). */
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
