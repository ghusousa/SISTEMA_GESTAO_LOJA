/**
 * O que vai em cada campo "contado" da conferência de caixa.
 *
 * O campo nasce com o esperado — na maioria dos dias o caixa bate e quem confere só
 * confirma — e SEGUE o esperado enquanto ninguém mexer nele. Ele era preenchido uma vez só,
 * ao abrir a tela: a venda que entrava com ela aberta mudava o esperado (o tempo real refaz
 * a consulta), o campo ficava no valor velho, e quem confirmava direto o "bateu" gravava uma
 * falta igual às vendas feitas desde então. O que a pessoa digitou é dela e não muda.
 *
 * Separado da tela para poder testar, como as regras do leitor em `leitura.ts`.
 */

import { formatar, paraCentavos } from './money';

export interface LinhaConferida {
  forma: string;
  esperado: string;
  /** O que foi contado no fechamento já feito hoje, ou `null` se o dia está aberto. */
  contado: string | null;
}

/** "1234.50" -> "1234,50": o valor do jeito que a pessoa digitaria no campo. */
function paraCampo(valor: string): string {
  return formatar(paraCentavos(valor)).replace(/[^\d,]/g, '');
}

/**
 * Os campos para a consulta de agora. `editados` são as formas em que a pessoa digitou:
 * essas ficam como estão; as outras seguem o servidor (o contado do fechamento já feito,
 * ou o esperado de agora).
 */
export function camposDoContado(
  linhas: readonly LinhaConferida[],
  atual: Readonly<Record<string, string>>,
  editados: ReadonlySet<string>,
): Record<string, string> {
  const campos: Record<string, string> = {};
  for (const linha of linhas) {
    const digitado = atual[linha.forma];
    campos[linha.forma] =
      editados.has(linha.forma) && digitado !== undefined
        ? digitado
        : paraCampo(linha.contado ?? linha.esperado);
  }
  return campos;
}
