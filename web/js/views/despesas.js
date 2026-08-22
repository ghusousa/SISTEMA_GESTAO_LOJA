/**
 * Despesas: aluguel, energia, fornecedor, maquininha — tudo que sai do caixa.
 *
 * Contas fixas são marcadas como recorrentes e replicadas para o mês seguinte por um botão.
 * A replicação é idempotente no servidor: clicar duas vezes não lança o aluguel duas vezes.
 */

import { api } from '../api.js';
import { formatar, paraCentavos, paraDecimalString, somar } from '../dinheiro.js';
import { trocarConsulta } from '../router.js';
import {
  aviso,
  avisarErro,
  carregando,
  competencia as formatarCompetencia,
  confirmar,
  cru,
  data as formatarData,
  erroBloco,
  etiqueta,
  hojeISO,
  html,
  ligarCampoDinheiro,
  ligarPaginacao,
  modal,
  numero,
  paginacao,
  plural,
  vazio,
} from '../ui.js';

const TAMANHO = 25;

export async function render(raiz, _params, consulta) {
  const filtros = {
    inicio: consulta.inicio || `${hojeISO().slice(0, 7)}-01`,
    fim: consulta.fim || hojeISO(),
    categoria_id: consulta.categoria_id || '',
    recorrente: consulta.recorrente || '',
    page: Number(consulta.page) || 1,
  };

  let categorias = [];

  raiz.innerHTML = html`
    <div class="pagina">
      <div class="pagina__topo">
        <div>
          <h1>Despesas</h1>
          <p class="texto-suave">O que sai do caixa. Entra no resultado do período nos relatórios.</p>
        </div>
        <div class="pagina__acoes">
          <button class="botao botao--neutro" data-categorias>Categorias</button>
          <button class="botao botao--neutro" data-replicar>Trazer contas fixas</button>
          <button class="botao" data-nova>Lançar despesa</button>
        </div>
      </div>

      <div class="filtros">
        <label class="campo">
          <span>De</span>
          <input data-inicio type="date" value="${filtros.inicio}" />
        </label>
        <label class="campo">
          <span>Até</span>
          <input data-fim type="date" value="${filtros.fim}" />
        </label>
        <label class="campo">
          <span>Categoria</span>
          <select data-categoria><option value="">Todas</option></select>
        </label>
        <label class="campo">
          <span>Tipo</span>
          <select data-recorrente>
            <option value="">Todas</option>
            <option value="true" ${cru(filtros.recorrente === 'true' ? 'selected' : '')}>Só contas fixas</option>
            <option value="false" ${cru(filtros.recorrente === 'false' ? 'selected' : '')}>Só avulsas</option>
          </select>
        </label>
      </div>

      <div data-resumo></div>
      <div data-lista></div>
    </div>
  `;

  const areaLista = raiz.querySelector('[data-lista]');
  const areaResumo = raiz.querySelector('[data-resumo]');
  const seletorCategoria = raiz.querySelector('[data-categoria]');

  async function carregarCategorias() {
    try {
      const { items } = await api.get('/despesas/categorias', { size: 100 });
      categorias = items;
      seletorCategoria.innerHTML =
        '<option value="">Todas</option>' +
        items.map((c) => html`<option value="${c.id}">${c.nome}</option>`).join('');
      seletorCategoria.value = filtros.categoria_id;
    } catch (erro) {
      avisarErro(erro);
    }
  }

  async function carregar() {
    areaLista.innerHTML = carregando();
    trocarConsulta(filtros);
    try {
      const pagina = await api.get('/despesas', { ...filtros, size: TAMANHO });
      desenhar(pagina);
    } catch (erro) {
      areaLista.innerHTML = erroBloco(erro.textoAmigavel);
    }
  }

  function desenhar(pagina) {
    const total = somar(pagina.items.map((d) => paraCentavos(d.valor)));
    const fixas = pagina.items.filter((d) => d.recorrente).length;

    areaResumo.innerHTML = html`
      <div class="grade-cartoes">
        <div class="indicador indicador--destaque">
          <div class="indicador__rotulo">Total nesta página</div>
          <div class="indicador__valor dinheiro">${formatar(total)}</div>
          <div class="indicador__nota">${plural(pagina.total, 'lançamento no filtro', 'lançamentos no filtro')}</div>
        </div>
        <div class="indicador">
          <div class="indicador__rotulo">Contas fixas</div>
          <div class="indicador__valor">${numero(fixas)}</div>
          <div class="indicador__nota">de ${numero(pagina.items.length)} nesta página</div>
        </div>
      </div>
    `;

    if (!pagina.items.length) {
      areaLista.innerHTML = vazio(
        'Nenhuma despesa no período',
        'Mude as datas ou lance a primeira despesa do mês.',
      );
      return;
    }

    areaLista.innerHTML = html`
      <div class="tabela-rolagem">
        <table>
          <thead>
            <tr>
              <th>Data</th>
              <th>Descrição</th>
              <th>Categoria</th>
              <th class="direita">Valor</th>
              <th class="direita">Ações</th>
            </tr>
          </thead>
          <tbody>
            ${pagina.items.map(
              (d) => html`
                <tr>
                  <td class="texto-suave" style="white-space:nowrap">${formatarData(d.data)}</td>
                  <td>
                    <span class="celula-principal">${d.descricao}</span>
                    ${d.observacao ? cru(html`<span class="celula-secundaria">${d.observacao}</span>`) : ''}
                  </td>
                  <td>
                    <span class="texto-suave">${d.categoria}</span>
                    ${d.recorrente ? cru(html`<span class="celula-secundaria">${etiqueta('Conta fixa', 'info')}</span>`) : ''}
                  </td>
                  <td class="direita dinheiro celula-principal">${formatar(paraCentavos(d.valor))}</td>
                  <td class="direita">
                    <button class="botao-icone" data-editar="${d.id}" title="Editar" aria-label="Editar ${d.descricao}">✏️</button>
                    <button class="botao-icone botao-icone--perigo" data-excluir="${d.id}" title="Excluir" aria-label="Excluir ${d.descricao}">🗑️</button>
                  </td>
                </tr>
              `,
            )}
          </tbody>
        </table>
      </div>
      ${paginacao({ total: pagina.total, page: pagina.page, size: pagina.size })}
    `;

    areaLista.querySelectorAll('[data-editar]').forEach((b) =>
      b.addEventListener('click', () => {
        const despesa = pagina.items.find((d) => d.id === Number(b.dataset.editar));
        formulario(despesa);
      }),
    );
    areaLista.querySelectorAll('[data-excluir]').forEach((b) =>
      b.addEventListener('click', () => {
        const despesa = pagina.items.find((d) => d.id === Number(b.dataset.excluir));
        excluir(despesa);
      }),
    );
    ligarPaginacao(areaLista, (p) => {
      filtros.page = p;
      carregar();
    });
  }

  /* --------------------------------------------------------------- formulário */

  async function formulario(despesa) {
    if (!categorias.length) {
      aviso('Cadastre uma categoria de despesa antes.', 'alerta');
      return gerirCategorias();
    }

    const salvou = await modal({
      titulo: despesa ? 'Editar despesa' : 'Lançar despesa',
      largura: '470px',
      render: () => html`
        <label class="campo">
          <span>Descrição</span>
          <input data-descricao maxlength="200" placeholder="Ex.: Aluguel de setembro"
            value="${despesa?.descricao || ''}" />
        </label>
        <div class="linha-campos">
          <label class="campo">
            <span>Valor</span>
            <input data-valor inputmode="numeric" />
          </label>
          <label class="campo">
            <span>Data</span>
            <input data-data type="date" value="${despesa?.data || hojeISO()}" />
          </label>
        </div>
        <label class="campo">
          <span>Categoria</span>
          <select data-categoria>
            ${categorias.map(
              (c) => html`<option value="${c.id}" ${cru(c.id === despesa?.categoria_id ? 'selected' : '')}>${c.nome}</option>`,
            )}
          </select>
        </label>
        <label class="marcador" style="margin-bottom:14px">
          <input type="checkbox" data-recorrente ${cru(despesa?.recorrente ? 'checked' : '')} />
          <span>É conta fixa <span class="campo__dica">entra na replicação mensal</span></span>
        </label>
        <label class="campo">
          <span>Observação <span class="campo__dica">opcional</span></span>
          <input data-observacao maxlength="500" value="${despesa?.observacao || ''}" />
        </label>
        <div class="modal__acoes">
          <button class="botao botao--neutro" data-nao>Cancelar</button>
          <button class="botao" data-ok>${despesa ? 'Salvar' : 'Lançar'}</button>
        </div>
      `,
      aoAbrir: (corpo, fechar) => {
        const dinheiro = ligarCampoDinheiro(
          corpo.querySelector('[data-valor]'),
          despesa ? paraCentavos(despesa.valor) : 0,
        );
        corpo.querySelector('[data-nao]').addEventListener('click', () => fechar(false));
        corpo.querySelector('[data-ok]').addEventListener('click', async (e) => {
          const descricao = corpo.querySelector('[data-descricao]').value.trim();
          if (descricao.length < 2) return aviso('Descreva a despesa.', 'alerta');
          if (dinheiro.valor() <= 0) return aviso('Informe o valor da despesa.', 'alerta');

          e.currentTarget.disabled = true;
          const dados = {
            categoria_id: Number(corpo.querySelector('[data-categoria]').value),
            descricao,
            valor: paraDecimalString(dinheiro.valor()),
            data: corpo.querySelector('[data-data]').value,
            recorrente: corpo.querySelector('[data-recorrente]').checked,
            observacao: corpo.querySelector('[data-observacao]').value.trim() || null,
          };
          try {
            if (despesa) await api.patch(`/despesas/${despesa.id}`, dados);
            else await api.post('/despesas', dados);
            aviso(despesa ? 'Despesa atualizada.' : 'Despesa lançada.');
            fechar(true);
          } catch (erro) {
            avisarErro(erro);
            e.currentTarget.disabled = false;
          }
        });
      },
    });
    if (salvou) carregar();
  }

  async function excluir(despesa) {
    const certeza = await confirmar({
      titulo: 'Excluir despesa',
      mensagem: `"${despesa.descricao}" de ${formatar(paraCentavos(despesa.valor))} sai do resultado do período.`,
      confirmarTexto: 'Excluir',
      perigo: true,
    });
    if (!certeza) return;
    try {
      await api.delete(`/despesas/${despesa.id}`);
      aviso('Despesa excluída.');
      carregar();
    } catch (erro) {
      avisarErro(erro);
    }
  }

  /* -------------------------------------------------------------- recorrentes */

  async function replicar() {
    const mes = await modal({
      titulo: 'Trazer as contas fixas',
      largura: '440px',
      render: () => html`
        <p class="texto-suave">
          As despesas marcadas como conta fixa são copiadas para a competência escolhida, com a
          mesma data do mês. Repetir a operação não duplica nada.
        </p>
        <label class="campo">
          <span>Competência</span>
          <input data-mes type="month" value="${hojeISO().slice(0, 7)}" />
        </label>
        <div class="modal__acoes">
          <button class="botao botao--neutro" data-nao>Cancelar</button>
          <button class="botao" data-ok>Trazer</button>
        </div>
      `,
      aoAbrir: (corpo, fechar) => {
        corpo.querySelector('[data-nao]').addEventListener('click', () => fechar(undefined));
        corpo.querySelector('[data-ok]').addEventListener('click', () => fechar(corpo.querySelector('[data-mes]').value));
      },
    });
    if (!mes) return;

    try {
      const resultado = await api.post(`/despesas/replicar-recorrentes?competencia=${encodeURIComponent(mes)}`);
      aviso(
        resultado.criadas
          ? `${plural(resultado.criadas, 'conta fixa lançada', 'contas fixas lançadas')} em ${formatarCompetencia(resultado.competencia)}, somando ${formatar(paraCentavos(resultado.valor_total))}.`
          : `Nada a fazer: as ${plural(resultado.ja_existentes, 'conta fixa já estava lançada', 'contas fixas já estavam lançadas')} nesta competência.`,
      );
      carregar();
    } catch (erro) {
      avisarErro(erro);
    }
  }

  /* --------------------------------------------------------------- categorias */

  async function gerirCategorias() {
    await modal({
      titulo: 'Categorias de despesa',
      largura: '460px',
      render: () => html`
        <div data-lista-cat>${carregando()}</div>
        <form data-nova-cat style="display:flex;gap:8px;align-items:flex-end;margin-top:12px">
          <label class="campo" style="flex:1;margin:0">
            <span>Nova categoria</span>
            <input name="nome" maxlength="80" placeholder="Ex.: Energia" required />
          </label>
          <button class="botao" type="submit">Criar</button>
        </form>
      `,
      aoAbrir: (corpo, fechar) => {
        const lista = corpo.querySelector('[data-lista-cat]');

        async function pintar() {
          const { items } = await api.get('/despesas/categorias', { size: 100 });
          categorias = items;
          lista.innerHTML = items.length
            ? items
                .map(
                  (c) => html`
                    <div class="pagamento-linha">
                      <strong>${c.nome}</strong>
                      <button class="botao-icone botao-icone--perigo" data-apagar="${c.id}" data-nome="${c.nome}"
                        aria-label="Excluir ${c.nome}">🗑️</button>
                    </div>
                  `,
                )
                .join('')
            : '<p class="texto-suave">Nenhuma categoria ainda.</p>';

          lista.querySelectorAll('[data-apagar]').forEach((b) =>
            b.addEventListener('click', async () => {
              const certeza = await confirmar({
                titulo: 'Excluir categoria',
                mensagem: `"${b.dataset.nome}" só sai se não houver despesa nela.`,
                confirmarTexto: 'Excluir',
                perigo: true,
              });
              if (!certeza) return;
              try {
                await api.delete(`/despesas/categorias/${b.dataset.apagar}`);
                pintar();
              } catch (erro) {
                avisarErro(erro);
              }
            }),
          );
        }

        corpo.querySelector('[data-nova-cat]').addEventListener('submit', async (e) => {
          e.preventDefault();
          const nome = new FormData(e.target).get('nome').trim();
          if (!nome) return;
          try {
            await api.post('/despesas/categorias', { nome });
            e.target.reset();
            pintar();
          } catch (erro) {
            avisarErro(erro);
          }
        });

        pintar();
        corpo.addEventListener('keydown', (e) => {
          if (e.key === 'Escape') fechar(true);
        });
      },
    });
    await carregarCategorias();
    carregar();
  }

  raiz.querySelector('[data-nova]').addEventListener('click', () => formulario(null));
  raiz.querySelector('[data-replicar]').addEventListener('click', replicar);
  raiz.querySelector('[data-categorias]').addEventListener('click', gerirCategorias);

  ['inicio', 'fim', 'categoria', 'recorrente'].forEach((nome) => {
    raiz.querySelector(`[data-${nome}]`).addEventListener('change', (e) => {
      filtros[nome === 'categoria' ? 'categoria_id' : nome] = e.target.value;
      filtros.page = 1;
      carregar();
    });
  });

  await carregarCategorias();
  await carregar();
}
