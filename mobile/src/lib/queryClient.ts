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
  usuarios: ['usuarios'] as const,
};

/** Tudo que depende de faturamento, custo ou resultado. */
const CHAVES_RELATORIO = [
  ['relatorio-resumo'],
  ['relatorio-vendas-dia'],
  ['relatorio-mais-vendidos'],
  ['relatorio-despesas'],
] as const;

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
  invalidarRelatorios();
}

export function invalidarAposMovimentoEstoque(): void {
  queryClient.invalidateQueries({ queryKey: chaves.saldos });
  queryClient.invalidateQueries({ queryKey: chaves.produtos });
  queryClient.invalidateQueries({ queryKey: chaves.movimentacoes });
  queryClient.invalidateQueries({ queryKey: chaves.estoqueBaixo });
}

/** Despesa entra no resultado do mês: a lista sozinha não basta. */
export function invalidarAposDespesa(): void {
  queryClient.invalidateQueries({ queryKey: chaves.despesas });
  invalidarRelatorios();
}
