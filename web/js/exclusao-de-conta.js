/**
 * Excluir conta (ADR-45): o que a tela diz antes de confirmar e como lê a resposta.
 *
 * Espelho de `mobile/src/lib/exclusaoDeConta.ts` — mudou um, mude o outro. As duas pontas
 * dizem o MESMO sobre o que some e o que fica, porque é isso que a pessoa (e o revisor da
 * loja de app) lê antes de apertar o botão. Sem DOM aqui: o teste roda no node
 * (`testes/web/exclusao-de-conta.test.mjs`).
 */

/** O que a tela de entrada diz depois que a própria conta saiu. */
export const AVISO_CONTA_EXCLUIDA =
  'Conta excluída. O seu acesso e os seus dados de login foram apagados deste sistema.';

/**
 * O que some e o que fica. `propria`: a pessoa excluindo a própria conta (Minha conta);
 * senão, quem administra a equipe excluindo a conta de `nome` (Usuários).
 */
export function textosDaExclusao({ propria, nome = '' }) {
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

/**
 * Em quem a lista da equipe mostra "Excluir conta" — a mesma regra do servidor: a própria
 * conta é em Minha conta (com a senha), e conta de dono só o dono mexe.
 */
export function podeExcluirDaEquipe(eu, alvo) {
  if (!eu || !alvo || eu.id === alvo.id) return false;
  return alvo.papel !== 'ADMIN' || eu.papel === 'ADMIN';
}

/**
 * Onde mostrar a recusa do "Excluir minha conta": `'senha'` vai embaixo do campo (a pessoa
 * só redigita); `'geral'` vai em destaque — o dono único lê ali o caminho que o servidor
 * manda (passar o papel de dono antes). Nada aqui desloga: a senha errada é 422, não 401.
 */
export function recusaDaExclusao({ status = 0, code = '', message = '' } = {}) {
  if (code === 'SENHA_INCORRETA') {
    return { onde: 'senha', texto: message || 'Senha incorreta. A conta continua como estava.' };
  }
  if (code === 'VALIDACAO') return { onde: 'senha', texto: 'Digite a sua senha para confirmar.' };
  if (!status || code === 'SEM_REDE') {
    return {
      onde: 'geral',
      texto: 'Sem conexão com o servidor. A conta não foi excluída; tente de novo.',
    };
  }
  return { onde: 'geral', texto: message || 'Não deu para excluir a conta. Ela continua como estava.' };
}
