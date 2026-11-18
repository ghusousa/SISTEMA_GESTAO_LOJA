/**
 * Excluir conta (ADR-45): o que a tela diz antes de confirmar e como lê a resposta.
 *
 * **Espelho de `web/js/exclusao-de-conta.js` — mudou um, mude o outro.** As duas pontas
 * dizem o MESMO sobre o que some e o que fica, porque é isso que a pessoa (e o revisor da
 * loja de app) lê antes de apertar o botão. Sem tela aqui, para dar para testar.
 */

import type { Papel } from '@/api/tipos';

/** O que a tela de entrada diz depois que a própria conta saiu. */
export const AVISO_CONTA_EXCLUIDA =
  'Conta excluída. O seu acesso e os seus dados de login foram apagados deste sistema.';

export interface TextosDaExclusao {
  some: string[];
  fica: string[];
  fim: string;
}

/**
 * O que some e o que fica. `propria`: a pessoa excluindo a própria conta (Minha conta);
 * senão, quem administra a equipe excluindo a conta de `nome` (Usuários).
 */
export function textosDaExclusao({
  propria,
  nome = '',
}: {
  propria: boolean;
  nome?: string;
}): TextosDaExclusao {
  if (propria) {
    return {
      some: [
        'O seu login: e-mail e senha deixam de existir, e ninguém mais entra com eles.',
        'As sessões abertas em todos os aparelhos e o celular ligado como leitor.',
        'O seu e-mail no diário da loja, que passa a mostrar só uma máscara.',
      ],
      fica: [
        'As vendas, devoluções, entradas e caixas que você registrou: são a contabilidade da loja.',
        'O seu nome nesses registros e no diário, como estava na hora de cada um.',
      ],
      fim: 'Não tem volta. Para usar o sistema de novo, a loja cria uma conta nova.',
    };
  }
  return {
    some: [
      `O login de ${nome}: e-mail e senha deixam de existir, e ninguém mais entra com eles.`,
      'As sessões abertas em todos os aparelhos caem na hora, e o celular ligado como leitor também.',
      'O e-mail no diário da loja, que passa a mostrar só uma máscara.',
    ],
    fica: [
      'As vendas, devoluções, entradas e caixas registrados com esta conta, com o nome de quem fez.',
      'As linhas do diário, com o nome e o papel de quando cada ato aconteceu.',
    ],
    fim: 'Não tem volta. Para um afastamento, use Desativar: dá para reativar depois.',
  };
}

interface Pessoa {
  id: number;
  papel: Papel | string;
}

/**
 * Em quem a lista da equipe mostra "Excluir conta" — a mesma regra do servidor: a própria
 * conta é em Minha conta (com a senha), e conta de dono só o dono mexe.
 */
export function podeExcluirDaEquipe(eu: Pessoa | null | undefined, alvo: Pessoa | null | undefined): boolean {
  if (!eu || !alvo || eu.id === alvo.id) return false;
  return alvo.papel !== 'ADMIN' || eu.papel === 'ADMIN';
}

export interface Recusa {
  /** `'senha'`: embaixo do campo (a pessoa só redigita); `'geral'`: em destaque. */
  onde: 'senha' | 'geral';
  texto: string;
  /**
   * Sem resposta do servidor (`status` 0: rede que caiu, tempo esgotado): o pedido pode ter
   * chegado e a conta, saído. A próxima tentativa lê o 401 com `depoisDaIncerta`.
   */
  incerta?: boolean;
}

/** O que a tela diz quando o pedido ficou sem resposta: nem "excluída", nem "não excluída". */
export const SEM_RESPOSTA =
  'Sem resposta do servidor: a conta pode ter sido excluída ou não. Tente de novo — se ela já ' +
  'tiver saído, o app volta para a entrada.';

/**
 * Onde mostrar a recusa do "Excluir minha conta". O dono único lê, em destaque, o caminho que
 * o servidor manda (passar o papel de dono antes). Nada aqui desloga: a senha errada é 422,
 * não 401. `status` 0 é o pedido que ficou sem resposta — e aí não dá para dizer que a conta
 * continua: o servidor pode ter excluído e a resposta é que se perdeu.
 */
export function recusaDaExclusao({
  status = 0,
  code = '',
  message = '',
}: { status?: number; code?: string | null; message?: string } = {}): Recusa {
  if (code === 'SENHA_INCORRETA') {
    return { onde: 'senha', texto: message || 'Senha incorreta. A conta continua como estava.' };
  }
  if (code === 'VALIDACAO') return { onde: 'senha', texto: 'Digite a sua senha para confirmar.' };
  if (!status || code === 'SEM_REDE') return { onde: 'geral', texto: SEM_RESPOSTA, incerta: true };
  return { onde: 'geral', texto: message || 'Não deu para excluir a conta. Ela continua como estava.' };
}

/**
 * A tentativa anterior ficou sem resposta, e esta levou 401. Pode ser o crachá que venceu no
 * meio — ou a conta que já saiu e levou as sessões junto. Quem desempata é a renovação da
 * sessão, feita sem o desvio de "sessão expirada": o servidor recusou o refresh
 * (`sessaoContinua` false) → a conta saiu, e a entrada diz "Conta excluída"; renovou → era só
 * o crachá, e a exclusão é pedida de novo.
 */
export function depoisDaIncerta(sessaoContinua: boolean): 'excluida' | 'pedir-de-novo' {
  return sessaoContinua ? 'pedir-de-novo' : 'excluida';
}
