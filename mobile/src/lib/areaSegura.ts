/**
 * Área segura: o que fica de fora do desenho em cada iPhone.
 *
 * Em cima é a barra de status (20 pt no SE, 47 a 62 pt nos de Face ID, com o recorte ou a
 * ilha no meio). Embaixo é o indicador de início dos aparelhos de Face ID (34 pt); no SE,
 * que tem botão de início, é zero. O valor vem do `useSafeAreaInsets()` na tela; aqui fica só
 * a conta, para ter teste — o export web não tem recorte nem indicador para mostrar o erro.
 *
 * Por que isto existe: altura fixa ignora o aparelho. A barra de abas com `height: 62` e
 * `paddingBottom: 8` deixava os rótulos encostados no indicador de início, e os rodapés com
 * `padding` fixo punham "Confirmar venda" e "Receber pagamento" em cima dele.
 */

/**
 * Respiro de um rodapé que encosta na base da tela (botão de concluir, barra de abas).
 *
 * O MAIOR entre o respiro de sempre e a área segura — não a soma. Os 34 pt de baixo já
 * deixam o indicador de início (5 pt, a 8 pt da borda) a uns 20 pt do botão, que é o que a
 * própria barra de abas do iOS faz. Somar empurrava o botão para cima à toa; no SE a área é
 * zero e o rodapé fica exatamente como era.
 */
export function respiroDeBaixo(areaSegura: number, minimo: number): number {
  const area = Number.isFinite(areaSegura) && areaSegura > 0 ? Math.ceil(areaSegura) : 0;
  return Math.max(minimo, area);
}

/**
 * Respiro de quem encosta no TOPO da tela sem cabeçalho (a folha de busca, o Modal de tela
 * cheia). Aqui é a SOMA: a barra de status ocupa a área inteira, e o conteúdo começa depois
 * dela.
 */
export function respiroDeCima(areaSegura: number, folga: number): number {
  const area = Number.isFinite(areaSegura) && areaSegura > 0 ? Math.ceil(areaSegura) : 0;
  return area + folga;
}

/**
 * O que cada aba da barra precisa de altura, de cima para baixo. Espelho do que o
 * `@react-navigation/bottom-tabs` 7 desenha numa aba de ícone em cima do rótulo
 * (`BottomTabItem`: `padding: 5`; `TabBarIcon`: moldura de 28 pt de altura).
 */
export const ABA = {
  respiroDaAba: 5,
  alturaDoIcone: 28,
  /** Linha do rótulo (11 pt): fixa, para a conta valer igual no iPhone, no Android e no web. */
  linhaDoRotulo: 14,
} as const;

/** Espaço entre o topo da barra e o começo das abas. */
const RESPIRO_EM_CIMA = 6;
/** Respiro embaixo quando o aparelho não tem área segura (SE, Android com botões). */
const RESPIRO_EMBAIXO = 8;

export interface MedidasDaBarra {
  height: number;
  paddingTop: number;
  paddingBottom: number;
  /** Para o `tabBarLabelStyle`: a mesma linha que a conta da altura usou. */
  lineHeight: number;
}

/**
 * Altura e respiros da barra de abas a partir da área segura de baixo.
 *
 * A altura é sempre "conteúdo + respiros": o miolo onde ícone e rótulo vivem tem a mesma
 * altura em todo aparelho, e o que muda é só o respiro de baixo. Assim o rótulo nunca fica
 * espremido (no web, um miolo menor que o rótulo cortava as letras pela metade) e nunca
 * desce para a faixa do indicador de início.
 */
export function medidasDaBarraDeAbas(areaSeguraDeBaixo: number): MedidasDaBarra {
  const miolo = ABA.respiroDaAba + ABA.alturaDoIcone + ABA.linhaDoRotulo + ABA.respiroDaAba;
  const paddingBottom = respiroDeBaixo(areaSeguraDeBaixo, RESPIRO_EMBAIXO);
  return {
    height: RESPIRO_EM_CIMA + miolo + paddingBottom,
    paddingTop: RESPIRO_EM_CIMA,
    paddingBottom,
    lineHeight: ABA.linhaDoRotulo,
  };
}

/** O que interessa da área segura aqui: as quatro bordas, em pt. */
export interface Bordas {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/**
 * A área segura que a NAVEGAÇÃO enxerga quando há faixa por cima dela — o aviso de sem
 * conexão e a da loja de demonstração (`components/FaixasDoTopo.tsx`).
 *
 * A faixa fica no topo da tela e já cobre a barra de status. Se o cabeçalho azul de baixo
 * somasse a área de cima de novo, ganharia uma tira vazia da altura da ilha — então o topo
 * vira zero, e os lados e a base continuam os do aparelho. Sem faixa, devolve a MESMA área
 * (o mesmo objeto): para quem não tem faixa, nada muda nem redesenha.
 *
 * O Modal de tela cheia desenha por cima de tudo, faixa inclusive, a partir do topo da TELA:
 * ele lê a área da janela (`useAreaDaJanela`, pelo `useRespiroDeCima`), nunca esta.
 */
export function areaAbaixoDasFaixas<T extends Bordas>(janela: T, temFaixa: boolean): T {
  return temFaixa && janela.top !== 0 ? { ...janela, top: 0 } : janela;
}

/**
 * O `keyboardVerticalOffset` de um `KeyboardAvoidingView` de tela que mora DEBAIXO das faixas
 * do topo: a altura delas, medida (`useAlturaDasFaixas`) — sem faixa, zero, e nada muda.
 *
 * O RN (0.81, `KeyboardAvoidingView.js`) mede o KAV em relação ao PAI, que começa debaixo das
 * faixas, e compara com o topo do teclado medido na tela inteira. Sem o desconto ele acolchoa
 * de menos justo a altura das faixas, e essa altura do fim do formulário fica atrás do teclado
 * (na entrada da demonstração, o rodapé e, com o Texto Maior, o "Entrar"). Para cima, como as
 * áreas acima: nunca fica atrás; medida inválida conta como sem faixa.
 */
export function deslocamentoDoTeclado(alturaDasFaixas: number): number {
  return Number.isFinite(alturaDasFaixas) && alturaDasFaixas > 0 ? Math.ceil(alturaDasFaixas) : 0;
}
