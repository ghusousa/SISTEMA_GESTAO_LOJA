/**
 * As duas formas de pagamento que não são dinheiro: vale de troca e fiado.
 *
 * Moram fora da tela de cobrança porque cada uma precisa de uma pergunta antes do valor —
 * "qual vale?" e "de quem é a dívida?" — e porque `pdv-cobranca.js` já está no teto de
 * linhas do CLAUDE.md.
 *
 * **O servidor decide os valores** (ADR-4). O vale é consultado aqui só para a tela saber
 * quanto propor e avisar cedo que o papel na mão da cliente já foi usado; quem trava o
 * consumo de verdade é o `UPDATE` condicional no banco, na hora de fechar a venda.
 */

import { api } from './api.js';
import { formatar, paraCentavos } from './dinheiro.js';
import { aviso, avisarErro, cru, html, modal } from './ui.js';

/**
 * Pergunta o código do vale. Resolve `{codigo, saldo}` (centavos) ou `undefined`.
 * @param {number} falta quanto ainda falta pagar, em centavos.
 */
export function pedirVale(falta) {
  return modal({
    titulo: 'Pagar com vale de troca',
    largura: '420px',
    render: () => html`
      <p class="texto-suave">O código está no papel que a cliente recebeu na devolução.</p>
      <label class="campo">
        <span>Código do vale</span>
        <input data-codigo maxlength="16" placeholder="V000123" autocomplete="off"
          style="text-transform:uppercase;font-size:20px;letter-spacing:0.08em" />
      </label>
      <div data-situacao></div>
      <div class="modal__acoes">
        <button class="botao botao--neutro" data-nao>Cancelar</button>
        <button class="botao botao--acao" data-ok>Usar este vale</button>
      </div>
    `,
    aoAbrir: (corpo, fechar) => {
      const campo = corpo.querySelector('[data-codigo]');
      const situacao = corpo.querySelector('[data-situacao]');

      async function conferir() {
        const codigo = campo.value.trim().toUpperCase();
        if (!codigo) return;
        try {
          const vale = await api.get(`/vendas/vales/${encodeURIComponent(codigo)}`);
          const saldo = paraCentavos(vale.saldo);
          if (saldo <= 0) {
            situacao.innerHTML = '<p class="alerta">Este vale já foi usado por inteiro.</p>';
            return;
          }
          if (saldo < falta) {
            aviso(
              `O vale cobre ${formatar(saldo)}; o resto sai por outra forma.`,
              'alerta',
            );
          }
          fechar({ codigo, saldo });
        } catch {
          situacao.innerHTML = '<p class="alerta">Vale não encontrado.</p>';
        }
      }

      campo.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          void conferir();
        }
      });
      corpo.querySelector('[data-ok]').addEventListener('click', () => void conferir());
      corpo.querySelector('[data-nao]').addEventListener('click', () => fechar(undefined));
    },
  });
}

/**
 * Escolhe (ou cadastra) a cliente da venda no fiado. Resolve o cliente ou `undefined`.
 *
 * Cadastrar aqui dentro não é conveniência: a cliente está na frente, com a peça na mão, e
 * mandar a vendedora sair da venda para cadastrar é o caminho mais curto para o fiado
 * voltar a ser anotado no papel — que é o problema que o crediário veio resolver.
 */
export function escolherCliente() {
  return modal({
    titulo: 'Fiado — de quem é a dívida?',
    largura: '480px',
    render: () => html`
      <label class="campo">
        <span>Procure pelo nome ou telefone</span>
        <input data-q placeholder="Maria" autocomplete="off" />
      </label>
      <div data-lista></div>
      <p class="texto-suave" style="margin-top:14px">Não está cadastrada?</p>
      <label class="campo"><span>Nome</span><input data-nome maxlength="120" /></label>
      <label class="campo"><span>Telefone</span><input data-telefone maxlength="20" /></label>
      <div class="modal__acoes">
        <button class="botao botao--neutro" data-nao>Cancelar</button>
        <button class="botao" data-cadastrar>Cadastrar e usar</button>
      </div>
    `,
    aoAbrir: (corpo, fechar) => {
      const lista = corpo.querySelector('[data-lista]');
      let achados = [];

      async function procurar(termo) {
        if (termo.length < 2) {
          lista.innerHTML = '';
          return;
        }
        try {
          const { items } = await api.get('/clientes', { q: termo, size: 8 });
          achados = items;
          lista.innerHTML = items.length
            ? html`
                <div class="busca-peca" style="position:static;box-shadow:none;max-height:220px">
                  ${items.map(
                    (c) => html`
                      <button type="button" class="busca-peca__item" data-cliente="${c.id}">
                        <span class="busca-peca__nome">${c.nome}</span>
                        <span class="busca-peca__grade">${c.telefone || 'sem telefone'}</span>
                        <span class="busca-peca__saldo ${paraCentavos(c.deve) > 0 ? 'is-zerado' : ''}">
                          ${paraCentavos(c.deve) > 0
                            ? `deve ${formatar(paraCentavos(c.deve))}`
                            : 'em dia'}
                        </span>
                      </button>
                    `,
                  )}
                </div>
              `
            : '<p class="texto-suave">Ninguém com esse nome.</p>';
          lista.querySelectorAll('[data-cliente]').forEach((b) =>
            b.addEventListener('click', () => {
              const c = achados.find((x) => x.id === Number(b.dataset.cliente));
              // Avisa, não bloqueia (ADR-20): quem conhece a freguesa é a dona, e travar
              // aqui só ensina a lançar como dinheiro e anotar no papel.
              if (c?.acima_do_limite) aviso(`${c.nome} está acima do limite combinado.`, 'alerta');
              fechar(c);
            }),
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
        const nome = corpo.querySelector('[data-nome]').value.trim();
        if (nome.length < 2) {
          aviso('Escreva o nome da cliente.', 'alerta');
          return;
        }
        try {
          fechar(
            await api.post('/clientes', {
              nome,
              telefone: corpo.querySelector('[data-telefone]').value.trim() || null,
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
