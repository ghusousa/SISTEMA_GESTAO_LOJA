/**
 * Taxas da maquininha: quanto a credenciadora fica de cada venda no cartão, e quando paga.
 *
 * É o contrato que o dono assinou — por isso só ele muda (`CONFIGURAR_LOJA`). O gerente lê
 * (`VER_DINHEIRO`): o Resultado que ele vê já desconta estas taxas, e precisa poder
 * conferir de onde saiu o número. A taxa vai FOTOGRAFADA em cada venda (ADR-35): mudar uma
 * linha aqui vale daqui para frente e não reescreve o mês que passou.
 */

import { api } from '../api.js';
import { MAX_PARCELAS } from '../pagar-credito.js';
import { PODE, pode } from '../permissoes.js';
import {
  ajuda,
  aviso,
  avisarErro,
  carregando,
  confirmar,
  erroBloco,
  html,
  modal,
  vazio,
} from '../ui.js';

const NOMES = { DEBITO: 'Débito', CREDITO: 'Crédito' };

const faixa = (t) =>
  t.parcelas_de === t.parcelas_ate ? `${t.parcelas_de}x` : `${t.parcelas_de}x a ${t.parcelas_ate}x`;

export async function render(raiz) {
  const podeMudar = pode(PODE.CONFIGURAR_LOJA);
  raiz.innerHTML = html`
    <div class="pagina">
      <div class="pagina__topo">
        <div>
          <h1>Taxas do cartão</h1>
          <p class="texto-suave">
            O que a maquininha cobra por forma e parcela, e em quantos dias o dinheiro cai.
            Os relatórios descontam estas taxas do Resultado.
          </p>
        </div>
        <div class="pagina__acoes">
          ${podeMudar ? html`<button class="botao" data-nova>Nova taxa</button>` : ''}
        </div>
      </div>
      <div data-lista></div>
    </div>
  `;

  const areaLista = raiz.querySelector('[data-lista]');

  async function carregar() {
    areaLista.innerHTML = carregando();
    try {
      // Débito (1 linha) + crédito (no máximo 12 faixas): uma página de 50 cabe tudo.
      const { items } = await api.get('/taxas-cartao', { size: 50 });
      desenhar(items);
    } catch (erro) {
      areaLista.innerHTML = erroBloco(erro.textoAmigavel);
    }
  }

  function desenhar(items) {
    if (!items.length) {
      areaLista.innerHTML = vazio(
        'Nenhuma taxa cadastrada',
        'Sem taxa, o Resultado não desconta a maquininha. Comece pelo débito e pelo crédito à vista, com os números do contrato.',
      );
      return;
    }
    areaLista.innerHTML = html`
      <div class="tabela-rolagem">
        <table>
          <thead>
            <tr>
              <th>Forma</th>
              <th>Parcelas</th>
              <th class="direita">Taxa</th>
              <th class="direita">Cai na conta ${ajuda('Dias depois da venda. No parcelado, é o prazo da 1ª parcela; as outras caem de 30 em 30 dias.')}</th>
              ${podeMudar ? html`<th class="direita">Ações</th>` : ''}
            </tr>
          </thead>
          <tbody>
            ${items.map(
              (t) => html`
                <tr>
                  <td class="celula-principal">${NOMES[t.forma] || t.forma}</td>
                  <td>${faixa(t)}</td>
                  <td class="direita">${t.percentual.replace('.', ',')}%</td>
                  <td class="direita">D+${t.prazo_dias}</td>
                  ${podeMudar
                    ? html`
                        <td class="direita">
                          <button class="botao-icone" data-editar="${t.id}" title="Editar" aria-label="Editar taxa">✏️</button>
                          <button class="botao-icone botao-icone--perigo" data-excluir="${t.id}" title="Excluir" aria-label="Excluir taxa">🗑️</button>
                        </td>
                      `
                    : ''}
                </tr>
              `,
            )}
          </tbody>
        </table>
      </div>
    `;
    areaLista.querySelectorAll('[data-editar]').forEach((b) =>
      b.addEventListener('click', () =>
        editar(items.find((t) => t.id === Number(b.dataset.editar))),
      ),
    );
    areaLista.querySelectorAll('[data-excluir]').forEach((b) =>
      b.addEventListener('click', () =>
        excluir(items.find((t) => t.id === Number(b.dataset.excluir))),
      ),
    );
  }

  /** O formulário da taxa. Resolve o corpo pronto para a API, ou `undefined`. */
  function pedirTaxa(titulo, atual) {
    const opcoes = (sel) =>
      Array.from({ length: MAX_PARCELAS }, (_, i) => i + 1).map(
        (n) => html`<option value="${n}" ${n === sel ? 'selected' : ''}>${n}x</option>`,
      );
    return modal({
      titulo,
      largura: '420px',
      render: () => html`
        <label class="campo">
          <span>Forma</span>
          <select data-forma ${atual ? 'disabled' : ''}>
            <option value="CREDITO" ${atual?.forma === 'CREDITO' ? 'selected' : ''}>Crédito</option>
            <option value="DEBITO" ${atual?.forma === 'DEBITO' ? 'selected' : ''}>Débito</option>
          </select>
        </label>
        <div class="linha-campos" data-faixa>
          <label class="campo"><span>De</span><select data-de>${opcoes(atual?.parcelas_de ?? 1)}</select></label>
          <label class="campo"><span>Até</span><select data-ate>${opcoes(atual?.parcelas_ate ?? 1)}</select></label>
        </div>
        <label class="campo">
          <span>Taxa (%)</span>
          <input data-percentual inputmode="decimal" placeholder="3,19" value="${atual ? atual.percentual.replace('.', ',') : ''}" />
        </label>
        <label class="campo">
          <span>Dias para cair na conta</span>
          <input data-prazo type="number" min="0" max="366" value="${atual?.prazo_dias ?? 30}" />
        </label>
        <div class="modal__acoes">
          <button class="botao botao--neutro" data-nao>Cancelar</button>
          <button class="botao" data-ok>Salvar</button>
        </div>
      `,
      aoAbrir: (corpo, fechar) => {
        const forma = corpo.querySelector('[data-forma]');
        // Débito não parcela: a faixa some, e vai 1x a 1x.
        const ajustar = () => {
          // `style`, não `hidden`: a classe da grade tem `display` e ganharia do atributo.
          corpo.querySelector('[data-faixa]').style.display = forma.value === 'DEBITO' ? 'none' : '';
        };
        forma.addEventListener('change', ajustar);
        ajustar();
        corpo.querySelector('[data-nao]').addEventListener('click', () => fechar(undefined));
        corpo.querySelector('[data-ok]').addEventListener('click', () => {
          const percentual = corpo.querySelector('[data-percentual]').value.trim().replace(',', '.');
          if (!/^\d{1,2}(\.\d{1,2})?$/.test(percentual)) {
            aviso('Escreva a taxa como no contrato, por exemplo 3,19.', 'alerta');
            return;
          }
          const debito = forma.value === 'DEBITO';
          fechar({
            forma: forma.value,
            parcelas_de: debito ? 1 : Number(corpo.querySelector('[data-de]').value),
            parcelas_ate: debito ? 1 : Number(corpo.querySelector('[data-ate]').value),
            percentual,
            prazo_dias: Number(corpo.querySelector('[data-prazo]').value || 0),
          });
        });
      },
    });
  }

  async function criar() {
    const dados = await pedirTaxa('Nova taxa');
    if (!dados) return;
    try {
      await api.post('/taxas-cartao', dados);
      aviso('Taxa cadastrada. Vale para as vendas daqui em diante.');
      carregar();
    } catch (erro) {
      avisarErro(erro);
    }
  }

  async function editar(taxa) {
    const dados = await pedirTaxa('Mudar taxa', taxa);
    if (!dados) return;
    const { forma: _forma, ...campos } = dados;
    try {
      await api.patch(`/taxas-cartao/${taxa.id}`, campos);
      aviso('Taxa alterada. As vendas de antes seguem com a taxa do dia delas.');
      carregar();
    } catch (erro) {
      avisarErro(erro);
    }
  }

  async function excluir(taxa) {
    const certeza = await confirmar({
      titulo: 'Excluir taxa',
      mensagem: `${NOMES[taxa.forma]} ${faixa(taxa)} passa a entrar sem taxa nas próximas vendas. As vendas de antes não mudam.`,
      confirmarTexto: 'Excluir',
      perigo: true,
    });
    if (!certeza) return;
    try {
      await api.delete(`/taxas-cartao/${taxa.id}`);
      aviso('Taxa excluída.');
      carregar();
    } catch (erro) {
      avisarErro(erro);
    }
  }

  raiz.querySelector('[data-nova]')?.addEventListener('click', criar);
  await carregar();
}
