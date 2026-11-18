/**
 * O que o leitor mostra para cada estado da permissão da câmera.
 *
 * Na primeira abertura (permissão ainda não decidida) quem fala é o ALERTA DO SISTEMA, pedido
 * na hora em que o leitor monta — nada de tela do app antes dele com um botão "Permitir": a
 * Apple recusa (5.1.1) a tela própria que antecede o alerta com cara de "Allow", e era isso que
 * a gravação pedida na 2.1 ia mostrar. A tela do app fica para depois de uma recusa: com o
 * botão que funciona naquele estado ("Abrir Ajustes" quando o sistema não pergunta mais) e o
 * caminho sem câmera ("Digitar código").
 *
 * Sem tela aqui, para dar para testar.
 */

export type SituacaoDaCamera =
  /** O hook ainda está lendo a permissão: fundo preto, nada a fazer. */
  | 'lendo'
  /** Nunca decidida e ainda não pedida nesta montagem: o leitor pede ao sistema agora. */
  | 'pedir-ao-sistema'
  | 'liberada'
  /** Recusada (ou o alerta foi dispensado), mas o sistema ainda pergunta: botão "Continuar". */
  | 'pedir-de-novo'
  /** Recusada e o sistema não pergunta mais (iOS): só os Ajustes do aparelho ligam. */
  | 'abrir-ajustes';

export interface PermissaoLida {
  granted: boolean;
  status: string;
  canAskAgain: boolean;
}

/** `jaPediu`: o leitor já chamou o alerta do sistema nesta montagem (não pede em laço). */
export function situacaoDaCamera(permissao: PermissaoLida | null | undefined, jaPediu: boolean): SituacaoDaCamera {
  if (!permissao) return 'lendo';
  if (permissao.granted) return 'liberada';
  if (permissao.status === 'undetermined' && !jaPediu) return 'pedir-ao-sistema';
  return permissao.canAskAgain ? 'pedir-de-novo' : 'abrir-ajustes';
}

/** O texto e o botão da tela do app, nos dois estados em que ela aparece. */
export function avisoDaCamera(situacao: 'pedir-de-novo' | 'abrir-ajustes'): {
  titulo: string;
  botao: string;
  texto: string;
} {
  const semCamera = 'Sem a câmera, use "Digitar código" para buscar a peça pelo número da etiqueta.';
  if (situacao === 'abrir-ajustes') {
    return {
      titulo: 'A câmera está desligada para o app',
      botao: 'Abrir Ajustes',
      texto: `Para ler o código de barras, ligue em Ajustes › Gestão de Loja › Câmera. ${semCamera}`,
    };
  }
  return {
    titulo: 'O app lê o código pela câmera',
    // "Continuar", e não "Permitir": quem permite é o alerta do sistema, que vem em seguida.
    botao: 'Continuar',
    texto: `É com ela que o app lê o código de barras das peças. ${semCamera}`,
  };
}
