/**
 * Texto de tela em português direito.
 *
 * `textTransform: 'capitalize'` NÃO serve para frase: ele põe maiúscula em toda palavra (o
 * iOS faz o mesmo, é o `capitalizedString`), e a tela mostrava "Novembro De 2026",
 * "Últimos 30 Dias" e "Terça-Feira, 17 De Novembro". Em português, só a primeira letra.
 */

/** "novembro de 2026" → "Novembro de 2026". O resto fica como veio. */
export function primeiraMaiuscula(texto: string): string {
  if (!texto) return texto;
  return texto.charAt(0).toUpperCase() + texto.slice(1);
}

/**
 * "1 peça", "12 peças", "1.250 peças" — no lugar do "peça(s)". Espelho do `plural` de
 * `web/js/ui.js` (mesmo número com ponto de milhar, mesma regra: só 1 é singular).
 */
export function plural(n: number, singular: string, varios: string): string {
  return `${n.toLocaleString('pt-BR')} ${n === 1 ? singular : varios}`;
}
