/**
 * Quem é esta loja: o nome que aparece na tela e as palavras que o ramo dela traz.
 *
 * **Espelho de `api/app/core/segmentos.py` e de `mobile/src/lib/segmento.ts` — mudou um,
 * mude os três.** O servidor manda o vocabulário pronto em `GET /configuracao`, então a
 * tabela daqui é só a rede de segurança para o momento em que a tela precisa desenhar
 * antes de a resposta chegar (ou quando a API não responde).
 *
 * A configuração é lida em DOIS tempos. Sem login, `GET /configuracao` dá só a fachada
 * (nome, ramo, fuso, palavras): a tela de entrada precisa do nome antes de existir sessão.
 * Com login, `GET /configuracao/completa` acrescenta documento, telefone e endereço, que o
 * recibo imprime — para MEI, o CPF e o endereço de casa do dono, que não podem ficar
 * abertos a quem digitar a URL. Ao sair, os três somem da memória da aba.
 */

import { api } from './api.js';
import { sessao } from './store.js';
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
    // Por cima do que já havia: se a leitura completa (com documento e contato) chegou
    // antes desta, a fachada não pode apagá-la. O `atual` é lido DEPOIS do await — no
    // spread junto com o await, ele seria o retrato de antes da completa chegar.
    const publica = await api.get('/configuracao');
    return aplicar({ ...atual, ...publica });
  } catch {
    return atual;
  }
}

/** Depois de salvar na tela de configuração, atualiza todo mundo sem recarregar a página. */
export const definirLoja = (config) => aplicar(config);

/* ----------------------------------------------- documento e contato, só com sessão */

const CAMPOS_PRIVADOS = ['documento', 'telefone', 'endereco'];
let leituraCompleta = null;

/**
 * Documento, telefone e endereço da loja — o cabeçalho do recibo. Quem imprime chama isto
 * antes de desenhar: abrir o recibo direto pelo F5 chega antes da leitura disparada pelo
 * login, e o papel sairia sem o CNPJ. Falha de rede devolve o que já havia.
 */
export function garantirDadosDaLoja() {
  const dono = sessao.get().usuario?.id;
  if (dono == null) return Promise.resolve(atual);
  leituraCompleta ??= api
    .get('/configuracao/completa')
    // Resposta que chega depois de a pessoa sair não pode repor o documento na memória.
    .then((config) => (sessao.get().usuario?.id === dono ? aplicar(config) : atual))
    .catch(() => {
      leituraCompleta = null; // a próxima chamada tenta de novo
      return atual;
    });
  return leituraCompleta;
}

// A leitura completa acompanha a sessão: nasce com ela e morre com ela. A comparação é por
// id porque cada renovação de token republica o mesmo usuário.
let quem = null;
sessao.inscrever(({ usuario }) => {
  const id = usuario?.id ?? null;
  if (id === quem) return;
  quem = id;
  leituraCompleta = null;
  if (id !== null) {
    void garantirDadosDaLoja();
    return;
  }
  const publico = { ...atual };
  CAMPOS_PRIVADOS.forEach((campo) => delete publico[campo]);
  aplicar(publico);
});
