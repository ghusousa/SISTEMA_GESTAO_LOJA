/**
 * Uma condicional: o que a cliente levou e, quando ela volta, o fechamento (ADR-39).
 *
 * Fechar é conferir a sacola peça por peça: cada linha pede quantas VOLTARAM, sem valor
 * sugerido — "tudo voltou" é um botão, não o padrão, para ninguém confirmar no automático
 * e devolver ao estoque a peça que ficou no guarda-roupa da cliente. O que ficou vira venda
 * comum (caixa, recibo, comissão), com os pagamentos daqui; a conta do total é de
 * `condicional.js` e quem decide o preço de verdade é o servidor (ADR-4).
 */

import { api, ErroApi } from '../api.js';
import { itensDoFechamento, resumirFechamento, textoDoPrazo } from '../condicional.js';
import { formatar, paraCentavos, paraDecimalString, somar } from '../dinheiro.js';
import { pedirParcelas } from '../pagar-credito.js';
import { pedirVale } from '../pagar-fiado-vale.js';
import { PODE, pode } from '../permissoes.js';
import { ir } from '../router.js';
import { novoClientUuid } from '../store.js';
import {
  FORMAS,
  aviso,
  avisarErro,
  carregando,
  data as formatarData,
  dataHora,
  erroBloco,
  etiqueta,
  grade,
  html,
  ligarCampoDinheiro,
  numero,
  rotuloPagamento,
} from '../ui.js';

const FORMAS_DO_FECHAMENTO = () =>
  ['DINHEIRO', 'PIX', 'DEBITO', 'CREDITO', 'VALE', 'FIADO'].filter(
    (f) => f !== 'FIADO' || pode(PODE.GERIR_CREDIARIO),
  );

export async function render(raiz, params) {
  raiz.innerHTML = carregando();
  let c;
  try {
    c = await api.get(`/condicionais/${params.id}`);
  } catch (erro) {
    raiz.innerHTML = erroBloco(erro.textoAmigavel);
    return;
  }
  const aberta = c.status === 'ABERTA';

  /** variante -> quantas voltaram (só as que a pessoa já respondeu). */
  const devolvidas = new Map();
  /** `{ forma, valor (centavos), codigo_vale?, parcelas?, bandeira? }` */
  let pagamentos = [];
  let desconto = 0;
  // A chave do fechamento nasce com a tela e fica até dar certo: a resposta perdida e o
  // reenvio caem no mesmo fechamento (e na mesma venda), nunca em dois.
  const chave = novoClientUuid();
  let enviando = false;

  raiz.innerHTML = html`
    <div class="pagina">
      <div class="pagina__topo">
        <div>
          <h1>Condicional #${c.id} ${aberta
            ? etiqueta(textoDoPrazo(c.dias_para_vencer), c.vencida ? 'perigo' : 'info')
            : etiqueta('Fechada', 'neutro')}</h1>
          <p class="texto-suave">
            ${c.cliente}${c.cliente_telefone ? ` · ${c.cliente_telefone}` : ''} · atendida por ${c.vendedora}
            em ${dataHora(c.criada_em)} · prazo ${formatarData(c.prazo)}
          </p>
          ${c.observacao ? html`<p class="texto-suave">${c.observacao}</p>` : ''}
        </div>
        <div class="pagina__acoes">
          <a class="botao botao--neutro" href="#/condicionais?situacao=todas&cliente_id=${c.cliente_id}">Outras desta cliente</a>
        </div>
      </div>
      <div class="tabela-rolagem">
        <table>
          <thead><tr>
            <th>Peça</th><th class="direita">Preço</th><th class="centro">Levou</th>
            <th class="centro">Voltou</th><th class="centro">Ficou</th>
          </tr></thead>
          <tbody>${c.itens.map(linha)}</tbody>
        </table>
      </div>
      ${aberta ? formularioDeFechamento() : resumoFechada()}
    </div>
  `;

  function linha(i) {
    return html`
      <tr>
        <td>
          <span class="celula-principal">${i.produto}</span>
          <span class="celula-secundaria">${grade(i.tamanho, i.cor)} · ${i.codigo_barras}</span>
        </td>
        <td class="direita dinheiro">${formatar(paraCentavos(i.preco_venda))}</td>
        <td class="centro">${numero(i.quantidade)}</td>
        <td class="centro">${aberta
          ? html`<input type="number" min="0" max="${i.quantidade}" step="1" style="width:72px"
              data-voltou="${i.variante_id}" aria-label="Quantas ${i.produto} voltaram" />`
          : numero(i.devolvida)}</td>
        <td class="centro" data-ficou="${i.variante_id}">${aberta ? '—' : numero(i.ficou)}</td>
      </tr>
    `;
  }

  function resumoFechada() {
    return html`
      <div class="cartao" style="margin-top:16px"><div class="cartao__corpo">
        <p>Fechada por <strong>${c.fechada_por}</strong> em ${dataHora(c.fechada_em)}.</p>
        ${c.venda_id
          ? html`<p>O que ficou com a cliente virou a <a href="#/vendas/${c.venda_id}">venda #${c.venda_id}</a>
              · <a href="#/vendas/${c.venda_id}/recibo">recibo</a>.</p>`
          : html`<p>Tudo voltou para o estoque: não houve venda.</p>`}
      </div></div>
    `;
  }

  function formularioDeFechamento() {
    return html`
      <div class="cartao" style="margin-top:16px"><div class="cartao__corpo">
        <div class="pagina__topo" style="margin-bottom:8px">
          <h2>Fechar a condicional</h2>
          <button class="botao botao--neutro botao--pequeno" data-tudo-voltou>Tudo voltou</button>
        </div>
        <div class="pdv__linha"><span class="texto-suave">Voltam ao estoque</span><strong data-voltam>—</strong></div>
        <div class="pdv__linha"><span class="texto-suave">Ficam com a cliente</span><strong data-ficam>—</strong></div>
        <div data-cobranca></div>
        <button class="botao botao--acao botao--grande" data-fechar style="margin-top:14px" disabled>Fechar condicional</button>
      </div></div>
    `;
  }

  if (!aberta) return undefined;

  const areaCobranca = raiz.querySelector('[data-cobranca]');
  const botaoFechar = raiz.querySelector('[data-fechar]');
  const respondeuTudo = () => c.itens.every((i) => devolvidas.has(i.variante_id));
  const resumo = () => resumirFechamento(c.itens, devolvidas);
  const aPagar = () => Math.max(0, resumo().total - desconto);
  const falta = () => aPagar() - somar(pagamentos.map((p) => p.valor));

  function atualizar() {
    const r = resumo();
    raiz.querySelector('[data-voltam]').textContent = respondeuTudo() ? numero(r.pecasQueVoltaram) : '—';
    raiz.querySelector('[data-ficam]').textContent = respondeuTudo() ? numero(r.pecasQueFicaram) : '—';
    c.itens.forEach((i) => {
      raiz.querySelector(`[data-ficou="${i.variante_id}"]`).textContent = devolvidas.has(i.variante_id)
        ? numero(i.quantidade - devolvidas.get(i.variante_id))
        : '—';
    });
    const pronto = respondeuTudo() && (r.total === 0 ? true : pagamentos.length > 0 && falta() === 0);
    botaoFechar.disabled = enviando || !pronto;
    const situacao = raiz.querySelector('[data-falta]');
    if (situacao) {
      situacao.textContent = falta() > 0 ? `Falta ${formatar(falta())}` : falta() < 0 ? `Passou ${formatar(-falta())}` : 'Pago';
    }
  }

  function pintarCobranca() {
    const r = resumo();
    if (!respondeuTudo() || r.total === 0) {
      pagamentos = [];
      areaCobranca.innerHTML = respondeuTudo() ? html`<p class="texto-suave">Nada a cobrar: tudo voltou.</p>` : '';
      atualizar();
      return;
    }
    areaCobranca.innerHTML = html`
      <div class="pdv__linha"><span class="texto-suave">Peças que ficaram</span><span class="dinheiro">${formatar(r.total)}</span></div>
      <label class="campo"><span>Desconto</span><input data-desconto style="width:140px" /></label>
      <div class="pdv__linha"><strong>A cobrar</strong><strong class="dinheiro">${formatar(aPagar())}</strong></div>
      <div class="formas">${FORMAS_DO_FECHAMENTO().map((f) => html`<button class="forma" data-forma="${f}">${FORMAS[f]}</button>`)}</div>
      ${pagamentos.map((p, i) => html`
        <div class="pagamento-linha">
          <strong>${rotuloPagamento(p)}${p.codigo_vale ? ` ${p.codigo_vale}` : ''}</strong>
          <input data-pagamento="${i}" style="width:120px;text-align:right" aria-label="Valor em ${FORMAS[p.forma]}" />
          <button class="botao-icone botao-icone--perigo" data-remover="${i}" aria-label="Tirar">✕</button>
        </div>`)}
      <p class="texto-suave" data-falta></p>
    `;
    ligarCampoDinheiro(areaCobranca.querySelector('[data-desconto]'), desconto, (v) => {
      desconto = Math.min(v, resumo().total);
      atualizar();
    });
    areaCobranca.querySelectorAll('[data-forma]').forEach((b) => b.addEventListener('click', () => adicionar(b.dataset.forma)));
    pagamentos.forEach((p, i) => {
      ligarCampoDinheiro(areaCobranca.querySelector(`[data-pagamento="${i}"]`), p.valor, (v) => {
        pagamentos[i].valor = v;
        atualizar();
      });
    });
    areaCobranca.querySelectorAll('[data-remover]').forEach((b) =>
      b.addEventListener('click', () => {
        pagamentos.splice(Number(b.dataset.remover), 1);
        pintarCobranca();
      }),
    );
    atualizar();
  }

  async function adicionar(forma) {
    const restante = Math.max(0, falta());
    if (forma === 'VALE') {
      const vale = await pedirVale(restante);
      if (!vale) return;
      pagamentos.push({ forma, valor: Math.min(vale.saldo, restante), codigo_vale: vale.codigo });
    } else if (pagamentos.some((p) => p.forma === forma)) {
      return;
    } else if (forma === 'CREDITO') {
      // Como no PDV (ADR-35): em quantas vezes e em que bandeira, antes do valor entrar.
      // Sem isto toda condicional parcelada virava 1x — a taxa e a agenda de recebíveis
      // saíam as do à vista.
      const escolha = await pedirParcelas(restante);
      if (!escolha) return;
      pagamentos.push({ forma, valor: restante, ...escolha });
    } else {
      pagamentos.push({ forma, valor: restante });
    }
    pintarCobranca();
  }

  async function fechar() {
    if (enviando) return;
    enviando = true;
    atualizar();
    try {
      const fechada = await api.post(`/condicionais/${c.id}/fechamento`, {
        client_uuid: chave,
        itens: itensDoFechamento(c.itens, devolvidas),
        // Tudo voltou: desconto 0 (o servidor recusa desconto sem venda). Espelho do app.
        desconto: paraDecimalString(Math.min(desconto, resumo().total)),
        pagamentos: pagamentos.map((p) => ({
          forma: p.forma,
          valor: paraDecimalString(p.valor),
          ...(p.codigo_vale ? { codigo_vale: p.codigo_vale } : {}),
          ...(p.parcelas ? { parcelas: p.parcelas } : {}),
          ...(p.bandeira ? { bandeira: p.bandeira } : {}),
        })),
      });
      aviso(fechada.venda_id ? `Condicional fechada: venda #${fechada.venda_id} registrada.` : 'Condicional fechada: tudo voltou ao estoque.');
      ir(fechada.venda_id ? `/vendas/${fechada.venda_id}/recibo` : `/condicionais/${c.id}`);
    } catch (erro) {
      avisarErro(erro);
      // Já fechada (por outro aparelho, ou com outro pagamento): a tela antiga não vale mais.
      if (erro instanceof ErroApi && erro.status === 409 && erro.detail?.condicional_id) ir(`/condicionais/${c.id}`);
    } finally {
      enviando = false;
      if (raiz.isConnected) atualizar();
    }
  }

  raiz.querySelectorAll('[data-voltou]').forEach((campo) =>
    campo.addEventListener('input', () => {
      const id = Number(campo.dataset.voltou);
      const item = c.itens.find((i) => i.variante_id === id);
      if (campo.value === '') devolvidas.delete(id);
      else devolvidas.set(id, Math.max(0, Math.min(item.quantidade, Math.trunc(Number(campo.value) || 0))));
      pintarCobranca();
    }),
  );
  raiz.querySelector('[data-tudo-voltou]').addEventListener('click', () => {
    c.itens.forEach((i) => {
      devolvidas.set(i.variante_id, i.quantidade);
      raiz.querySelector(`[data-voltou="${i.variante_id}"]`).value = i.quantidade;
    });
    pintarCobranca();
  });
  botaoFechar.addEventListener('click', fechar);
  pintarCobranca();
  return undefined;
}
