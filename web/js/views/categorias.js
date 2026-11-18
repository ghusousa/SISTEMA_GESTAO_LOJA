/** Categorias do catálogo. Lista curta, mexida de vez em quando: cabe tudo numa tela. */

import { api } from '../api.js';
import {
  ajuda,
  aviso,
  avisarErro,
  carregando,
  confirmar,
  diaNaLoja,
  erroBloco,
  html,
  modal,
  vazio,
} from '../ui.js';

export async function render(raiz) {
  raiz.innerHTML = html`
    <div class="pagina">
      <div class="pagina__topo">
        <div>
          <h1>Categorias</h1>
          <p class="texto-suave">Servem para filtrar o catálogo e agrupar os relatórios.</p>
        </div>
        <div class="pagina__acoes">
          <button class="botao" data-nova>Nova categoria</button>
        </div>
      </div>
      <div data-lista></div>
    </div>
  `;

  const areaLista = raiz.querySelector('[data-lista]');

  async function carregar() {
    areaLista.innerHTML = carregando();
    try {
      const { items } = await api.get('/categorias', { size: 100 });
      desenhar(items);
    } catch (erro) {
      areaLista.innerHTML = erroBloco(erro.textoAmigavel);
    }
  }

  function desenhar(items) {
    if (!items.length) {
      areaLista.innerHTML = vazio(
        'Nenhuma categoria ainda',
        'Comece com as que a loja mais usa: Camisetas, Calças, Vestidos.',
      );
      return;
    }

    areaLista.innerHTML = html`
      <div class="tabela-rolagem">
        <table>
          <thead>
            <tr>
              <th>Categoria</th>
              <th>Criada em</th>
              <th class="direita">
                Ações
                ${ajuda('Renomear troca o nome em todas as peças de uma vez. Excluir só funciona se a categoria estiver vazia: mova as peças para outra antes.')}
              </th>
            </tr>
          </thead>
          <tbody>
            ${items.map(
              (c) => html`
                <tr>
                  <td class="celula-principal">${c.nome}</td>
                  <td class="texto-suave">${diaNaLoja(c.criada_em)}</td>
                  <td class="direita">
                    <button class="botao-icone" data-renomear="${c.id}" data-nome="${c.nome}" title="Renomear" aria-label="Renomear ${c.nome}">✏️</button>
                    <button class="botao-icone botao-icone--perigo" data-excluir="${c.id}" data-nome="${c.nome}" title="Excluir" aria-label="Excluir ${c.nome}">🗑️</button>
                  </td>
                </tr>
              `,
            )}
          </tbody>
        </table>
      </div>
    `;

    areaLista.querySelectorAll('[data-renomear]').forEach((b) =>
      b.addEventListener('click', () => renomear(Number(b.dataset.renomear), b.dataset.nome)),
    );
    areaLista.querySelectorAll('[data-excluir]').forEach((b) =>
      b.addEventListener('click', () => excluir(Number(b.dataset.excluir), b.dataset.nome)),
    );
  }

  function pedirNome(titulo, valor = '') {
    return modal({
      titulo,
      largura: '400px',
      render: () => html`
        <label class="campo">
          <span>Nome da categoria</span>
          <input data-nome value="${valor}" maxlength="80" placeholder="Ex.: Vestidos" />
        </label>
        <div class="modal__acoes">
          <button class="botao botao--neutro" data-nao>Cancelar</button>
          <button class="botao" data-ok>Salvar</button>
        </div>
      `,
      aoAbrir: (corpo, fechar) => {
        const campo = corpo.querySelector('[data-nome]');
        const enviar = () => fechar(campo.value.trim());
        corpo.querySelector('[data-nao]').addEventListener('click', () => fechar(undefined));
        corpo.querySelector('[data-ok]').addEventListener('click', enviar);
        campo.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') enviar();
        });
        campo.select();
      },
    });
  }

  async function criar() {
    const nome = await pedirNome('Nova categoria');
    if (!nome) return;
    try {
      await api.post('/categorias', { nome });
      aviso('Categoria criada.');
      carregar();
    } catch (erro) {
      avisarErro(erro);
    }
  }

  async function renomear(id, atual) {
    const nome = await pedirNome('Renomear categoria', atual);
    if (!nome || nome === atual) return;
    try {
      await api.patch(`/categorias/${id}`, { nome });
      aviso('Categoria renomeada.');
      carregar();
    } catch (erro) {
      avisarErro(erro);
    }
  }

  async function excluir(id, nome) {
    const certeza = await confirmar({
      titulo: 'Excluir categoria',
      mensagem: `"${nome}" só pode sair se não houver produto nela.`,
      confirmarTexto: 'Excluir',
      perigo: true,
    });
    if (!certeza) return;
    try {
      await api.delete(`/categorias/${id}`);
      aviso('Categoria excluída.');
      carregar();
    } catch (erro) {
      avisarErro(erro);
    }
  }

  raiz.querySelector('[data-nova]').addEventListener('click', criar);
  await carregar();
}
