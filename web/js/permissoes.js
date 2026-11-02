/**
 * Quem pode o quê, no navegador.
 *
 * **Espelho de `api/app/core/permissoes.py` — mudou lá, mude aqui.** As duas tabelas
 * precisam bater, mas não pelo motivo que parece: quem recusa de verdade é o servidor.
 * Isto aqui existe para a tela não oferecer um botão que vai dar 403 na cara da pessoa.
 *
 * Se um dia divergirem, o pior que acontece é uma tela sumir ou um botão dar erro — nunca
 * um dado a mais chegando a quem não pode vê-lo, porque o dado nem sai da API.
 */

import { sessao } from './store.js';

export const PODE = {
  VER_DINHEIRO: 'VER_DINHEIRO',
  LANCAR_DESPESA: 'LANCAR_DESPESA',
  CANCELAR_VENDA: 'CANCELAR_VENDA',
  DEVOLVER_VENDA: 'DEVOLVER_VENDA',
  GERIR_CREDIARIO: 'GERIR_CREDIARIO',
  ATENDER_CLIENTE: 'ATENDER_CLIENTE',
  FAZER_CONDICIONAL: 'FAZER_CONDICIONAL',
  VER_VENDAS_DE_TODOS: 'VER_VENDAS_DE_TODOS',
  CORRIGIR_ESTOQUE: 'CORRIGIR_ESTOQUE',
  EDITAR_CATALOGO: 'EDITAR_CATALOGO',
  FECHAR_CAIXA: 'FECHAR_CAIXA',
  GERIR_USUARIOS: 'GERIR_USUARIOS',
  VER_AUDITORIA: 'VER_AUDITORIA',
  CONFIGURAR_LOJA: 'CONFIGURAR_LOJA',
  GERIR_BACKUP: 'GERIR_BACKUP',
  DEFINIR_COMISSAO: 'DEFINIR_COMISSAO',
};

const VENDEDORA = [PODE.ATENDER_CLIENTE, PODE.FAZER_CONDICIONAL];
const SUPERVISORA = [
  ...VENDEDORA,
  PODE.VER_VENDAS_DE_TODOS,
  PODE.CORRIGIR_ESTOQUE,
  PODE.EDITAR_CATALOGO,
  PODE.FECHAR_CAIXA,
];
const GERENTE = [
  ...SUPERVISORA,
  PODE.VER_DINHEIRO,
  PODE.LANCAR_DESPESA,
  PODE.CANCELAR_VENDA,
  PODE.DEVOLVER_VENDA,
  PODE.GERIR_CREDIARIO,
  PODE.GERIR_USUARIOS,
];
const DONO = Object.values(PODE);

const PERMISSOES = {
  ADMIN: DONO,
  GERENTE,
  SUPERVISORA,
  VENDEDOR: VENDEDORA,
};

/** Como o cargo aparece na tela. Os valores gravados são históricos (ver o modelo). */
export const TITULO = {
  ADMIN: 'Dono',
  GERENTE: 'Gerente',
  SUPERVISORA: 'Supervisora',
  VENDEDOR: 'Vendedora',
};

export const PAPEIS = ['ADMIN', 'GERENTE', 'SUPERVISORA', 'VENDEDOR'];

/** Papel desconhecido não recebe nada — falha fechada, igual ao servidor. */
export function papelPode(papel, capacidade) {
  return (PERMISSOES[papel] ?? VENDEDORA).includes(capacidade);
}

/** A pergunta do dia a dia: quem está logado pode isto? */
export function pode(capacidade) {
  return papelPode(sessao.get().usuario?.papel, capacidade);
}

export const titulo = (papel) => TITULO[papel] ?? papel;

/** O que cada capacidade significa para quem está lendo a tela. */
const EM_PORTUGUES = {
  [PODE.VER_DINHEIRO]: 'ver custo, lucro e margem',
  [PODE.LANCAR_DESPESA]: 'lançar despesas',
  [PODE.CANCELAR_VENDA]: 'cancelar venda concluída',
  [PODE.ATENDER_CLIENTE]: 'buscar e cadastrar cliente no balcão',
  [PODE.FAZER_CONDICIONAL]: 'levar peça em condicional para a cliente provar',
  [PODE.VER_VENDAS_DE_TODOS]: 'ver as vendas de toda a equipe',
  [PODE.CORRIGIR_ESTOQUE]: 'ajustar estoque e fazer inventário',
  [PODE.EDITAR_CATALOGO]: 'editar e excluir produtos e categorias',
  [PODE.FECHAR_CAIXA]: 'conferir e fechar o caixa do dia',
  [PODE.GERIR_USUARIOS]: 'administrar os logins da equipe',
  [PODE.VER_AUDITORIA]: 'ver o diário de auditoria',
  [PODE.CONFIGURAR_LOJA]: 'mudar o nome e o ramo da loja',
  [PODE.GERIR_BACKUP]: 'ligar e configurar o backup na nuvem',
  [PODE.DEFINIR_COMISSAO]: 'definir a comissão e a meta do dia da equipe',
};

/** Sempre aberto a quem entrou: é disto que o balcão vive. */
export const BASE = [
  'vender no PDV',
  'bipar código de barras e consultar preço',
  'cadastrar peça nova',
  'dar entrada de mercadoria',
];

/** Lista, em português, tudo o que um papel faz — para a pessoa ler na própria conta. */
export function resumoDoPapel(papel) {
  const extras = (PERMISSOES[papel] ?? VENDEDORA).map((c) => EM_PORTUGUES[c]).filter(Boolean);
  return [...BASE, ...extras];
}
