/**
 * Quem é esta loja, para qualquer tela do app.
 *
 * Lida sem sessão (a tela de entrada precisa do nome antes do login) e guardada por
 * bastante tempo: nome de loja não muda de minuto em minuto, e uma consulta a cada tela
 * seria gasto de bateria e de rede da loja por nada.
 */

import { useQuery } from '@tanstack/react-query';

import { sistema } from '@/api/endpoints';
import type { ConfiguracaoLoja } from '@/api/tipos';
import { chaves } from '@/lib/queryClient';
import { NEUTRO, type Vocabulario } from '@/lib/segmento';

/** Enquanto a resposta não chega, a tela desenha com isto — nunca com um vazio. */
const PADRAO: ConfiguracaoLoja = {
  nome: 'Minha Loja',
  segmento: 'OUTRO',
  documento: null,
  telefone: null,
  endereco: null,
  vocabulario: NEUTRO,
};

export function useLoja(): ConfiguracaoLoja {
  const consulta = useQuery({
    queryKey: chaves.configuracao,
    queryFn: sistema.configuracao,
    staleTime: 10 * 60_000,
    // Servidor fora do ar não pode impedir o PDV de desenhar: cai no padrão e segue.
    retry: false,
  });
  return consulta.data ?? PADRAO;
}

/** As palavras da loja: `useVocabulario().eixo1` é "Tamanho" numa loja de roupas. */
export function useVocabulario(): Vocabulario {
  return useLoja().vocabulario ?? NEUTRO;
}
