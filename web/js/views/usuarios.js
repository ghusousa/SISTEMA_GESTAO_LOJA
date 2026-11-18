/**
 * Usuários da loja.
 *
 * Quem manda no que cada papel enxerga é o servidor (`app/core/permissoes.py`). Esta tela
 * só administra quem existe: a vendedora não vê custo nem despesa mesmo abrindo a URL na
 * mão, e o gerente não consegue criar nem editar um dono — a API recusa com 403.
 */

import { api } from '../api.js';
import { trocarConsulta } from '../router.js';
import { sessao } from '../store.js';
import {
  ajuda,
  aviso,
  avisarErro,
  carregando,
  comAtraso,
  cru,
  diaNaLoja,
  erroBloco,
  etiqueta,
  html,
  ligarPaginacao,
  modal,
  paginacao,
  vazio,
} from '../ui.js';
import { podeExcluirDaEquipe } from '../exclusao-de-conta.js';
import { PAPEIS, titulo } from '../permissoes.js';
import { excluirConta, redefinirSenha } from './usuarios-acoes.js';
import { camposComissao, ligarCamposComissao, resumoComissao } from './usuarios-comissao.js';

const TAMANHO = 25;

const DESCRICAO = {
  ADMIN: 'vê e faz tudo',
  GERENTE: 'tudo do chão de loja, mais dinheiro, despesas, estorno e equipe',
  SUPERVISORA: 'estoque, catálogo, caixa e as vendas da equipe — sem custo nem despesa',
  VENDEDOR: 'vende, consulta preço, cadastra peça e dá entrada',
};

// Um gerente administra a equipe, mas não cria nem promove dono: seria virar dono. O
// servidor recusa de qualquer jeito; aqui a opção nem aparece, para não oferecer um 403.
const papeisQuePossoDar = PAPEIS.filter(
  (p) => p !== 'ADMIN' || sessao.get().usuario?.papel === 'ADMIN',
);

export async function render(raiz, _params, consulta) {
  const filtros = {
    q: consulta.q || '',
    papel: consulta.papel || '',
    ativo: consulta.ativo || '',
    page: Number(consulta.page) || 1,
  };

  raiz.innerHTML = html`
    <div class="pagina">
      <div class="pagina__topo">
        <div>
          <h1>Usuários</h1>
          <p class="texto-suave">
            O dono vê tudo. O vendedor cadastra, consulta estoque e vende — sem custo, lucro ou despesas.
          </p>
        </div>
        <div class="pagina__acoes">
          <button class="botao" data-novo>Novo usuário</button>
        </div>
      </div>

      <div class="filtros">
        <label class="campo campo--busca">
          <span>Buscar</span>
          <input data-q type="search" placeholder="Nome ou e-mail" value="${filtros.q}" />
        </label>
        <label class="campo">
          <span>Papel</span>
          <select data-papel>
            <option value="">Todos</option>
            ${PAPEIS.map(
              (p) => html`<option value="${p}" ${cru(filtros.papel === p ? 'selected' : '')}>${titulo(p)}</option>`,
            )}
          </select>
        </label>
        <label class="campo">
          <span>Situação</span>
          <select data-ativo>
            <option value="">Todos</option>
            <option value="true" ${cru(filtros.ativo === 'true' ? 'selected' : '')}>Ativos</option>
            <option value="false" ${cru(filtros.ativo === 'false' ? 'selected' : '')}>Desativados</option>
          </select>
        </label>
      </div>

      <div data-lista></div>
    </div>
  `;

  const areaLista = raiz.querySelector('[data-lista]');

  async function carregar() {
    areaLista.innerHTML = carregando();
    trocarConsulta(filtros);
    try {
      const pagina = await api.get('/usuarios', { ...filtros, size: TAMANHO });
      desenhar(pagina);
    } catch (erro) {
      areaLista.innerHTML = erroBloco(erro.textoAmigavel);
    }
  }

  function desenhar(pagina) {
    if (!pagina.items.length) {
      areaLista.innerHTML = vazio('Nenhum usuário encontrado', 'Tire os filtros ou cadastre alguém.');
      return;
    }

    const eu = sessao.get().usuario;

    areaLista.innerHTML = html`
      <div class="tabela-rolagem">
        <table>
          <thead>
            <tr>
              <th>Nome</th>
              <th>E-mail</th>
              <th>Papel</th>
              <th>Situação</th>
              <th>Desde</th>
              <th class="direita">Ações</th>
            </tr>
          </thead>
          <tbody>
            ${pagina.items.map(
              (u) => html`
                <tr>
                  <td>
                    <span class="celula-principal">${u.nome}</span>
                    ${u.id === eu?.id ? cru(html`<span class="celula-secundaria">é você</span>`) : ''}
                  </td>
                  <td class="texto-suave">${u.email}</td>
                  <td>
                    ${cru(etiqueta(titulo(u.papel), u.papel === 'ADMIN' ? 'info' : 'neutro'))}
                    ${resumoComissao(u) ? cru(html`<span class="celula-secundaria">${resumoComissao(u)}</span>`) : ''}
                  </td>
                  <td>${u.ativo ? etiqueta('Ativo', 'ok') : etiqueta('Desativado', 'perigo')}</td>
                  <td class="texto-suave">${diaNaLoja(u.criado_em)}</td>
                  <td class="direita">
                    <button class="botao-icone" data-editar="${u.id}" title="Editar" aria-label="Editar ${u.nome}">✏️</button>
                    <button class="botao-icone" data-senha="${u.id}" title="Redefinir senha" aria-label="Redefinir senha de ${u.nome}">🔑</button>
                    ${podeExcluirDaEquipe(eu, u)
                      ? html`<button class="botao-icone botao-icone--perigo" data-excluir="${u.id}" title="Excluir conta" aria-label="Excluir a conta de ${u.nome}">🗑️</button>`
                      : ''}
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
      b.addEventListener('click', () => editar(pagina.items.find((u) => u.id === Number(b.dataset.editar)))),
    );
    areaLista.querySelectorAll('[data-senha]').forEach((b) =>
      b.addEventListener('click', () => redefinirSenha(pagina.items.find((u) => u.id === Number(b.dataset.senha)))),
    );
    areaLista.querySelectorAll('[data-excluir]').forEach((b) =>
      b.addEventListener('click', async () => {
        if (await excluirConta(pagina.items.find((u) => u.id === Number(b.dataset.excluir)))) carregar();
      }),
    );
    ligarPaginacao(areaLista, (p) => {
      filtros.page = p;
      carregar();
    });
  }

  async function novo() {
    const criou = await modal({
      titulo: 'Novo usuário',
      largura: '450px',
      render: () => html`
        <label class="campo">
          <span>Nome</span>
          <input data-nome maxlength="120" placeholder="Ex.: Ana Paula" />
        </label>
        <label class="campo">
          <span>E-mail <span class="campo__dica">é com ele que a pessoa entra</span></span>
          <input data-email type="email" placeholder="ana@sualoja.com.br" />
        </label>
        <label class="campo">
          <span>Senha <span class="campo__dica">mínimo de 8 caracteres</span></span>
          <input data-senha type="password" autocomplete="new-password" />
        </label>
        <label class="campo">
          <span>Papel</span>
          <select data-papel>
            ${PAPEIS.filter((p) => papeisQuePossoDar.includes(p)).map(
              (p) => html`<option value="${p}">${titulo(p)} — ${DESCRICAO[p]}</option>`,
            )}
          </select>
        </label>
        ${camposComissao()}
        <div class="modal__acoes">
          <button class="botao botao--neutro" data-nao>Cancelar</button>
          <button class="botao" data-ok>Criar</button>
        </div>
      `,
      aoAbrir: (corpo, fechar) => {
        const lerComissao = ligarCamposComissao(corpo);
        corpo.querySelector('[data-nao]').addEventListener('click', () => fechar(false));
        corpo.querySelector('[data-ok]').addEventListener('click', async (e) => {
          const senha = corpo.querySelector('[data-senha]').value;
          if (senha.length < 8) return aviso('A senha precisa de pelo menos 8 caracteres.', 'alerta');
          e.currentTarget.disabled = true;
          try {
            await api.post('/usuarios', {
              nome: corpo.querySelector('[data-nome]').value.trim(),
              email: corpo.querySelector('[data-email]').value.trim(),
              senha,
              papel: corpo.querySelector('[data-papel]').value,
              ...lerComissao(),
            });
            aviso('Usuário criado.');
            fechar(true);
          } catch (erro) {
            avisarErro(erro);
            e.currentTarget.disabled = false;
          }
        });
      },
    });
    if (criou) carregar();
  }

  async function editar(usuario) {
    const eu = sessao.get().usuario?.id === usuario.id;

    const salvou = await modal({
      titulo: `Editar ${usuario.nome}`,
      largura: '450px',
      render: () => html`
        <label class="campo">
          <span>Nome</span>
          <input data-nome value="${usuario.nome}" maxlength="120" />
        </label>
        <label class="campo">
          <span>Papel ${ajuda('Decide o que a pessoa enxerga: vendedora e supervisora não veem custo, lucro nem despesa. Cancelar venda é do dono e do gerente; auditoria e backup, só do dono.')}</span>
          <select data-papel ${cru(eu ? 'disabled' : '')}>
            ${PAPEIS.filter((p) => papeisQuePossoDar.includes(p) || p === usuario.papel).map(
              (p) => html`<option value="${p}" ${cru(usuario.papel === p ? 'selected' : '')}>${titulo(p)}</option>`,
            )}
          </select>
          ${eu ? cru('<span class="campo__dica">você não pode mudar o próprio papel</span>') : ''}
        </label>
        <label class="marcador">
          <input type="checkbox" data-ativo ${cru(usuario.ativo ? 'checked' : '')} ${cru(eu ? 'disabled' : '')} />
          <span>Pode entrar no sistema ${ajuda('Desmarcado, o acesso dela para na hora, inclusive no celular. As vendas que ela fez continuam no histórico e na auditoria.')}</span>
        </label>
        ${eu ? cru('<p class="campo__dica">você não pode desativar a própria conta</p>') : ''}
        ${camposComissao(usuario)}
        <div class="modal__acoes">
          <button class="botao botao--neutro" data-nao>Cancelar</button>
          <button class="botao" data-ok>Salvar</button>
        </div>
      `,
      aoAbrir: (corpo, fechar) => {
        const lerComissao = ligarCamposComissao(corpo, usuario);
        corpo.querySelector('[data-nao]').addEventListener('click', () => fechar(false));
        corpo.querySelector('[data-ok]').addEventListener('click', async (e) => {
          e.currentTarget.disabled = true;
          const dados = { nome: corpo.querySelector('[data-nome]').value.trim(), ...lerComissao() };
          if (!eu) {
            dados.papel = corpo.querySelector('[data-papel]').value;
            dados.ativo = corpo.querySelector('[data-ativo]').checked;
          }
          try {
            await api.patch(`/usuarios/${usuario.id}`, dados);
            aviso('Usuário atualizado.');
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

  raiz.querySelector('[data-novo]').addEventListener('click', novo);
  raiz.querySelector('[data-q]').addEventListener(
    'input',
    comAtraso((e) => {
      filtros.q = e.target.value.trim();
      filtros.page = 1;
      carregar();
    }),
  );
  ['papel', 'ativo'].forEach((nome) =>
    raiz.querySelector(`[data-${nome}]`).addEventListener('change', (e) => {
      filtros[nome] = e.target.value;
      filtros.page = 1;
      carregar();
    }),
  );

  await carregar();
}
