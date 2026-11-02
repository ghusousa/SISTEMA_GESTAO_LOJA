/**
 * NFC-e no app (ADR-41): o que mostrar, sem decidir nada fiscal. Espelho de
 * `web/js/nfce.js` e `web/js/campos-fiscais.js` — mudou um, mude o outro.
 *
 * Quem decide se a nota sai, e o que falta, é o servidor. Aqui só se traduz o que ele
 * respondeu em rótulo, cor e botão — e isso tem teste (`fiscal.test.ts`).
 */

import type { Nfce, StatusNota } from '../api/tipos';

export const CFOP_PADRAO = '5102';

export const ORIGENS: [number, string][] = [
  [0, '0 — Nacional'],
  [1, '1 — Estrangeira, importação direta'],
  [2, '2 — Estrangeira, comprada no mercado interno'],
  [3, '3 — Nacional, mais de 40% importado'],
  [4, '4 — Nacional, processo produtivo básico'],
  [5, '5 — Nacional, até 40% importado'],
  [6, '6 — Estrangeira direta, sem similar nacional'],
  [7, '7 — Estrangeira interna, sem similar nacional'],
  [8, '8 — Nacional, mais de 70% importado'],
];

export const REGIMES: [number, string][] = [
  [1, 'Simples Nacional'],
  [2, 'Simples — excesso de sublimite'],
  [3, 'Regime Normal'],
];

/** "61091000" → "6109.10.00", como vem no papel do contador. */
export const ncmFormatado = (ncm: string | null | undefined): string =>
  ncm ? ncm.replace(/^(\d{4})(\d{2})(\d{2})$/, '$1.$2.$3') : '';

export const cestFormatado = (cest: string | null | undefined): string =>
  cest ? cest.replace(/^(\d{2})(\d{3})(\d{2})$/, '$1.$2.$3') : '';

/** Chave de 44 dígitos em grupos de 4, como sai no DANFE. */
export const chaveFormatada = (chave: string | null | undefined): string =>
  (chave ?? '').replace(/(\d{4})(?=\d)/g, '$1 ');

/** Campo vazio vira `null` (apaga no servidor); o servidor confere o formato. */
export function lerCodigo(texto: string): string | null {
  const limpo = texto.trim();
  return limpo ? limpo : null;
}

export type Tom = 'ok' | 'alerta' | 'perigo' | 'neutro';

const STATUS: Record<StatusNota, { texto: string; tom: Tom }> = {
  PENDENTE: { texto: 'Pendente', tom: 'alerta' },
  AUTORIZADA: { texto: 'Autorizada', tom: 'ok' },
  REJEITADA: { texto: 'Rejeitada', tom: 'perigo' },
  CANCELADA: { texto: 'Cancelada', tom: 'neutro' },
};

export const rotuloDaNota = (status: StatusNota) => STATUS[status] ?? { texto: status, tom: 'neutro' };

/** Só link http(s): o endereço vem do emissor, e outro esquema não vira botão. */
export const linkSeguro = (url: string | null | undefined): string | null =>
  url && /^https?:\/\//i.test(url) ? url : null;

export interface CartaoNfce {
  /** Nada a mostrar: o cartão some (emissor desligado para quem não pode ligar). */
  oculto: boolean;
  /** Botão "Emitir NFC-e" / "Tentar de novo", ou nenhum. */
  botao: 'Emitir NFC-e' | 'Tentar de novo' | null;
  /** O motivo do emissor, quando a nota não está autorizada. */
  mensagem: string | null;
  /** O que falta para emitir (emissor desligado), em frase do servidor. */
  faltando: string[];
}

/**
 * O que o cartão da NFC-e mostra no detalhe da venda. `podeConfigurar` é o dono: só ele
 * vê o aviso de emissor desligado — para o balcão seria ruído que ninguém ali resolve.
 */
export function cartaoDaNfce(
  nfce: Nfce | null | undefined,
  vendaCancelada: boolean,
  podeConfigurar: boolean,
): CartaoNfce {
  const vazio: CartaoNfce = { oculto: true, botao: null, mensagem: null, faltando: [] };
  if (!nfce) return vazio;
  const { emissor, nota } = nfce;
  const podeEmitir = emissor.configurado && !vendaCancelada;
  if (!nota) {
    if (!emissor.configurado) {
      return podeConfigurar ? { ...vazio, oculto: false, faltando: emissor.faltando } : vazio;
    }
    return { ...vazio, oculto: false, botao: podeEmitir ? 'Emitir NFC-e' : null };
  }
  const repetir = podeEmitir && (nota.status === 'PENDENTE' || nota.status === 'REJEITADA');
  return {
    oculto: false,
    botao: repetir ? 'Tentar de novo' : null,
    mensagem: nota.status === 'AUTORIZADA' ? null : nota.mensagem,
    faltando: [],
  };
}

/** A linha do recibo: "NFC-e autorizada: <chave>", ou `null` se não houver nota valendo. */
export function linhaDoRecibo(nfce: Nfce | null | undefined): string | null {
  const nota = nfce?.nota;
  if (!nota || nota.status !== 'AUTORIZADA' || !nota.chave) return null;
  return `NFC-e autorizada: ${chaveFormatada(nota.chave)}`;
}

/** Com nota autorizada, o motivo do cancelamento vai à SEFAZ: mínimo de 15 letras. */
export const MOTIVO_MINIMO_COM_NOTA = 15;
export const motivoMinimo = (nfce: Nfce | null | undefined): number =>
  nfce?.nota?.status === 'AUTORIZADA' ? MOTIVO_MINIMO_COM_NOTA : 3;
