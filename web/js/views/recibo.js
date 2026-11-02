/**
 * Recibo da venda, para dar à cliente.
 *
 * Não é nota fiscal e não finge ser — está escrito no rodapé. É o papel que a loja de
 * bairro entrega há sempre: o que levou, quanto pagou, quando, com quem. Serve para trocar
 * depois, para conferir o cartão na fatura e para a cliente lembrar o que comprou.
 *
 * **Impresso em bobina de 80mm**, que é a impressora que existe em balcão de loja pequena.
 * A folha A4 também funciona (o navegador ajusta), mas a largura fixa é a da bobina porque
 * é nela que o recibo sai torto se ninguém pensar no assunto.
 *
 * O que NÃO entra aqui: custo, margem e qualquer número de dentro da loja. O papel vai
 * para a mão da cliente.
 *
 * Com NFC-e autorizada (ADR-41), o recibo diz a chave: a cliente consulta a nota na SEFAZ
 * com ela. O documento fiscal continua sendo o DANFE, aberto pelo detalhe da venda.
 */

import { api } from '../api.js';
import { formatar, paraCentavos } from '../dinheiro.js';
import { avisarErro, cru, dataHora, grade, html, numero, plural, rotuloPagamento } from '../ui.js';
import { garantirDadosDaLoja, loja } from '../loja.js';
import { linhaDoRecibo, situacaoDaNfce } from '../nfce.js';

const FORMAS = {
  DINHEIRO: 'Dinheiro',
  PIX: 'PIX',
  DEBITO: 'Cartão de débito',
  CREDITO: 'Cartão de crédito',
  VALE: 'Vale de troca',
  FIADO: 'Fiado',
};

export async function render(raiz, params) {
  raiz.innerHTML = '<div class="carregando">Carregando…</div>';

  let venda;
  let nfce;
  try {
    // O cabeçalho do recibo (documento, endereço, telefone) só vem com sessão; aberto pelo
    // F5, ele ainda não chegou. Pedir junto não atrasa nada.
    [venda, , nfce] = await Promise.all([
      api.get(`/vendas/${params.id}`),
      garantirDadosDaLoja(),
      situacaoDaNfce(params.id),
    ]);
  } catch (erro) {
    avisarErro(erro);
    raiz.innerHTML = '<div class="vazio"><p class="vazio__titulo">Venda não encontrada</p></div>';
    return;
  }

  const temFiado = venda.pagamentos.some((p) => p.forma === 'FIADO');

  raiz.innerHTML = html`
    <div class="pagina">
      <div class="folha-topo">
        <div class="pagina__topo">
          <div>
            <a class="botao botao--fantasma botao--pequeno" href="#/vendas/${venda.id}">← Venda #${venda.id}</a>
            <h1>Recibo</h1>
            <p class="texto-suave">
              Confira e imprima. Sai na largura de bobina de 80&nbsp;mm; em folha A4 o
              navegador ajusta sozinho.
            </p>
          </div>
          <div class="pagina__acoes">
            <button class="botao" data-imprimir>Imprimir</button>
          </div>
        </div>
      </div>

      <div class="recibo" data-recibo>
        <div class="recibo__cabecalho">
          <strong>${loja().nome}</strong>
          ${loja().documento ? cru(html`<span>${loja().documento}</span>`) : ''}
          ${loja().endereco ? cru(html`<span>${loja().endereco}</span>`) : ''}
          ${loja().telefone ? cru(html`<span>${loja().telefone}</span>`) : ''}
          <span>${dataHora(venda.vendida_em)}</span>
          <span>Venda #${venda.id} · ${venda.vendedor}</span>
          ${venda.cliente ? cru(html`<span>Cliente: ${venda.cliente}</span>`) : ''}
        </div>

        <div class="recibo__linhas">
          ${venda.itens.map(
            (item) => html`
              <div class="recibo__item">
                <span class="recibo__nome">${item.produto}</span>
                <span class="recibo__detalhe">
                  <span>${numero(item.quantidade)} × ${formatar(paraCentavos(item.preco_unitario))} · ${grade(item.tamanho, item.cor)}</span>
                  <span class="dinheiro">${formatar(paraCentavos(item.total_item))}</span>
                </span>
              </div>
            `,
          )}
        </div>

        <div class="recibo__contas">
          <div><span>Subtotal</span><span class="dinheiro">${formatar(paraCentavos(venda.subtotal))}</span></div>
          ${paraCentavos(venda.desconto) > 0
            ? cru(html`<div><span>Desconto</span><span class="dinheiro">− ${formatar(paraCentavos(venda.desconto))}</span></div>`)
            : ''}
          <div class="recibo__total"><span>Total</span><span class="dinheiro">${formatar(paraCentavos(venda.total))}</span></div>
          ${venda.pagamentos.map(
            (p) => html`
              <div class="recibo__pagamento">
                <span>${rotuloPagamento(p, FORMAS)}</span>
                <span class="dinheiro">${formatar(paraCentavos(p.valor))}</span>
              </div>
            `,
          )}
        </div>

        ${temFiado
          ? cru(html`
              <p class="recibo__aviso">
                Parte desta compra ficou no fiado. Guarde este recibo para conferir o
                acerto.
              </p>
            `)
          : ''}

        <div class="recibo__rodape">
          <span>${plural(venda.quantidade_pecas, 'peça', 'peças')}</span>
          <span>Troca em até 30 dias, com este recibo e a etiqueta na peça.</span>
          ${cru(linhaDoRecibo(nfce))}
          <span class="recibo__miudo">Este recibo não tem valor fiscal${nfce?.nota?.status === 'AUTORIZADA' ? ': a nota é a NFC-e acima' : ''}.</span>
        </div>
      </div>
    </div>
  `;

  raiz.querySelector('[data-imprimir]')?.addEventListener('click', () => window.print());
}
