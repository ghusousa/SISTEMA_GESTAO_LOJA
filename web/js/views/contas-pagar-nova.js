/**
 * Lançar uma nota de fornecedor sem Entrada: a nota antiga, o boleto que chegou depois.
 *
 * O caminho normal é a Entrada de mercadoria, que já traz a nota junto (ADR-40). Este é o
 * avulso, com a mesma pergunta (`nota-fornecedor.js`). Idempotente pela chave: a resposta
 * perdida e o segundo clique não lançam a dívida duas vezes.
 */

import { api } from '../api.js';
import { ligarNotaFornecedor } from '../nota-fornecedor.js';
import { novoClientUuid } from '../store.js';
import { aviso, avisarErro, html, modal, plural } from '../ui.js';

/** Como a LOJA paga o fornecedor (não são as formas do PDV). */
export const FORMAS_CONTA = {
  BOLETO: 'Boleto',
  PIX: 'PIX',
  TRANSFERENCIA: 'Transferência',
  DINHEIRO: 'Dinheiro',
  CARTAO: 'Cartão',
};

/** Abre o lançamento. Resolve `true` quando gravou. */
export function lancarConta() {
  const chave = novoClientUuid();
  return modal({
    titulo: 'Lançar nota de fornecedor',
    largura: '520px',
    render: () => html`
      <p class="texto-suave">Mercadoria que chegou agora? Lance pela <a href="#/estoque/entrada">Entrada</a>:
        a nota vai junto e a peça entra no estoque.</p>
      <label class="campo"><span>Fornecedor</span><input data-fornecedor maxlength="120" /></label>
      <label class="campo"><span>Descrição</span><input data-descricao maxlength="160" placeholder="Coleção de inverno" /></label>
      <div data-nota></div>
      <div class="modal__acoes">
        <button class="botao botao--neutro" data-nao>Cancelar</button>
        <button class="botao" data-sim>Lançar</button>
      </div>
    `,
    aoAbrir: (corpo, fechar) => {
      const nota = ligarNotaFornecedor(corpo.querySelector('[data-nota]'), { opcional: false });
      let enviando = false;
      corpo.querySelector('[data-nao]').addEventListener('click', () => fechar(false));
      corpo.querySelector('[data-sim]').addEventListener('click', async () => {
        if (enviando) return;
        const fornecedor = corpo.querySelector('[data-fornecedor]').value.trim();
        const descricao = corpo.querySelector('[data-descricao]').value.trim();
        if (fornecedor.length < 2 || descricao.length < 2) {
          avisarErro({ message: 'Diga de qual fornecedor é a nota e do que se trata.' });
          return;
        }
        enviando = true;
        try {
          const lancamento = await api.post('/contas-pagar', {
            client_uuid: chave, fornecedor, descricao, nota: nota.paraApi(),
          });
          aviso(`${plural(lancamento.contas.length, 'parcela lançada', 'parcelas lançadas')}.`);
          fechar(true);
        } catch (erro) {
          avisarErro(erro);
        } finally {
          enviando = false;
        }
      });
    },
  });
}
