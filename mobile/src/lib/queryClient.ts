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

/** Depois de vender, o que estava na tela mudou: saldo, lista de vendas e caixa do dia. */
export function invalidarAposVenda(): void {
  queryClient.invalidateQueries({ queryKey: chaves.saldos });
  queryClient.invalidateQueries({ queryKey: chaves.vendas });
  queryClient.invalidateQueries({ queryKey: chaves.produtos });
  queryClient.invalidateQueries({ queryKey: chaves.movimentacoes });
  queryClient.invalidateQueries({ queryKey: ['caixa-dia'] });
  queryClient.invalidateQueries({ queryKey: chaves.estoqueBaixo });
}

export function invalidarAposMovimentoEstoque(): void {
  queryClient.invalidateQueries({ queryKey: chaves.saldos });
  queryClient.invalidateQueries({ queryKey: chaves.produtos });
  queryClient.invalidateQueries({ queryKey: chaves.movimentacoes });
  queryClient.invalidateQueries({ queryKey: chaves.estoqueBaixo });
}
