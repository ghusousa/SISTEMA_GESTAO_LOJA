/**
 * Sessão do usuário. Os tokens NÃO ficam aqui — vivem no SecureStore (api/sessao.ts).
 * Esta store guarda só quem está logado, para a navegação e as telas decidirem o que mostrar.
 */

import { create } from 'zustand';

import { auth } from '@/api/endpoints';
import { queryClient } from '@/lib/queryClient';
import { useCartStore } from '@/stores/cartStore';
import { useLeitorStore } from '@/stores/leitorStore';
import {
  lerRefreshToken,
  lerUsuarioSalvo,
  limparSessao,
  salvarSessao,
} from '@/api/sessao';
import type { Usuario } from '@/api/tipos';
import { AVISO_CONTA_EXCLUIDA } from '@/lib/exclusaoDeConta';
import { pode, type Capacidade } from '@/lib/permissoes';
import { conectarTempoReal, desconectarTempoReal } from '@/lib/tempoReal';

interface AuthState {
  usuario: Usuario | null;
  carregando: boolean;
  /** Recado da tela de entrada sobre como a sessão acabou ("Conta excluída"). */
  avisoDaEntrada: string | null;
  entrar: (email: string, senha: string) => Promise<void>;
  sair: () => Promise<void>;
  restaurar: () => Promise<void>;
  encerrarPorTokenInvalido: () => void;
  /**
   * A própria conta acabou de ser excluída (ADR-45): fecha a sessão só deste lado — o
   * servidor já derrubou tudo — e a entrada diz o que aconteceu.
   */
  encerrarPorContaExcluida: () => Promise<void>;
  /** Pergunta por capacidade, nunca por cargo — ver `lib/permissoes.ts`. */
  podeFazer: (capacidade: Capacidade) => boolean;
}

/**
 * O que morre junto com a sessão.
 *
 * O carrinho é global e sobreviveria à troca de usuário: a vendedora sai no meio de uma
 * venda, o colega entra e encontra as peças dela no PDV — com os preços daquele momento e
 * o client_uuid da sessão anterior. O cache do React Query some pelo mesmo motivo. E o
 * celular-leitor (ADR-43): o próximo usuário não pode bipar para o computador do anterior.
 */
function limparEstadoDaSessao(): void {
  useCartStore.getState().limpar();
  useLeitorStore.getState().limpar();
  queryClient.clear();
}

/** Teto da espera pelo servidor ao desligar o leitor na saída. */
const ESPERA_DESLIGAR_LEITOR_MS = 4000;

export const useAuthStore = create<AuthState>((set, get) => ({
  usuario: null,
  carregando: true,
  avisoDaEntrada: null,

  async entrar(email, senha) {
    const tokens = await auth.login(email.trim().toLowerCase(), senha);
    await salvarSessao(tokens.access_token, tokens.refresh_token, tokens.usuario);
    set({ usuario: tokens.usuario, carregando: false, avisoDaEntrada: null });
    conectarTempoReal();
  },

  async sair() {
    // Primeiro, com os tokens ainda valendo: o celular-leitor termina junto com a sessão,
    // e o computador para de esperar bipe deste aparelho. Melhor esforço — sem rede, o
    // pareamento acaba sozinho nas 12 h, ou quando alguém desligar no computador.
    await useLeitorStore.getState().desligar({ timeout: ESPERA_DESLIGAR_LEITOR_MS });
    const refresh = await lerRefreshToken();
    if (refresh) {
      // Revogar no servidor é o que faz o logout valer de verdade; se a rede falhar,
      // a sessão local some do mesmo jeito.
      await auth.logout(refresh).catch(() => undefined);
    }
    // Antes de limpar: o canal fala com o servidor que ainda reconhece esta sessão.
    desconectarTempoReal();
    await limparSessao();
    limparEstadoDaSessao();
    set({ usuario: null, carregando: false });
  },

  async restaurar() {
    // Nada aqui pode estourar: uma falha na leitura da sessão travaria o app na abertura,
    // e a loja ficaria sem PDV por causa de um token ilegível.
    const salvo = await lerUsuarioSalvo().catch(() => null);
    if (!salvo) {
      set({ usuario: null, carregando: false });
      return;
    }
    // Mostra o app imediatamente com o usuário salvo e confirma com o servidor em seguida:
    // abrir o PDV não pode depender de uma ida à rede.
    set({ usuario: salvo, carregando: false });
    conectarTempoReal();
    try {
      const atual = await auth.eu();
      set({ usuario: atual });
    } catch {
      // O interceptor já trata 401 e chama encerrarPorTokenInvalido.
    }
  },

  encerrarPorTokenInvalido() {
    desconectarTempoReal();
    limparEstadoDaSessao();
    set({ usuario: null, carregando: false });
  },

  async encerrarPorContaExcluida() {
    // Sem `auth.logout` nem desligar o leitor no servidor: a exclusão já revogou as sessões
    // e levou o pareamento junto. Chamar agora daria 401, o interceptor tentaria renovar e
    // a pessoa sairia por "sessão expirada" — e o cofre ficaria com os tokens mortos.
    desconectarTempoReal();
    await limparSessao();
    limparEstadoDaSessao();
    set({ usuario: null, carregando: false, avisoDaEntrada: AVISO_CONTA_EXCLUIDA });
  },

  podeFazer(capacidade) {
    return pode(get().usuario?.papel, capacidade);
  },
}));
