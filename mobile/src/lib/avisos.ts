/**
 * O que fazer com os avisos de tempo real — a parte sem socket, para dar para testar.
 *
 * Uma venda sozinha publica dois assuntos (`vendas` e `estoque`), uma devolução publica
 * três, e num sábado cheio dois balcões vendem no mesmo segundo. Tratar aviso por aviso
 * fazia cada celular aberto refazer o estoque rolado (todas as páginas), o resumo do mês e
 * o estoque-baixo duas, três vezes seguidas para mostrar a mesma coisa — e o servidor da
 * loja pagava essa conta multiplicada pelo número de aparelhos. Aqui os avisos que chegam
 * juntos viram UMA rodada: a união dos assuntos, cada chave invalidada uma vez.
 *
 * O aviso continua sem dado nenhum: a rodada só diz QUAIS consultas refazer, e quem busca
 * é a rota REST de sempre, com o filtro por papel inteiro (ADR-16).
 *
 * Espelho de `web/js/tempo-real.js`, onde a rodada vira um redesenho por tela inscrita.
 */

import type { QueryClient, QueryKey } from '@tanstack/react-query';

import { CHAVES_GIRO, CHAVES_RELATORIO, chaves, queryClient } from './queryClient';

/** Os mesmos assuntos de `api/app/core/eventos.py`. Mudou lá, mude aqui. */
export type Assunto =
  | 'catalogo'
  | 'estoque'
  | 'vendas'
  | 'despesas'
  | 'clientes'
  | 'caixa'
  | 'usuarios'
  | 'condicionais'
  | 'contas_pagar'
  | 'leitor'
  | 'conectado'
  | 'ping';

/**
 * Silêncio que fecha a rodada. Os assuntos de uma mesma transação saem do mesmo commit e
 * chegam com milissegundos de diferença; um segundo junta também a venda do outro balcão.
 */
export const JANELA_RAJADA = 1000;

/**
 * Teto contado do PRIMEIRO aviso. Sem ele, um fluxo contínuo (uma venda a cada meio
 * segundo) empurraria a rodada para sempre e a tela nunca se atualizaria. Dois segundos
 * é o atraso máximo que a tela de outro aparelho fica atrás do balcão.
 */
export const TETO_RAJADA = 2000;

/**
 * O que cada assunto derruba. `clientes` existia no servidor e o app ignorava: cliente
 * cadastrado no balcão não aparecia na lista aberta no celular até sair e voltar.
 */
const CHAVES_POR_ASSUNTO: Record<Assunto, readonly QueryKey[]> = {
  // O lookup por código de barras guarda a peça bipada: preço editado no balcão precisa
  // valer no próximo bipe, não no próximo login.
  catalogo: [chaves.produtos, chaves.categorias, ['variante-codigo']],
  estoque: [
    chaves.saldos,
    chaves.movimentacoes,
    chaves.produtos,
    chaves.estoqueBaixo,
    ['variante-codigo'],
    ...CHAVES_GIRO,
  ],
  vendas: [chaves.vendas, ['caixa-dia'], ...CHAVES_RELATORIO],
  despesas: [chaves.despesas, chaves.categoriasDespesa, ...CHAVES_RELATORIO],
  clientes: [chaves.clientes],
  caixa: [['caixa-dia'], chaves.fechamentos],
  // O dono mudou a meta de alguém: o placar do PDV daquela pessoa precisa da régua nova.
  usuarios: [chaves.usuarios, chaves.meuDia],
  condicionais: [chaves.condicionais],
  contas_pagar: [chaves.contasPagar],
  // Celular-leitor (ADR-43): o assunto sai a cada bipe gravado. Quem precisa dele é o
  // computador pareado; no app, a tela do leitor consulta o pareamento no próprio ritmo
  // (15 s), e refazer algo a cada bipe seria uma ida ao servidor por peça bipada.
  leitor: [],
  // Sinais de vida, não mudança: quem trata `conectado` é a reconexão, que recarrega tudo.
  conectado: [],
  ping: [],
};

/**
 * As chaves de uma rodada, cada uma UMA vez. `catalogo` e `estoque` derrubam os dois a
 * lista de produtos — que no app é rolagem infinita e refaz todas as páginas já vistas.
 */
export function chavesDosAssuntos(assuntos: Iterable<Assunto>): QueryKey[] {
  const unicas = new Map<string, QueryKey>();
  for (const assunto of assuntos) {
    // Assunto que o servidor passar a mandar antes de o app conhecer: ignorar, não quebrar.
    for (const chave of CHAVES_POR_ASSUNTO[assunto] ?? []) {
      unicas.set(JSON.stringify(chave), chave);
    }
  }
  return [...unicas.values()];
}

/**
 * Aplica uma rodada. Só o que tem tela MONTADA refaz a busca (`refetchType: 'active'`);
 * o resto fica marcado como velho e é buscado quando a tela abrir. É o que impede o
 * relatório que ninguém abriu de ser recalculado a cada venda da loja.
 */
export function aplicarRodada(
  assuntos: Iterable<Assunto>,
  cliente: QueryClient = queryClient,
): void {
  for (const queryKey of chavesDosAssuntos(assuntos)) {
    void cliente.invalidateQueries({ queryKey, refetchType: 'active' });
  }
}

/** O relógio vem de fora para o teste andar no tempo sem esperar de verdade. */
export interface Relogio {
  agora(): number;
  agendar(fn: () => void, ms: number): unknown;
  cancelar(id: unknown): void;
}

export const relogioReal: Relogio = {
  agora: () => Date.now(),
  agendar: (fn, ms) => setTimeout(fn, ms),
  cancelar: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
};

export interface Agrupador<T> {
  /** Põe o item na rodada aberta (ou abre uma) e reprograma o disparo. */
  avisar(item: T): void;
  /** Dispara já o que estiver pendente. Sem nada pendente, não faz nada. */
  descarregar(): void;
  /** Esquece a rodada pendente: quem chama vai recarregar tudo de qualquer jeito. */
  descartar(): void;
  pendentes(): ReadonlySet<T>;
}

export interface OpcoesAgrupador {
  janela?: number;
  teto?: number;
  relogio?: Relogio;
  /**
   * Perguntado na hora do disparo. Verdadeiro (app no fundo, aba escondida) segura a
   * rodada: ninguém está olhando, e recarregar agora é gastar servidor à toa. Quem acorda
   * a tela chama `descarregar` — ou `descartar`, se for recarregar tudo de qualquer jeito.
   */
  segurar?: () => boolean;
}

/**
 * Junta itens que chegam em rajada e dispara UMA vez com o conjunto: espera `janela` ms de
 * silêncio, mas nunca mais que `teto` ms desde o primeiro item da rodada.
 */
export function criarAgrupador<T>(
  disparar: (itens: ReadonlySet<T>) => void,
  {
    janela = JANELA_RAJADA,
    teto = TETO_RAJADA,
    relogio = relogioReal,
    segurar = () => false,
  }: OpcoesAgrupador = {},
): Agrupador<T> {
  let itens = new Set<T>();
  let primeiro = 0;
  let timer: unknown = null;

  function parar(): void {
    if (timer !== null) {
      relogio.cancelar(timer);
      timer = null;
    }
  }

  function soltar(): void {
    parar();
    if (itens.size === 0) return;
    // Troca o conjunto ANTES de disparar: se quem recebe quebrar, a próxima rodada começa
    // limpa em vez de arrastar os assuntos de uma rodada que já foi.
    const rodada = itens;
    itens = new Set();
    disparar(rodada);
  }

  function vencer(): void {
    timer = null;
    if (segurar()) return;
    soltar();
  }

  return {
    avisar(item) {
      const agora = relogio.agora();
      if (itens.size === 0) primeiro = agora;
      itens.add(item);
      parar();
      const espera = Math.max(0, Math.min(janela, primeiro + teto - agora));
      timer = relogio.agendar(vencer, espera);
    },
    descarregar: soltar,
    descartar() {
      parar();
      itens = new Set();
    },
    pendentes: () => itens,
  };
}
