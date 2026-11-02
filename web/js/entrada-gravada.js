import { formatar, paraCentavos } from './dinheiro.js';

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

/**
 * O que fazer com a nota do formulário depois do mesmo 409.
 *
 * As peças saem da lista; a nota também precisa sair quando a entrada gravada JÁ a levou —
 * ela está em Contas a pagar, e o reenvio do que falta com a mesma nota lançaria as
 * parcelas de novo (a nota de R$ 900 virava R$ 1.800). O servidor diz no `detail.nota`
 * qual nota a gravada levou, ou `null` se foi sem: aí a do formulário é nova e fica.
 * Sem a chave (servidor antigo), a tela não sabe: mantém a nota e pede para conferir.
 *
 * Espelho de `notaDepoisDoDuplicado` em `mobile/src/lib/entrada.ts`.
 *
 * @param {{nota?: {numero: string|null, valor_total: string, parcelas: unknown[]}|null}} detalhe
 *   o `detail` do 409
 * @param {boolean} temNota o formulário tem nota preenchida (ligada)
 * @returns {{tirarNota: boolean, frase: string}}
 */
export function notaDepoisDoDuplicado(detalhe, temNota) {
  const gravada = detalhe?.nota;
  if (gravada) {
    const n = gravada.parcelas.length;
    const qual = gravada.numero ? `A nota ${gravada.numero}` : 'A nota';
    const resumo =
      `${qual} (${formatar(paraCentavos(gravada.valor_total))} em ${n} ` +
      `${n === 1 ? 'parcela' : 'parcelas'}) já está em Contas a pagar com a entrada gravada`;
    if (!temNota) return { tirarNota: false, frase: `${resumo}.` };
    return {
      tirarNota: true,
      frase: `${resumo}: tirei a nota do formulário para não lançá-la de novo. Se algo nela mudou, corrija em Contas a pagar.`,
    };
  }
  if (!temNota) return { tirarNota: false, frase: '' };
  if (gravada === null) {
    return { tirarNota: false, frase: 'A entrada gravada foi sem nota: a nota do formulário fica e vai com o que falta.' };
  }
  return { tirarNota: false, frase: 'Confira em Contas a pagar se esta nota já entrou antes de registrar o que falta.' };
}
