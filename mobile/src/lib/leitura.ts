/**
 * As regras de tempo do leitor de código de barras, separadas da câmera para poder testar.
 *
 * A câmera dispara um evento por quadro em que enxerga o código — um único bipe do
 * operador vira dezenas de eventos. Toda a defesa mora aqui: enquanto essas decisões
 * estavam soltas dentro do componente, não dava para provar nada, e foi assim que passou
 * o defeito de a mesma etiqueta desconhecida empilhar cinco diálogos iguais na tela.
 */

/** Tempo de afastar e reaproximar a etiqueta antes de o mesmo código valer de novo. */
export const ESPERA_MESMO_CODIGO = 1500;
/** Intervalo mínimo entre duas leituras quaisquer. */
export const ESPERA_QUALQUER = 400;

export interface EstadoLeitura {
  /** Último código aceito, ou null se ainda não houve nenhum. */
  ultimoCodigo: string | null;
  /** Instante em que `ultimoCodigo` foi aceito. */
  instanteUltimoCodigo: number;
  /** Instante da última leitura aceita, de qualquer código. */
  instanteQualquer: number;
  /** Leitura suspensa: modo 'unico' já leu, ou há um diálogo na frente da câmera. */
  pausado: boolean;
  /** A tela ainda está consultando o bipe anterior. */
  ocupado: boolean;
}

export type Decisao =
  /** Entrega o código para a tela. */
  | 'ler'
  /** Quadro repetido ou leitor pausado: nada acontece. */
  | 'ignorar'
  /** Chegou código novo enquanto a consulta anterior não voltou: avisa e descarta. */
  | 'avisar-ocupado';

export function decidirLeitura(
  estado: EstadoLeitura,
  codigo: string,
  agora: number,
): Decisao {
  // Pausado vem antes de tudo: com um diálogo aberto, nem avisar faz sentido.
  if (estado.pausado) return 'ignorar';

  if (estado.ocupado) {
    // O aviso também respeita o intervalo. Sem isso, cada quadro decodificado disparava
    // uma vibração e o aparelho tremia sem parar enquanto a rede não respondia.
    return agora - estado.instanteQualquer >= ESPERA_QUALQUER ? 'avisar-ocupado' : 'ignorar';
  }

  if (agora - estado.instanteQualquer < ESPERA_QUALQUER) return 'ignorar';

  if (
    codigo === estado.ultimoCodigo &&
    agora - estado.instanteUltimoCodigo < ESPERA_MESMO_CODIGO
  ) {
    return 'ignorar';
  }

  return 'ler';
}
