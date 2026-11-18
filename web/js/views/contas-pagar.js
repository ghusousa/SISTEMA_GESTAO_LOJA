/**
 * Contas a pagar do fornecedor: o que vence, o que venceu e o que já foi pago (ADR-40).
 *
 * **Não é despesa e não entra no Resultado.** A mercadoria já entra no Resultado pelo CMV,
 * no dia em que a peça é vendida; o boleto do fornecedor lançado em Despesas contaria o
 * mesmo custo duas vezes. Aqui é o calendário de saída de dinheiro, e a tela diz isso.
 *
 * O topo é o aviso de quem olha o dinheiro: vencidas e a semana que vem (`/contas-pagar/resumo`).
 */

import { api } from '../api.js';
import { formatar, paraCentavos } from '../dinheiro.js';
import { somarDias } from '../parcelas.js';
import { ir, trocarConsulta } from '../router.js';
import { ouvir } from '../tempo-real.js';
import {
  ajuda,
  aviso,
  avisarErro,
  carregando,
  confirmar,
  cru,
  data as formatarData,
  erroBloco,
  etiqueta,
  hojeISO,
  html,
  ligarPaginacao,
  modal,
  numero,
  paginacao,
  vazio,
} from '../ui.js';
import { FORMAS_CONTA, lancarConta } from './contas-pagar-nova.js';

const TAMANHO = 25;

const ABAS = [
  ['abertas', 'Abertas'],
  ['vencidas', 'Vencidas'],
  ['proximos_7_dias', 'Próximos 7 dias'],
  ['pagas', 'Pagas'],
  ['todas', 'Todas'],
];

const TOM = { ABERTA: 'info', VENCIDA: 'perigo', PAGA: 'ok' };

export async function render(raiz, _params, consulta) {
  const filtros = {
    situacao: consulta.situacao || 'abertas',
    fornecedor: consulta.fornecedor || '',
    entrada_id: consulta.entrada_id || '',
    page: Number(consulta.page) || 1,
  };

  raiz.innerHTML = html`
    <div class="pagina">
      <div class="pagina__topo">
        <div>
          <h1>Contas a pagar</h1>
          <p class="texto-suave">
            O que a loja deve aos fornecedores e quando vence.
            <strong>Não entra no Resultado</strong>
            ${ajuda('O custo da mercadoria já entra no Resultado pelo CMV, no dia em que a peça é vendida. Se o boleto do fornecedor entrasse também (ou fosse lançado em Despesas), o mesmo custo sairia duas vezes do lucro do mês.')}
          </p>
        </div>
        <div class="pagina__acoes"><button class="botao" data-nova>Lançar nota sem entrada</button></div>
      </div>
      <div data-resumo></div>
      <div class="filtros">
        ${ABAS.map(([valor, texto]) => html`
          <button class="botao ${cru(filtros.situacao === valor ? '' : 'botao--neutro')} botao--pequeno"
            data-aba="${valor}">${texto}</button>`)}
        <label class="campo campo--busca">
          <span>Fornecedor</span>
          <input data-fornecedor value="${filtros.fornecedor}" placeholder="Nome do fornecedor" />
        </label>
      </div>
      ${filtros.entrada_id ? html`<p class="texto-suave">Só as parcelas da entrada #${filtros.entrada_id}.</p>` : ''}
      <div data-lista></div>
    </div>
  `;

  const areaLista = raiz.querySelector('[data-lista]');
  const areaResumo = raiz.querySelector('[data-resumo]');

  async function carregarResumo() {
    try {
      const r = await api.get('/contas-pagar/resumo');
      areaResumo.innerHTML = html`
        <div class="grade-cartoes">
          <div class="indicador ${cru(r.vencidas.quantidade ? 'indicador--destaque' : '')}">
            <div class="indicador__rotulo">Vencidas</div>
            <div class="indicador__valor dinheiro">${formatar(paraCentavos(r.vencidas.valor))}</div>
            <div class="indicador__nota">${numero(r.vencidas.quantidade)} sem pagar</div>
          </div>
          <div class="indicador">
            <div class="indicador__rotulo">A pagar nos próximos 7 dias</div>
            <div class="indicador__valor dinheiro">${formatar(paraCentavos(r.proximos_7_dias.valor))}</div>
            <div class="indicador__nota">${numero(r.proximos_7_dias.quantidade)} até ${formatarData(somarDias(r.hoje, 7))}</div>
          </div>
          <div class="indicador">
            <div class="indicador__rotulo">Total em aberto</div>
            <div class="indicador__valor dinheiro">${formatar(paraCentavos(r.em_aberto.valor))}</div>
            <div class="indicador__nota">${numero(r.em_aberto.quantidade)} parcelas</div>
          </div>
        </div>
      `;
    } catch (erro) {
      areaResumo.innerHTML = erroBloco(erro.textoAmigavel);
    }
  }

  async function carregar() {
    areaLista.innerHTML = carregando();
    trocarConsulta(filtros);
    void carregarResumo();
    try {
      const pagina = await api.get('/contas-pagar', { ...filtros, size: TAMANHO });
      desenhar(pagina);
    } catch (erro) {
      areaLista.innerHTML = erroBloco(erro.textoAmigavel);
    }
  }

  function desenhar(pagina) {
    if (!pagina.items.length) {
      areaLista.innerHTML = vazio(
        'Nenhuma conta aqui',
        'A nota do fornecedor entra pela Entrada de mercadoria, com valor e vencimentos.',
      );
      return;
    }
    areaLista.innerHTML = html`
      <div class="tabela-rolagem">
        <table>
          <thead><tr>
            <th>Vencimento</th><th>Fornecedor</th><th>Descrição</th>
            <th class="direita">Valor</th><th>Situação</th><th></th>
          </tr></thead>
          <tbody>${pagina.items.map(linha)}</tbody>
        </table>
      </div>
      ${paginacao({ total: pagina.total, page: pagina.page, size: pagina.size })}
    `;
    areaLista.querySelectorAll('[data-pagar]').forEach((b) =>
      b.addEventListener('click', () => pagar(pagina.items.find((c) => c.id === Number(b.dataset.pagar)))),
    );
    areaLista.querySelectorAll('[data-desfazer]').forEach((b) =>
      b.addEventListener('click', () => desfazer(Number(b.dataset.desfazer))),
    );
    areaLista.querySelectorAll('[data-excluir]').forEach((b) =>
      b.addEventListener('click', () => excluir(Number(b.dataset.excluir))),
    );
    ligarPaginacao(areaLista, (p) => {
      filtros.page = p;
      carregar();
    });
  }

  function linha(c) {
    const quando =
      c.situacao === 'PAGA'
        ? `paga em ${formatarData(c.paga_em)} · ${FORMAS_CONTA[c.forma_pagamento] || c.forma_pagamento}`
        : c.dias_para_vencer < 0
          ? `venceu há ${-c.dias_para_vencer} dia(s)`
          : c.dias_para_vencer === 0 ? 'vence hoje' : `em ${c.dias_para_vencer} dia(s)`;
    return html`
      <tr>
        <td><span class="celula-principal">${formatarData(c.vencimento)}</span></td>
        <td>${c.fornecedor}</td>
        <td>
          <span class="celula-principal">${c.descricao}</span>
          <span class="celula-secundaria">
            ${c.parcelas > 1 ? `parcela ${c.parcela} de ${c.parcelas}` : 'parcela única'}${c.numero_nota ? ` · ${c.numero_nota}` : ''}
          </span>
        </td>
        <td class="direita dinheiro celula-principal">${formatar(paraCentavos(c.valor))}</td>
        <td>${etiqueta(c.situacao === 'PAGA' ? 'Paga' : c.situacao === 'VENCIDA' ? 'Vencida' : 'Aberta', TOM[c.situacao])}
          <span class="celula-secundaria">${quando}</span></td>
        <td class="direita" style="white-space:nowrap">
          ${c.situacao === 'PAGA'
            ? html`<button class="botao botao--neutro botao--pequeno" data-desfazer="${c.id}">Desfazer</button>`
            : html`<button class="botao botao--pequeno" data-pagar="${c.id}">Marcar paga</button>
                <button class="botao-icone botao-icone--perigo" data-excluir="${c.id}" aria-label="Excluir conta">✕</button>`}
        </td>
      </tr>
    `;
  }

  async function pagar(conta) {
    const dados = await modal({
      titulo: `Pagar ${formatar(paraCentavos(conta.valor))} — ${conta.fornecedor}`,
      largura: '420px',
      render: () => html`
        <label class="campo"><span>Como pagou</span>
          <select data-forma>${Object.entries(FORMAS_CONTA).map(([v, t]) => html`<option value="${v}">${t}</option>`)}</select>
        </label>
        <label class="campo"><span>Quando</span><input data-dia type="date" max="${hojeISO()}" value="${hojeISO()}" /></label>
        <p class="texto-suave">Pagar em dinheiro aqui não tira da conferência do caixa.</p>
        <div class="modal__acoes">
          <button class="botao botao--neutro" data-nao>Cancelar</button>
          <button class="botao botao--acao" data-sim>Marcar como paga</button>
        </div>`,
      aoAbrir: (corpo, fechar) => {
        corpo.querySelector('[data-nao]').addEventListener('click', () => fechar(undefined));
        corpo.querySelector('[data-sim]').addEventListener('click', () =>
          fechar({ forma: corpo.querySelector('[data-forma]').value, pago_em: corpo.querySelector('[data-dia]').value || null }),
        );
      },
    });
    if (!dados) return;
    try {
      await api.post(`/contas-pagar/${conta.id}/pagamento`, dados);
      aviso('Conta marcada como paga.');
      carregar();
    } catch (erro) {
      avisarErro(erro);
    }
  }

  async function desfazer(id) {
    const certeza = await confirmar({
      titulo: 'Desfazer o pagamento',
      mensagem: 'A conta volta a ficar em aberto, como se não tivesse sido paga.',
      confirmarTexto: 'Desfazer',
    });
    if (!certeza) return;
    try {
      await api.delete(`/contas-pagar/${id}/pagamento`);
      carregar();
    } catch (erro) {
      avisarErro(erro);
    }
  }

  async function excluir(id) {
    const certeza = await confirmar({
      titulo: 'Excluir esta conta',
      mensagem: 'Use para conta lançada por engano. A mercadoria da entrada não muda.',
      confirmarTexto: 'Excluir',
      perigo: true,
    });
    if (!certeza) return;
    try {
      await api.delete(`/contas-pagar/${id}`);
      carregar();
    } catch (erro) {
      avisarErro(erro);
    }
  }

  const navegar = (mudanca) => {
    const proximo = { ...filtros, ...mudanca, page: 1 };
    const busca = new URLSearchParams(Object.entries(proximo).filter(([, v]) => v !== '' && v !== null));
    ir(`/contas-pagar?${busca}`);
  };
  raiz.querySelectorAll('[data-aba]').forEach((b) =>
    b.addEventListener('click', () => navegar({ situacao: b.dataset.aba })),
  );
  raiz.querySelector('[data-fornecedor]').addEventListener('change', (e) => {
    filtros.fornecedor = e.target.value.trim();
    filtros.page = 1;
    carregar();
  });
  raiz.querySelector('[data-nova]').addEventListener('click', async () => {
    if (await lancarConta()) carregar();
  });

  await carregar();
  return ouvir(['contas_pagar', 'reconectado'], () => void carregar());
}
