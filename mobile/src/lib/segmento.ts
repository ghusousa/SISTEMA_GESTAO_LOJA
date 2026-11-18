/**
 * Quem é esta loja e as palavras que o ramo dela traz.
 *
 * **Espelho de `api/app/core/segmentos.py` e de `web/js/loja.js` — mudou um, mude os
 * três.** O servidor manda o vocabulário pronto em `GET /configuracao`; a tabela daqui é
 * a rede de segurança de quando a tela precisa desenhar antes da resposta chegar.
 *
 * Essa rota é a FACHADA, lida sem login: nome, ramo e palavras. Documento, telefone e
 * endereço da loja só saem com sessão, por `GET /configuracao/completa`
 * (`useDadosDaLoja`, em `hooks/useLoja.ts`) — no web, `garantirDadosDaLoja` em `loja.js`.
 */

export const SEGMENTOS = [
  'ROUPAS',
  'CALCADOS',
  'AUTOPECAS',
  'INFORMATICA',
  'COSMETICOS',
  'ALIMENTOS',
  'CONSTRUCAO',
  'OUTRO',
] as const;

export type Segmento = (typeof SEGMENTOS)[number];

export interface Vocabulario {
  icone: string;
  exemplo_produto: string;
  item: string;
  itens: string;
  artigo: string;
  eixo1: string;
  eixo1_exemplos: string;
  /** Atalhos do cadastro em grade; vazio quando o eixo não tem valores previsíveis. */
  eixo1_rapidos: string[];
  eixo2: string;
  eixo2_exemplos: string;
}

/** Usado enquanto a resposta não chega e quando o ramo é desconhecido. */
export const NEUTRO: Vocabulario = {
  icone: '🏪',
  exemplo_produto: 'Nome do produto',
  item: 'produto',
  itens: 'produtos',
  artigo: 'o',
  eixo1: 'Variação',
  eixo1_exemplos: 'Único, A, B',
  eixo1_rapidos: [],
  eixo2: 'Tipo',
  eixo2_exemplos: 'Padrão',
};

export const ROTULOS: Record<Segmento, string> = {
  ROUPAS: 'Roupas e confecção',
  CALCADOS: 'Calçados',
  AUTOPECAS: 'Peças de carro e moto',
  INFORMATICA: 'Informática e eletrônicos',
  COSMETICOS: 'Cosméticos e perfumaria',
  ALIMENTOS: 'Alimentos e mercearia',
  CONSTRUCAO: 'Material de construção',
  OUTRO: 'Outro ramo',
};

/** Primeira letra maiúscula, para o rótulo do campo ficar de gente. */
export function maiuscula(texto: string): string {
  return texto ? texto[0].toUpperCase() + texto.slice(1) : '';
}
