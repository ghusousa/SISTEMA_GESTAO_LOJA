/**
 * Crediário — a caderneta, dentro do sistema.
 *
 * A loja já vendia fiado; o que não existia era o registro. Caderneta perdida é venda
 * perdida, e ninguém cobra o que não sabe que tem a receber.
 *
 * A tela abre em **quem está devendo**, não na lista inteira de clientes: a pergunta de
 * segunda-feira é "quem preciso cobrar?", e não "quantos clientes eu tenho". O limite
 * combinado aparece como aviso, nunca como bloqueio (ADR-20) — travar a venda ensina a
 * vendedora a lançar como dinheiro e anotar no papel, e aí a dívida some da conta.
 */

import { api } from '../api.js';
import { formatar, paraCentavos, paraDecimalString } from '../dinheiro.js';
import { novoClientUuid } from '../store.js';
import { trocarConsulta } from '../router.js';
import {
  ajuda,
  aviso,
  avisarErro,
  confirmar,
  cru,
  data as formatarData,
  html,
  ligarCampoDinheiro,
  modal,
  numero,
  plural,
} from '../ui.js';

export async function render(raiz, _params, consulta) {
  const somenteDevendo = consulta.devendo !== '0';
  const busca = consulta.q || '';

  raiz.innerHTML = html`
    <div class="pagina">
      <div class="pagina__topo">
        <div>
          <h1>Crediário</h1>
          <p class="texto-suave">Quem levou fiado, quanto deve e quem já acertou.</p>
        </div>
        <div class="pagina__acoes">
          <button class="botao botao--acao" data-novo>Novo cliente</button>
        </div>
      </div>

      <div class="filtros">
        <input data-q value="${busca}" placeholder="Nome, telefone ou documento" />
        <label class="filtro-check">
          <input type="checkbox" data-devendo ${somenteDevendo ? 'checked' : ''} />
          Só quem está devendo
        </label>
      </div>

      <div data-lista><div class="carregando">Carregando…</div></div>
    </div>
  `;

  const lista = raiz.querySelector('[data-lista]');

  raiz.querySelector('[data-q]').addEventListener('change', (e) =>
    trocarConsulta({ q: e.target.value.trim() || undefined }),
  );
  raiz.querySelector('[data-devendo]').addEventListener('change', (e) =>
    trocarConsulta({ devendo: e.target.checked ? undefined : '0' }),
  );
  raiz.querySelector('[data-novo]').addEventListener('click', () => abrirCadastro());

  async function carregar() {
    try {
      const { items, total } = await api.get('/clientes', {
        q: busca || undefined,
        somente_devendo: somenteDevendo,
        size: 50,
      });
      if (!items.length) {
        lista.innerHTML = html`
          <div class="vazio">
            <p class="vazio__titulo">${somenteDevendo ? 'Ninguém devendo' : 'Nenhum cliente'}</p>
            <p class="texto-suave">
              ${somenteDevendo
                ? 'Todo mundo em dia — é o estado que a gente quer.'
                : 'Cadastre a cliente na hora de vender no fiado.'}
            </p>
          </div>
        `;
        return;
      }
      const devendo = items.filter((c) => Number(c.deve) > 0);
      const totalDevido = devendo.reduce((t, c) => t + paraCentavos(c.deve), 0);
      lista.innerHTML = html`
        ${devendo.length
          ? cru(html`
              <div class="cartao" style="margin-bottom:12px">
                <div class="cartao__corpo">
                  <span class="texto-suave">A receber de ${plural(devendo.length, 'cliente', 'clientes')}:</span>
                  <strong class="dinheiro" style="font-size:22px;display:block">${formatar(totalDevido)}</strong>
                </div>
              </div>
            `)
          : ''}
        <table>
          <thead>
            <tr><th>Cliente</th><th>Telefone</th><th class="direita">Deve ${ajuda('O que ela ainda deve: o que levou no fiado, menos o que já pagou e menos o que devolveu. A conta é refeita toda vez que a tela abre.')}</th><th></th></tr>
          </thead>
          <tbody>
            ${items.map(
              (c) => html`
                <tr>
                  <td>
                    <span class="celula-principal">${c.nome}</span>
                    ${c.acima_do_limite
                      ? cru('<span class="celula-secundaria alerta">acima do limite combinado</span>')
                      : ''}
                  </td>
                  <td>${c.telefone || '—'}</td>
                  <td class="direita dinheiro ${Number(c.deve) > 0 ? 'negativo' : ''}">
                    ${formatar(paraCentavos(c.deve))}
                  </td>
                  <td class="direita">
                    <button class="botao botao--fantasma botao--pequeno" data-extrato="${c.id}">Extrato</button>
                    ${Number(c.deve) > 0
                      ? cru(html`<button class="botao botao--pequeno" data-receber="${c.id}">Receber</button>`)
                      : ''}
                  </td>
                </tr>
              `,
            )}
          </tbody>
        </table>
        <p class="texto-fraco">${plural(total, 'cliente', 'clientes')}</p>
      `;
      lista.querySelectorAll('[data-extrato]').forEach((b) =>
        b.addEventListener('click', () => void abrirExtrato(Number(b.dataset.extrato))),
      );
      lista.querySelectorAll('[data-receber]').forEach((b) =>
        b.addEventListener('click', () => void abrirRecebimento(Number(b.dataset.receber))),
      );
    } catch (erro) {
      avisarErro(erro);
      lista.innerHTML = '<div class="vazio"><p class="vazio__titulo">Não deu para carregar</p></div>';
    }
  }

  /* ------------------------------------------------------------- cadastro */

  function abrirCadastro() {
    modal({
      titulo: 'Novo cliente',
      render: () => html`
          <label class="campo"><span>Nome</span><input data-nome maxlength="120" placeholder="Maria da Silva" /></label>
          <label class="campo"><span>Telefone</span><input data-telefone maxlength="20" placeholder="(11) 99999-8888" /></label>
          <label class="campo"><span>Documento <span class="campo__dica">opcional</span></span><input data-documento maxlength="20" /></label>
          <label class="campo">
            <span>Limite combinado <span class="campo__dica">só avisa, não bloqueia</span> ${ajuda('Quanto você aceita deixar essa cliente dever. Passando disso a tela avisa e a venda continua: quem decide na hora é você.')}</span>
            <input data-limite inputmode="numeric" />
          </label>
        <button class="botao botao--acao botao--largo" data-ok>Cadastrar</button>
      `,
      aoAbrir: (corpo, fechar) => {
        let limite = 0;
        ligarCampoDinheiro(corpo.querySelector('[data-limite]'), 0, (v) => {
          limite = v;
        });
        corpo.querySelector('[data-ok]').addEventListener('click', async () => {
          const nome = corpo.querySelector('[data-nome]').value.trim();
          if (nome.length < 2) {
            aviso('Escreva o nome da cliente.', 'alerta');
            return;
          }
          try {
            await api.post('/clientes', {
              nome,
              telefone: corpo.querySelector('[data-telefone]').value.trim() || null,
              documento: corpo.querySelector('[data-documento]').value.trim() || null,
              limite: limite > 0 ? paraDecimalString(limite) : null,
            });
            fechar();
            aviso(`${nome} cadastrada.`);
            void carregar();
          } catch (erro) {
            avisarErro(erro);
          }
        });
      },
    });
  }

  /* -------------------------------------------------------------- extrato */

  // Compras e pagamentos vêm paginados juntos (o mesmo ?page=&size=): "Carregar mais" traz a
  // próxima leva das duas listas. Os totais do topo são da conta inteira, nunca da página —
  // a caderneta de anos não desce numa resposta só, e a conta continua fechando.
  const linhaVenda = (v) => html`
    <tr>
      <td><a href="#/vendas/${v.venda_id}">Venda #${v.venda_id}</a></td>
      <td>${formatarData(v.vendida_em)}</td>
      <td class="direita dinheiro">${formatar(paraCentavos(v.no_fiado))}</td>
    </tr>`;
  const linhaPagamento = (p) => html`
    <tr>
      <td>${formatarData(p.pago_em)}</td>
      <td>${p.forma.toLowerCase()}</td>
      <td class="direita dinheiro">${formatar(paraCentavos(p.valor))}</td>
    </tr>`;
  const temMais = ({ vendas, pagamentos }) =>
    vendas.page * vendas.size < Math.max(vendas.total, pagamentos.total);

  async function abrirExtrato(clienteId) {
    const buscar = (page) => api.get(`/clientes/${clienteId}/extrato`, { page, size: 20 });
    try {
      const extrato = await buscar(1);
      modal({
        titulo: extrato.cliente.nome,
        largura: '620px',
        render: () => html`
            <div class="pdv__linha"><span class="texto-suave">Levou no fiado</span><span class="dinheiro">${formatar(paraCentavos(extrato.total_fiado))}</span></div>
            <div class="pdv__linha"><span class="texto-suave">Já pagou</span><span class="dinheiro">${formatar(paraCentavos(extrato.total_pago))}</span></div>
            <div class="pdv__linha"><span class="texto-suave">Devolveu</span><span class="dinheiro">${formatar(paraCentavos(extrato.total_devolvido))}</span></div>
            <div class="pdv__total"><span>Deve</span><strong class="dinheiro">${formatar(paraCentavos(extrato.deve))}</strong></div>

            <h3 style="margin-top:16px">Compras no fiado</h3>
            ${extrato.vendas.total
              ? cru(html`<table><tbody data-vendas>${extrato.vendas.items.map(linhaVenda)}</tbody></table>`)
              : cru('<p class="texto-suave">Nenhuma.</p>')}

            <h3 style="margin-top:16px">Pagamentos</h3>
            ${extrato.pagamentos.total
              ? cru(html`<table><tbody data-pagamentos>${extrato.pagamentos.items.map(linhaPagamento)}</tbody></table>`)
              : cru('<p class="texto-suave">Ainda não pagou nada.</p>')}
            ${temMais(extrato)
              ? cru('<button class="botao botao--neutro botao--largo" style="margin-top:12px" data-mais>Carregar mais</button>')
              : ''}
        `,
        aoAbrir: (corpo) => {
          const mais = corpo.querySelector('[data-mais]');
          let ultima = extrato;
          mais?.addEventListener('click', async () => {
            mais.disabled = true;
            try {
              ultima = await buscar(ultima.vendas.page + 1);
              corpo.querySelector('[data-vendas]')
                ?.insertAdjacentHTML('beforeend', ultima.vendas.items.map(linhaVenda).join(''));
              corpo.querySelector('[data-pagamentos]')
                ?.insertAdjacentHTML('beforeend', ultima.pagamentos.items.map(linhaPagamento).join(''));
              if (!temMais(ultima)) mais.remove();
            } catch (erro) {
              avisarErro(erro);
            } finally {
              mais.disabled = false;
            }
          });
        },
      });
    } catch (erro) {
      avisarErro(erro);
    }
  }

  /* ---------------------------------------------------------- recebimento */

  async function abrirRecebimento(clienteId) {
    const cliente = await api.get(`/clientes/${clienteId}`);
    modal({
      titulo: `Receber de ${cliente.nome}`,
      render: () => html`
          <p class="texto-suave">Deve <strong class="dinheiro">${formatar(paraCentavos(cliente.deve))}</strong>.</p>
          <label class="campo"><span>Valor recebido ${ajuda('Pode receber em partes. O sistema não aceita mais do que ela deve hoje, senão a loja é que ficaria devendo a ela.')}</span><input data-valor inputmode="numeric" /></label>
          <label class="campo">
            <span>Forma ${ajuda('Como o dinheiro entrou. O que você receber hoje entra na conferência da gaveta do dia por essa forma.')}</span>
            <select data-forma>
              <option value="DINHEIRO">Dinheiro</option>
              <option value="PIX">PIX</option>
              <option value="DEBITO">Débito</option>
              <option value="CREDITO">Crédito</option>
            </select>
          </label>
        <button class="botao botao--acao botao--largo" data-ok>Registrar pagamento</button>
      `,
      aoAbrir: (corpo, fechar) => {
        // Já vem preenchido com o que falta: é o valor que a pessoa digita em nove de dez
        // vezes, e o campo de dinheiro troca tudo no primeiro dígito se for outro.
        let valor = paraCentavos(cliente.deve);
        ligarCampoDinheiro(corpo.querySelector('[data-valor]'), valor, (v) => {
          valor = v;
        });
        // Um uuid por diálogo aberto, não por clique: se a resposta se perder no caminho e
        // a pessoa clicar de novo, o servidor reconhece o replay e responde o MESMO
        // pagamento. Com uuid novo a cada envio, o segundo clique perdoaria uma dívida que
        // ninguém pagou — que é justamente o que o UNIQUE de `customer_payments` existe
        // para impedir.
        const clientUuid = novoClientUuid();
        const botao = corpo.querySelector('[data-ok]');
        let enviando = false;
        botao.addEventListener('click', async () => {
          if (enviando) return;
          if (valor <= 0) {
            aviso('Informe o valor recebido.', 'alerta');
            return;
          }
          enviando = true;
          botao.disabled = true;
          botao.innerHTML = cru('<span class="giro" aria-hidden="true"></span> Registrando…');
          try {
            await api.post(`/clientes/${clienteId}/pagamentos`, {
              forma: corpo.querySelector('[data-forma]').value,
              valor: paraDecimalString(valor),
              client_uuid: clientUuid,
            });
            fechar();
            aviso(`${formatar(valor)} recebidos de ${cliente.nome}.`);
            void carregar();
          } catch (erro) {
            avisarErro(erro);
            enviando = false;
            botao.disabled = false;
            botao.textContent = 'Registrar pagamento';
          }
        });
      },
    });
  }

  await carregar();
}
