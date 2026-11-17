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
  | 'DEVOLUCAO'
  /** Foi para a casa da cliente provar (ADR-39): saiu do disponível, não foi vendida. */
  | 'CONDICIONAL_SAIDA'
  /** A condicional fechou e a peça voltou; o que ficou sai logo depois como VENDA. */
  | 'CONDICIONAL_RETORNO';
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
  /** % sobre o faturamento líquido ("2.50"). Opcional: servidor antigo não manda (ADR-37). */
  comissao_percentual?: string;
  /** Meta de venda do dia; `null` = sem meta. */
  meta_diaria?: string | null;
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
  /** Dados fiscais da NFC-e (ADR-41). NCM nulo = a nota com esta peça não sai. */
  ncm: string | null;
  cest: string | null;
  origem: number;
  cfop: string;
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
  condicional_id?: number | null;
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
  /** Quantas parcelas da nota viraram contas a pagar (ADR-40). */
  contas_a_pagar?: number;
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
  /**
   * Taxas da maquininha no período, já descontadas do `resultado`. Opcional de propósito:
   * servidor sem o cálculo de taxas não manda o campo, e a linha some da tela.
   */
  taxas_cartao?: string;
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

/** Uma pessoa da equipe no período, devoluções já abatidas (ADR-37). */
export interface Vendedora {
  usuario_id: number;
  nome: string;
  comissao_percentual: string;
  quantidade_vendas: number;
  faturamento: string;
  devolucoes: string;
  /** Base da comissão. Pode ser negativo num período só de devoluções (estorno). */
  faturamento_liquido: string;
  pecas: number;
  ticket_medio: string;
  comissao: string;
}

/** A página e os totais do período INTEIRO (a folha soma a equipe toda). */
export interface PaginaVendedoras extends Pagina<Vendedora> {
  faturamento_liquido_total: string;
  comissao_total: string;
}

/** O placar de hoje de quem está logado: sem custo, lucro nem comissão. */
export interface MeuDia {
  data: string;
  vendido: string;
  quantidade_vendas: number;
  pecas: number;
  meta: string | null;
  falta: string | null;
}

export interface EstoqueParado {
  variante_id: number;
  produto_id: number;
  produto: string;
  tamanho: string;
  cor: string;
  codigo_barras: string;
  saldo: number;
  ultima_venda: string | null;
  ultima_entrada: string | null;
  dias_parada: number;
  preco_custo: string;
  preco_venda: string;
  valor_em_custo: string;
  valor_em_venda: string;
}

/** Os totais valem para TODAS as peças paradas, não só para a página. */
export interface PaginaEstoqueParado extends Pagina<EstoqueParado> {
  dias: number;
  pecas_total: number;
  valor_em_custo_total: string;
  valor_em_venda_total: string;
}

export type ClasseAbc = 'A' | 'B' | 'C';

export interface CurvaAbc {
  produto_id: number;
  produto: string;
  pecas: number;
  faturamento_liquido: string;
  percentual: string;
  percentual_acumulado: string;
  classe: ClasseAbc;
}

/** A arara inteira, agora. */
export interface ValorEstoque {
  pecas: number;
  variantes: number;
  valor_em_custo: string;
  valor_em_venda: string;
}

/** Um dia da agenda "a receber do cartão" (ADR da taxa de cartão). */
export interface Recebivel {
  data: string;
  bruto: string;
  taxa: string;
  liquido: string;
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
  /** Fuso da loja (IANA). Opcional: servidor antigo não manda, e aí vale São Paulo. */
  timezone?: string;
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
  /** NFC-e (ADR-41): 1 Simples Nacional · 2 Simples, excesso de sublimite · 3 Normal. */
  regime_tributario: number | null;
  inscricao_estadual: string | null;
  serie_nfce: number;
}

// ------------------------------------------------------------------ NFC-e (ADR-41)
export type StatusNota = 'PENDENTE' | 'AUTORIZADA' | 'REJEITADA' | 'CANCELADA';
export type AmbienteFiscal = 'homologacao' | 'producao';

/** O emissor ligado no `.env` do servidor. O token nunca vem — só se ele existe. */
export interface EmissorFiscal {
  nome: string;
  ambiente: AmbienteFiscal | null;
  configurado: boolean;
  faltando: string[];
  emitir_automatico: boolean;
}

export interface NotaFiscal {
  id: number;
  venda_id: number;
  status: StatusNota;
  ambiente: AmbienteFiscal;
  emissor: string;
  referencia: string;
  numero: number | null;
  serie: number | null;
  chave: string | null;
  protocolo: string | null;
  url_danfe: string | null;
  url_xml: string | null;
  mensagem: string | null;
  tentativas: number;
  autorizada_em: string | null;
  cancelada_em: string | null;
  criada_em: string;
  atualizada_em: string;
}

/** `GET /vendas/{id}/nfce`: a nota (se já houve tentativa) e o emissor. */
export interface Nfce {
  venda_id: number;
  emissor: EmissorFiscal;
  nota: NotaFiscal | null;
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

// ------------------------------------------------------------------ condicional (ADR-39)
export type StatusCondicional = 'ABERTA' | 'FECHADA';
export type FiltroCondicionais = 'abertas' | 'vencidas' | 'fechadas' | 'todas';

export interface ItemCondicional {
  variante_id: number;
  produto: string;
  tamanho: string;
  cor: string;
  codigo_barras: string;
  /** Preço de venda de HOJE: é por ele que o que ficar será cobrado. */
  preco_venda: string;
  quantidade: number;
  devolvida: number | null;
  ficou: number | null;
}

export interface Condicional {
  id: number;
  status: StatusCondicional;
  cliente_id: number;
  cliente: string;
  cliente_telefone: string | null;
  vendedora_id: number;
  vendedora: string;
  prazo: string;
  vencida: boolean;
  dias_para_vencer: number;
  observacao: string | null;
  criada_em: string;
  fechada_em: string | null;
  fechada_por: string | null;
  venda_id: number | null;
  itens: ItemCondicional[];
  total_pecas: number;
  valor_pecas: string;
}

/** A cliente como o balcão a enxerga (`GET /clientes/balcao`, frente B1): sem saldo. */
export interface ClienteDoBalcao {
  id: number;
  nome: string;
  telefone: string | null;
}

// ------------------------------------------------------------------ contas a pagar (ADR-40)
export type FormaPagamentoConta = 'BOLETO' | 'PIX' | 'TRANSFERENCIA' | 'DINHEIRO' | 'CARTAO';
export type SituacaoConta = 'ABERTA' | 'VENCIDA' | 'PAGA';
export type FiltroContas = 'abertas' | 'vencidas' | 'proximos_7_dias' | 'pagas' | 'todas';

export interface ContaPagar {
  id: number;
  fornecedor: string;
  descricao: string;
  numero_nota: string | null;
  valor: string;
  vencimento: string;
  parcela: number;
  parcelas: number;
  situacao: SituacaoConta;
  dias_para_vencer: number;
  paga_em: string | null;
  forma_pagamento: FormaPagamentoConta | null;
  entrada_id: number | null;
  observacao: string | null;
  ativo: boolean;
  criada_em: string;
}

export interface FaixaContas {
  quantidade: number;
  valor: string;
}

export interface ResumoContas {
  hoje: string;
  vencidas: FaixaContas;
  proximos_7_dias: FaixaContas;
  em_aberto: FaixaContas;
}

/** A nota do fornecedor como a API recebe: dinheiro em string decimal. */
export interface NotaFornecedor {
  numero: string | null;
  valor_total: string;
  parcelas: { vencimento: string; valor: string }[];
}

// ------------------------------------------------------------------ leitor pelo celular (ADR-43)

/** Calculado no servidor (nunca coluna): ver `lib/leitorRemoto.ts`. */
export type StatusPareamento = 'AGUARDANDO' | 'ATIVO' | 'EXPIRADO' | 'ENCERRADO';

export type MotivoEncerramento = 'COMPUTADOR' | 'CELULAR' | 'TROCOU' | 'SUBSTITUIDO';

/** Um computador e o celular que bipa para ele. Datas em ISO UTC. */
export interface Pareamento {
  id: number;
  codigo: string;
  status: StatusPareamento;
  computador_nome: string;
  aparelho_nome: string | null;
  criado_em: string;
  codigo_expira_em: string;
  aceito_em: string | null;
  /** Aceite + 12 h, fixo: não desliza com o uso. */
  expira_em: string | null;
  encerrado_em: string | null;
  motivo_encerramento: MotivoEncerramento | null;
}

export interface BipeEnviado {
  id: number;
  client_uuid: string;
  pareamento_id: number;
  codigo: string;
  criado_em: string;
}

/** O lote que o computador retira (até 50). Não é listagem paginada: é uma fila. */
export interface BipesRetirados {
  items: { id: number; codigo: string; criado_em: string }[];
  /** Pendentes velhos demais (ou de leitor já desligado): marcados, não entregues. */
  descartados: number;
  pareamento: Pareamento;
}
