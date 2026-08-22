/**
 * Dinheiro no app é SEMPRE inteiro de centavos.
 *
 * JavaScript não tem decimal nativo: `0.1 + 0.2 === 0.30000000000000004`. No caixa, isso
 * é dinheiro errado. A API fala string decimal ("149.90"); a conversão acontece na borda
 * (aqui) e daí para dentro tudo é `number` inteiro de centavos.
 *
 * Regra do projeto: nenhum `parseFloat` em valor monetário fora deste arquivo.
 */

export type Centavos = number;

/** "149.90" | "149.9" | 149.9 -> 14990. Aceita vírgula porque o usuário digita vírgula. */
export function paraCentavos(valor: string | number | null | undefined): Centavos {
  if (valor === null || valor === undefined || valor === '') return 0;

  if (typeof valor === 'number') {
    // Vem de um campo numérico: arredonda meio-para-cima no último centavo.
    return Math.round(valor * 100);
  }

  const limpo = valor.trim().replace(/\s/g, '').replace(',', '.');
  const negativo = limpo.startsWith('-');
  const semSinal = negativo ? limpo.slice(1) : limpo;

  const [inteiros = '0', decimais = ''] = semSinal.split('.');
  // Trabalha com os dígitos, não com float: "149.90" nunca vira 149.89999999.
  const centavosDecimais = (decimais + '00').slice(0, 2);
  const total = Number(inteiros || '0') * 100 + Number(centavosDecimais || '0');

  if (!Number.isFinite(total)) return 0;
  return negativo ? -total : total;
}

/** 14990 -> "149.90". É este formato que a API espera no corpo da requisição. */
export function paraDecimalString(centavos: Centavos): string {
  const negativo = centavos < 0;
  const absoluto = Math.abs(Math.round(centavos));
  const inteiros = Math.floor(absoluto / 100);
  const resto = absoluto % 100;
  return `${negativo ? '-' : ''}${inteiros}.${String(resto).padStart(2, '0')}`;
}

const formatador = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
});

/** 14990 -> "R$ 149,90" */
export function formatar(centavos: Centavos): string {
  return formatador.format(Math.round(centavos) / 100);
}

/** 14990 -> "149,90" (sem o símbolo, para dentro de campos de entrada). */
export function formatarSemSimbolo(centavos: Centavos): string {
  const negativo = centavos < 0;
  const absoluto = Math.abs(Math.round(centavos));
  const inteiros = Math.floor(absoluto / 100);
  const resto = String(absoluto % 100).padStart(2, '0');
  const comSeparador = inteiros.toLocaleString('pt-BR');
  return `${negativo ? '-' : ''}${comSeparador},${resto}`;
}

/**
 * Entrada estilo caixa registradora: cada dígito empurra o valor pela direita.
 * Digitar 1, 5, 0 vira R$ 1,50 — sem ambiguidade de onde fica a vírgula.
 */
export function digitar(atual: Centavos, digito: string): Centavos {
  if (!/^\d$/.test(digito)) return atual;
  const proximo = atual * 10 + Number(digito);
  // Trava em R$ 9.999.999,99: acima disso é erro de digitação, não venda.
  return Math.min(proximo, 999_999_999);
}

export function apagarDigito(atual: Centavos): Centavos {
  return Math.trunc(atual / 10);
}

/** Percentual sobre um valor, arredondando meio-para-cima no centavo. */
export function percentual(base: Centavos, pct: number): Centavos {
  return Math.round((base * pct) / 100);
}

/**
 * Divide um total entre N partes sem perder nem inventar centavo.
 * O resto vai para as primeiras partes — a soma volta exatamente ao total.
 */
export function dividir(total: Centavos, partes: number): Centavos[] {
  if (partes <= 0) return [];
  const base = Math.floor(total / partes);
  const resto = total - base * partes;
  return Array.from({ length: partes }, (_, i) => base + (i < resto ? 1 : 0));
}

export function somar(valores: Centavos[]): Centavos {
  return valores.reduce((total, valor) => total + valor, 0);
}
