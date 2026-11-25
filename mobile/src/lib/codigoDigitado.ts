/**
 * O "Digitar código", para quando a câmera não lê a etiqueta (barras apagadas, amassadas,
 * rasgadas): a parte sem tela do `components/CodigoManual.tsx`, para dar para testar.
 *
 * Duas regras:
 * - o que dá para mandar: sem espaço nas pontas, de 4 a 64 caracteres, sem caractere de
 *   controle. Os 64 e o controle são a régua do servidor para a leitura que vai ao computador
 *   (`MAX_CODIGO_LIDO` em `api/app/modules/leitor/schemas.py`, ADR-43): passou disso, o bipe
 *   voltava 422 e virava "não enviado" sem dizer por quê. Nas outras telas não muda nada — o
 *   código de uma peça tem até 32 (`catalogo/schemas.py`);
 * - uma abertura, um código. A caixa fica na frente da câmera: abrir PARA a leitura da tela,
 *   como qualquer diálogo sobre o leitor (`lib/leitura.ts`), e fechar a devolve, com as travas
 *   recomeçando — senão a etiqueta que ficou embaixo da lente entra sozinha enquanto a pessoa
 *   digita. E o segundo toque no botão (ou o Enter do teclado junto com ele) antes de a caixa
 *   sumir não manda o código de novo: no leitor do computador seria a mesma peça duas vezes no
 *   carrinho de lá.
 */

/** Menos que isto é engano de dedo (a regra que o "Digitar código" sempre teve). */
export const MIN_CODIGO_DIGITADO = 4;
/** O teto do servidor para a leitura que vai ao computador (`MAX_CODIGO_LIDO`). */
export const MAX_CODIGO_DIGITADO = 64;

/** Os caracteres de controle (a categoria Cc do Unicode, a mesma que o servidor recusa). */
const CONTROLE = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * O código pronto para seguir, ou `null` quando não dá para mandar (o botão fica apagado).
 * Conta caracteres como o servidor (pontos de código, não metades de UTF-16).
 */
export function codigoDigitado(texto: string): string | null {
  const limpo = texto.trim();
  const tamanho = Array.from(limpo).length;
  if (tamanho < MIN_CODIGO_DIGITADO || tamanho > MAX_CODIGO_DIGITADO) return null;
  // Enter, Tab ou ESC colados de outro app virariam tecla no campo do computador.
  if (CONTROLE.test(limpo)) return null;
  return limpo;
}

export interface DependenciasDaDigitacao {
  /** A caixa abriu na frente da câmera: a tela para a leitura (`ScannerRef.pausar`). */
  pausar(): void;
  /** A caixa fechou: a câmera volta, com as travas recomeçando agora (`ScannerRef.retomar`). */
  retomar(): void;
  /** O código segue pelo MESMO caminho da leitura da câmera (no leitor: a fila de bipes). */
  entregar(codigo: string): void;
}

export interface Digitacao {
  /** O toque em "Digitar código". Já aberta, nada muda (a câmera não para duas vezes). */
  abrir(): void;
  /**
   * O botão da caixa (ou o Enter do teclado). `true`: o código saiu e a caixa fecha. `false`:
   * nada saiu — código que não dá para mandar (a caixa fica aberta e a câmera parada) ou o
   * segundo toque de quem já mandou.
   */
  confirmar(texto: string): boolean;
  /** "Voltar", o voltar do Android ou a tela que saiu com a caixa aberta: fecha sem mandar. */
  fechar(): void;
  aberta(): boolean;
}

/** Cada `pausar` tem o seu `retomar`, uma vez só, saia o código ou não. */
export function criarDigitacao(dep: DependenciasDaDigitacao): Digitacao {
  let aberta = false;
  return {
    abrir() {
      if (aberta) return;
      aberta = true;
      dep.pausar();
    },
    confirmar(texto) {
      if (!aberta) return false;
      const codigo = codigoDigitado(texto);
      if (codigo === null) return false;
      // Fecha ANTES de entregar: o segundo toque, que chega com a caixa ainda na tela, cai no
      // `!aberta` acima.
      aberta = false;
      try {
        dep.entregar(codigo);
      } finally {
        dep.retomar();
      }
      return true;
    },
    fechar() {
      if (!aberta) return;
      aberta = false;
      dep.retomar();
    },
    aberta: () => aberta,
  };
}
