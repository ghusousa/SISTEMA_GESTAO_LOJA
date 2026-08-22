/**
 * Dinheiro na tela é SEMPRE inteiro de centavos.
 *
 * Espelho de `mobile/src/lib/money.ts` — as duas telas do mesmo sistema precisam
 * arredondar igual, senão o mesmo carrinho fecha com totais diferentes no celular e no
 * computador. Se mudar aqui, mude lá.
 *
 * JavaScript não tem decimal nativo: `0.1 + 0.2 === 0.30000000000000004`. No caixa isso é
 * dinheiro errado. A API fala string decimal ("149.90"); a conversão acontece na borda
 * (aqui) e daí para dentro tudo é inteiro de centavos.
 *
 * Regra do projeto: nenhum `parseFloat` em valor monetário fora deste arquivo.
 */

/**
 * Converte para centavos o que vem da API e o que a pessoa digita.
 *
 * Precisa aguentar os dois mundos: a API manda `"149.90"` (ponto decimal) e a pessoa digita
 * `"2.500,00"` (ponto de milhar, vírgula decimal). Tratar o ponto sempre como decimal
 * transformaria um aluguel de R$ 2.500 em R$ 2,50.
 *
 * A regra: o ÚLTIMO separador manda. Se sobrarem 1 ou 2 dígitos depois dele, ele é o
 * decimal; se sobrarem 3, era separador de milhar ("1.000" é mil, não um e pouco).
 */
export function paraCentavos(valor) {
  if (valor === null || valor === undefined || valor === '') return 0;

  if (typeof valor === 'number') {
    return Number.isFinite(valor) ? Math.round(valor * 100) : 0;
  }

  const limpo = String(valor).trim().replace(/[\s R$]/g, '');
  const negativo = limpo.startsWith('-');
  const semSinal = (negativo ? limpo.slice(1) : limpo).replace(/[^\d.,]/g, '');
  if (semSinal === '') return 0;

  const ultimoSeparador = Math.max(semSinal.lastIndexOf('.'), semSinal.lastIndexOf(','));
  const digitosApos = ultimoSeparador === -1 ? 0 : semSinal.length - ultimoSeparador - 1;

  let inteiros;
  let decimais;
  if (ultimoSeparador !== -1 && digitosApos > 0 && digitosApos <= 2) {
    inteiros = semSinal.slice(0, ultimoSeparador);
    decimais = semSinal.slice(ultimoSeparador + 1);
  } else {
    inteiros = semSinal;
    decimais = '';
  }

  // Só dígitos daqui para frente: nada de float, então "149.90" nunca vira 149.89999999.
  const reais = inteiros.replace(/\D/g, '') || '0';
  const centavos = (decimais.replace(/\D/g, '') + '00').slice(0, 2);

  const total = Number(reais) * 100 + Number(centavos);
  if (!Number.isFinite(total)) return 0;
  return negativo ? -total : total;
}

/** 14990 -> "149.90". É este formato que a API espera no corpo da requisição. */
export function paraDecimalString(centavos) {
  const negativo = centavos < 0;
  const absoluto = Math.abs(Math.round(centavos));
  const inteiros = Math.floor(absoluto / 100);
  const resto = absoluto % 100;
  return `${negativo ? '-' : ''}${inteiros}.${String(resto).padStart(2, '0')}`;
}

const formatador = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

/** 14990 -> "R$ 149,90" */
export function formatar(centavos) {
  return formatador.format(Math.round(centavos) / 100);
}

/** 14990 -> "149,90" (sem o símbolo, para dentro de campos de entrada). */
export function formatarSemSimbolo(centavos) {
  const negativo = centavos < 0;
  const absoluto = Math.abs(Math.round(centavos));
  const inteiros = Math.floor(absoluto / 100);
  const resto = String(absoluto % 100).padStart(2, '0');
  return `${negativo ? '-' : ''}${inteiros.toLocaleString('pt-BR')},${resto}`;
}

/**
 * Entrada estilo caixa registradora: cada dígito empurra o valor pela direita.
 * Digitar 1, 5, 0 vira R$ 1,50 — sem ambiguidade de onde fica a vírgula.
 */
export function digitar(atual, digito) {
  if (!/^\d$/.test(digito)) return atual;
  // Trava em R$ 9.999.999,99: acima disso é erro de digitação, não venda.
  return Math.min(atual * 10 + Number(digito), 999999999);
}

export function apagarDigito(atual) {
  return Math.trunc(atual / 10);
}

/** Percentual sobre um valor, arredondando meio-para-cima no centavo. */
export function percentual(base, pct) {
  return Math.round((base * pct) / 100);
}

/**
 * Divide um total entre N partes sem perder nem inventar centavo.
 * O resto vai para as primeiras partes — a soma volta exatamente ao total.
 */
export function dividir(total, partes) {
  if (partes <= 0) return [];
  const base = Math.floor(total / partes);
  const resto = total - base * partes;
  return Array.from({ length: partes }, (_, i) => base + (i < resto ? 1 : 0));
}

export function somar(valores) {
  return valores.reduce((total, valor) => total + valor, 0);
}

/** "42.35" -> "42,4%". A API manda percentual como string decimal. */
export function formatarPercentual(valor) {
  const numero = typeof valor === 'number' ? valor : Number(String(valor).replace(',', '.'));
  if (!Number.isFinite(numero)) return '0%';
  return `${numero.toLocaleString('pt-BR', {
    minimumFractionDigits: numero % 1 === 0 ? 0 : 1,
    maximumFractionDigits: 1,
  })}%`;
}
