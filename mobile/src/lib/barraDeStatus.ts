/**
 * A cor da barra de status (hora, sinal, bateria), tela a tela.
 *
 * O padrão do app é CLARA (texto branco, `<StatusBar style="light" />` na raiz): quase toda
 * tela tem o cabeçalho azul embaixo dela. As telas sem cabeçalho e de fundo claro — a entrada,
 * o servidor e a aba Vender — pedem a ESCURA enquanto estão em foco (`useBarraDeStatusEscura`).
 * Sem isso, a hora e a bateria ficavam brancas sobre o #F5F6F8 em qualquer iPhone, justamente
 * na primeira tela da gravação que a Apple pediu.
 *
 * No iPhone quem guarda a pilha é o próprio `StatusBar` do React Native. No navegador (o
 * export web, que fotografa as capturas) não há barra de status: a pilha daqui anota no
 * `<html data-barra-de-status>` o que o app pediu, e o `compor.mjs` pinta a barra da arte com
 * ESSA cor — e para se ela ficar ilegível sobre a foto, em vez de corrigir o que o iPhone mostra.
 */

export type EstiloDaBarra = 'clara' | 'escura';

/** O da raiz (`app/_layout.tsx`): texto claro, para os cabeçalhos azuis. */
export const ESTILO_PADRAO: EstiloDaBarra = 'clara';

export interface Anotador {
  dataset: Record<string, string | undefined>;
}

/**
 * Uma pilha de pedidos, como a do `StatusBar`: vale o último que entrou e ainda não saiu.
 * Devolve `pedir(estilo)`, que anota e devolve a função que desfaz o pedido.
 */
export function criarPilhaDaBarra(anotar: (estilo: EstiloDaBarra) => void) {
  const pilha: { estilo: EstiloDaBarra }[] = [];
  const aplicar = () => anotar(pilha.at(-1)?.estilo ?? ESTILO_PADRAO);
  return function pedir(estilo: EstiloDaBarra): () => void {
    const pedido = { estilo };
    pilha.push(pedido);
    aplicar();
    return () => {
      const i = pilha.indexOf(pedido);
      if (i >= 0) pilha.splice(i, 1);
      aplicar();
    };
  };
}

/** A pilha do navegador: anota no `<html>` (o `gerar.mjs` lê `data-barra-de-status`). */
export function anotarNoHtml(raiz: Anotador | undefined): (estilo: EstiloDaBarra) => void {
  return (estilo) => {
    if (raiz) raiz.dataset.barraDeStatus = estilo;
  };
}
