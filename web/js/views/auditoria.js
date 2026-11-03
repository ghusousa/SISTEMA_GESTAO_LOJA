/**
 * Auditoria — o diário da loja, e ele é só do dono.
 *
 * A pergunta que esta tela responde é a de quem confia na equipe mas confere: "o que a Ana
 * fez hoje?", "quem cancelou aquela venda?", "quem mexeu no preço?". Cada linha é um ato,
 * com o nome e o papel de quem agiu CONGELADOS no momento — renomear a pessoa depois não
 * reescreve o passado.
 *
 * A recusa de verdade é do servidor (`VER_AUDITORIA`, capacidade que nem o gerente tem);
 * esconder o menu para os outros é só conveniência.
 */

import { api } from '../api.js';
import { trocarConsulta } from '../router.js';
import {
  ajuda,
  carregando,
  cru,
  dataHora,
  diasAtrasISO,
  erroBloco,
  etiqueta,
  hojeISO,
  html,
  ligarPaginacao,
  paginacao,
  plural,
  vazio,
} from '../ui.js';

const TAMANHO = 30;

// Como cada ação aparece: um rótulo curto e um tom. O tom separa o que o dono varre a
// gente procurando — dinheiro desfeito e mexida em quem entra no sistema chamam a atenção.
const ACOES = {
  LOGIN: ['Entrou', 'info'],
  LOGOUT: ['Saiu', 'info'],
  LOGIN_FALHOU: ['Senha errada', 'alerta'],
  VENDA_CRIADA: ['Venda', 'ok'],
  VENDA_CANCELADA: ['Cancelou venda', 'perigo'],
  DEVOLUCAO: ['Devolução', 'alerta'],
  ENTRADA: ['Entrada de estoque', 'info'],
  AJUSTE: ['Ajuste de estoque', 'alerta'],
  INVENTARIO: ['Inventário', 'info'],
  PRODUTO_CRIADO: ['Cadastrou peça', 'info'],
  PRODUTO_EDITADO: ['Editou produto', 'info'],
  PRODUTO_EXCLUIDO: ['Excluiu produto', 'perigo'],
  PECA_ADICIONADA: ['Nova peça na grade', 'info'],
  PECA_EDITADA: ['Editou peça', 'alerta'],
  PECA_EXCLUIDA: ['Excluiu peça', 'perigo'],
  FOTO: ['Trocou foto', 'info'],
  CATEGORIA_CRIADA: ['Categoria', 'info'],
  CATEGORIA_EDITADA: ['Editou categoria', 'info'],
  CATEGORIA_EXCLUIDA: ['Excluiu categoria', 'perigo'],
  CLIENTE_CRIADO: ['Cadastrou cliente', 'info'],
  CLIENTE_EDITADO: ['Editou cliente', 'info'],
  CLIENTE_EXCLUIDO: ['Excluiu cliente', 'perigo'],
  FIADO_RECEBIDO: ['Recebeu fiado', 'ok'],
  DESPESA_CRIADA: ['Lançou despesa', 'info'],
  DESPESA_EDITADA: ['Editou despesa', 'info'],
  DESPESA_EXCLUIDA: ['Excluiu despesa', 'perigo'],
  DESPESAS_REPLICADAS: ['Contas fixas do mês', 'info'],
  CAIXA_FECHADO: ['Fechou o caixa', 'ok'],
  USUARIO_CRIADO: ['Criou usuário', 'perigo'],
  USUARIO_EDITADO: ['Editou usuário', 'perigo'],
  SENHA_REDEFINIDA: ['Redefiniu senha', 'perigo'],
  SENHA_PROPRIA: ['Trocou a própria senha', 'info'],
  // A carga da demonstração na Vercel (ADR-42): quem age é o build, não uma pessoa.
  DEMONSTRACAO_INICIADA: ['Carga da demonstração', 'info'],
  DEMONSTRACAO_SEMEADA: ['Demonstração carregada', 'ok'],
  OUTRO: ['Outra ação', 'info'],
};

const PAPEIS = { ADMIN: 'Dono', GERENTE: 'Gerente', SUPERVISORA: 'Supervisora', VENDEDOR: 'Vendedora' };

export async function render(raiz, _params, consulta) {
  const filtros = {
    inicio: consulta.inicio || diasAtrasISO(7),
    fim: consulta.fim || hojeISO(),
    usuario_id: consulta.usuario_id || '',
    acao: consulta.acao || '',
    page: Number(consulta.page) || 1,
  };

  // O <select> de usuário é alimentado por /usuarios — mesma capacidade que o dono já tem.
  let usuarios = [];
  try {
    usuarios = (await api.get('/usuarios', { size: 100 })).items;
  } catch {
    usuarios = [];
  }

  raiz.innerHTML = html`
    <div class="pagina">
      <div class="pagina__topo">
        <div>
          <h1>Auditoria</h1>
          <p class="texto-suave">
            Tudo que cada pessoa fez no login dela. Só você vê esta tela.
          </p>
        </div>
      </div>

      <div class="filtros">
        <label class="campo">
          <span>De</span>
          <input type="date" data-inicio value="${filtros.inicio}" />
        </label>
        <label class="campo">
          <span>Até ${ajuda('O dia escolhido entra inteiro, contado pelo relógio da loja: o que foi feito às 23h fica no dia dele, não no seguinte.')}</span>
          <input type="date" data-fim value="${filtros.fim}" />
        </label>
        <label class="campo">
          <span>Quem</span>
          <select data-usuario>
            <option value="">Todo mundo</option>
            ${usuarios.map(
              (u) => html`
                <option value="${u.id}" ${filtros.usuario_id == u.id ? 'selected' : ''}>
                  ${u.nome}
                </option>
              `,
            )}
          </select>
        </label>
        <label class="campo">
          <span>O quê</span>
          <select data-acao>
            <option value="">Tudo</option>
            ${Object.entries(ACOES).map(
              ([codigo, [rotulo]]) => html`
                <option value="${codigo}" ${filtros.acao === codigo ? 'selected' : ''}>
                  ${rotulo}
                </option>
              `,
            )}
          </select>
        </label>
      </div>

      <div data-lista>${cru(carregando())}</div>
    </div>
  `;

  raiz.querySelector('[data-inicio]').addEventListener('change', (e) =>
    trocarConsulta({ inicio: e.target.value, page: 1 }),
  );
  raiz.querySelector('[data-fim]').addEventListener('change', (e) =>
    trocarConsulta({ fim: e.target.value, page: 1 }),
  );
  raiz.querySelector('[data-usuario]').addEventListener('change', (e) =>
    trocarConsulta({ usuario_id: e.target.value || undefined, page: 1 }),
  );
  raiz.querySelector('[data-acao]').addEventListener('change', (e) =>
    trocarConsulta({ acao: e.target.value || undefined, page: 1 }),
  );

  const lista = raiz.querySelector('[data-lista]');

  try {
    const pagina = await api.get('/auditoria', {
      inicio: filtros.inicio,
      fim: filtros.fim,
      usuario_id: filtros.usuario_id || undefined,
      acao: filtros.acao || undefined,
      page: filtros.page,
      size: TAMANHO,
    });

    if (!pagina.items.length) {
      lista.innerHTML = vazio('Nada neste filtro', 'Ninguém fez nada que se encaixe — ou o período está vazio.');
      return;
    }

    lista.innerHTML = html`
      <p class="texto-fraco">${plural(pagina.total, 'registro', 'registros')} no período.</p>
      <table class="tabela-auditoria">
        <thead>
          <tr>
            <th>Quando</th>
            <th>Quem ${ajuda('O nome e o cargo ficam gravados como eram na hora. Trocar o cargo de alguém, ou até apagar a conta, não muda o que já está aqui.')}</th>
            <th>O que fez</th>
            <th>Origem ${ajuda('O endereço de internet de onde a ação partiu. Serve para notar acesso de fora da loja. Um traço quer dizer que não deu para saber.')}</th>
          </tr>
        </thead>
        <tbody>
          ${pagina.items.map((e) => {
            const [rotulo, tom] = ACOES[e.acao] || [e.acao, 'info'];
            return html`
              <tr>
                <td class="texto-suave" style="white-space:nowrap">${dataHora(e.quando)}</td>
                <td>
                  <span class="celula-principal">${e.usuario}</span>
                  ${e.papel ? cru(`<span class="celula-secundaria">${PAPEIS[e.papel] || e.papel}</span>`) : ''}
                </td>
                <td>
                  ${cru(etiqueta(rotulo, tom))}
                  <span class="auditoria__descricao">${e.descricao}</span>
                </td>
                <td class="texto-fraco" style="white-space:nowrap">${e.ip || '—'}</td>
              </tr>
            `;
          })}
        </tbody>
      </table>
      ${cru(paginacao({ total: pagina.total, page: pagina.page, size: pagina.size }))}
    `;
    ligarPaginacao(lista, (page) => trocarConsulta({ page }));
  } catch (erro) {
    lista.innerHTML = erroBloco(erro?.message || 'Não deu para carregar a auditoria.');
  }
}
