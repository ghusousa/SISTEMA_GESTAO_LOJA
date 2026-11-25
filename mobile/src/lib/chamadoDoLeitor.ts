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

import { lerPushDoServidor, sinalValido } from './notificacoes';

/** A rota do leitor (Mais → Leitor do computador): lá a própria tela mostra os chamados. */
export const ROTA_DO_LEITOR = '/mais/leitor';

export function naTelaDoLeitor(caminho: string | null | undefined): boolean {
  return caminho === ROTA_DO_LEITOR;
}

export interface ChamadoNaFaixa {
  id: number;
  sinal: string;
}

// ------------------------------------------------------------------ o prazo do chamado

/**
 * O chamado vale 5 min no servidor (`PRAZO_DO_CODIGO` de `leitor/service.py`; o ttl do push,
 * `VALIDADE_DO_CHAMADO_S`, segue o mesmo valor). Aqui só serve quando a
 * lista não traz o `criado_em` legível: a vida de cada um sai das datas dele.
 */
export const VIDA_DO_CHAMADO_MS = 5 * 60_000;

/**
 * Vencer não muda linha nenhuma no servidor (o status é calculado das datas), então nenhum aviso
 * de tempo real sai quando o chamado vence: a faixa ficaria lá por horas num celular que passa o
 * dia na frente. Por isso, enquanto a lista tem chamado, o servidor a reconfirma de 30 em 30 s
 * (o relógio do TanStack, que para com o app no fundo e não depende do relógio do aparelho) — e
 * o `vence_em` tira da tela, na hora, o que venceu entre uma conferência e outra.
 */
export const CONFERENCIA_DOS_CHAMADOS_MS = 30_000;

/** O `refetchInterval` da lista: de 30 em 30 s com chamado nela; sem chamado, só os avisos. */
export function intervaloDaConferencia(chamados: readonly unknown[] | null | undefined): number | false {
  return chamados && chamados.length > 0 ? CONFERENCIA_DOS_CHAMADOS_MS : false;
}

export interface ChamadoComPrazo {
  criado_em?: string | null;
  vence_em?: string | null;
}

/**
 * - `agora`: o relógio daqui;
 * - `buscadoEm`: quando a lista chegou (o `dataUpdatedAt`), no mesmo relógio. Se nesse instante
 *   o relógio daqui já dava o chamado por vencido mas o servidor o listou, o relógio daqui está
 *   adiantado: o `vence_em` não serve, e vale a vida inteira do chamado contada desde a busca.
 *   Sem `buscadoEm`, o relógio daqui é tido por certo.
 */
export interface Relogio {
  agora: number;
  buscadoEm?: number;
}

/** O instante, no relógio daqui, em que o chamado sai da tela; `null`: sem prazo legível. */
export function fimDoChamado(chamado: ChamadoComPrazo, buscadoEm?: number): number | null {
  const vence = Date.parse(chamado.vence_em ?? '');
  if (!Number.isFinite(vence)) return null;
  if (buscadoEm === undefined || buscadoEm < vence) return vence;
  const criado = Date.parse(chamado.criado_em ?? '');
  const vida = Number.isFinite(criado) && vence > criado ? vence - criado : VIDA_DO_CHAMADO_MS;
  return buscadoEm + vida;
}

/** Ainda vale? Sem prazo legível, sim: quem decide é a próxima conferência do servidor. */
export function chamadoVivo(chamado: ChamadoComPrazo, { agora, buscadoEm }: Relogio): boolean {
  const fim = fimDoChamado(chamado, buscadoEm);
  return fim === null || agora < fim;
}

export function chamadosVivos<T extends ChamadoComPrazo>(chamados: readonly T[], relogio: Relogio): T[] {
  return chamados.filter((c) => chamadoVivo(c, relogio));
}

/** Quando o próximo dos que ainda valem sai da tela (no relógio daqui); `null`: nenhum. */
export function proximoFim(chamados: readonly ChamadoComPrazo[], { agora, buscadoEm }: Relogio): number | null {
  let menor: number | null = null;
  for (const chamado of chamados) {
    const fim = fimDoChamado(chamado, buscadoEm);
    if (fim !== null && fim > agora && (menor === null || fim < menor)) menor = fim;
  }
  return menor;
}

// ------------------------------------------------------------------ a faixa

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
  agora,
  buscadoEm,
}: {
  chamados: readonly (ChamadoNaFaixa & ChamadoComPrazo)[];
  dispensados: readonly number[];
  leitorLigado: boolean;
  naTelaDoLeitor: boolean;
  /** Com o relógio, o chamado que venceu sai da faixa (`chamadoVivo`). */
  agora?: number;
  buscadoEm?: number;
}): OQueAFaixaMostra | null {
  // Na tela do leitor, quem mostra é ela (o cartão de cada chamado, ou a linha de trocar).
  if (naTela) return null;
  // Sinal fora do formato não é chamado que a pessoa consiga conferir com o computador; o que
  // venceu levaria ao 404 "O chamado venceu ou já foi atendido.".
  const visiveis = chamados.filter(
    (c) =>
      !dispensados.includes(c.id) &&
      sinalValido(c.sinal) &&
      (agora === undefined || chamadoVivo(c, { agora, buscadoEm })),
  );
  if (visiveis.length === 0) return null;
  const ids = visiveis.map((c) => c.id);
  if (leitorLigado) return { tipo: 'leitor-ligado', ids };
  if (visiveis.length === 1) return { tipo: 'um', chamado: { id: visiveis[0].id, sinal: visiveis[0].sinal }, ids };
  return { tipo: 'varios', quantidade: visiveis.length, ids };
}

/**
 * O "Usar o celular como leitor" da tela do leitor. No servidor de antes da ADR-47 (a VPS ainda
 * não atualizada, com o app novo da loja de aplicativos), o computador não tem o botão "Abrir no
 * app o leitor de código" e nada chama o celular: o texto é o da ADR-43, só com o QR e o código.
 */
export function instrucaoDoLeitor({ servidorComChamado }: { servidorComChamado: boolean }): string {
  const depois =
    'Depois de ligado, cada peça bipada aqui cai na tela do computador, como no leitor de código de barras.';
  if (!servidorComChamado) {
    return `No computador, peça para ligar o celular como leitor: aparece um QR e um código de 6 letras e números. ${depois}`;
  }
  return (
    'No computador, entre com o mesmo login e toque em “Abrir no app o leitor de código”: o chamado ' +
    'aparece aqui, com o mesmo sinal da tela de lá. Para o celular de outra pessoa, leia o QR do ' +
    `computador. ${depois}`
  );
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

/**
 * O servidor ganhou o chamado (ADR-47) depois de o app o marcar como antigo? A marca
 * (`servidorSemChamados`: o 404 sem `code` da lista) desliga a consulta dos chamados, e só a
 * saída da conta a apagava — o celular aberto antes de a loja atualizar o servidor ficava cego
 * aos chamados, calado. A configuração que chega com `notificacoes_push` (ligado OU desligado)
 * é do servidor novo: a marca cai e a lista volta a ser consultada. Sem o campo, nada muda.
 */
export function servidorGanhouOChamado(
  semChamados: boolean,
  configuracao: { notificacoes_push?: unknown } | null | undefined,
): boolean {
  return semChamados && lerPushDoServidor(configuracao) !== 'servidor-antigo';
}
