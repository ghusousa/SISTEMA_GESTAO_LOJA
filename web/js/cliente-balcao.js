/**
 * Quem está comprando — o nome da cliente em QUALQUER venda, não só no fiado (ADR-36).
 *
 * É a porta do balcão (`ATENDER_CLIENTE`): busca e cadastro sem saldo, sem limite, sem a
 * observação do crediário. Quem precisa ver a dívida é o fiado, e o fiado continua com a
 * pergunta dele (`escolherCliente` em `pagar-fiado-vale.js`).
 *
 * Espelho de `mobile/src/components/ClienteDaVenda.tsx`: mesmas perguntas, mesmo texto.
 */

import { api } from './api.js';
import { novoClientUuid } from './store.js';
import { aviso, avisarErro, html, modal } from './ui.js';

/** Escolhe ou cadastra a cliente da venda. Resolve `{id, nome, preferencias}` ou `undefined`. */
export function escolherClienteDaVenda() {
  // Uma chave por abertura: a rede caiu depois de gravar e a pessoa tocou de novo — o
  // servidor devolve o mesmo cadastro em vez de a cliente nascer duas vezes.
  const chave = novoClientUuid();
  return modal({
    titulo: 'Quem está comprando?',
    largura: '480px',
    render: () => html`
      <label class="campo">
        <span>Procure pelo nome ou telefone</span>
        <input data-q placeholder="Maria" autocomplete="off" />
      </label>
      <div data-lista></div>
      <p class="texto-suave" style="margin-top:14px">Primeira vez na loja?</p>
      <label class="campo"><span>Nome</span><input data-nome maxlength="120" /></label>
      <label class="campo"><span>Telefone</span><input data-telefone maxlength="20" inputmode="tel" /></label>
      <label class="campo"><span>Aniversário <span class="campo__dica">opcional</span></span><input data-nascimento type="date" /></label>
      <label class="campo"><span>Preferências <span class="campo__dica">tamanho, estilo</span></span><input data-preferencias maxlength="200" placeholder="Veste M, gosta de linho" /></label>
      <div class="modal__acoes">
        <button class="botao botao--neutro" data-nao>Cancelar</button>
        <button class="botao" data-cadastrar>Cadastrar e usar</button>
      </div>
    `,
    aoAbrir: (corpo, fechar) => {
      const lista = corpo.querySelector('[data-lista]');
      const valor = (seletor) => corpo.querySelector(seletor).value.trim();
      let achados = [];

      async function procurar(termo) {
        if (termo.length < 2) {
          lista.innerHTML = '';
          return;
        }
        try {
          const { items } = await api.get('/clientes/balcao', { q: termo, size: 8 });
          achados = items;
          lista.innerHTML = items.length
            ? html`
                <div class="busca-peca" style="position:static;box-shadow:none;max-height:220px">
                  ${items.map(
                    (c) => html`
                      <button type="button" class="busca-peca__item" data-cliente="${c.id}">
                        <span class="busca-peca__nome">${c.nome}</span>
                        <span class="busca-peca__grade">${c.telefone || 'sem telefone'}</span>
                        <span class="busca-peca__saldo">${c.preferencias || ''}</span>
                      </button>
                    `,
                  )}
                </div>
              `
            : '<p class="texto-suave">Ninguém com esse nome.</p>';
          lista.querySelectorAll('[data-cliente]').forEach((b) =>
            b.addEventListener('click', () =>
              fechar(achados.find((x) => x.id === Number(b.dataset.cliente))),
            ),
          );
        } catch (erro) {
          avisarErro(erro);
        }
      }

      let timer = null;
      corpo.querySelector('[data-q]').addEventListener('input', (e) => {
        clearTimeout(timer);
        const termo = e.target.value.trim();
        timer = setTimeout(() => void procurar(termo), 250);
      });

      corpo.querySelector('[data-cadastrar]').addEventListener('click', async () => {
        const nome = valor('[data-nome]');
        if (nome.length < 2) {
          aviso('Escreva o nome da cliente.', 'alerta');
          return;
        }
        try {
          fechar(
            await api.post('/clientes/balcao', {
              client_uuid: chave,
              nome,
              telefone: valor('[data-telefone]') || null,
              nascimento: valor('[data-nascimento]') || null,
              preferencias: valor('[data-preferencias]') || null,
            }),
          );
        } catch (erro) {
          avisarErro(erro);
        }
      });
      corpo.querySelector('[data-nao]').addEventListener('click', () => fechar(undefined));
    },
  });
}
