/**
 * O toque na notificação do chamado abre a câmera já ligada ao chamado DAQUELE sinal (ADR-47):
 * o toque é o "sim". Montado no layout do grupo `(app)`, que só existe com sessão.
 *
 * Cobre as duas portas: o app aberto pelo toque, a frio (`getLastNotificationResponse`), e o
 * app que estava no fundo (o listener). Não usa o `useLastNotificationResponse` do pacote: ele
 * chama a função num `useLayoutEffect`, e no export web ela LANÇA. Aqui, sem o módulo nativo
 * (web, Expo Go), nada acontece.
 *
 * Quem procura o sinal entre os chamados abertos e atende é a tela do leitor
 * (`app/(app)/mais/leitor.tsx`), com o pedido que fica na store. Só a resposta a uma
 * notificação liga sozinha — e só com menos de 5 min e com o leitor desligado; o link
 * `gestaoloja://leitor` e o QR continuam só preenchendo, nunca ligando.
 */

import { useRouter } from 'expo-router';
import { useEffect } from 'react';

import { ROTA_DO_LEITOR } from '@/lib/chamadoDoLeitor';
import { ehChamadoDoLeitor, instanteDaNotificacao, respostaAindaVale } from '@/lib/notificacoes';
import { modulo, type ModuloDeNotificacoes } from '@/lib/notificacoesNativas';
import { useLeitorStore } from '@/stores/leitorStore';

type Resposta = ReturnType<ModuloDeNotificacoes['getLastNotificationResponse']>;

/** Respostas já tratadas nesta abertura do app: o layout remonta a cada login. */
const tratadas = new Set<string>();

export function useToqueNaNotificacao(): void {
  const router = useRouter();

  useEffect(() => {
    const N = modulo();
    if (!N) return undefined;

    function tratar(resposta: Resposta): void {
      if (!resposta || !N) return;
      const notificacao = resposta.notification;
      const id = notificacao.request.identifier;
      if (tratadas.has(id)) return;
      tratadas.add(id);
      // Só o toque na própria notificação (não um botão de ação dela).
      if (resposta.actionIdentifier !== N.DEFAULT_ACTION_IDENTIFIER) return;
      const dados = notificacao.request.content.data;
      if (!ehChamadoDoLeitor(dados)) return;
      try {
        // Lida: a próxima montagem não a trata de novo como se fosse um toque novo.
        N.clearLastNotificationResponse();
      } catch {
        // Sem limpar, o conjunto `tratadas` já segura a repetição nesta abertura.
      }
      // Velha (o chamado vale 5 min): o toque só abre o app.
      if (!respostaAindaVale(instanteDaNotificacao(notificacao.date), Date.now())) return;
      useLeitorStore.getState().pedirAtendimento(dados.sinal);
      router.navigate(ROTA_DO_LEITOR as never);
    }

    try {
      tratar(N.getLastNotificationResponse());
    } catch {
      // Sem a resposta da partida a frio: o listener ainda cobre o app que estava no fundo.
    }
    const assinatura = N.addNotificationResponseReceivedListener(tratar);
    return () => assinatura.remove();
  }, [router]);
}
