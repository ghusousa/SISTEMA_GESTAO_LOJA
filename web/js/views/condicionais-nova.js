/**
 * Nova condicional: bipar o que a cliente vai levar para provar (ADR-39).
 *
 * O mesmo campo da Entrada e do PDV: bipe ou nome (`busca-peca.js`). Gravar tira as peças
 * do saldo na hora — enquanto estiverem com a cliente, o balcão não as vende de novo.
 *
 * A cliente é obrigatória (é a ela que se liga quando o prazo vence) e vem da busca de
 * balcão (`GET /clientes/balcao`, sem saldo nem limite), que é de toda a equipe.
 */

import { api, ErroApi } from '../api.js';
import { ligarBuscaDePeca } from '../busca-peca.js';
import { formatar, paraCentavos, somar } from '../dinheiro.js';
import { criarLeitor, manterFoco } from '../leitor.js';
import { ir } from '../router.js';
import { novoClientUuid } from '../store.js';
import { pintarConferencia } from '../tabela-conferencia.js';
import { aviso, avisarErro, comAtraso, hojeISO, html, modal, plural } from '../ui.js';

export function render(raiz) {
  /** `{ variante_id, produto, tamanho, cor, codigo_barras, preco_venda, quantidade }` */
  let itens = [];
  let cliente = null;
  let chave = null; // nasce no primeiro envio e fica até dar certo (reenvio não tira duas vezes)
  let enviando = false;

  raiz.innerHTML = html`
    <div class="pagina pagina--larga pdv">
      <div>
        <div class="pdv__leitura">
          <div class="pdv__campo">
            <label class="so-leitor" for="leitura-condicional">Código de barras ou nome da peça</label>
            <input id="leitura-condicional" data-leitor type="text" autocomplete="off"
              placeholder="Bipe a etiqueta ou digite o nome da peça" />
            <span class="pdv__pisca">Leitor pronto</span>
          </div>
          <div class="busca-peca" data-busca hidden></div>
        </div>
        <div class="pdv__itens" data-itens></div>
      </div>

      <aside class="pdv__resumo">
        <h2 style="margin-bottom:6px">Nova condicional</h2>
        <p class="texto-fraco" style="margin-bottom:12px">
          As peças <strong>saem do estoque</strong> agora e voltam (ou viram venda) quando a
          cliente trouxer a sacola.
        </p>
        <div class="campo">
          <span>Cliente</span>
          <button class="botao botao--neutro botao--largo" data-cliente>Escolher a cliente</button>
        </div>
        <label class="campo">
          <span>Prazo para devolver</span>
          <input data-prazo type="date" min="${hojeISO()}" required />
        </label>
        <label class="campo">
          <span>Observação <span class="campo__dica">opcional</span></span>
          <input data-observacao maxlength="500" />
        </label>
        <div class="pdv__linha"><span class="texto-suave">Peças</span><strong data-pecas>0</strong></div>
        <div class="pdv__linha"><span class="texto-suave">Valor</span><span class="dinheiro" data-valor>R$ 0,00</span></div>
        <button class="botao botao--acao botao--largo botao--grande" data-salvar style="margin-top:14px" disabled>
          Registrar condicional
        </button>
        <a class="botao botao--neutro botao--largo botao--pequeno" href="#/condicionais" style="margin-top:8px">Ver as abertas</a>
      </aside>
    </div>
  `;

  const campo = raiz.querySelector('[data-leitor]');
  const areaItens = raiz.querySelector('[data-itens]');
  const botaoSalvar = raiz.querySelector('[data-salvar]');
  const botaoCliente = raiz.querySelector('[data-cliente]');
  const campoPrazo = raiz.querySelector('[data-prazo]');

  function mudarItens(novos) {
    itens = novos;
    chave = null; // outra sacola é outro pedido: a chave antiga já não serve para ela
    pintar();
  }

  function somarPeca(peca) {
    const id = peca.variante_id ?? peca.id;
    const existe = itens.find((i) => i.variante_id === id);
    mudarItens(
      existe
        ? itens.map((i) => (i.variante_id === id ? { ...i, quantidade: i.quantidade + 1 } : i))
        : [...itens, {
            variante_id: id, produto: peca.produto, tamanho: peca.tamanho, cor: peca.cor,
            codigo_barras: peca.codigo_barras, preco_venda: peca.preco_venda, quantidade: 1,
          }],
    );
  }

  async function lerCodigo(codigo) {
    try {
      somarPeca(await api.get(`/variantes/codigo-barras/${encodeURIComponent(codigo)}`));
    } catch (erro) {
      avisarErro(erro instanceof ErroApi && erro.status === 404
        ? { message: `Nenhuma peça com o código ${codigo}.` } : erro);
    }
  }

  function pintar() {
    if (itens.length) {
      pintarConferencia({ area: areaItens, itens, veDinheiro: false, aoMudar: mudarItens });
    } else {
      areaItens.innerHTML = html`
        <div class="vazio" style="border:0;box-shadow:none">
          <p class="vazio__titulo">O que a cliente vai levar?</p>
          <p class="texto-suave">Bipe a etiqueta ou digite o nome da peça e escolha da lista.</p>
        </div>`;
    }
    const pecas = somar(itens.map((i) => i.quantidade));
    raiz.querySelector('[data-pecas]').textContent = pecas;
    raiz.querySelector('[data-valor]').textContent = formatar(
      somar(itens.map((i) => paraCentavos(i.preco_venda) * i.quantidade)),
    );
    botaoCliente.textContent = cliente ? `${cliente.nome}${cliente.telefone ? ` · ${cliente.telefone}` : ''}` : 'Escolher a cliente';
    botaoSalvar.disabled = enviando || !itens.length;
  }

  async function salvar() {
    if (enviando || !itens.length) return;
    if (!cliente) return avisarErro({ message: 'Escolha a cliente que está levando as peças.' });
    if (!campoPrazo.value) return avisarErro({ message: 'Combine o prazo para a cliente devolver.' });
    enviando = true;
    pintar();
    chave = chave || novoClientUuid();
    try {
      const condicional = await api.post('/condicionais', {
        client_uuid: chave,
        cliente_id: cliente.id,
        prazo: campoPrazo.value,
        observacao: raiz.querySelector('[data-observacao]').value.trim() || null,
        itens: itens.map((i) => ({ variante_id: i.variante_id, quantidade: i.quantidade })),
      });
      aviso(`Condicional #${condicional.id}: ${plural(condicional.total_pecas, 'peça saiu', 'peças saíram')} com ${condicional.cliente}.`);
      ir(`/condicionais/${condicional.id}`);
    } catch (erro) {
      if (erro instanceof ErroApi && erro.status === 409 && erro.detail?.condicional_id) chave = null;
      avisarErro(erro);
    } finally {
      enviando = false;
      if (raiz.isConnected) pintar();
    }
  }

  botaoCliente.addEventListener('click', async () => {
    const escolhida = await escolherCliente();
    if (escolhida) {
      cliente = escolhida;
      chave = null;
      pintar();
    }
    campo.focus();
  });
  campoPrazo.addEventListener('change', () => (chave = null));
  botaoSalvar.addEventListener('click', salvar);

  const busca = ligarBuscaDePeca({ campo, painel: raiz.querySelector('[data-busca]'), aoEscolher: somarPeca, mostrarPreco: true });
  const leitor = criarLeitor({ aoLer: lerCodigo, repeticaoMs: 250, ignorarQuando: busca.aberta });
  leitor.ligar();
  const pararFoco = manterFoco(campo);
  pintar();

  return () => {
    leitor.desligar();
    busca.desligar();
    pararFoco();
  };
}

/** Busca (ou cadastra no balcão) a cliente. Resolve `{id, nome, telefone}` ou `undefined`. */
function escolherCliente() {
  const chaveCadastro = novoClientUuid();
  return modal({
    titulo: 'Quem vai levar as peças?',
    largura: '480px',
    render: () => html`
      <label class="campo"><span>Procure pelo nome ou telefone</span><input data-q autocomplete="off" placeholder="Maria" /></label>
      <div data-lista></div>
      <p class="texto-suave" style="margin-top:14px">Primeira vez na loja?</p>
      <label class="campo"><span>Nome</span><input data-nome maxlength="120" /></label>
      <label class="campo"><span>Telefone</span><input data-telefone maxlength="20" inputmode="tel" /></label>
      <div class="modal__acoes">
        <button class="botao botao--neutro" data-nao>Cancelar</button>
        <button class="botao" data-cadastrar>Cadastrar e usar</button>
      </div>
    `,
    aoAbrir: (corpo, fechar) => {
      const lista = corpo.querySelector('[data-lista]');
      const buscar = comAtraso(async (q) => {
        try {
          const { items } = await api.get('/clientes/balcao', { q, size: 8 });
          lista.innerHTML = items.length
            ? items.map((c) => html`<button class="busca-peca__item" data-id="${c.id}" style="width:100%">
                <span class="busca-peca__nome">${c.nome}</span>
                <span class="busca-peca__grade">${c.telefone || ''}</span></button>`).join('')
            : html`<p class="texto-suave">Ninguém com esse nome.</p>`;
          lista.querySelectorAll('[data-id]').forEach((b) =>
            b.addEventListener('click', () => fechar(items.find((c) => c.id === Number(b.dataset.id)))),
          );
        } catch (erro) {
          lista.innerHTML = html`<p class="texto-suave">${erro.textoAmigavel || erro.message}</p>`;
        }
      });
      corpo.querySelector('[data-q]').addEventListener('input', (e) => buscar(e.target.value.trim()));
      buscar('');
      corpo.querySelector('[data-nao]').addEventListener('click', () => fechar(undefined));
      corpo.querySelector('[data-cadastrar]').addEventListener('click', async () => {
        const nome = corpo.querySelector('[data-nome]').value.trim();
        if (nome.length < 2) return avisarErro({ message: 'Digite o nome da cliente.' });
        try {
          fechar(await api.post('/clientes/balcao', {
            nome, telefone: corpo.querySelector('[data-telefone]').value.trim() || null, client_uuid: chaveCadastro,
          }));
        } catch (erro) {
          avisarErro(erro);
        }
      });
    },
  });
}

