/**
 * O chamado do computador no app (ADR-47) — o que a faixa do topo mostra, sem tela, para dar
 * para testar. A faixa e o cartão moram em `components/FaixaDoChamado.tsx`.
 *
 * No computador, "Abrir no app o leitor de código" chama o leitor no celular do MESMO login. O
 * app ouve o assunto `leitor_pareamento` do tempo real (só o assunto: quem busca é a rota
 * REST, `GET /leitor/chamados/abertos`) e desce a faixa "O computador está chamando · Sinal
 * 7K3" em qualquer tela. Com o mesmo login em dois caixas, cada aba tem o seu chamado e o seu
 * sinal: quem desambigua é a pessoa, comparando o sinal das duas telas.
 */

import { sinalValido } from './notificacoes';

/** A rota do leitor (Mais → Leitor do computador): lá a própria tela mostra os chamados. */
export const ROTA_DO_LEITOR = '/mais/leitor';

export function naTelaDoLeitor(caminho: string | null | undefined): boolean {
  return caminho === ROTA_DO_LEITOR;
}

export interface ChamadoNaFaixa {
  id: number;
  sinal: string;
}

/**
 * - `um`: "O computador está chamando · Sinal 7K3" + [Abrir o leitor] + [✕];
 * - `leitor-ligado`: com o leitor ligado NESTE celular, a faixa só avisa ("Outro computador
 *   está chamando" + [Ver]): trocar fica na tela do leitor, onde se vê para quem se lê agora;
 * - `varios`: "N computadores estão chamando" + [Ver] — a tela do leitor lista os sinais.
 * Em todas, ✕ dispensa os `ids` que estão na faixa (um chamado novo aparece de novo).
 */
export type OQueAFaixaMostra =
  | { tipo: 'um'; chamado: ChamadoNaFaixa; ids: number[] }
  | { tipo: 'leitor-ligado'; ids: number[] }
  | { tipo: 'varios'; quantidade: number; ids: number[] };

export function oQueAFaixaMostra({
  chamados,
  dispensados,
  leitorLigado,
  naTelaDoLeitor: naTela,
}: {
  chamados: readonly ChamadoNaFaixa[];
  dispensados: readonly number[];
  leitorLigado: boolean;
  naTelaDoLeitor: boolean;
}): OQueAFaixaMostra | null {
  // Na tela do leitor, quem mostra é ela (o cartão de cada chamado, ou a linha de trocar).
  if (naTela) return null;
  // Sinal fora do formato não é chamado que a pessoa consiga conferir com o computador.
  const visiveis = chamados.filter((c) => !dispensados.includes(c.id) && sinalValido(c.sinal));
  if (visiveis.length === 0) return null;
  const ids = visiveis.map((c) => c.id);
  if (leitorLigado) return { tipo: 'leitor-ligado', ids };
  if (visiveis.length === 1) return { tipo: 'um', chamado: { id: visiveis[0].id, sinal: visiveis[0].sinal }, ids };
  return { tipo: 'varios', quantidade: visiveis.length, ids };
}

/** "há 20 s", "há 2 min" — do cartão do chamado na tela do leitor. Data ilegível: nada. */
export function haQuantoTempo(iso: string | null | undefined, agora: number): string {
  const instante = iso ? Date.parse(iso) : Number.NaN;
  if (!Number.isFinite(instante)) return '';
  const segundos = Math.max(0, Math.floor((agora - instante) / 1000));
  if (segundos < 5) return 'agora mesmo';
  if (segundos < 60) return `há ${segundos} s`;
  return `há ${Math.floor(segundos / 60)} min`;
}

// ------------------------------------------------------------------ contraste (WCAG 2)

function canal(valor: number): number {
  const c = valor / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** Luminância relativa de uma cor `#RRGGBB`. */
export function luminancia(hex: string): number {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new Error(`cor fora do formato #RRGGBB: ${hex}`);
  const n = Number.parseInt(m[1], 16);
  return 0.2126 * canal((n >> 16) & 255) + 0.7152 * canal((n >> 8) & 255) + 0.0722 * canal(n & 255);
}

/** A razão de contraste entre duas cores (1 a 21). */
export function razaoDeContraste(a: string, b: string): number {
  const [clara, escura] = [luminancia(a), luminancia(b)].sort((x, y) => y - x);
  return (clara + 0.05) / (escura + 0.05);
}
