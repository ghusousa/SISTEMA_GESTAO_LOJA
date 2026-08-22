/**
 * Carrinho do PDV.
 *
 * Vive só no aparelho até a venda ser confirmada, então é Zustand e não React Query.
 * Todo valor aqui é INTEIRO DE CENTAVOS: a conta do balcão não pode ter erro de float.
 *
 * O `clientUuid` nasce junto com o carrinho e acompanha a venda até o POST. É o que faz
 * um toque duplo em "confirmar", ou um retry depois de timeout, não virar venda duplicada.
 */

import { create } from 'zustand';

import type { FormaPagamento, VarianteLookup } from '@/api/tipos';
import { gerarUuid } from '@/lib/uuid';
import type { Centavos } from '@/lib/money';

export interface ItemCarrinho {
  varianteId: number;
  produto: string;
  tamanho: string;
  cor: string;
  codigoBarras: string;
  precoUnitario: Centavos;
  quantidade: number;
  saldoDisponivel: number;
}

export interface PagamentoCarrinho {
  forma: FormaPagamento;
  valor: Centavos;
}

interface CartState {
  clientUuid: string;
  itens: ItemCarrinho[];
  desconto: Centavos;
  pagamentos: PagamentoCarrinho[];
  /** Só para o troco na tela; não vai para a API. */
  recebidoEmDinheiro: Centavos;

  adicionar: (peca: VarianteLookup, precoCentavos: Centavos) => ResultadoAdicao;
  alterarQuantidade: (varianteId: number, quantidade: number) => void;
  remover: (varianteId: number) => void;
  definirDesconto: (valor: Centavos) => void;
  definirPagamentos: (pagamentos: PagamentoCarrinho[]) => void;
  definirRecebido: (valor: Centavos) => void;
  limpar: () => void;

  subtotal: () => Centavos;
  total: () => Centavos;
  totalPago: () => Centavos;
  restante: () => Centavos;
  quantidadePecas: () => number;
}

export type ResultadoAdicao =
  | { ok: true; quantidade: number }
  | { ok: false; motivo: 'sem_saldo'; disponivel: number };

const estadoInicial = () => ({
  clientUuid: gerarUuid(),
  itens: [] as ItemCarrinho[],
  desconto: 0,
  pagamentos: [] as PagamentoCarrinho[],
  recebidoEmDinheiro: 0,
});

export const useCartStore = create<CartState>((set, get) => ({
  ...estadoInicial(),

  adicionar(peca, precoCentavos) {
    const existente = get().itens.find((i) => i.varianteId === peca.variante_id);
    const desejada = (existente?.quantidade ?? 0) + 1;

    // Bloqueia no carrinho: a API recusaria a venda e o vendedor descobriria só na cobrança.
    if (desejada > peca.saldo) {
      return { ok: false, motivo: 'sem_saldo', disponivel: peca.saldo };
    }

    set((estado) => ({
      itens: existente
        ? estado.itens.map((i) =>
            i.varianteId === peca.variante_id ? { ...i, quantidade: desejada } : i,
          )
        : [
            ...estado.itens,
            {
              varianteId: peca.variante_id,
              produto: peca.produto,
              tamanho: peca.tamanho,
              cor: peca.cor,
              codigoBarras: peca.codigo_barras,
              precoUnitario: precoCentavos,
              quantidade: 1,
              saldoDisponivel: peca.saldo,
            },
          ],
      // Mexer nos itens invalida a divisão de pagamento montada antes.
      pagamentos: [],
      recebidoEmDinheiro: 0,
    }));
    return { ok: true, quantidade: desejada };
  },

  alterarQuantidade(varianteId, quantidade) {
    if (quantidade <= 0) {
      get().remover(varianteId);
      return;
    }
    set((estado) => ({
      itens: estado.itens.map((i) =>
        i.varianteId === varianteId
          ? { ...i, quantidade: Math.min(quantidade, i.saldoDisponivel) }
          : i,
      ),
      pagamentos: [],
      recebidoEmDinheiro: 0,
    }));
  },

  remover(varianteId) {
    set((estado) => ({
      itens: estado.itens.filter((i) => i.varianteId !== varianteId),
      pagamentos: [],
      recebidoEmDinheiro: 0,
    }));
  },

  definirDesconto(valor) {
    const subtotal = get().subtotal();
    set({
      desconto: Math.max(0, Math.min(valor, subtotal)),
      pagamentos: [],
      recebidoEmDinheiro: 0,
    });
  },

  definirPagamentos(pagamentos) {
    set({ pagamentos });
  },

  definirRecebido(valor) {
    set({ recebidoEmDinheiro: valor });
  },

  limpar() {
    // UUID novo: a próxima venda é outra venda.
    set(estadoInicial());
  },

  subtotal() {
    return get().itens.reduce((total, i) => total + i.precoUnitario * i.quantidade, 0);
  },

  total() {
    return Math.max(0, get().subtotal() - get().desconto);
  },

  totalPago() {
    return get().pagamentos.reduce((total, p) => total + p.valor, 0);
  },

  restante() {
    return get().total() - get().totalPago();
  },

  quantidadePecas() {
    return get().itens.reduce((total, i) => total + i.quantidade, 0);
  },
}));
