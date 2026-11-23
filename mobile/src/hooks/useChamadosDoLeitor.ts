/**
 * Os chamados do computador para este login (ADR-47), e o atender.
 *
 * A lista é a mesma para a faixa do topo, para a tela do leitor e para a linha "Outro
 * computador está chamando" do leitor ligado: uma consulta só, que se refaz ao montar, no
 * assunto `leitor_pareamento` do tempo real, a cada "conectado" e volta ao app (o tempo real
 * recarrega o que está na tela) e no push que chega com o app na frente. Servidor de antes da
 * ADR-47 (404 sem `code`): lista vazia, e ninguém pergunta de novo até a próxima sessão — ou até
 * a configuração mostrar o servidor novo (`vigiarServidorNovo`: a loja atualizou o servidor com o
 * app aberto, e o "conectado" do tempo real relê a configuração).
 *
 * Vencer (5 min) não avisa ninguém — o status é calculado das datas, nenhuma linha muda —, então
 * com chamado na lista o servidor a reconfirma de 30 em 30 s, e o que venceu sai da tela na hora
 * pelo `vence_em` (`lib/chamadoDoLeitor.ts`, com teste): o relógio daqui anda no vencimento do
 * próximo.
 */

import { hashKey, useMutation, useQuery } from '@tanstack/react-query';
import axios from 'axios';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { codigoDoErro, mensagemDoErro } from '@/api/client';
import { leitor } from '@/api/endpoints';
import type { ChamadoAberto, ErroApi } from '@/api/tipos';
import { chamadosVivos, intervaloDaConferencia, proximoFim, servidorGanhouOChamado } from '@/lib/chamadoDoLeitor';
import { idDaInstalacao } from '@/lib/instalacao';
import { pedirPermissaoNoToque, registrarAparelho, tirarDaCentral } from '@/lib/pushDoLeitor';
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

const HASH_DA_CONFIGURACAO = hashKey(chaves.configuracao);

/**
 * A marca de servidor antigo cai quando a configuração mostra o servidor novo (ADR-47).
 *
 * O celular abriu o app novo antes de a loja atualizar o servidor (o `--automatico` é opcional):
 * a lista deu o 404 sem `code` e a consulta se desligou. A atualização derruba o tempo real, o
 * "conectado" relê a configuração — e ela chega com `notificacoes_push`. Sem este vigia, só a
 * saída da conta religava a lista: o chamado não aparecia no app aberto, e o computador dizia
 * "atualize o app" a quem já tinha o novo. Junto, o aparelho se registra na hora: o registro da
 * abertura da sessão tinha dado 404 no servidor antigo. Uma vez, na raiz do app, em toda
 * plataforma (não só onde há `expo-notifications`).
 */
export function vigiarServidorNovo(): () => void {
  return queryClient.getQueryCache().subscribe((evento) => {
    if (evento.type !== 'updated' || evento.action.type !== 'success') return;
    if (evento.query.queryHash !== HASH_DA_CONFIGURACAO) return;
    const leitorAgora = useLeitorStore.getState();
    const configuracao = evento.query.state.data as { notificacoes_push?: unknown } | undefined;
    if (!servidorGanhouOChamado(leitorAgora.servidorSemChamados, configuracao)) return;
    leitorAgora.desmarcarServidorSemChamados();
    void queryClient.invalidateQueries({ queryKey: chaves.chamadosDoLeitor });
    if (useAuthStore.getState().usuario) void registrarAparelho();
  });
}

const SEM_CHAMADOS: readonly ChamadoAberto[] = [];

/**
 * O "agora" de quem mostra os chamados: anda sozinho no instante em que o próximo deles sai da
 * tela (`proximoFim`) — um relógio só, sem bater de segundo em segundo na raiz do app.
 */
function useRelogioDoVencimento(chamados: readonly ChamadoAberto[], buscadoEm: number): number {
  const [agora, setAgora] = useState(() => Date.now());
  useEffect(() => {
    const fim = proximoFim(chamados, { agora, buscadoEm });
    if (fim === null) return undefined;
    // `agora` pode ser de antes da lista: o que já passou dispara na hora (espera 0).
    const relogio = setTimeout(() => setAgora(Date.now()), Math.max(0, fim - Date.now()) + 50);
    return () => clearTimeout(relogio);
  }, [chamados, buscadoEm, agora]);
  return agora;
}

export interface ChamadosDoLeitor {
  /** A lista como veio na última conferência do servidor. */
  chamados: readonly ChamadoAberto[];
  /** Só os que ainda valem pelo relógio daqui: os cartões e a linha do leitor ligado. */
  vivos: readonly ChamadoAberto[];
  /** O relógio (anda no vencimento do próximo) e o instante da lista: a faixa decide com eles. */
  agora: number;
  buscadoEm: number;
}

export function useChamadosDoLeitor(): ChamadosDoLeitor {
  const logado = useAuthStore((e) => !!e.usuario);
  const semRota = useLeitorStore((e) => e.servidorSemChamados);
  const { data, dataUpdatedAt } = useQuery({
    queryKey: chaves.chamadosDoLeitor,
    queryFn: buscarChamadosAbertos,
    enabled: logado && !semRota,
    staleTime: 0,
    retry: false,
    // Vencer não avisa ninguém: com chamado na lista, o servidor reconfirma (para no fundo).
    refetchInterval: (consulta) => intervaloDaConferencia(consulta.state.data),
  });
  const chamados = data ?? SEM_CHAMADOS;
  const agora = useRelogioDoVencimento(chamados, dataUpdatedAt);
  const vivos = useMemo(
    () => chamadosVivos(chamados, { agora, buscadoEm: dataUpdatedAt }),
    [chamados, agora, dataUpdatedAt],
  );
  return { chamados, vivos, agora, buscadoEm: dataUpdatedAt };
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
