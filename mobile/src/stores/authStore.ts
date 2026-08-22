/**
 * Sessão do usuário. Os tokens NÃO ficam aqui — vivem no SecureStore (api/sessao.ts).
 * Esta store guarda só quem está logado, para a navegação e as telas decidirem o que mostrar.
 */

import { create } from 'zustand';

import { auth } from '@/api/endpoints';
import { queryClient } from '@/lib/queryClient';
import { useCartStore } from '@/stores/cartStore';
import {
  lerRefreshToken,
  lerUsuarioSalvo,
  limparSessao,
  salvarSessao,
} from '@/api/sessao';
import type { Usuario } from '@/api/tipos';

interface AuthState {
  usuario: Usuario | null;
  carregando: boolean;
  entrar: (email: string, senha: string) => Promise<void>;
  sair: () => Promise<void>;
  restaurar: () => Promise<void>;
  encerrarPorTokenInvalido: () => void;
  ehAdmin: () => boolean;
}

/**
 * O que morre junto com a sessão.
 *
 * O carrinho é global e sobreviveria à troca de usuário: a vendedora sai no meio de uma
 * venda, o colega entra e encontra as peças dela no PDV — com os preços daquele momento e
 * o client_uuid da sessão anterior. O cache do React Query some pelo mesmo motivo.
 */
function limparEstadoDaSessao(): void {
  useCartStore.getState().limpar();
  queryClient.clear();
}

export const useAuthStore = create<AuthState>((set, get) => ({
  usuario: null,
  carregando: true,

  async entrar(email, senha) {
    const tokens = await auth.login(email.trim().toLowerCase(), senha);
    await salvarSessao(tokens.access_token, tokens.refresh_token, tokens.usuario);
    set({ usuario: tokens.usuario, carregando: false });
  },

  async sair() {
    const refresh = await lerRefreshToken();
    if (refresh) {
      // Revogar no servidor é o que faz o logout valer de verdade; se a rede falhar,
      // a sessão local some do mesmo jeito.
      await auth.logout(refresh).catch(() => undefined);
    }
    await limparSessao();
    limparEstadoDaSessao();
    set({ usuario: null, carregando: false });
  },

  async restaurar() {
    const salvo = await lerUsuarioSalvo();
    if (!salvo) {
      set({ usuario: null, carregando: false });
      return;
    }
    // Mostra o app imediatamente com o usuário salvo e confirma com o servidor em seguida:
    // abrir o PDV não pode depender de uma ida à rede.
    set({ usuario: salvo, carregando: false });
    try {
      const atual = await auth.eu();
      set({ usuario: atual });
    } catch {
      // O interceptor já trata 401 e chama encerrarPorTokenInvalido.
    }
  },

  encerrarPorTokenInvalido() {
    limparEstadoDaSessao();
    set({ usuario: null, carregando: false });
  },

  ehAdmin() {
    return get().usuario?.papel === 'ADMIN';
  },
}));
