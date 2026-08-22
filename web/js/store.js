/**
 * Estado compartilhado, sem framework: um objeto e quem quiser ser avisado se inscreve.
 *
 * Só entra aqui o que mais de uma tela precisa enxergar: a sessão (quem está logado) e o
 * carrinho do PDV (que não pode sumir se a pessoa abrir o catálogo para conferir um preço
 * no meio da venda). Todo o resto é estado local da view.
 */

function criarStore(inicial) {
  let estado = inicial;
  const inscritos = new Set();

  return {
    get() {
      return estado;
    },
    set(parcial) {
      const anterior = estado;
      estado = typeof parcial === 'function' ? parcial(estado) : { ...estado, ...parcial };
      if (estado !== anterior) inscritos.forEach((fn) => fn(estado));
    },
    inscrever(fn) {
      inscritos.add(fn);
      return () => inscritos.delete(fn);
    },
  };
}

/** Quem está logado. `carregando` cobre o instante entre abrir a página e renovar a sessão. */
export const sessao = criarStore({ usuario: null, carregando: true });

export const ehAdmin = () => sessao.get().usuario?.papel === 'ADMIN';

/**
 * Carrinho do PDV. Itens são `{ variante_id, produto, tamanho, cor, codigo_barras,
 * preco_unitario (centavos), quantidade, saldo }`; desconto em centavos.
 */
export const carrinho = criarStore({ itens: [], desconto: 0, clientUuid: null });

export function novoClientUuid() {
  // crypto.randomUUID existe em todo navegador atual; o fallback cobre http em rede local,
  // onde o contexto não é seguro e a API some.
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = [...b].map((n) => n.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const carrinhoVazio = () => carrinho.get().itens.length === 0;

/** Soma dos itens, antes do desconto. */
export function subtotalCarrinho() {
  return carrinho.get().itens.reduce((t, i) => t + i.preco_unitario * i.quantidade, 0);
}

/**
 * Total a cobrar. O desconto é limitado ao subtotal aqui — se a pessoa tirar um item
 * depois de dar desconto, o desconto órfão não pode virar uma venda de R$ 0,00.
 */
export function totalCarrinho() {
  const subtotal = subtotalCarrinho();
  return Math.max(0, subtotal - Math.min(carrinho.get().desconto, subtotal));
}

export function descontoEfetivo() {
  return Math.min(carrinho.get().desconto, subtotalCarrinho());
}

export function limparCarrinho() {
  carrinho.set({ itens: [], desconto: 0, clientUuid: null });
}
