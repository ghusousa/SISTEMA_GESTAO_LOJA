/**
 * Cobrança: escolher a forma de pagamento, fechar a venda e mostrar o troco.
 *
 * O troco é calculado sobre o DINHEIRO recebido menos a PARTE em dinheiro da venda — nunca
 * sobre o total. Numa venda de R$ 200 paga com R$ 150 no cartão e R$ 50 em dinheiro, quem
 * comparasse a nota de R$ 50 com o total devolveria troco negativo, e quem comparasse com o
 * total pago devolveria R$ 150 a mais. O troco não vai para a API: é conta do balcão.
 */

import { api } from '../api.js';
import { formatar, paraCentavos, paraDecimalString, somar } from '../dinheiro.js';
import {
  FORMAS,
  avisarErro,
  cru,
  dataHora,
  escapar,
  grade,
  html,
  ligarCampoDinheiro,
  modal,
  numero,
  plural,
} from '../ui.js';

const ICONES = { DINHEIRO: '💵', PIX: '📱', DEBITO: '💳', CREDITO: '🧾' };
const ORDEM = ['DINHEIRO', 'PIX', 'DEBITO', 'CREDITO'];

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
        ${ORDEM.map(
          (forma) => html`
            <button class="forma" data-forma="${forma}" aria-pressed="false">
              <span class="forma__icone" aria-hidden="true">${ICONES[forma]}</span>
              <span>${FORMAS[forma]}</span>
            </button>
          `,
        )}
      </div>

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
  /** @type {{forma: string, valor: number}[]} */
  let pagamentos = [];
  let recebidoEmDinheiro = 0;
  let enviando = false;

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
            <strong>${FORMAS[p.forma]}</strong>
            <input data-pagamento="${i}" style="width:120px;text-align:right" aria-label="Valor em ${FORMAS[p.forma]}" />
            <button class="botao-icone botao-icone--perigo" data-remover="${i}" aria-label="Tirar ${FORMAS[p.forma]}">✕</button>
          </div>
        `,
      )
      .join('');

    pagamentos.forEach((p, i) => {
      ligarCampoDinheiro(areaPagamentos.querySelector(`[data-pagamento="${i}"]`), p.valor, (valor) => {
        pagamentos[i].valor = valor;
        // Ajustar a parte em dinheiro sem mexer no recebido deixaria um troco fantasma.
        if (p.forma === 'DINHEIRO' && recebidoEmDinheiro < valor) definirRecebido(valor);
        atualizarSituacao();
      });
    });
    areaPagamentos.querySelectorAll('[data-remover]').forEach((b) =>
      b.addEventListener('click', () => {
        pagamentos.splice(Number(b.dataset.remover), 1);
        if (!pagamentos.some((p) => p.forma === 'DINHEIRO')) recebidoEmDinheiro = 0;
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
        <span>Dinheiro recebido <span class="campo__dica">para calcular o troco</span></span>
        <input data-recebido inputmode="numeric" />
      </label>
    `;
    campoRecebido = ligarCampoDinheiro(
      areaDinheiro.querySelector('[data-recebido]'),
      Math.max(recebidoEmDinheiro, parte),
      (valor) => {
        recebidoEmDinheiro = valor;
        atualizarSituacao();
      },
    );
    recebidoEmDinheiro = Math.max(recebidoEmDinheiro, parte);
  }

  function definirRecebido(valor) {
    recebidoEmDinheiro = valor;
    campoRecebido?.definir(valor);
  }

  const pintarTudo = () => pintarPagamentos();

  corpo.querySelectorAll('[data-forma]').forEach((botao) =>
    botao.addEventListener('click', () => {
      const forma = botao.dataset.forma;
      const indice = pagamentos.findIndex((p) => p.forma === forma);
      if (indice >= 0) {
        pagamentos.splice(indice, 1);
        if (forma === 'DINHEIRO') recebidoEmDinheiro = 0;
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
        pagamentos: pagamentos
          .filter((p) => p.valor > 0)
          .map((p) => ({ forma: p.forma, valor: paraDecimalString(p.valor) })),
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

/* --------------------------------------------------------------------- recibo */

async function mostrarRecibo(venda, troco) {
  await modal({
    titulo: `Venda #${venda.id} registrada`,
    largura: '440px',
    render: () => html`
      ${troco > 0
        ? cru(html`
            <div class="troco" style="margin-bottom:14px">
              <span>Troco para a cliente</span>
              <strong class="dinheiro">${formatar(troco)}</strong>
            </div>
          `)
        : ''}
      <div class="cobranca__valor" style="padding-top:0">
        <span>Total da venda</span>
        <strong class="dinheiro">${formatar(paraCentavos(venda.total))}</strong>
      </div>
      <p class="texto-suave centro">
        ${plural(venda.quantidade_pecas, 'peça', 'peças')} ·
        ${venda.pagamentos.map((p) => FORMAS[p.forma]).join(' + ')}
      </p>
      <div class="modal__acoes">
        <button class="botao botao--neutro" data-imprimir>Imprimir recibo</button>
        <button class="botao botao--acao" data-ok>Próxima venda</button>
      </div>
    `,
    aoAbrir: (corpo, fechar) => {
      corpo.querySelector('[data-ok]').addEventListener('click', () => fechar(true));
      corpo.querySelector('[data-imprimir]').addEventListener('click', () => imprimir(venda, troco));
      corpo.querySelector('[data-ok]').focus();
    },
  });
}

/**
 * Recibo simples numa janela à parte: a loja não emite documento fiscal (fora do escopo do
 * v1), isso aqui é o comprovante de balcão que a cliente leva.
 */
function imprimir(venda, troco) {
  const linhas = venda.itens
    .map(
      (i) => `<tr><td>${escapar(i.produto)}<br><small>${escapar(grade(i.tamanho, i.cor))}</small></td>
        <td style="text-align:center">${numero(i.quantidade)}</td>
        <td style="text-align:right">${escapar(formatar(paraCentavos(i.total_item)))}</td></tr>`,
    )
    .join('');

  const pagamentos = venda.pagamentos
    .map(
      (p) =>
        `<div class="l"><span>${escapar(FORMAS[p.forma])}</span><span>${escapar(formatar(paraCentavos(p.valor)))}</span></div>`,
    )
    .join('');

  const janela = window.open('', '_blank', 'width=380,height=640');
  if (!janela) return;
  janela.document.write(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
    <title>Recibo ${venda.id}</title>
    <style>
      body{font:12px system-ui,sans-serif;margin:14px;color:#000}
      h1{font-size:15px;margin:0 0 2px}
      table{width:100%;border-collapse:collapse;margin:10px 0}
      td{padding:4px 0;border-bottom:1px dotted #bbb;vertical-align:top}
      small{color:#555}
      .l{display:flex;justify-content:space-between;padding:2px 0}
      .t{display:flex;justify-content:space-between;font-size:16px;font-weight:700;
         border-top:2px solid #000;margin-top:8px;padding-top:6px}
      .r{text-align:center;color:#555;margin-top:14px;font-size:11px}
    </style></head><body>
    <h1>Comprovante de venda</h1>
    <div class="l"><span>Venda nº ${venda.id}</span><span>${escapar(dataHora(venda.vendida_em))}</span></div>
    <div class="l"><span>Atendimento</span><span>${escapar(venda.vendedor)}</span></div>
    <table>${linhas}</table>
    <div class="l"><span>Subtotal</span><span>${escapar(formatar(paraCentavos(venda.subtotal)))}</span></div>
    ${paraCentavos(venda.desconto) > 0 ? `<div class="l"><span>Desconto</span><span>− ${escapar(formatar(paraCentavos(venda.desconto)))}</span></div>` : ''}
    <div class="t"><span>Total</span><span>${escapar(formatar(paraCentavos(venda.total)))}</span></div>
    ${pagamentos}
    ${troco > 0 ? `<div class="l"><span>Troco</span><span>${escapar(formatar(troco))}</span></div>` : ''}
    <p class="r">Não é documento fiscal.<br>Obrigada pela preferência!</p>
    </body></html>`);
  janela.document.close();
  janela.focus();
  janela.print();
}
