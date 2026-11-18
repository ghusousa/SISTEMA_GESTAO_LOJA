/**
 * Cobrança: escolher a forma de pagamento, fechar a venda e mostrar o troco.
 *
 * O troco é calculado sobre o DINHEIRO recebido menos a PARTE em dinheiro da venda — nunca
 * sobre o total. Numa venda de R$ 200 paga com R$ 150 no cartão e R$ 50 em dinheiro, quem
 * comparasse a nota de R$ 50 com o total devolveria troco negativo, e quem comparasse com o
 * total pago devolveria R$ 150 a mais. O troco não vai para a API: é conta do balcão.
 */

import { api } from '../api.js';
import { escolherClienteDaVenda } from '../cliente-balcao.js';
import { pedirParcelas } from '../pagar-credito.js';
import { escolherCliente, pedirVale } from '../pagar-fiado-vale.js';
import { PODE, pode } from '../permissoes.js';
import { mostrarRecibo } from '../recibo-pdv.js';
import { formatar, paraDecimalString, somar } from '../dinheiro.js';
import {
  FORMAS,
  ajuda,
  avisarErro,
  cru,
  html,
  ligarCampoDinheiro,
  modal,
  rotuloPagamento,
} from '../ui.js';

const ICONES = { DINHEIRO: '💵', PIX: '📱', DEBITO: '💳', CREDITO: '🧾', VALE: '🎟️', FIADO: '🤝' };
// Vale e fiado no fim: são a exceção, e a mão vai primeiro no que acontece o dia todo.
const ORDEM = ['DINHEIRO', 'PIX', 'DEBITO', 'CREDITO', 'VALE', 'FIADO'];
// As duas formas que não são dinheiro entrando: é aqui que a dúvida aparece, com a
// cliente na frente. As outras quatro se explicam sozinhas.
const DICAS = {
  VALE: 'Crédito de uma devolução anterior, no papel que a cliente trouxe. Não é dinheiro na gaveta: não entra na conferência do caixa.',
  FIADO: 'A cliente leva agora e paga depois. O limite dela avisa, mas não impede a venda. Fiado não entra na conferência da gaveta.',
};

/**
 * Fiado só aparece para quem cuida do crediário.
 *
 * Sem isto o botão existe para todo mundo, mas a busca de cliente responde 403 — e a
 * vendedora fica travada com a cliente na frente, que é exatamente o caminho de volta para
 * o papel. O vale continua para todos: consultar o papel na mão da cliente é do balcão.
 */
const formasVisiveis = () =>
  ORDEM.filter((forma) => forma !== 'FIADO' || pode(PODE.GERIR_CREDIARIO));

/**
 * Abre a cobrança. Resolve `true` quando a venda foi registrada (aí o carrinho pode sumir).
 */
export async function cobrar({ total, itens, desconto, clientUuid }) {
  if (total <= 0) {
    avisarErro({ message: 'O total da venda precisa ser maior que zero.' });
    return false;
  }

  const venda = await modal({
    titulo: 'Cobrança',
    largura: '470px',
    render: () => html`
      <div class="cobranca__valor">
        <span>Total a receber</span>
        <strong class="dinheiro">${formatar(total)}</strong>
      </div>

      <div class="formas">
        ${formasVisiveis().map(
          (forma) => html`
            <button class="forma" data-forma="${forma}" aria-pressed="false">
              <span class="forma__icone" aria-hidden="true">${ICONES[forma]}</span>
              <span>${FORMAS[forma]}</span>
            </button>
          `,
        )}
      </div>

      <div data-cliente></div>
      <div data-pagamentos></div>
      <div data-dinheiro></div>
      <div data-situacao></div>

      <div class="modal__acoes">
        <button class="botao botao--neutro" data-nao>Voltar</button>
        <button class="botao botao--acao" data-confirmar disabled>Registrar venda</button>
      </div>
    `,
    aoAbrir: (corpo, fechar) => ligarCobranca(corpo, fechar, { total, desconto, itens, clientUuid }),
  });

  if (!venda) return false;
  await mostrarRecibo(venda.dados, venda.troco);
  return true;
}

function ligarCobranca(corpo, fechar, { total, desconto, itens, clientUuid }) {
  /**
   * Quem está comprando. Opcional em qualquer venda (ADR-36) e obrigatório no fiado — o
   * fiado escolhe pela pergunta dele, que mostra a dívida; aqui é a porta do balcão.
   */
  let cliente = null;
  /** @type {{forma: string, valor: number, codigoVale?: string, parcelas?: number, bandeira?: string}[]} */
  let pagamentos = [];
  let recebidoEmDinheiro = 0;
  // O "recebido" nasce como SUGESTÃO (igual à parte em dinheiro) e a acompanha nos dois
  // sentidos enquanto ninguém digitar nele. Acompanhar só para cima deixava troco fantasma:
  // R$ 200 em dinheiro baixados para R$ 50 (+ R$ 150 no PIX) mantinham "recebido 200", que
  // ninguém digitou, e a tela mandava devolver R$ 150 a quem entregou R$ 50. Digitado, o
  // número é o que a cliente entregou de fato: a parte mudar não o reescreve — se ele ficar
  // menor que a parte, a tela avisa em vez de inventar um valor que ninguém recebeu.
  let recebidoDigitado = false;
  let enviando = false;

  const areaCliente = corpo.querySelector('[data-cliente]');
  const areaPagamentos = corpo.querySelector('[data-pagamentos]');
  const areaDinheiro = corpo.querySelector('[data-dinheiro]');
  const areaSituacao = corpo.querySelector('[data-situacao]');
  const botaoConfirmar = corpo.querySelector('[data-confirmar]');

  const pagoAteAgora = () => somar(pagamentos.map((p) => p.valor));
  const emDinheiro = () => pagamentos.find((p) => p.forma === 'DINHEIRO')?.valor ?? 0;
  const falta = () => total - pagoAteAgora();
  const troco = () => Math.max(0, recebidoEmDinheiro - emDinheiro());

  function atualizarSituacao() {
    const restante = falta();
    const parteDinheiro = emDinheiro();
    const faltaDinheiro = parteDinheiro > 0 && recebidoEmDinheiro < parteDinheiro;

    if (restante > 0) {
      areaSituacao.innerHTML = html`
        <div class="troco falta">
          <span>Ainda falta</span>
          <strong class="dinheiro">${formatar(restante)}</strong>
        </div>
      `;
    } else if (restante < 0) {
      areaSituacao.innerHTML = html`
        <div class="troco falta">
          <span>Passou do total em</span>
          <strong class="dinheiro">${formatar(-restante)}</strong>
        </div>
      `;
    } else if (faltaDinheiro) {
      areaSituacao.innerHTML = html`
        <div class="troco falta">
          <span>Dinheiro recebido é menor que a parte em dinheiro</span>
          <strong class="dinheiro">${formatar(parteDinheiro - recebidoEmDinheiro)}</strong>
        </div>
      `;
    } else if (troco() > 0) {
      areaSituacao.innerHTML = html`
        <div class="troco">
          <span>Troco</span>
          <strong class="dinheiro">${formatar(troco())}</strong>
        </div>
      `;
    } else {
      areaSituacao.innerHTML = '';
    }

    botaoConfirmar.disabled = enviando || restante !== 0 || !pagamentos.length || faltaDinheiro;
  }

  function pintarPagamentos() {
    corpo.querySelectorAll('[data-forma]').forEach((b) => {
      b.setAttribute('aria-pressed', String(pagamentos.some((p) => p.forma === b.dataset.forma)));
    });

    areaPagamentos.innerHTML = pagamentos
      .map(
        (p, i) => html`
          <div class="pagamento-linha">
            <span aria-hidden="true">${ICONES[p.forma]}</span>
            <strong>${rotuloPagamento(p)} ${DICAS[p.forma] ? ajuda(DICAS[p.forma]) : ''}</strong>
            <input data-pagamento="${i}" style="width:120px;text-align:right" aria-label="Valor em ${FORMAS[p.forma]}" />
            <button class="botao-icone botao-icone--perigo" data-remover="${i}" aria-label="Tirar ${FORMAS[p.forma]}">✕</button>
          </div>
        `,
      )
      .join('');

    pagamentos.forEach((p, i) => {
      ligarCampoDinheiro(areaPagamentos.querySelector(`[data-pagamento="${i}"]`), p.valor, (valor) => {
        pagamentos[i].valor = valor;
        // Ajustar a parte em dinheiro sem mexer no recebido sugerido deixaria um troco fantasma.
        if (p.forma === 'DINHEIRO' && !recebidoDigitado) definirRecebido(valor);
        atualizarSituacao();
      });
    });
    areaPagamentos.querySelectorAll('[data-remover]').forEach((b) =>
      b.addEventListener('click', () => {
        pagamentos.splice(Number(b.dataset.remover), 1);
        if (!pagamentos.some((p) => p.forma === 'DINHEIRO')) {
          recebidoEmDinheiro = 0;
          recebidoDigitado = false;
        }
        // Tirar o fiado NÃO tira a cliente: ela continua sendo quem comprou (ADR-36). Se
        // não for, o ✕ da linha da cliente está logo acima.
        pintarTudo();
      }),
    );

    pintarDinheiro();
    atualizarSituacao();
  }

  let campoRecebido = null;

  function pintarDinheiro() {
    const parte = emDinheiro();
    if (!pagamentos.some((p) => p.forma === 'DINHEIRO')) {
      areaDinheiro.innerHTML = '';
      campoRecebido = null;
      return;
    }
    areaDinheiro.innerHTML = html`
      <label class="campo">
        <span>Dinheiro recebido <span class="campo__dica">para calcular o troco</span>${ajuda('Quanto a cliente entregou em mãos, só para calcular o troco. Na venda entra a parte em dinheiro acima, nunca este valor.')}</span>
        <input data-recebido inputmode="numeric" />
      </label>
    `;
    if (!recebidoDigitado) recebidoEmDinheiro = parte;
    campoRecebido = ligarCampoDinheiro(
      areaDinheiro.querySelector('[data-recebido]'),
      recebidoEmDinheiro,
      (valor) => {
        recebidoEmDinheiro = valor;
        recebidoDigitado = true;
        atualizarSituacao();
      },
    );
  }

  /** A sugestão acompanhando a parte em dinheiro. Não é digitação, embora avise o campo. */
  function definirRecebido(valor) {
    campoRecebido?.definir(valor);
    recebidoEmDinheiro = valor;
    recebidoDigitado = false;
  }

  function pintarCliente() {
    const temFiado = pagamentos.some((p) => p.forma === 'FIADO');
    if (!cliente && !pode(PODE.ATENDER_CLIENTE)) {
      areaCliente.innerHTML = '';
      return;
    }
    areaCliente.innerHTML = cliente
      ? html`
          <div class="pagamento-linha">
            <span aria-hidden="true">👤</span>
            <strong>${cliente.nome}</strong>
            <span class="texto-suave">${cliente.preferencias || ''}</span>
            ${temFiado
              ? ''
              : cru(html`<button class="botao-icone botao-icone--perigo" data-sem-cliente aria-label="Tirar a cliente da venda">✕</button>`)}
          </div>
        `
      : html`<button class="botao botao--fantasma botao--pequeno" data-por-cliente>👤 Pôr o nome da cliente (opcional)</button>`;
    areaCliente.querySelector('[data-sem-cliente]')?.addEventListener('click', () => {
      cliente = null;
      pintarCliente();
    });
    areaCliente.querySelector('[data-por-cliente]')?.addEventListener('click', async () => {
      const escolhida = await escolherClienteDaVenda();
      if (!escolhida) return;
      cliente = escolhida;
      pintarCliente();
    });
  }

  const pintarTudo = () => {
    pintarCliente();
    pintarPagamentos();
  };

  corpo.querySelectorAll('[data-forma]').forEach((botao) =>
    botao.addEventListener('click', async () => {
      const forma = botao.dataset.forma;
      const indice = pagamentos.findIndex((p) => p.forma === forma);
      if (indice >= 0) {
        pagamentos.splice(indice, 1);
        if (forma === 'DINHEIRO') {
          recebidoEmDinheiro = 0;
          recebidoDigitado = false;
        }
      } else if (forma === 'CREDITO') {
        // Crédito pergunta antes: em quantas vezes e em que bandeira (ADR-35). A taxa não
        // aparece aqui — quem a fotografa é o servidor, pela tabela do dono.
        const escolha = await pedirParcelas(Math.max(0, falta()));
        if (!escolha) return;
        pagamentos.push({ forma, valor: Math.max(0, falta()), ...escolha });
      } else if (forma === 'VALE') {
        // Vale precisa saber QUAL vale antes de saber quanto. E o valor é limitado pelo
        // saldo dele: pedir mais faria o servidor recusar a venda inteira no fim.
        const vale = await pedirVale(Math.max(0, falta()));
        if (!vale) return;
        pagamentos.push({
          forma,
          valor: Math.min(Math.max(0, falta()), vale.saldo),
          codigoVale: vale.codigo,
        });
      } else if (forma === 'FIADO') {
        const escolhido = await escolherCliente();
        if (!escolhido) return;
        cliente = escolhido;
        pagamentos.push({ forma, valor: Math.max(0, falta()) });
      } else {
        // O normal é uma forma só: já entra com o que falta, e a venda fecha num clique.
        pagamentos.push({ forma, valor: Math.max(0, falta()) });
      }
      pintarTudo();
    }),
  );

  corpo.querySelector('[data-nao]').addEventListener('click', () => fechar(undefined));

  botaoConfirmar.addEventListener('click', async () => {
    if (enviando || falta() !== 0) return;
    enviando = true;
    botaoConfirmar.disabled = true;
    botaoConfirmar.innerHTML = cru('<span class="giro" aria-hidden="true"></span> Registrando…');

    try {
      const dados = await api.post('/vendas', {
        client_uuid: clientUuid,
        desconto: paraDecimalString(desconto),
        itens: itens.map((i) => ({ variante_id: i.variante_id, quantidade: i.quantidade })),
        cliente_id: cliente?.id ?? null,
        pagamentos: pagamentos
          .filter((p) => p.valor > 0)
          .map((p) => ({
            forma: p.forma,
            valor: paraDecimalString(p.valor),
            ...(p.codigoVale ? { codigo_vale: p.codigoVale } : {}),
            ...(p.parcelas ? { parcelas: p.parcelas } : {}),
            ...(p.bandeira ? { bandeira: p.bandeira } : {}),
          })),
      });
      fechar({ dados, troco: troco() });
    } catch (erro) {
      avisarErro(erro);
      enviando = false;
      botaoConfirmar.textContent = 'Registrar venda';
      atualizarSituacao();
    }
  });

  pintarTudo();
}
