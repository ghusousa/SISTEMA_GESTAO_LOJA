/**
 * Loja de demonstração (ADR-46).
 *
 * A demonstração sobe junto com a loja, no mesmo domínio (`<domínio>/demo`), com dados
 * fictícios — e o mesmo app instalado fala com uma ou com a outra. O dono não pode confundir
 * as duas: vender "de verdade" na demonstração, ou mostrar a loja real achando que é a de
 * mentira. Quem diz qual é qual é o servidor, em `GET /configuracao` (`demonstracao: true`),
 * e o app pinta a faixa em toda tela (`components/FaixasDoTopo.tsx`).
 *
 * A frase é a mesma da faixa do web — as duas pontas mostram a mesma loja.
 */

export const FRASE_DA_DEMONSTRACAO = 'Loja de demonstração — os dados são fictícios.';

/**
 * É a loja de demonstração? Só com `true` de verdade: servidor antigo não manda o campo, a
 * demonstração da Vercel não o liga, e qualquer outra coisa (texto, número) não conta —
 * na dúvida, a loja é a real e não ganha faixa.
 */
export function ehLojaDeDemonstracao(configuracao: { demonstracao?: unknown } | null | undefined): boolean {
  return configuracao?.demonstracao === true;
}
