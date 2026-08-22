/**
 * Qual servidor da loja este celular usa.
 *
 * Fica separado da sessão de propósito: trocar de vendedor não pode desconfigurar o
 * aparelho, e sair do app não apaga o endereço. Quem instala o app num celular novo
 * configura o servidor uma vez; dali em diante é só login e senha.
 */

import { create } from 'zustand';

import { esquecerServidor, lerServidor, salvarServidor } from '@/api/servidor';

interface ServidorState {
  endereco: string | null;
  carregando: boolean;
  restaurar: () => Promise<void>;
  definir: (endereco: string) => Promise<void>;
  esquecer: () => Promise<void>;
}

export const useServidorStore = create<ServidorState>((set) => ({
  endereco: null,
  carregando: true,

  async restaurar() {
    // Uma falha na leitura não pode travar a abertura: sem endereço, o app simplesmente
    // pede a configuração de novo.
    const salvo = await lerServidor().catch(() => null);
    set({ endereco: salvo, carregando: false });
  },

  async definir(endereco) {
    await salvarServidor(endereco);
    set({ endereco, carregando: false });
  },

  async esquecer() {
    await esquecerServidor();
    set({ endereco: null, carregando: false });
  },
}));
