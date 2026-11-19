/**
 * Tema do app. Loja é ambiente claro e o uso é rápido, de pé, às vezes com uma mão só:
 * contraste alto, área de toque grande, nada de cinza sobre cinza.
 */

export const cores = {
  fundo: '#F5F6F8',
  superficie: '#FFFFFF',
  superficieAlt: '#EEF1F5',

  primaria: '#1E3A5F',
  primariaClara: '#2C5282',
  primariaFraca: '#E8EEF6',

  acao: '#0F9D58',
  acaoEscura: '#0B7A44',

  perigo: '#C62828',
  perigoFraco: '#FDECEA',
  alerta: '#E8A317',
  alertaFraco: '#FFF6E0',
  sucessoFraco: '#E6F4EA',
  /**
   * Faixa da loja de demonstração (ADR-46). Ela fica debaixo da barra de status, que é clara
   * nas telas de cabeçalho azul e escura nas de fundo claro: este tom deixa as duas legíveis
   * (hora branca 5:1, preta 4,2:1) e o texto branco da faixa também.
   */
  demonstracao: '#B45309',
  /**
   * Faixa "O computador está chamando" (ADR-47). Pela mesma razão da demonstração, quando ela
   * é a primeira faixa fica debaixo da barra de status, clara ou escura conforme a tela de
   * baixo: hora branca 4,9:1, preta 4,3:1 (o teste de `lib/chamadoDoLeitor.test.ts` mede). Azul,
   * e não o âmbar da demonstração: na demonstração as duas aparecem juntas.
   */
  chamadoDoLeitor: '#2F6FD0',

  texto: '#16202C',
  textoSuave: '#5A6572',
  textoFraco: '#8B95A1',
  borda: '#DCE1E8',
  bordaForte: '#B9C2CD',

  aoFundoEscuro: '#FFFFFF',
} as const;

export const espaco = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

export const raio = {
  sm: 8,
  md: 12,
  lg: 16,
  redondo: 999,
} as const;

/** Mínimo de 48pt: o dedo no balcão não tem a precisão do mouse. */
export const ALVO_TOQUE = 48;
export const ALVO_TOQUE_GRANDE = 64;

export const fonte = {
  micro: 11,
  pequena: 13,
  base: 15,
  media: 17,
  grande: 20,
  titulo: 24,
  destaque: 34,
} as const;

export const sombra = {
  shadowColor: '#0B1B2B',
  shadowOffset: { width: 0, height: 2 },
  shadowOpacity: 0.08,
  shadowRadius: 8,
  elevation: 3,
} as const;
