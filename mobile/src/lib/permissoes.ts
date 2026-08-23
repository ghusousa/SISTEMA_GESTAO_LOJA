/**
 * Quem pode o quê, no aparelho.
 *
 * **Espelho de `api/app/core/permissoes.py` — mudou lá, mude aqui** (e em
 * `web/js/permissoes.js`, que é o mesmo espelho do outro lado). As três tabelas precisam
 * bater, mas não é daqui que vem a segurança: quem recusa é o servidor, e o dado que a
 * vendedora não pode ver nem sai da API. Isto existe para o app não desenhar uma aba que
 * responderia 403 no primeiro toque.
 */

import type { Papel } from '@/api/tipos';

export const PODE = {
  VER_DINHEIRO: 'VER_DINHEIRO',
  LANCAR_DESPESA: 'LANCAR_DESPESA',
  CANCELAR_VENDA: 'CANCELAR_VENDA',
  VER_VENDAS_DE_TODOS: 'VER_VENDAS_DE_TODOS',
  CORRIGIR_ESTOQUE: 'CORRIGIR_ESTOQUE',
  EDITAR_CATALOGO: 'EDITAR_CATALOGO',
  FECHAR_CAIXA: 'FECHAR_CAIXA',
  GERIR_USUARIOS: 'GERIR_USUARIOS',
} as const;

export type Capacidade = (typeof PODE)[keyof typeof PODE];

const VENDEDORA: Capacidade[] = [];

const SUPERVISORA: Capacidade[] = [
  ...VENDEDORA,
  PODE.VER_VENDAS_DE_TODOS,
  PODE.CORRIGIR_ESTOQUE,
  PODE.EDITAR_CATALOGO,
  PODE.FECHAR_CAIXA,
];

const GERENTE: Capacidade[] = [
  ...SUPERVISORA,
  PODE.VER_DINHEIRO,
  PODE.LANCAR_DESPESA,
  PODE.CANCELAR_VENDA,
  PODE.GERIR_USUARIOS,
];

const DONO: Capacidade[] = Object.values(PODE);

const PERMISSOES: Record<Papel, Capacidade[]> = {
  ADMIN: DONO,
  GERENTE,
  SUPERVISORA,
  VENDEDOR: VENDEDORA,
};

/** Como o cargo aparece na tela. Os valores gravados são históricos (ver o modelo da API). */
export const TITULO: Record<Papel, string> = {
  ADMIN: 'Dono',
  GERENTE: 'Gerente',
  SUPERVISORA: 'Supervisora',
  VENDEDOR: 'Vendedora',
};

export const PAPEIS: Papel[] = ['ADMIN', 'GERENTE', 'SUPERVISORA', 'VENDEDOR'];

/** O que cada cargo faz, em uma linha — para quem escolhe o papel de alguém. */
export const DESCRICAO: Record<Papel, string> = {
  ADMIN: 'Vê e faz tudo.',
  GERENTE:
    'Tudo do chão de loja, mais custo, lucro, despesas, estorno e os logins da equipe.',
  SUPERVISORA:
    'Estoque, catálogo, caixa e as vendas da equipe. Não vê custo nem despesa, e não estorna.',
  VENDEDOR: 'Vende, consulta preço, cadastra peça e dá entrada de mercadoria.',
};

/** Papel desconhecido não recebe nada — falha fechada, igual ao servidor. */
export function pode(papel: Papel | undefined, capacidade: Capacidade): boolean {
  if (!papel) return false;
  return (PERMISSOES[papel] ?? VENDEDORA).includes(capacidade);
}

export const titulo = (papel: Papel | undefined): string =>
  papel ? (TITULO[papel] ?? papel) : '';
