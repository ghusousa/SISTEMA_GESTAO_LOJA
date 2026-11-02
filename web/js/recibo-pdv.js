/**
 * O fim da cobrança: o troco na tela e o recibo de balcão para imprimir.
 *
 * Saiu de `views/pdv-cobranca.js` quando a cobrança ganhou parcelas e cliente (ADR-35 e
 * ADR-36) e passou do teto de linhas. O recibo é o papel que vai para a mão da cliente:
 * nada de custo, nada de taxa da maquininha.
 */

import { formatar, paraCentavos } from './dinheiro.js';
import { loja } from './loja.js';
import {
  FORMAS,
  cru,
  dataHora,
  escapar,
  grade,
  html,
  modal,
  numero,
  plural,
  rotuloPagamento,
} from './ui.js';

export async function mostrarRecibo(venda, troco) {
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
        ${venda.pagamentos.map((p) => rotuloPagamento(p)).join(' + ')}
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
        `<div class="l"><span>${escapar(rotuloPagamento(p, FORMAS))}</span><span>${escapar(formatar(paraCentavos(p.valor)))}</span></div>`,
    )
    .join('');

  // O papel que vai para a mão da cliente é onde o nome da loja mais importa: é por ele
  // que ela volta para trocar. Contato só entra quando existe — linha em branco no recibo
  // é pior do que recibo sem telefone.
  const l = loja();
  const cabecalhoDaLoja = [l.documento, l.endereco, l.telefone]
    .filter(Boolean)
    .map((linha) => `<div class="loja">${escapar(String(linha))}</div>`)
    .join('');

  const janela = window.open('', '_blank', 'width=380,height=640');
  if (!janela) return;
  janela.document.write(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
    <title>${escapar(l.nome)} — recibo ${venda.id}</title>
    <style>
      /* Bobina térmica de 80mm é a impressora de balcão. Contemos a LARGURA do
         conteúdo, sem fixar o tamanho da página: assim quem imprime em A4 (ou em PDF)
         continua funcionando, e a térmica para de cortar a direita. */
      body{font:12px system-ui,sans-serif;margin:0 auto;padding:5mm;max-width:80mm;color:#000}
      h1{font-size:15px;margin:0;text-align:center}
      .loja{text-align:center;color:#555;font-size:11px}
      .cab{margin-top:10px}
      table{width:100%;border-collapse:collapse;margin:10px 0}
      td{padding:4px 0;border-bottom:1px dotted #bbb;vertical-align:top}
      small{color:#555}
      .l{display:flex;justify-content:space-between;padding:2px 0}
      .t{display:flex;justify-content:space-between;font-size:16px;font-weight:700;
         border-top:2px solid #000;margin-top:8px;padding-top:6px}
      .r{text-align:center;color:#555;margin-top:14px;font-size:11px}
    </style></head><body>
    <h1>${escapar(l.nome)}</h1>
    ${cabecalhoDaLoja}
    <div class="l cab"><span>Venda nº ${venda.id}</span><span>${escapar(dataHora(venda.vendida_em))}</span></div>
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
