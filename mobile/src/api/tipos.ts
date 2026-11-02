/**
 * Tipos espelhando os schemas Pydantic da API.
 *
 * Regra: valores monetários chegam como STRING decimal ("149.90"). Converta com
 * `paraCentavos` de lib/money no momento em que o dado entra na tela — nunca faça
 * conta com essas strings.
 */

export type Papel = 'ADMIN' | 'GERENTE' | 'SUPERVISORA' | 'VENDEDOR';
export type FormaPagamento = 'DINHEIRO' | 'PIX' | 'DEBITO' | 'CREDITO' | 'VALE' | 'FIADO';

/** O que vira dinheiro NA GAVETA hoje. Vale e fiado não — espelha `FORMAS_DE_GAVETA`
 * da API: o vale foi pago na venda anterior, o fiado ainda nem foi pago. */
export const FORMAS_DE_GAVETA = ['DINHEIRO', 'PIX', 'DEBITO', 'CREDITO'] as const;
export type StatusVenda = 'CONCLUIDA' | 'CANCELADA';
export type TipoMovimento =
  | 'ENTRADA'
  | 'AJUSTE'
  | 'INVENTARIO'
  | 'VENDA'
  | 'ESTORNO'
  /** Peça devolvida pela cliente com a venda continuando de pé (≠ ESTORNO, que é a venda inteira). */
  | 'DEVOLUCAO';
export type TipoCodigo = 'EAN' | 'INTERNO';

export interface Pagina<T> {
  items: T[];
  total: number;
  page: number;
  size: number;
}

export interface ErroApi {
  code: string;
  message: string;
  detail?: Record<string, unknown>;
}

export interface Usuario {
  id: number;
  nome: string;
  email: string;
  papel: Papel;
  ativo: boolean;
  criado_em: string;
}

export interface Tokens {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  usuario: Usuario;
}

export interface Categoria {
  id: number;
  nome: string;
  criada_em: string;
}

export interface Variante {
  id: number;
  produto_id: number;
  /** Nome do produto. Sem ele, uma busca por nome devolveria tamanhos sem dizer de quê. */
  produto: string;
  tamanho: string;
  cor: string;
  codigo_barras: string;
  tipo_codigo: TipoCodigo;
  preco_venda: string;
  estoque_minimo: number;
  saldo: number;
  /** Só chega para ADMIN. */
  preco_custo?: string;
}

export interface Produto {
  id: number;
  nome: string;
  descricao: string | null;
  foto_url: string | null;
  categoria_id: number;
  categoria: string;
  variantes: Variante[];
  saldo_total: number;
}

export interface VarianteLookup {
  variante_id: number;
  produto_id: number;
  produto: string;
  categoria: string;
  tamanho: string;
  cor: string;
  codigo_barras: string;
  preco_venda: string;
  saldo: number;
  foto_url: string | null;
}

export interface Movimento {
  id: number;
  variante_id: number;
  tipo: TipoMovimento;
  quantidade: number;
  saldo_apos: number;
  venda_id: number | null;
  entrada_id: number | null;
  usuario_id: number;
  observacao: string | null;
  criado_em: string;
  produto: string | null;
  tamanho: string | null;
  cor: string | null;
  codigo_barras: string | null;
  usuario: string | null;
}

export interface Saldo {
  variante_id: number;
  produto_id: number;
  produto: string;
  categoria: string;
  tamanho: string;
  cor: string;
  codigo_barras: string;
  preco_venda: string;
  saldo: number;
  estoque_minimo: number;
  estoque_baixo: boolean;
  /** Só para ADMIN. */
  preco_custo?: string;
  valor_em_custo?: string;
}

export interface Entrada {
  id: number;
  fornecedor: string | null;
  observacao: string | null;
  criada_em: string;
  itens: Movimento[];
  total_pecas: number;
}

export interface InventarioDiferenca {
  variante_id: number;
  codigo_barras: string;
  produto: string;
  tamanho: string;
  cor: string;
  saldo_sistema: number;
  quantidade_contada: number;
  diferenca: number;
}

export interface InventarioResultado {
  conferidas: number;
  ajustadas: number;
  diferenca_total: number;
  diferencas: InventarioDiferenca[];
}

export interface ItemVenda {
  id: number;
  variante_id: number;
  produto: string;
  tamanho: string;
  cor: string;
  codigo_barras: string;
  quantidade: number;
  /** Quanto desta linha já voltou — a tela de devolução usa para não oferecer de novo. */
  quantidade_devolvida: number;
  preco_unitario: string;
  total_item: string;
  custo_unitario?: string;
}

export interface Pagamento {
  forma: FormaPagamento;
  valor: string;
  /** Em quantas vezes no crédito; 1 em toda outra forma (ADR-35). */
  parcelas?: number;
  bandeira?: string | null;
  /** Só para quem vê dinheiro: a taxa da maquininha fotografada na venda. */
  taxa_percentual?: string;
  taxa?: string;
}

export interface Venda {
  id: number;
  status: StatusVenda;
  vendedor_id: number;
  vendedor: string;
  subtotal: string;
  desconto: string;
  total: string;
  quantidade_pecas: number;
  vendida_em: string;
  cancelada_em: string | null;
  motivo_cancelamento: string | null;
  observacao: string | null;
  /** Nome de quem comprou, em qualquer venda (ADR-36). Nulo na venda sem nome. */
  cliente: string | null;
  cliente_id: number | null;
  itens: ItemVenda[];
  pagamentos: Pagamento[];
  /** Só para ADMIN. */
  custo_total?: string;
  lucro_bruto?: string;
  /** Só para quem vê dinheiro: soma das taxas da maquininha desta venda. */
  taxas_cartao?: string;
}

export interface VendaResumo {
  id: number;
  status: StatusVenda;
  vendedor: string;
  total: string;
  quantidade_pecas: number;
  vendida_em: string;
  formas_pagamento: FormaPagamento[];
}

export interface CategoriaDespesa {
  id: number;
  nome: string;
  criada_em: string;
}

export interface Despesa {
  id: number;
  categoria_id: number;
  categoria: string;
  descricao: string;
  valor: string;
  data: string;
  competencia: string;
  recorrente: boolean;
  observacao: string | null;
  origem_recorrente_id: number | null;
}

export interface Replicacao {
  competencia: string;
  criadas: number;
  ja_existentes: number;
  valor_total: string;
  despesas: Despesa[];
}

export interface LinhaCaixa {
  forma: FormaPagamento;
  esperado: string;
  contado: string | null;
  diferenca: string | null;
}

export interface DiaCaixa {
  data: string;
  linhas: LinhaCaixa[];
  total_esperado: string;
  quantidade_vendas: number;
  quantidade_canceladas: number;
  fechado: boolean;
  fechamento_id: number | null;
}

export interface Fechamento {
  id: number;
  data: string;
  fechado_por: string;
  fechado_em: string;
  linhas: LinhaCaixa[];
  total_esperado: string;
  total_contado: string;
  diferenca: string;
  observacao: string | null;
}

export interface ResumoFinanceiro {
  inicio: string;
  fim: string;
  faturamento: string;
  custo_mercadoria_vendida: string;
  lucro_bruto: string;
  despesas: string;
  resultado: string;
  margem_bruta_pct: string;
  quantidade_vendas: number;
  quantidade_pecas: number;
  ticket_medio: string;
  vendas_canceladas: number;
}

export interface DiaVenda {
  data: string;
  faturamento: string;
  quantidade_vendas: number;
  quantidade_pecas: number;
}

export interface MaisVendido {
  variante_id: number;
  produto: string;
  tamanho: string;
  cor: string;
  codigo_barras: string;
  quantidade: number;
  faturamento: string;
  lucro_bruto: string;
}

export interface DespesaPorCategoria {
  categoria_id: number;
  categoria: string;
  total: string;
  percentual: string;
  quantidade: number;
}

export interface EstoqueBaixo {
  variante_id: number;
  produto: string;
  tamanho: string;
  cor: string;
  codigo_barras: string;
  saldo: number;
  estoque_minimo: number;
  faltam: number;
  preco_custo: string;
}

/**
 * A versão que está rodando no servidor, e se ela é a mais nova.
 *
 * `resumo` vem pronto do servidor de propósito: é a mesma frase no web e no app, e assim
 * as duas telas não divergem sobre o que "atualizada" quer dizer.
 */
export interface Versao {
  commit: string | null;
  data: string | null;
  conferido_em: string | null;
  atualizada: boolean | null;
  conferido_recente: boolean;
  resumo: string;
}

/* ------------------------------------------------- devolução, vale e fiado */

export interface ItemDevolvido {
  item_id: number;
  variante_id: number;
  produto: string;
  tamanho: string;
  cor: string;
  codigo_barras: string;
  quantidade: number;
  preco_unitario: string;
  valor_devolvido: string;
  voltou_ao_estoque: boolean;
}

export interface PagamentoDevolucao {
  forma: FormaPagamento;
  valor: string;
  /** Preenchido quando a devolução virou vale — é o código que vai no papel. */
  codigo_vale: string | null;
}

export interface Devolucao {
  id: number;
  venda_id: number;
  devolvida_em: string;
  motivo: string | null;
  total: string;
  itens: ItemDevolvido[];
  pagamentos: PagamentoDevolucao[];
}

export interface Vale {
  id: number;
  codigo: string;
  valor: string;
  usado: string;
  saldo: string;
  vence_em: string | null;
}

export interface Cliente {
  id: number;
  nome: string;
  telefone: string | null;
  documento: string | null;
  limite: string | null;
  observacao: string | null;
  ativo: boolean;
  /** Calculado no servidor: não existe coluna guardando isto. */
  deve: string;
  acima_do_limite: boolean;
  /** "1990-03-14" — sem hora, sem fuso. */
  nascimento: string | null;
  preferencias: string | null;
}

/**
 * A cliente vista do BALCÃO (ADR-36): quem ela é e do que gosta. Sem saldo, limite ou
 * observação — o servidor nem manda.
 */
export interface ClienteBalcao {
  id: number;
  nome: string;
  telefone: string | null;
  nascimento: string | null;
  preferencias: string | null;
}

/** Uma linha do contrato com a credenciadora (ADR-35). */
export interface TaxaCartao {
  id: number;
  forma: 'DEBITO' | 'CREDITO';
  parcelas_de: number;
  parcelas_ate: number;
  /** String decimal: "3.19" = 3,19%. */
  percentual: string;
  prazo_dias: number;
}

export interface PagamentoCliente {
  id: number;
  cliente_id: number;
  forma: FormaPagamento;
  valor: string;
  pago_em: string;
  observacao: string | null;
}

export interface VendaEmAberto {
  venda_id: number;
  vendida_em: string;
  total_da_venda: string;
  no_fiado: string;
}

export interface ExtratoCliente {
  cliente: Cliente;
  /**
   * As duas listas andam juntas pelo mesmo `?page=&size=`: a página seguinte traz a próxima
   * leva das duas. Os totais abaixo são da conta inteira, nunca da página.
   */
  vendas: Pagina<VendaEmAberto>;
  pagamentos: Pagina<PagamentoCliente>;
  total_fiado: string;
  total_pago: string;
  total_devolvido: string;
  deve: string;
}

export interface Auditoria {
  id: number;
  usuario_id: number | null;
  /** Congelado no momento do ato — não muda se a pessoa for renomeada depois. */
  usuario: string;
  papel: Papel | null;
  acao: string;
  descricao: string;
  entidade: string | null;
  entidade_id: number | null;
  ip: string | null;
  quando: string;
}

/**
 * Identidade da loja como a porta mostra, SEM login: nome, ramo e as palavras do ramo.
 * Documento e contato não vêm aqui — ver `ConfiguracaoLoja`.
 */
export interface ConfiguracaoPublica {
  nome: string;
  segmento: string;
  vocabulario: {
    icone: string;
    exemplo_produto: string;
    item: string;
    itens: string;
    artigo: string;
    eixo1: string;
    eixo1_exemplos: string;
    eixo1_rapidos: string[];
    eixo2: string;
    eixo2_exemplos: string;
  };
}

/**
 * A configuração inteira, só com sessão (`GET /configuracao/completa`): o recibo imprime
 * documento, endereço e telefone — para MEI, o CPF e o endereço de casa do dono.
 */
export interface ConfiguracaoLoja extends ConfiguracaoPublica {
  documento: string | null;
  telefone: string | null;
  endereco: string | null;
}

/**
 * Backup na nuvem (`GET /backup`, só o dono). O token do Google NUNCA vem: a tela só sabe
 * se ele existe (`configurado`).
 */
export interface Backup {
  ativo: boolean;
  configurado: boolean;
  pasta: string;
  manter: number;
  intervalo_min: number;
  ultimo_em: string | null;
  ultimo_ok: boolean | null;
  ultimo_erro: string | null;
  ultimo_bytes: number | null;
  copias_na_nuvem: number | null;
  /** Ligado e sem cópia nova há mais de 2× o intervalo. Quem decide é o servidor. */
  atrasado: boolean;
}
