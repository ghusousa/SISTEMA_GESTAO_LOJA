/**
 * Quem é esta loja: o nome que aparece na tela e as palavras que o ramo dela traz.
 *
 * **Espelho de `api/app/core/segmentos.py` e de `mobile/src/lib/segmento.ts` — mudou um,
 * mude os três.** O servidor manda o vocabulário pronto em `GET /configuracao`, então a
 * tabela daqui é só a rede de segurança para o momento em que a tela precisa desenhar
 * antes de a resposta chegar (ou quando a API não responde).
 *
 * A configuração é lida SEM login: a tela de entrada mostra o nome da loja antes de
 * existir sessão. Por isso a chamada vive aqui e não no fluxo autenticado.
 */

import { api } from './api.js';
import { definirFusoDaLoja } from './ui.js';

/** O neutro, usado enquanto a resposta não chega e quando o ramo é desconhecido. */
const NEUTRO = {
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

/** Espelho da tabela do servidor. Só para desenhar antes da resposta. */
export const SEGMENTOS = {
  ROUPAS: { rotulo: 'Roupas e confecção', eixo1: 'Tamanho', eixo2: 'Cor' },
  CALCADOS: { rotulo: 'Calçados', eixo1: 'Numeração', eixo2: 'Cor' },
  AUTOPECAS: { rotulo: 'Peças de carro e moto', eixo1: 'Aplicação', eixo2: 'Posição' },
  INFORMATICA: { rotulo: 'Informática e eletrônicos', eixo1: 'Capacidade', eixo2: 'Cor' },
  COSMETICOS: { rotulo: 'Cosméticos e perfumaria', eixo1: 'Volume', eixo2: 'Tom' },
  ALIMENTOS: { rotulo: 'Alimentos e mercearia', eixo1: 'Peso', eixo2: 'Sabor' },
  CONSTRUCAO: { rotulo: 'Material de construção', eixo1: 'Medida', eixo2: 'Acabamento' },
  OUTRO: { rotulo: 'Outro ramo', eixo1: 'Variação', eixo2: 'Tipo' },
};

let atual = { nome: 'Loja', segmento: 'OUTRO', vocabulario: NEUTRO };
const ouvintes = new Set();

/** A configuração que está valendo agora — nunca `null`, para nenhuma tela ter de checar. */
export const loja = () => atual;

/** As palavras da loja. `vocab().eixo1` é "Tamanho" numa loja de roupas. */
export const vocab = () => atual.vocabulario ?? NEUTRO;

/**
 * A primeira letra maiúscula, para o rótulo do campo ficar de gente.
 * `maiuscula(vocab().item)` → "Peça".
 */
export const maiuscula = (texto) =>
  typeof texto === 'string' && texto ? texto[0].toUpperCase() + texto.slice(1) : '';

export function aoMudarLoja(fn) {
  ouvintes.add(fn);
  return () => ouvintes.delete(fn);
}

function aplicar(config) {
  atual = { ...config, vocabulario: config.vocabulario ?? NEUTRO };
  // Antes de qualquer tela desenhar hora: quem manda no relógio é a loja, não o navegador.
  definirFusoDaLoja(config.timezone);
  // O nome da aba do navegador é a primeira coisa que identifica o sistema quando a
  // pessoa tem cinco abas abertas.
  document.title = `${atual.nome} · Gestão`;
  ouvintes.forEach((fn) => fn(atual));
  return atual;
}

/**
 * Busca a configuração. Falha de rede NÃO derruba a tela: o sistema continua com o nome
 * genérico, porque não abrir o PDV por causa do nome da loja seria trocar um detalhe por
 * um dia de trabalho.
 */
export async function carregarLoja() {
  try {
    return aplicar(await api.get('/configuracao'));
  } catch {
    return atual;
  }
}

/** Depois de salvar na tela de configuração, atualiza todo mundo sem recarregar a página. */
export const definirLoja = (config) => aplicar(config);
