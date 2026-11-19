/**
 * Os chamados do computador para este login (ADR-47), e o atender.
 *
 * A lista é a mesma para a faixa do topo, para a tela do leitor e para a linha "Outro
 * computador está chamando" do leitor ligado: uma consulta só, que se refaz ao montar, no
 * assunto `leitor_pareamento` do tempo real, a cada "conectado" e volta ao app (o tempo real
 * recarrega o que está na tela) e no push que chega com o app na frente. Servidor de antes da
 * ADR-47 (404 sem `code`): lista vazia, e ninguém pergunta de novo até a próxima sessão.
 */

import { useMutation, useQuery } from '@tanstack/react-query';
import axios from 'axios';
import { useCallback, useState } from 'react';

import { codigoDoErro, mensagemDoErro } from '@/api/client';
import { leitor } from '@/api/endpoints';
import type { ChamadoAberto, ErroApi } from '@/api/tipos';
import { idDaInstalacao } from '@/lib/instalacao';
import { pedirPermissaoNoToque, tirarDaCentral } from '@/lib/pushDoLeitor';
import { chaves, queryClient } from '@/lib/queryClient';
import { useAuthStore } from '@/stores/authStore';
import { useLeitorStore } from '@/stores/leitorStore';

/** O 404 do FastAPI para rota que não existe vem sem `code`: o servidor é de antes. */
function semARota(erro: unknown): boolean {
  return axios.isAxiosError<ErroApi>(erro) && erro.response?.status === 404 && !erro.response.data?.code;
}

/** A consulta da lista, também para quem busca fora de tela (o toque numa notificação). */
export async function buscarChamadosAbertos(): Promise<ChamadoAberto[]> {
  try {
    return await leitor.chamadosAbertos();
  } catch (erro) {
    if (!semARota(erro)) throw erro;
    useLeitorStore.getState().marcarServidorSemChamados();
    return [];
  }
}

export function useChamadosDoLeitor() {
  const logado = useAuthStore((e) => !!e.usuario);
  const semRota = useLeitorStore((e) => e.servidorSemChamados);
  return useQuery({
    queryKey: chaves.chamadosDoLeitor,
    queryFn: buscarChamadosAbertos,
    enabled: logado && !semRota,
    staleTime: 0,
    retry: false,
  });
}

/** O 404 do atender é o mesmo para tudo que não serve: venceu, foi cancelado, outro atendeu. */
export const CHAMADO_QUE_NAO_SERVE = 'O chamado venceu ou já foi atendido.';

interface Atender {
  id: number;
  /**
   * Pergunta antes a permissão de notificação (o "Abrir o leitor" da faixa e do cartão). Não
   * no toque NA notificação (ela já existe) nem com a câmera montada (o Trocar).
   */
  pedirPermissao: boolean;
}

/**
 * Atender um chamado, na tela do leitor: a permissão (se for o caso), o `POST .../atender`
 * com o id desta instalação, ligar o leitor e tirar da central os avisos de chamado. O toque
 * é o "sim": ligar é sempre um toque da pessoa (ADR-43).
 *
 * A faixa do topo NÃO atende ali mesmo: ela leva à tela do leitor com o pedido na store, e é
 * daqui que sai o alerta da permissão. A faixa aparece por cima de telas com a câmera aberta
 * (Vender, Entrada…), e o alerta do iOS não para a câmera (CLAUDE.md, "Alert.alert não para a
 * câmera"); a tela do leitor sem leitor ligado não tem câmera, e a aba Vender apaga a dela ao
 * perder o foco.
 */
export function useAtenderChamado() {
  const [aviso, setAviso] = useState<string | null>(null);

  const mutacao = useMutation({
    mutationFn: async ({ id, pedirPermissao }: Atender) => {
      // A sessão de quando o toque aconteceu: se ela sair antes da resposta, nada liga.
      const sessao = useLeitorStore.getState().sessao;
      // O alerta do sistema vem ANTES do atender (e da câmera): um depois do outro.
      if (pedirPermissao) await pedirPermissaoNoToque();
      const novo = await leitor.atender(id, await idDaInstalacao());
      return { novo, sessao };
    },
    onSuccess: ({ novo, sessao }) => {
      setAviso(null);
      useLeitorStore.getState().ligar(novo, sessao);
      // Ligou de verdade (a sessão é a mesma): os avisos de chamado na central não servem mais.
      if (useLeitorStore.getState().pareamento?.id === novo.id) void tirarDaCentral();
    },
    onError: (erro) => {
      setAviso(
        codigoDoErro(erro) === 'LEITOR_CHAMADO_INVALIDO'
          ? CHAMADO_QUE_NAO_SERVE
          : mensagemDoErro(erro, 'Não deu para ligar o leitor.'),
      );
    },
    onSettled: () => {
      // Atendido ou não, a lista mudou (ou estava velha).
      void queryClient.invalidateQueries({ queryKey: chaves.chamadosDoLeitor });
    },
  });

  const { mutate } = mutacao;
  const atender = useCallback((id: number, { pedirPermissao }: { pedirPermissao: boolean }) => {
    setAviso(null);
    mutate({ id, pedirPermissao });
  }, [mutate]);

  return {
    atender,
    atendendo: mutacao.isPending,
    /** Qual chamado está sendo atendido agora (o botão dele mostra que carrega). */
    atendendoId: mutacao.isPending ? mutacao.variables?.id ?? null : null,
    aviso,
    esquecerAviso: useCallback(() => setAviso(null), []),
  };
}

export type AtenderChamado = ReturnType<typeof useAtenderChamado>;
