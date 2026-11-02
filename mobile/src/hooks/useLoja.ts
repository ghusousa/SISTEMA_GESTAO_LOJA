/**
 * Quem é esta loja, para qualquer tela do app.
 *
 * Em dois tempos, como no web (`web/js/loja.js`). `useLoja` é a fachada, lida sem sessão
 * (a tela de entrada precisa do nome antes do login). `useDadosDaLoja` acrescenta
 * documento, telefone e endereço, que só saem com sessão — para MEI, são o CPF e o
 * endereço de casa do dono. Os dois ficam guardados por bastante tempo: nome de loja não
 * muda de minuto em minuto, e uma consulta a cada tela seria gasto de bateria por nada.
 * O logout limpa o cache inteiro (`queryClient.clear`), e o documento vai junto.
 */

import { useQuery } from '@tanstack/react-query';

import { sistema } from '@/api/endpoints';
import type { ConfiguracaoLoja, ConfiguracaoPublica } from '@/api/tipos';
import { chaves } from '@/lib/queryClient';
import { NEUTRO, type Vocabulario } from '@/lib/segmento';

/** Enquanto a resposta não chega, a tela desenha com isto — nunca com um vazio. */
const PADRAO: ConfiguracaoPublica = {
  nome: 'Minha Loja',
  segmento: 'OUTRO',
  vocabulario: NEUTRO,
};

/** A chave mora debaixo de `configuracao`: invalidar a fachada invalida isto junto. */
const CHAVE_COMPLETA = [...chaves.configuracao, 'completa'] as const;

export function useLoja(): ConfiguracaoPublica {
  const consulta = useQuery({
    queryKey: chaves.configuracao,
    queryFn: sistema.configuracao,
    staleTime: 10 * 60_000,
    // Servidor fora do ar não pode impedir o PDV de desenhar: cai no padrão e segue.
    retry: false,
  });
  return consulta.data ?? PADRAO;
}

/**
 * A configuração inteira, para quem está logado (recibo e tela da loja). Só chame dentro
 * do grupo `(app)`: sem sessão a rota responde 401.
 */
export function useDadosDaLoja(): ConfiguracaoLoja & { carregado: boolean } {
  const fachada = useLoja();
  const consulta = useQuery({
    queryKey: CHAVE_COMPLETA,
    queryFn: sistema.configuracaoCompleta,
    staleTime: 10 * 60_000,
    retry: false,
  });
  if (consulta.data) return { ...consulta.data, carregado: true };
  return { ...fachada, documento: null, telefone: null, endereco: null, carregado: false };
}

/** Depois de salvar na tela da loja: a resposta do PATCH já é a configuração inteira. */
export { CHAVE_COMPLETA as CHAVE_CONFIGURACAO_COMPLETA };

/** As palavras da loja: `useVocabulario().eixo1` é "Tamanho" numa loja de roupas. */
export function useVocabulario(): Vocabulario {
  return useLoja().vocabulario ?? NEUTRO;
}
