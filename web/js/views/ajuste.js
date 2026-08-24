/**
 * Ajuste manual de saldo, usado pelo catálogo e pela tela de saldos.
 *
 * O que vai para a API é a DIFERENÇA com sinal, não o saldo novo — a tela pergunta pelo
 * saldo correto, que é como a pessoa pensa ("tem 3 aqui na arara"), e converte na hora.
 * Motivo é obrigatório: ajuste sem explicação vira buraco no caixa.
 */

import { api } from '../api.js';
import { ajuda, aviso, avisarErro, cru, grade, html, modal, numero, plural } from '../ui.js';

const MOTIVOS = [
  'Contagem na arara',
  'Peça com defeito',
  'Peça extraviada',
  'Devolução de cliente',
  'Erro de digitação na entrada',
];

/** Resolve `true` quando o ajuste foi gravado (a tela que chamou deve recarregar). */
export async function ajustarEstoque(peca) {
  const saldoAtual = peca.saldo ?? 0;

  const gravou = await modal({
    titulo: 'Ajustar estoque',
    largura: '460px',
    render: () => html`
      <p class="celula-principal" style="margin-bottom:2px">${peca.produto}</p>
      <p class="texto-suave">${grade(peca.tamanho, peca.cor)} · ${peca.codigo_barras}</p>

      <div class="pagamento-linha" style="margin:14px 0">
        <strong>Saldo no sistema</strong>
        <span class="dinheiro">${plural(saldoAtual, 'peça', 'peças')}</span>
      </div>

      <label class="campo">
        <span>Quantas peças existem de verdade? ${ajuda('Escreva o que existe de verdade na arara; o sistema grava só a diferença. Ajuste é para perda, quebra ou furto — mercadoria que chegou entra por Estoque > Entrada.')}</span>
        <input data-contado type="number" min="0" step="1" value="${saldoAtual}" />
      </label>

      <div data-diferenca></div>

      <label class="campo">
        <span>Motivo <span class="campo__dica">fica no extrato, com seu nome</span></span>
        <input data-motivo list="motivos-ajuste" placeholder="Ex.: contagem na arara" />
        <datalist id="motivos-ajuste">
          ${MOTIVOS.map((m) => html`<option value="${m}"></option>`)}
        </datalist>
      </label>

      <div class="modal__acoes">
        <button class="botao botao--neutro" data-nao>Cancelar</button>
        <button class="botao" data-ok disabled>Gravar ajuste</button>
      </div>
    `,
    aoAbrir: (corpo, fechar) => {
      const campoContado = corpo.querySelector('[data-contado]');
      const campoMotivo = corpo.querySelector('[data-motivo]');
      const areaDiferenca = corpo.querySelector('[data-diferenca]');
      const botao = corpo.querySelector('[data-ok]');

      const diferenca = () => {
        const contado = Number(campoContado.value);
        return Number.isFinite(contado) && contado >= 0 ? contado - saldoAtual : 0;
      };

      function atualizar() {
        const d = diferenca();
        areaDiferenca.innerHTML = d
          ? html`
              <div class="troco ${cru(d < 0 ? 'falta' : '')}">
                <span>${d > 0 ? 'Vai entrar' : 'Vai sair'}</span>
                <strong>${plural(Math.abs(d), 'peça', 'peças')}</strong>
              </div>
            `
          : '<p class="texto-suave">Sem diferença: nada a ajustar.</p>';
        botao.disabled = d === 0 || campoMotivo.value.trim().length < 3;
      }

      campoContado.addEventListener('input', atualizar);
      campoMotivo.addEventListener('input', atualizar);
      corpo.querySelector('[data-nao]').addEventListener('click', () => fechar(false));

      botao.addEventListener('click', async () => {
        const delta = diferenca();
        if (!delta) return;
        botao.disabled = true;
        botao.innerHTML = cru('<span class="giro" aria-hidden="true"></span> Gravando…');
        try {
          await api.post('/estoque/ajustes', {
            variante_id: peca.variante_id ?? peca.id,
            quantidade: delta,
            motivo: campoMotivo.value.trim(),
          });
          aviso(
            `Estoque ajustado para ${numero(Number(campoContado.value))} — ${peca.produto} ${grade(peca.tamanho, peca.cor)}.`,
          );
          fechar(true);
        } catch (erro) {
          avisarErro(erro);
          botao.disabled = false;
          botao.textContent = 'Gravar ajuste';
        }
      });

      atualizar();
      campoContado.focus();
      campoContado.select();
    },
  });

  return gravou === true;
}
