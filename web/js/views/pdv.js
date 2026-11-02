/**
 * PDV — a tela do balcão.
 *
 * O leitor USB digita o código e dá Enter; o campo de leitura fica sempre com o cursor, para
 * que ninguém precise clicar antes de bipar. Quem tiver a etiqueta rasgada digita o código
 * no mesmo campo e aperta Enter — leitor e dedo entram pelo mesmo lugar.
 *
 * O carrinho vive no store (não aqui): conferir um preço no catálogo no meio da venda não
 * pode perder o que já foi bipado.
 */

import { api, ErroApi } from '../api.js';
import { ligarBuscaDePeca } from '../busca-peca.js';
import { criarLeitor, manterFoco } from '../leitor.js';
import { ir } from '../router.js';
import {
  carrinho,
  descontoEfetivo,
  limparCarrinho,
  novoClientUuid,
  subtotalCarrinho,
  totalCarrinho,
} from '../store.js';
import { formatar, paraCentavos } from '../dinheiro.js';
import {
  ajuda,
  aviso,
  avisarErro,
  confirmar,
  cru,
  grade,
  html,
  ligarCampoDinheiro,
  modal,
  numero,
  plural,
} from '../ui.js';
import { cobrar } from './pdv-cobranca.js';
import { ligarMetaDoDia } from './pdv-meta.js';

const LAYOUT = html`
  <div class="pagina pagina--larga pdv">
    <div>
      <div class="pdv__leitura">
        <div class="pdv__campo">
          <label class="so-leitor" for="leitura">Código de barras ou nome da peça</label>
          <input
            id="leitura"
            data-leitor
            type="text"
            autocomplete="off"
            placeholder="Bipe a etiqueta ou digite o nome da peça"
          />
          <span class="pdv__pisca">Leitor pronto</span>
        </div>
        <div class="busca-peca" data-busca hidden></div>
      </div>
      <div class="pdv__itens" data-itens></div>
    </div>

    <aside class="pdv__resumo">
      <div data-meta hidden style="margin-bottom:12px;padding-bottom:12px;border-bottom:1px solid var(--borda)"></div>
      <div class="pdv__linha">
        <span class="texto-suave">Itens ${ajuda('O que já foi bipado fica guardado se você sair para consultar um preço em outra tela. Some ao limpar a venda, ao sair do sistema ou se a página for recarregada.')}</span>
        <strong data-contagem>0 peças</strong>
      </div>
      <div class="pdv__linha">
        <span class="texto-suave">Subtotal</span>
        <span class="dinheiro" data-subtotal>R$ 0,00</span>
      </div>
      <div class="pdv__linha">
        <button class="botao botao--fantasma botao--pequeno" data-desconto>Desconto</button>
        <span class="dinheiro negativo" data-valor-desconto>—</span>
      </div>
      <div class="pdv__total">
        <span>Total</span>
        <strong class="dinheiro" data-total>R$ 0,00</strong>
      </div>

      <button class="botao botao--acao botao--largo botao--grande" data-cobrar style="margin-top:16px">
        Cobrar
      </button>
      <button class="botao botao--neutro botao--largo botao--pequeno" data-limpar style="margin-top:8px">
        Limpar venda
      </button>

      <div class="pdv__atalhos">
        <span><kbd>F2</kbd> cobrar · <kbd>F4</kbd> desconto · <kbd>Esc</kbd> limpar</span>
        <span>O leitor USB funciona sem clicar em nada. Etiqueta rasgada? Digite o nome.</span>
      </div>
    </aside>
  </div>
`;

export function render(raiz) {
  raiz.innerHTML = LAYOUT;

  const campo = raiz.querySelector('[data-leitor]');
  const areaItens = raiz.querySelector('[data-itens]');
  let ultimoAdicionado = null;
  let cobrando = false;

  /* ----------------------------------------------------------------- carrinho */

  /** Aceita a resposta do bipe (`variante_id`) e a da busca por nome (`id`). */
  function adicionar(bruta) {
    const peca = { ...bruta, variante_id: bruta.variante_id ?? bruta.id };
    const itens = [...carrinho.get().itens];
    const indice = itens.findIndex((i) => i.variante_id === peca.variante_id);
    const jaNoCarrinho = indice >= 0 ? itens[indice].quantidade : 0;

    if (jaNoCarrinho + 1 > peca.saldo) {
      aviso(
        peca.saldo === 0
          ? `${peca.produto} ${grade(peca.tamanho, peca.cor)} está sem estoque.`
          : `Só há ${plural(peca.saldo, 'peça', 'peças')} de ${peca.produto} ${grade(peca.tamanho, peca.cor)} no estoque.`,
        'alerta',
      );
      return;
    }

    if (indice >= 0) {
      // O saldo vem novo a cada bipada: aproveita para corrigir o que está na tela.
      itens[indice] = { ...itens[indice], quantidade: jaNoCarrinho + 1, saldo: peca.saldo };
    } else {
      itens.push({
        variante_id: peca.variante_id,
        produto: peca.produto,
        tamanho: peca.tamanho,
        cor: peca.cor,
        codigo_barras: peca.codigo_barras,
        preco_unitario: paraCentavos(peca.preco_venda),
        quantidade: 1,
        saldo: peca.saldo,
      });
    }
    ultimoAdicionado = peca.variante_id;
    carrinho.set({ itens });
  }

  function mudarQuantidade(varianteId, delta) {
    const itens = carrinho
      .get()
      .itens.map((i) => {
        if (i.variante_id !== varianteId) return i;
        const nova = i.quantidade + delta;
        if (nova > i.saldo) {
          aviso(`Estoque disponível: ${plural(i.saldo, 'peça', 'peças')}.`, 'alerta');
          return i;
        }
        return { ...i, quantidade: nova };
      })
      .filter((i) => i.quantidade > 0);
    carrinho.set({ itens });
  }

  function remover(varianteId) {
    carrinho.set({ itens: carrinho.get().itens.filter((i) => i.variante_id !== varianteId) });
  }

  /* -------------------------------------------------------------------- leitura */

  async function lerCodigo(codigo) {
    try {
      const peca = await api.get(`/variantes/codigo-barras/${encodeURIComponent(codigo)}`);
      adicionar(peca);
    } catch (erro) {
      if (erro instanceof ErroApi && erro.status === 404) codigoDesconhecido(codigo);
      else avisarErro(erro);
    }
  }

  async function codigoDesconhecido(codigo) {
    const cadastrar = await confirmar({
      titulo: 'Código não cadastrado',
      mensagem: `Nenhuma peça com o código ${codigo}. Quer cadastrar agora?`,
      confirmarTexto: 'Cadastrar peça',
    });
    if (cadastrar) ir(`/produtos/novo?codigo=${encodeURIComponent(codigo)}`);
  }

  /* ------------------------------------------------------------------ desenho */

  function linhaItem(item) {
    const total = item.preco_unitario * item.quantidade;
    return html`
      <tr data-linha="${item.variante_id}" class="${cru(item.variante_id === ultimoAdicionado ? 'pdv__ultimo' : '')}">
        <td>
          <span class="celula-principal">${item.produto}</span>
          <span class="celula-secundaria">${grade(item.tamanho, item.cor)} · ${item.codigo_barras}</span>
        </td>
        <td class="direita dinheiro">${formatar(item.preco_unitario)}</td>
        <td class="centro">
          <span class="qtd">
            <button data-menos="${item.variante_id}" aria-label="Tirar uma peça">−</button>
            <span>${numero(item.quantidade)}</span>
            <button data-mais="${item.variante_id}" aria-label="Somar uma peça"
              ${cru(item.quantidade >= item.saldo ? 'disabled title="Sem mais estoque"' : '')}>+</button>
          </span>
        </td>
        <td class="direita dinheiro celula-principal">${formatar(total)}</td>
        <td class="direita">
          <button class="botao-icone botao-icone--perigo" data-tirar="${item.variante_id}" aria-label="Tirar do carrinho">✕</button>
        </td>
      </tr>
    `;
  }

  function pintar() {
    const { itens } = carrinho.get();
    const pecas = itens.reduce((t, i) => t + i.quantidade, 0);

    areaItens.innerHTML = itens.length
      ? html`
          <table>
            <thead>
              <tr>
                <th>Peça</th>
                <th class="direita">Preço</th>
                <th class="centro">Qtd</th>
                <th class="direita">Total</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              ${itens.map(linhaItem)}
            </tbody>
          </table>
        `
      : html`
          <div class="vazio" style="border:0;box-shadow:none">
            <p class="vazio__titulo">Bipe a primeira peça</p>
            <p class="texto-suave">
              Passe a etiqueta no leitor. O código aparece no campo acima e a peça entra aqui.
            </p>
          </div>
        `;

    areaItens.querySelectorAll('[data-menos]').forEach((b) =>
      b.addEventListener('click', () => mudarQuantidade(Number(b.dataset.menos), -1)),
    );
    areaItens.querySelectorAll('[data-mais]').forEach((b) =>
      b.addEventListener('click', () => mudarQuantidade(Number(b.dataset.mais), +1)),
    );
    areaItens.querySelectorAll('[data-tirar]').forEach((b) =>
      b.addEventListener('click', () => remover(Number(b.dataset.tirar))),
    );

    const subtotal = subtotalCarrinho();
    const desconto = descontoEfetivo();
    raiz.querySelector('[data-contagem]').textContent = plural(pecas, 'peça', 'peças');
    raiz.querySelector('[data-subtotal]').textContent = formatar(subtotal);
    raiz.querySelector('[data-valor-desconto]').textContent = desconto ? `− ${formatar(desconto)}` : '—';
    raiz.querySelector('[data-total]').textContent = formatar(totalCarrinho());
    raiz.querySelector('[data-cobrar]').disabled = itens.length === 0;
    raiz.querySelector('[data-limpar]').disabled = itens.length === 0;
  }

  /* -------------------------------------------------------------------- ações */

  async function pedirDesconto() {
    if (!carrinho.get().itens.length) return;
    const subtotal = subtotalCarrinho();
    const valor = await modal({
      titulo: 'Desconto na venda',
      largura: '420px',
      render: () => html`
        <p class="texto-suave">Subtotal de ${formatar(subtotal)}.</p>
        <label class="campo">
          <span>Valor do desconto <span class="campo__dica">(digite só os números)</span>${ajuda('O desconto vale para a venda inteira, não para uma peça. Numa devolução volta o que a cliente pagou com o desconto, não o preço da etiqueta.')}</span>
          <input data-valor inputmode="numeric" />
        </label>
        <div class="pagina__acoes">
          <button class="botao botao--neutro botao--pequeno" data-pct="5">5%</button>
          <button class="botao botao--neutro botao--pequeno" data-pct="10">10%</button>
          <button class="botao botao--neutro botao--pequeno" data-pct="15">15%</button>
          <button class="botao botao--neutro botao--pequeno" data-pct="0">Sem desconto</button>
        </div>
        <div class="modal__acoes">
          <button class="botao botao--neutro" data-nao>Cancelar</button>
          <button class="botao" data-ok>Aplicar</button>
        </div>
      `,
      aoAbrir: (corpo, fechar) => {
        const campoValor = ligarCampoDinheiro(corpo.querySelector('[data-valor]'), descontoEfetivo());
        corpo.querySelectorAll('[data-pct]').forEach((b) =>
          b.addEventListener('click', () =>
            campoValor.definir(Math.round((subtotal * Number(b.dataset.pct)) / 100)),
          ),
        );
        corpo.querySelector('[data-nao]').addEventListener('click', () => fechar(undefined));
        corpo.querySelector('[data-ok]').addEventListener('click', () => fechar(campoValor.valor()));
      },
    });

    if (valor === undefined) return;
    if (valor > subtotal) {
      aviso('O desconto não pode passar do subtotal da venda.', 'alerta');
      return;
    }
    carrinho.set({ desconto: valor });
  }

  async function fecharVenda() {
    if (cobrando || !carrinho.get().itens.length) return;
    cobrando = true;
    try {
      // O client_uuid nasce quando a cobrança começa e sobrevive a uma repetição: se a
      // resposta se perder na rede, reenviar não cobra a cliente duas vezes.
      const uuid = carrinho.get().clientUuid || novoClientUuid();
      carrinho.set({ clientUuid: uuid });

      const concluida = await cobrar({
        total: totalCarrinho(),
        itens: carrinho.get().itens,
        desconto: descontoEfetivo(),
        clientUuid: uuid,
      });
      if (!concluida) return;

      limparCarrinho();
      ultimoAdicionado = null;
      leitor.esquecerUltimo();
      campo.value = '';
      campo.focus();
      metaDoDia.atualizar();
    } finally {
      cobrando = false;
    }
  }

  async function limpar() {
    if (!carrinho.get().itens.length) return;
    const certeza = await confirmar({
      titulo: 'Limpar a venda',
      mensagem: 'Tudo que foi bipado sai do carrinho. Nada é registrado.',
      confirmarTexto: 'Limpar',
      perigo: true,
    });
    if (!certeza) return;
    limparCarrinho();
    ultimoAdicionado = null;
    leitor.esquecerUltimo();
    campo.focus();
  }

  function atalhos(evento) {
    if (document.querySelector('.modal-fundo')) return;
    if (evento.key === 'F2') {
      evento.preventDefault();
      fecharVenda();
    } else if (evento.key === 'F4') {
      evento.preventDefault();
      pedirDesconto();
    } else if (evento.key === 'Escape') {
      evento.preventDefault();
      limpar();
    }
  }

  raiz.querySelector('[data-cobrar]').addEventListener('click', fecharVenda);
  raiz.querySelector('[data-limpar]').addEventListener('click', limpar);
  raiz.querySelector('[data-desconto]').addEventListener('click', pedirDesconto);

  // Etiqueta rasgada, peça que voltou da prova sem tag, cliente na fila: no balcão também
  // existe o dia em que não há o que bipar. O mesmo campo aceita o nome.
  const busca = ligarBuscaDePeca({
    campo,
    painel: raiz.querySelector('[data-busca]'),
    aoEscolher: adicionar,
    mostrarPreco: true,
  });
  const leitor = criarLeitor({ aoLer: lerCodigo, ignorarQuando: busca.aberta });
  leitor.ligar();
  const pararFoco = manterFoco(campo);
  const desinscrever = carrinho.inscrever(pintar);
  const metaDoDia = ligarMetaDoDia(raiz.querySelector('[data-meta]'));
  document.addEventListener('keydown', atalhos);
  pintar();

  return () => {
    metaDoDia.desligar();
    leitor.desligar();
    busca.desligar();
    pararFoco();
    desinscrever();
    document.removeEventListener('keydown', atalhos);
  };
}
