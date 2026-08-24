/**
 * Fechamento de caixa: o que o sistema esperava receber contra o que a pessoa contou.
 *
 * Os campos já nascem com o valor esperado, e não em branco. Caixa em branco transformaria
 * "conferi só o dinheiro" numa diferença falsa de todo o PIX e todo o cartão do dia — o
 * sistema acusaria um rombo que não existe.
 *
 * O dia é o dia da LOJA (fuso de São Paulo), definido pela API. Quem fecha às 23h de um
 * sábado ainda está no sábado, mesmo que em UTC já seja domingo.
 */

import { api } from '../api.js';
import { formatar, paraCentavos, paraDecimalString } from '../dinheiro.js';
import {
  FORMAS,
  ajuda,
  aviso,
  avisarErro,
  carregando,
  cru,
  data as formatarData,
  dataHora,
  erroBloco,
  etiqueta,
  hojeISO,
  html,
  ligarCampoDinheiro,
  numero,
  plural,
} from '../ui.js';

export async function render(raiz, _params, consulta) {
  let dia = consulta.data || hojeISO();

  raiz.innerHTML = html`
    <div class="pagina">
      <div class="pagina__topo">
        <div>
          <h1>Caixa do dia</h1>
          <p class="texto-suave">Confira o que entrou por forma de pagamento e registre a contagem.</p>
        </div>
        <div class="pagina__acoes">
          <label class="campo" style="margin:0">
            <span>Dia</span>
            <input data-dia type="date" value="${dia}" max="${hojeISO()}" />
          </label>
        </div>
      </div>
      <div data-conteudo></div>
      <div data-historico style="margin-top:24px"></div>
    </div>
  `;

  const area = raiz.querySelector('[data-conteudo]');
  const areaHistorico = raiz.querySelector('[data-historico]');

  async function carregar() {
    area.innerHTML = carregando();
    try {
      const resumo = await api.get('/caixa/dia', { data: dia });
      desenhar(resumo);
    } catch (erro) {
      area.innerHTML = erroBloco(erro.textoAmigavel);
    }
    carregarHistorico();
  }

  function desenhar(resumo) {
    const esperadoTotal = paraCentavos(resumo.total_esperado);

    area.innerHTML = html`
      <div class="grade-cartoes">
        <div class="indicador indicador--destaque">
          <div class="indicador__rotulo">Esperado no caixa ${ajuda('As vendas do dia, mais o fiado recebido hoje, menos as devoluções pagas em dinheiro ou PIX. Devolução no cartão volta pela maquininha e não sai daqui.')}</div>
          <div class="indicador__valor dinheiro">${formatar(esperadoTotal)}</div>
          <div class="indicador__nota">${formatarData(resumo.data)}</div>
        </div>
        <div class="indicador">
          <div class="indicador__rotulo">Vendas do dia</div>
          <div class="indicador__valor">${numero(resumo.quantidade_vendas)}</div>
          <div class="indicador__nota">
            ${resumo.quantidade_canceladas
              ? `${plural(resumo.quantidade_canceladas, 'cancelada', 'canceladas')} não entram na conta`
              : 'nenhuma cancelada'}
          </div>
        </div>
        <div class="indicador">
          <div class="indicador__rotulo">Situação</div>
          <div class="indicador__valor" style="font-size:20px">
            ${resumo.fechado ? cru(etiqueta('Já conferido', 'ok')) : cru(etiqueta('Em aberto', 'alerta'))}
          </div>
          <div class="indicador__nota">
            ${resumo.fechado ? 'refazer a contagem atualiza o registro' : 'fechar o caixa não bloqueia novas vendas'}
          </div>
        </div>
      </div>

      <div class="cartao">
        <div class="cartao__topo">
          <h2>Contagem</h2>
          <span class="texto-fraco">Os campos já vêm com o valor esperado — corrija só o que divergir.</span>
        </div>
        <div class="tabela-rolagem" style="border:0;box-shadow:none;border-radius:0">
          <table>
            <thead>
              <tr>
                <th>Forma de pagamento ${ajuda('Vale e fiado não aparecem aqui: nenhum dos dois é dinheiro que passou pela gaveta hoje.')}</th>
                <th class="direita">Sistema esperava</th>
                <th class="direita">Contado</th>
                <th class="direita">Diferença ${ajuda('Positivo é sobra, negativo é falta. A diferença fica registrada com a sua observação e não trava venda nenhuma.')}</th>
              </tr>
            </thead>
            <tbody>
              ${resumo.linhas.map(
                (linha) => html`
                  <tr>
                    <td class="celula-principal">${FORMAS[linha.forma] || linha.forma}</td>
                    <td class="direita dinheiro texto-suave">${formatar(paraCentavos(linha.esperado))}</td>
                    <td class="direita">
                      <input data-contado="${linha.forma}" style="width:130px;text-align:right"
                        aria-label="Valor contado em ${FORMAS[linha.forma] || linha.forma}" />
                    </td>
                    <td class="direita dinheiro" data-diferenca="${linha.forma}">—</td>
                  </tr>
                `,
              )}
            </tbody>
            <tfoot>
              <tr>
                <td>Total</td>
                <td class="direita dinheiro">${formatar(esperadoTotal)}</td>
                <td class="direita dinheiro" data-total-contado>—</td>
                <td class="direita dinheiro" data-total-diferenca>—</td>
              </tr>
            </tfoot>
          </table>
        </div>
        <div class="cartao__corpo">
          <label class="campo">
            <span>Observação <span class="campo__dica">o que explica a diferença, se houver</span></span>
            <input data-observacao maxlength="2000" placeholder="Ex.: troco tirado para o almoço" />
          </label>
          <div class="pagina__acoes" style="justify-content:flex-end">
            <button class="botao botao--acao botao--grande" data-fechar>
              ${resumo.fechado ? 'Atualizar conferência' : 'Fechar caixa do dia'}
            </button>
          </div>
        </div>
      </div>
    `;

    const campos = new Map();
    resumo.linhas.forEach((linha) => {
      const esperado = paraCentavos(linha.esperado);
      // Já fechado: mostra o que foi contado. Aberto: parte do esperado.
      const inicial = linha.contado !== null && linha.contado !== undefined ? paraCentavos(linha.contado) : esperado;
      campos.set(
        linha.forma,
        ligarCampoDinheiro(area.querySelector(`[data-contado="${linha.forma}"]`), inicial, atualizar),
      );
    });

    function atualizar() {
      let contadoTotal = 0;
      resumo.linhas.forEach((linha) => {
        const esperado = paraCentavos(linha.esperado);
        const contado = campos.get(linha.forma).valor();
        contadoTotal += contado;
        const diferenca = contado - esperado;
        const celula = area.querySelector(`[data-diferenca="${linha.forma}"]`);
        celula.textContent = diferenca === 0 ? 'confere' : formatar(diferenca);
        celula.className = `direita dinheiro ${diferenca === 0 ? 'texto-suave' : diferenca > 0 ? 'positivo' : 'negativo'}`;
      });

      const diferencaTotal = contadoTotal - esperadoTotal;
      area.querySelector('[data-total-contado]').textContent = formatar(contadoTotal);
      const celulaTotal = area.querySelector('[data-total-diferenca]');
      celulaTotal.textContent = diferencaTotal === 0 ? 'confere' : formatar(diferencaTotal);
      celulaTotal.className = `direita dinheiro ${diferencaTotal === 0 ? '' : diferencaTotal > 0 ? 'positivo' : 'negativo'}`;
    }

    atualizar();

    area.querySelector('[data-fechar]').addEventListener('click', async (evento) => {
      const botao = evento.currentTarget;
      botao.disabled = true;
      botao.innerHTML = cru('<span class="giro" aria-hidden="true"></span> Gravando…');
      try {
        const fechamento = await api.post('/caixa/fechamentos', {
          data: dia,
          contagens: resumo.linhas.map((linha) => ({
            forma: linha.forma,
            valor_contado: paraDecimalString(campos.get(linha.forma).valor()),
          })),
          observacao: area.querySelector('[data-observacao]').value.trim() || null,
        });
        const diferenca = paraCentavos(fechamento.diferenca);
        aviso(
          diferenca === 0
            ? 'Caixa fechado: contagem bateu com o sistema.'
            : `Caixa fechado com diferença de ${formatar(diferenca)}.`,
          diferenca === 0 ? 'ok' : 'alerta',
        );
        carregar();
      } catch (erro) {
        avisarErro(erro);
        botao.disabled = false;
        botao.textContent = 'Fechar caixa do dia';
      }
    });
  }

  async function carregarHistorico() {
    try {
      const { items } = await api.get('/caixa/fechamentos', { size: 10 });
      if (!items.length) {
        areaHistorico.innerHTML = '';
        return;
      }
      areaHistorico.innerHTML = html`
        <h2 style="margin-bottom:10px">Últimos fechamentos</h2>
        <div class="tabela-rolagem">
          <table>
            <thead>
              <tr>
                <th>Dia</th>
                <th>Quem fechou</th>
                <th class="direita">Esperado</th>
                <th class="direita">Contado</th>
                <th class="direita">Diferença</th>
                <th>Observação</th>
              </tr>
            </thead>
            <tbody>
              ${items.map((f) => {
                const diferenca = paraCentavos(f.diferenca);
                return html`
                  <tr class="clicavel" data-dia="${f.data}" tabindex="0">
                    <td class="celula-principal">${formatarData(f.data)}</td>
                    <td class="texto-suave">
                      ${f.fechado_por}
                      <span class="celula-secundaria">${dataHora(f.fechado_em)}</span>
                    </td>
                    <td class="direita dinheiro texto-suave">${formatar(paraCentavos(f.total_esperado))}</td>
                    <td class="direita dinheiro">${formatar(paraCentavos(f.total_contado))}</td>
                    <td class="direita dinheiro ${cru(diferenca === 0 ? 'texto-suave' : diferenca > 0 ? 'positivo' : 'negativo')}">
                      ${diferenca === 0 ? 'confere' : formatar(diferenca)}
                    </td>
                    <td class="texto-fraco">${f.observacao || ''}</td>
                  </tr>
                `;
              })}
            </tbody>
          </table>
        </div>
      `;
      areaHistorico.querySelectorAll('[data-dia]').forEach((tr) =>
        tr.addEventListener('click', () => {
          dia = tr.dataset.dia;
          raiz.querySelector('[data-dia]').value = dia;
          carregar();
        }),
      );
    } catch {
      areaHistorico.innerHTML = '';
    }
  }

  raiz.querySelector('[data-dia]').addEventListener('change', (e) => {
    dia = e.target.value || hojeISO();
    carregar();
  });

  await carregar();
}
