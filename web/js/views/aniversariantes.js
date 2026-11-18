/**
 * Aniversariantes do mês — o "feliz aniversário, chegou coleção no seu tamanho" (ADR-36).
 *
 * É do balcão (`ATENDER_CLIENTE`): nome, telefone e preferências, nada do crediário. O mês
 * vai na URL (`?mes=`), para o F5 não perder; sem ele, o servidor usa o mês de hoje NA
 * LOJA, não o do computador de quem olha.
 */

import { api } from '../api.js';
import { trocarConsulta } from '../router.js';
import {
  carregando,
  erroBloco,
  html,
  ligarPaginacao,
  paginacao,
  vazio,
} from '../ui.js';

const MESES = [
  'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro',
];

export async function render(raiz, _params, consulta) {
  const mes = Number(consulta.mes) || null;
  const page = Number(consulta.page) || 1;

  raiz.innerHTML = html`
    <div class="pagina">
      <div class="pagina__topo">
        <div>
          <h1>Aniversariantes</h1>
          <p class="texto-suave">Quem faz aniversário no mês, na ordem do calendário.</p>
        </div>
      </div>
      <div class="filtros">
        <select data-mes aria-label="Mês">
          <option value="">Este mês</option>
          ${MESES.map((nome, i) => html`<option value="${i + 1}" ${mes === i + 1 ? 'selected' : ''}>${nome}</option>`)}
        </select>
      </div>
      <div data-lista>${carregando()}</div>
    </div>
  `;

  raiz.querySelector('[data-mes]').addEventListener('change', (e) =>
    trocarConsulta({ mes: e.target.value || undefined, page: undefined }),
  );

  const lista = raiz.querySelector('[data-lista]');
  try {
    const resp = await api.get('/clientes/aniversariantes', {
      ...(mes ? { mes } : {}),
      page,
      size: 50,
    });
    if (!resp.total) {
      lista.innerHTML = vazio(
        'Ninguém neste mês',
        'O aniversário entra no cadastro da cliente, no balcão ou no crediário.',
      );
      return;
    }
    lista.innerHTML = html`
      <div class="tabela-rolagem">
        <table>
          <thead><tr><th>Dia</th><th>Cliente</th><th>Telefone</th><th>Preferências</th></tr></thead>
          <tbody>
            ${resp.items.map(
              (c) => html`
                <tr>
                  <td>${c.nascimento.slice(8, 10)}/${c.nascimento.slice(5, 7)}</td>
                  <td class="celula-principal">${c.nome}</td>
                  <td>${c.telefone || '—'}</td>
                  <td class="texto-suave">${c.preferencias || '—'}</td>
                </tr>
              `,
            )}
          </tbody>
        </table>
      </div>
      ${paginacao(resp)}
    `;
    ligarPaginacao(lista, (nova) => trocarConsulta({ page: nova }));
  } catch (erro) {
    lista.innerHTML = erroBloco(erro.textoAmigavel);
  }
}
