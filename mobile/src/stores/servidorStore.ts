/**
 * Qual servidor da loja este celular usa.
 *
 * Fica separado da sessão de propósito: trocar de vendedor não pode desconfigurar o
 * aparelho, e sair do app não apaga o endereço. Quem instala o app num celular novo
 * configura o servidor uma vez; dali em diante é só login e senha.
 */

import { create } from 'zustand';

import { esquecerServidor, lerServidor, salvarServidor } from '@/api/servidor';
import { novaInstalacao } from '@/lib/instalacao';
import { chaves, queryClient } from '@/lib/queryClient';

/**
 * O que o app sabe da loja (nome, ramo, se é a de demonstração) veio do servidor ANTIGO.
 * Sem esquecer, quem troca da demonstração para a loja de verdade seguiria vendo a faixa de
 * "dados fictícios" — e o nome da outra loja na entrada — até o cache envelhecer (10 min).
 * O reset volta ao padrão e busca de novo, no endereço novo, o que estiver na tela.
 */
function esquecerALojaAnterior(): void {
  void queryClient.resetQueries({ queryKey: chaves.configuracao });
}

interface ServidorState {
  endereco: string | null;
  carregando: boolean;
  restaurar: () => Promise<void>;
  definir: (endereco: string) => Promise<void>;
  esquecer: () => Promise<void>;
}

export const useServidorStore = create<ServidorState>((set, get) => ({
  endereco: null,
  carregando: true,

  async restaurar() {
    // Uma falha na leitura não pode travar a abertura: sem endereço, o app simplesmente
    // pede a configuração de novo.
    const salvo = await lerServidor().catch(() => null);
    set({ endereco: salvo, carregando: false });
  },

  async definir(endereco) {
    // Outro servidor, outro id de instalação (ADR-47): dois servidores não recebem o mesmo
    // identificador deste aparelho. O anterior já ouviu o "esqueça" no `sair` de "Trocar de
    // servidor" (ou ouve na limpeza pendente, que guarda o endereço e o id de lá).
    if (get().endereco !== endereco) await novaInstalacao();
    await salvarServidor(endereco);
    set({ endereco, carregando: false });
    esquecerALojaAnterior();
  },

  async esquecer() {
    await esquecerServidor();
    set({ endereco: null, carregando: false });
    esquecerALojaAnterior();
  },
}));
