import { QueryClient } from '@tanstack/react-query';

/**
 * Sem cache em disco: o app é online-only no v1 e dado de estoque velho na tela é pior
 * que tela vazia — o vendedor confiaria num saldo que não existe mais.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
    mutations: {
      // Mutação não repete sozinha: venda e entrada são idempotentes por client_uuid,
      // mas ajuste e despesa não são — repetir criaria lançamento duplicado.
      retry: 0,
    },
  },
});

/** Chaves em um lugar só: invalidar depois de uma venda não pode depender de memória. */
export const chaves = {
  saldos: ['saldos'] as const,
  produtos: ['produtos'] as const,
  produto: (id: number) => ['produtos', id] as const,
  variantePorCodigo: (codigo: string) => ['variante-codigo', codigo] as const,
  vendas: ['vendas'] as const,
  venda: (id: number) => ['vendas', id] as const,
  movimentacoes: ['movimentacoes'] as const,
  categorias: ['categorias'] as const,
  despesas: ['despesas'] as const,
  categoriasDespesa: ['categorias-despesa'] as const,
  caixaDia: (data?: string) => ['caixa-dia', data ?? 'hoje'] as const,
  fechamentos: ['fechamentos'] as const,
  relatorioResumo: (inicio: string, fim: string) => ['relatorio-resumo', inicio, fim] as const,
  relatorioVendasDia: (inicio: string, fim: string) =>
    ['relatorio-vendas-dia', inicio, fim] as const,
  relatorioMaisVendidos: (inicio: string, fim: string) =>
    ['relatorio-mais-vendidos', inicio, fim] as const,
  relatorioDespesas: (inicio: string, fim: string) =>
    ['relatorio-despesas', inicio, fim] as const,
  estoqueBaixo: ['estoque-baixo'] as const,
  relatorioVendedoras: (inicio: string, fim: string) =>
    ['relatorio-vendedoras', inicio, fim] as const,
  relatorioCurvaAbc: (inicio: string, fim: string) => ['relatorio-curva-abc', inicio, fim] as const,
  relatorioRecebiveis: (inicio: string, fim: string) =>
    ['relatorio-recebiveis', inicio, fim] as const,
  /** O placar do PDV. Cai com venda (relatório) e com usuário (o dono mudou a meta). */
  meuDia: ['relatorio-meu-dia'] as const,
  /** Fotografias do agora, sem período: caem com qualquer mexida no estoque. */
  estoqueParado: (dias: number) => ['estoque-parado', dias] as const,
  valorDoEstoque: ['valor-do-estoque'] as const,
  usuarios: ['usuarios'] as const,
  auditoria: ['auditoria'] as const,
  configuracao: ['configuracao'] as const,
  clientes: ['clientes'] as const,
  cliente: (id: number) => ['clientes', id] as const,
  extratoCliente: (id: number) => ['clientes', id, 'extrato'] as const,
  devolucoesDaVenda: (vendaId: number) => ['devolucoes', vendaId] as const,
  /** Mudar a taxa NÃO invalida relatório: a venda guarda a taxa do dia dela (ADR-35). */
  taxasCartao: ['taxas-cartao'] as const,
  aniversariantes: (mes: number) => ['clientes', 'aniversariantes', mes] as const,
  comprasDaCliente: (id: number) => ['vendas', 'cliente', id] as const,
  condicionais: ['condicionais'] as const,
  condicional: (id: number) => ['condicionais', id] as const,
  /** NÃO é relatório: conta a pagar fica fora do Resultado (ADR-40). */
  contasPagar: ['contas-pagar'] as const,
};

/**
 * Tudo que depende de faturamento, custo ou resultado. Exportado porque o tempo real
 * (`lib/avisos.ts`) derruba a mesma lista: duas cópias divergem no primeiro relatório novo.
 */
export const CHAVES_RELATORIO = [
  ['relatorio-resumo'],
  ['relatorio-vendas-dia'],
  ['relatorio-mais-vendidos'],
  ['relatorio-despesas'],
  ['relatorio-vendedoras'],
  ['relatorio-curva-abc'],
  ['relatorio-recebiveis'],
  ['relatorio-meu-dia'],
] as const;

/**
 * O que é fotografia do estoque de agora (não do período): saldo mudou, elas caem. Mesma
 * lista no tempo real (`lib/avisos.ts`) e nas mutações daqui.
 */
export const CHAVES_GIRO = [['estoque-parado'], ['valor-do-estoque']] as const;

function invalidarGiro(): void {
  for (const chave of CHAVES_GIRO) {
    queryClient.invalidateQueries({ queryKey: chave });
  }
}

function invalidarRelatorios(): void {
  for (const chave of CHAVES_RELATORIO) {
    queryClient.invalidateQueries({ queryKey: chave });
  }
}

/**
 * Depois de vender (ou cancelar), o que estava na tela mudou: saldo, lista de vendas,
 * caixa do dia e os relatórios. Sem invalidar os relatórios, o admin registra três vendas,
 * volta para a aba Financeiro e continua vendo o resultado de antes.
 */
export function invalidarAposVenda(): void {
  queryClient.invalidateQueries({ queryKey: chaves.saldos });
  queryClient.invalidateQueries({ queryKey: chaves.vendas });
  queryClient.invalidateQueries({ queryKey: chaves.produtos });
  queryClient.invalidateQueries({ queryKey: chaves.movimentacoes });
  queryClient.invalidateQueries({ queryKey: ['caixa-dia'] });
  queryClient.invalidateQueries({ queryKey: chaves.estoqueBaixo });
  // Venda no fiado mexe na dívida da cliente: sem isto, a segunda venda fiado seguida
  // mostraria o saldo antigo no seletor — e poderia não disparar o aviso de limite.
  queryClient.invalidateQueries({ queryKey: chaves.clientes });
  invalidarRelatorios();
  invalidarGiro();
}

/**
 * Abrir ou fechar condicional mexe no saldo; fechar com venda mexe também em vendas, caixa,
 * fiado e relatórios — é uma venda comum (ADR-39).
 */
export function invalidarAposCondicional(): void {
  queryClient.invalidateQueries({ queryKey: chaves.condicionais });
  invalidarAposVenda();
}

export function invalidarAposMovimentoEstoque(): void {
  queryClient.invalidateQueries({ queryKey: chaves.saldos });
  queryClient.invalidateQueries({ queryKey: chaves.produtos });
  queryClient.invalidateQueries({ queryKey: chaves.movimentacoes });
  queryClient.invalidateQueries({ queryKey: chaves.estoqueBaixo });
  invalidarGiro();
}

/** Despesa entra no resultado do mês: a lista sozinha não basta. */
export function invalidarAposDespesa(): void {
  queryClient.invalidateQueries({ queryKey: chaves.despesas });
  invalidarRelatorios();
}

/**
 * Devolver mexe em quase tudo: o estoque volta (quando a peça volta), o dinheiro sai da
 * gaveta e o faturamento do dia encolhe. A venda em si muda de cara — passa a mostrar o
 * que foi devolvido —, então a chave dela também cai.
 */
export function invalidarAposDevolucao(vendaId: number): void {
  queryClient.invalidateQueries({ queryKey: chaves.venda(vendaId) });
  queryClient.invalidateQueries({ queryKey: chaves.devolucoesDaVenda(vendaId) });
  queryClient.invalidateQueries({ queryKey: chaves.vendas });
  queryClient.invalidateQueries({ queryKey: chaves.saldos });
  queryClient.invalidateQueries({ queryKey: chaves.produtos });
  queryClient.invalidateQueries({ queryKey: chaves.movimentacoes });
  queryClient.invalidateQueries({ queryKey: chaves.estoqueBaixo });
  queryClient.invalidateQueries({ queryKey: ['caixa-dia'] });
  // A devolução pode ter abatido fiado: o saldo da cliente mudou junto.
  queryClient.invalidateQueries({ queryKey: chaves.clientes });
  invalidarRelatorios();
  invalidarGiro();
}

/**
 * Fiado recebido é dinheiro que entrou na gaveta hoje — mas não é faturamento de hoje
 * (a venda já foi contada no dia dela). Por isso o caixa cai e os relatórios também: o
 * resumo mostra "recebimentos de fiado" separado do faturamento.
 */
export function invalidarAposCrediario(): void {
  // `['clientes']` é prefixo de `['clientes', id]` e `['clientes', id, 'extrato']`: uma
  // invalidação derruba a lista, o cliente e o extrato dele.
  queryClient.invalidateQueries({ queryKey: chaves.clientes });
  queryClient.invalidateQueries({ queryKey: ['caixa-dia'] });
  invalidarRelatorios();
}
