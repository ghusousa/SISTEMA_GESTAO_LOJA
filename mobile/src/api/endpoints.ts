/**
 * Uma função por operação da API. Nenhuma tela monta URL ou corpo na mão — quando o
 * contrato muda, muda aqui, e o TypeScript aponta quem precisa acompanhar.
 */

import { api } from './client';
import type {
  ConfiguracaoLoja,
  Categoria,
  CategoriaDespesa,
  Despesa,
  DespesaPorCategoria,
  DiaCaixa,
  DiaVenda,
  Entrada,
  EstoqueBaixo,
  Fechamento,
  FormaPagamento,
  InventarioResultado,
  MaisVendido,
  Movimento,
  Pagina,
  Produto,
  Replicacao,
  ResumoFinanceiro,
  Saldo,
  TipoMovimento,
  Tokens,
  Usuario,
  Auditoria,
  Cliente,
  Devolucao,
  ExtratoCliente,
  PagamentoCliente,
  Vale,
  Variante,
  VarianteLookup,
  Versao,
  Venda,
  VendaResumo,
} from './tipos';

interface Paginado {
  page?: number;
  size?: number;
}

// ------------------------------------------------------------------ auth
export const auth = {
  async login(email: string, senha: string): Promise<Tokens> {
    const { data } = await api.post<Tokens>('/auth/login', { email, senha });
    return data;
  },
  async logout(refresh_token: string): Promise<void> {
    await api.post('/auth/logout', { refresh_token });
  },
  async eu(): Promise<Usuario> {
    const { data } = await api.get<Usuario>('/auth/me');
    return data;
  },
};

// ------------------------------------------------------------------ usuários
export const usuarios = {
  async listar(params: Paginado & { q?: string; papel?: string; ativo?: boolean } = {}) {
    const { data } = await api.get<Pagina<Usuario>>('/usuarios', { params });
    return data;
  },
  async criar(dados: { nome: string; email: string; senha: string; papel: string }) {
    const { data } = await api.post<Usuario>('/usuarios', dados);
    return data;
  },
  async atualizar(id: number, dados: { nome?: string; papel?: string; ativo?: boolean }) {
    const { data } = await api.patch<Usuario>(`/usuarios/${id}`, dados);
    return data;
  },
  async redefinirSenha(id: number, nova_senha: string) {
    await api.patch(`/usuarios/${id}/senha`, { nova_senha });
  },
  async trocarMinhaSenha(senha_atual: string, nova_senha: string) {
    await api.patch('/usuarios/me/senha', { senha_atual, nova_senha });
  },
};

// ------------------------------------------------------------------ catálogo
export const sistema = {
  /** Que versão está instalada no servidor, e se existe coisa nova esperando. */
  async versao() {
    const { data } = await api.get<Versao>('/versao');
    return data;
  },
  /**
   * Quem é esta loja. Lida SEM sessão de propósito: a tela de entrada mostra o nome
   * antes de alguém digitar senha, e é assim que dá para conferir que o aparelho está
   * falando com o servidor da loja certa.
   */
  async configuracao() {
    const { data } = await api.get<ConfiguracaoLoja>('/configuracao');
    return data;
  },
  /** Os ramos que o sistema conhece, para a tela montar o seletor sem lista própria. */
  async segmentos() {
    const { data } = await api.get<
      { valor: string; rotulo: string; eixo1: string; eixo2: string }[]
    >('/configuracao/segmentos');
    return data;
  },
  /** Só o dono (`CONFIGURAR_LOJA`). */
  async salvarConfiguracao(dados: Partial<
    Pick<ConfiguracaoLoja, 'nome' | 'segmento' | 'documento' | 'telefone' | 'endereco'>
  >) {
    const { data } = await api.patch<ConfiguracaoLoja>('/configuracao', dados);
    return data;
  },
};

export const catalogo = {
  async categorias(params: Paginado & { q?: string } = { size: 100 }) {
    const { data } = await api.get<Pagina<Categoria>>('/categorias', { params });
    return data;
  },
  async criarCategoria(nome: string) {
    const { data } = await api.post<Categoria>('/categorias', { nome });
    return data;
  },
  async renomearCategoria(id: number, nome: string) {
    const { data } = await api.patch<Categoria>(`/categorias/${id}`, { nome });
    return data;
  },
  async excluirCategoria(id: number) {
    await api.delete(`/categorias/${id}`);
  },

  async produtos(params: Paginado & { q?: string; categoria_id?: number } = {}) {
    const { data } = await api.get<Pagina<Produto>>('/produtos', { params });
    return data;
  },
  async produto(id: number) {
    const { data } = await api.get<Produto>(`/produtos/${id}`);
    return data;
  },
  async criarProduto(dados: {
    categoria_id: number;
    nome: string;
    descricao?: string | null;
    variantes: VariantePayload[];
  }) {
    const { data } = await api.post<Produto>('/produtos', dados);
    return data;
  },
  async atualizarProduto(
    id: number,
    dados: { categoria_id?: number; nome?: string; descricao?: string | null },
  ) {
    const { data } = await api.patch<Produto>(`/produtos/${id}`, dados);
    return data;
  },
  async excluirProduto(id: number) {
    await api.delete(`/produtos/${id}`);
  },
  async adicionarVariante(produtoId: number, variante: VariantePayload) {
    const { data } = await api.post<Produto>(`/produtos/${produtoId}/variantes`, variante);
    return data;
  },
  async atualizarVariante(
    id: number,
    dados: {
      tamanho?: string;
      cor?: string;
      codigo_barras?: string;
      preco_custo?: string;
      preco_venda?: string;
      estoque_minimo?: number;
    },
  ) {
    const { data } = await api.patch<Variante>(`/variantes/${id}`, dados);
    return data;
  },
  async excluirVariante(id: number) {
    await api.delete(`/variantes/${id}`);
  },
  /**
   * Peças pelo NOME (ou pelo código). Existe para a mercadoria que chega sem a nossa
   * etiqueta colada — ver `components/BuscarPeca.tsx`.
   */
  async buscarVariantes(q: string) {
    const { data } = await api.get<Pagina<Variante>>('/variantes', { params: { q, size: 20 } });
    return data;
  },
  async porCodigoBarras(codigo: string) {
    const { data } = await api.get<VarianteLookup>(
      `/variantes/codigo-barras/${encodeURIComponent(codigo)}`,
    );
    return data;
  },
  async gerarCodigoInterno() {
    const { data } = await api.post<{ codigo: string; tipo: string }>(
      '/variantes/gerar-codigo-interno',
    );
    return data.codigo;
  },
  async enviarFoto(produtoId: number, arquivo: { uri: string; nome: string; tipo: string }) {
    const form = new FormData();
    // O React Native aceita este formato de "arquivo" no FormData.
    form.append('arquivo', {
      uri: arquivo.uri,
      name: arquivo.nome,
      type: arquivo.tipo,
    } as unknown as Blob);
    const { data } = await api.put<Produto>(`/produtos/${produtoId}/foto`, form, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
    return data;
  },
};

export interface VariantePayload {
  tamanho: string;
  cor: string;
  codigo_barras?: string | null;
  preco_custo: string;
  preco_venda: string;
  estoque_minimo?: number;
  estoque_inicial?: number;
}

// ------------------------------------------------------------------ estoque
export const estoque = {
  async saldos(
    params: Paginado & { q?: string; categoria_id?: number; somente_baixo?: boolean } = {},
  ) {
    const { data } = await api.get<Pagina<Saldo>>('/estoque/saldos', { params });
    return data;
  },
  async movimentacoes(
    params: Paginado & { variante_id?: number; tipo?: TipoMovimento } = {},
  ) {
    const { data } = await api.get<Pagina<Movimento>>('/estoque/movimentacoes', { params });
    return data;
  },
  async registrarEntrada(dados: {
    client_uuid: string;
    fornecedor?: string | null;
    observacao?: string | null;
    itens: { variante_id: number; quantidade: number; custo_unitario?: string }[];
  }) {
    const { data } = await api.post<Entrada>('/estoque/entradas', dados);
    return data;
  },
  async ajustar(dados: { variante_id: number; quantidade: number; motivo: string }) {
    const { data } = await api.post<Movimento>('/estoque/ajustes', dados);
    return data;
  },
  async inventariar(dados: {
    observacao?: string | null;
    contagens: { variante_id: number; quantidade_contada: number }[];
  }) {
    const { data } = await api.post<InventarioResultado>('/estoque/inventarios', dados);
    return data;
  },
};

// ------------------------------------------------------------------ vendas
export const vendas = {
  async registrar(dados: {
    client_uuid: string;
    desconto?: string;
    observacao?: string | null;
    cliente_id?: number | null;
    itens: { variante_id: number; quantidade: number }[];
    pagamentos: { forma: FormaPagamento; valor: string; codigo_vale?: string }[];
  }) {
    const { data } = await api.post<Venda>('/vendas', dados);
    return data;
  },
  async listar(
    params: Paginado & {
      inicio?: string;
      fim?: string;
      status?: string;
      /** Só vendas que levaram esta peça — é o caminho da devolução no balcão. */
      variante_id?: number;
      cliente_id?: number;
    } = {},
  ) {
    const { data } = await api.get<Pagina<VendaResumo>>('/vendas', { params });
    return data;
  },
  async detalhe(id: number) {
    const { data } = await api.get<Venda>(`/vendas/${id}`);
    return data;
  },
  async cancelar(id: number, motivo: string) {
    const { data } = await api.post<Venda>(`/vendas/${id}/cancelamento`, { motivo });
    return data;
  },
  async devolver(
    vendaId: number,
    dados: {
      client_uuid: string;
      motivo?: string | null;
      itens: { item_id: number; quantidade: number; voltar_ao_estoque?: boolean }[];
    },
  ) {
    const { data } = await api.post<Devolucao>(`/vendas/${vendaId}/devolucoes`, dados);
    return data;
  },
  async devolucoesDaVenda(vendaId: number) {
    const { data } = await api.get<Devolucao[]>(`/vendas/${vendaId}/devolucoes`);
    return data;
  },
  async consultarVale(codigo: string) {
    const { data } = await api.get<Vale>(`/vendas/vales/${encodeURIComponent(codigo)}`);
    return data;
  },
};

export const auditoria = {
  async listar(
    params: Paginado & {
      usuario_id?: number;
      acao?: string;
      inicio?: string;
      fim?: string;
    } = {},
  ) {
    const { data } = await api.get<Pagina<Auditoria>>('/auditoria', { params });
    return data;
  },
};

export const clientes = {
  async listar(params: Paginado & { q?: string; somente_devendo?: boolean } = {}) {
    const { data } = await api.get<Pagina<Cliente>>('/clientes', { params });
    return data;
  },
  async criar(dados: {
    nome: string;
    telefone?: string | null;
    documento?: string | null;
    /** Limite combinado, string decimal. Avisa na venda, nunca bloqueia (ADR-20). */
    limite?: string | null;
  }) {
    const { data } = await api.post<Cliente>('/clientes', dados);
    return data;
  },
  async detalhe(id: number) {
    const { data } = await api.get<Cliente>(`/clientes/${id}`);
    return data;
  },
  async extrato(id: number) {
    const { data } = await api.get<ExtratoCliente>(`/clientes/${id}/extrato`);
    return data;
  },
  async receber(
    id: number,
    dados: { forma: FormaPagamento; valor: string; client_uuid: string; observacao?: string | null },
  ) {
    const { data } = await api.post<PagamentoCliente>(`/clientes/${id}/pagamentos`, dados);
    return data;
  },
};

// ------------------------------------------------------------------ despesas
export const despesas = {
  async categorias(params: Paginado = { size: 100 }) {
    const { data } = await api.get<Pagina<CategoriaDespesa>>('/despesas/categorias', {
      params,
    });
    return data;
  },
  async criarCategoria(nome: string) {
    const { data } = await api.post<CategoriaDespesa>('/despesas/categorias', { nome });
    return data;
  },
  async excluirCategoria(id: number) {
    await api.delete(`/despesas/categorias/${id}`);
  },
  async listar(
    params: Paginado & {
      inicio?: string;
      fim?: string;
      categoria_id?: number;
      recorrente?: boolean;
    } = {},
  ) {
    const { data } = await api.get<Pagina<Despesa>>('/despesas', { params });
    return data;
  },
  async criar(dados: {
    categoria_id: number;
    descricao: string;
    valor: string;
    data: string;
    recorrente?: boolean;
    observacao?: string | null;
  }) {
    const { data } = await api.post<Despesa>('/despesas', dados);
    return data;
  },
  async excluir(id: number) {
    await api.delete(`/despesas/${id}`);
  },
  async replicarRecorrentes(competencia: string) {
    const { data } = await api.post<Replicacao>('/despesas/replicar-recorrentes', null, {
      params: { competencia },
    });
    return data;
  },
};

// ------------------------------------------------------------------ caixa
export const caixa = {
  async dia(data?: string) {
    const resposta = await api.get<DiaCaixa>('/caixa/dia', { params: { data } });
    return resposta.data;
  },
  async fechar(dados: {
    data: string;
    contagens: { forma: FormaPagamento; valor_contado: string }[];
    observacao?: string | null;
  }) {
    const { data } = await api.post<Fechamento>('/caixa/fechamentos', dados);
    return data;
  },
  async fechamentos(params: Paginado & { inicio?: string; fim?: string } = {}) {
    const { data } = await api.get<Pagina<Fechamento>>('/caixa/fechamentos', { params });
    return data;
  },
};

// ------------------------------------------------------------------ relatórios
export const relatorios = {
  async resumo(inicio: string, fim: string) {
    const { data } = await api.get<ResumoFinanceiro>('/relatorios/resumo', {
      params: { inicio, fim },
    });
    return data;
  },
  async vendasPorDia(inicio: string, fim: string) {
    const { data } = await api.get<DiaVenda[]>('/relatorios/vendas-por-dia', {
      params: { inicio, fim },
    });
    return data;
  },
  async maisVendidos(inicio: string, fim: string, limite = 10) {
    const { data } = await api.get<MaisVendido[]>('/relatorios/mais-vendidos', {
      params: { inicio, fim, limite },
    });
    return data;
  },
  async despesasPorCategoria(inicio: string, fim: string) {
    const { data } = await api.get<DespesaPorCategoria[]>(
      '/relatorios/despesas-por-categoria',
      { params: { inicio, fim } },
    );
    return data;
  },
  async estoqueBaixo() {
    const { data } = await api.get<EstoqueBaixo[]>('/relatorios/estoque-baixo');
    return data;
  },
};
