/**
 * Tira da conferência o que uma entrada já gravada levou.
 *
 * A resposta da Entrada se perde, a pessoa bipa mais peças e reenvia: o servidor recusa
 * com 409 (a chave é da entrada que existe) e devolve os itens dela. Trocar a chave e
 * reenviar a lista INTEIRA somaria de novo o que já entrou — 10 P gravadas + 7 M bipadas
 * depois virariam +20 P. Sai o que foi gravado; fica só o que falta registrar.
 *
 * Espelho de `mobile/src/lib/entrada.ts` — mudou lá, mude aqui.
 *
 * @param {{variante_id: number, quantidade: number}[]} lista a conferência na tela
 * @param {{variante_id: number, quantidade: number}[]} gravados os itens da entrada que existe
 */
export function tirarOQueJaEntrou(lista, gravados) {
  const restante = new Map();
  for (const g of gravados) {
    restante.set(g.variante_id, (restante.get(g.variante_id) ?? 0) + g.quantidade);
  }
  const saida = [];
  for (const item of lista) {
    const jaEntrou = restante.get(item.variante_id) ?? 0;
    const tirar = Math.min(jaEntrou, item.quantidade);
    if (tirar > 0) restante.set(item.variante_id, jaEntrou - tirar);
    if (item.quantidade - tirar > 0) saida.push({ ...item, quantidade: item.quantidade - tirar });
  }
  return saida;
}
