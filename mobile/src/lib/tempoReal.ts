/**
 * A ligação que mantém o app em dia com o resto da loja.
 *
 * Sem isto, cada aparelho vivia da própria cópia dos dados: cadastrava-se uma peça no
 * computador do balcão e o celular só a via depois de fechar e abrir o app. Agora o
 * servidor avisa, e a tela aberta refaz a consulta sozinha.
 *
 * O que chega é um AVISO ("estoque mudou"), nunca o dado. Quem busca é a rota REST de
 * sempre, com o filtro por papel inteiro — é isso que impede uma vendedora de receber
 * custo por um caminho lateral.
 *
 * Reconectar é a regra, não a exceção: celular entra no elevador, troca de Wi-Fi para
 * 4G, dorme no bolso — e na Vercel o servidor fecha o socket no `maxDuration` da função.
 * A queda é rotina e a volta é automática (`lib/canal.ts`).
 */

import { focusManager } from '@tanstack/react-query';

import { baseAtual } from '@/api/client';
import { lerAccessToken } from '@/api/sessao';
import { aplicarRodada, criarAgrupador, relogioReal, type Assunto } from '@/lib/avisos';
import { criarCanal } from '@/lib/canal';
import { urlDoTempoReal } from '@/lib/enderecoDoServidor';
import { queryClient } from '@/lib/queryClient';

/**
 * Avisos que chegam juntos viram UMA rodada de invalidação (`lib/avisos.ts`). Com o app no
 * fundo a rodada fica segurada: ninguém está olhando, e o celular no bolso do gerente não
 * tem por que recalcular o resumo do mês a cada venda. Na volta, `acordarTempoReal`
 * recarrega tudo de uma vez — e a rodada segurada, que viraria uma segunda busca das
 * mesmas coisas, é descartada.
 *
 * Quem diz se o app está no fundo é o `focusManager` do TanStack, ligado ao `AppState` em
 * `app/_layout.tsx`: uma fonte só, a mesma que pausa as novas tentativas de consulta.
 */
const rajada = criarAgrupador<Assunto>((assuntos) => aplicarRodada(assuntos), {
  segurar: () => !focusManager.isFocused(),
});

/** Ficamos um tempo sem ouvir: recarrega o que está na tela, de uma vez. */
function recarregarTudo(): void {
  rajada.descartar(); // o "tudo" já cobre o que estava pendente
  // No fundo, nada: a volta ao primeiro plano chama `acordarTempoReal`, que faz isto.
  if (!focusManager.isFocused()) return;
  void queryClient.invalidateQueries({ refetchType: 'active' });
}

function urlDoCanal(): string {
  // ws:// para http://, wss:// para https://, com a porta e o caminho da base (a demonstração
  // em `/demo`) — a conexão segue o mesmo endereço da API, então não há um segundo lugar
  // para configurar quando a loja muda de servidor.
  return urlDoTempoReal(baseAtual());
}

/**
 * Quando cair e como voltar mora em `lib/canal.ts` (com teste): espera crescente, zera só
 * no "conectado", e o "conectado" — inclusive o de toda religação depois que a Vercel
 * fecha o socket no `maxDuration` — recarrega o que está na tela.
 */
const canal = criarCanal({
  abrirSocket(ouvidos) {
    const ws = new WebSocket(urlDoCanal());
    ws.onopen = () => ouvidos.aoAbrir();
    ws.onmessage = (evento) => ouvidos.aoReceber(evento.data);
    ws.onclose = () => ouvidos.aoCair();
    ws.onerror = () => ouvidos.aoCair();
    return {
      enviar: (dados) => ws.send(dados),
      fechar: () => ws.close(),
      aberta: () => ws.readyState === WebSocket.OPEN,
    };
  },
  lerToken: lerAccessToken,
  relogio: relogioReal,
  aoConectar: recarregarTudo,
  aoAvisar: (assunto) => rajada.avisar(assunto as Assunto),
});

/** Liga o canal. Chamado quando a sessão abre. */
export function conectarTempoReal(): void {
  canal.ligar();
}

/** Desliga de vez: logout, ou troca de servidor. */
export function desconectarTempoReal(): void {
  canal.desligar();
  // Rodada pendente do usuário anterior não dispara depois do logout.
  rajada.descartar();
}

/** O app voltou do fundo: reconecta na hora, sem esperar a próxima tentativa. */
export function acordarTempoReal(): void {
  if (!canal.ligado()) return;
  if (canal.aberto()) {
    // Conexão de pé, mas o aparelho pode ter passado horas dormindo e perdido avisos.
    recarregarTudo();
    return;
  }
  // Canal caído: o que se ouviu antes da queda e ficou segurado no fundo vale agora, sem
  // esperar a reconexão (que pode demorar se o servidor estiver fora).
  rajada.descarregar();
  canal.reabrirJa();
}
