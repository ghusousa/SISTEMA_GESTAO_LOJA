/**
 * Relatórios do dono: o período inteiro numa tela só.
 *
 * A conta que importa é faturamento − custo da mercadoria − despesas = resultado. Tudo é
 * agregado pela API (o navegador nunca soma dez mil linhas), e o custo usado é o congelado
 * na venda, não o custo de hoje — senão uma remarcação de fornecedor reescreveria o lucro
 * do mês passado.
 *
 * Cada cartão com lista própria mora num módulo irmão (`relatorios-*.js`) e pagina no
 * servidor, com a página na URL para o F5 não perdê-la. Os que dependem do período
 * (equipe, curva ABC, a receber do cartão) recomeçam da página 1 quando as datas mudam;
 * os que são o AGORA do estoque (repor, valor, parado) não dependem delas.
 */

import { api } from '../api.js';
import { formatar, formatarPercentual, paraCentavos } from '../dinheiro.js';
import { barrasPorDia, proporcoes } from '../grafico.js';
import { trocarConsulta } from '../router.js';
import {
  carregando,
  cru,
  data as formatarData,
  diasAtrasISO,
  erroBloco,
  grade,
  hojeISO,
  html,
  numero,
  plural,
} from '../ui.js';
import { desenharEquipe } from './relatorios-equipe.js';
import { DIAS_PARADO, desenharCurvaAbc, desenharEstoqueParado, desenharValorEstoque } from './relatorios-giro.js';
import { desenharRecebiveis } from './relatorios-recebiveis.js';
import { desenharRepor } from './relatorios-repor.js';
import { cartoesDoResumo } from './relatorios-resumo.js';

const ATALHOS = [
  { chave: 'hoje', texto: 'Hoje', inicio: () => hojeISO() },
  { chave: '7', texto: '7 dias', inicio: () => diasAtrasISO(6) },
  { chave: '30', texto: '30 dias', inicio: () => diasAtrasISO(29) },
  { chave: 'mes', texto: 'Este mês', inicio: () => `${hojeISO().slice(0, 7)}-01` },
];

const reaisCurto = (centavos) => {
  const reais = Math.round(centavos / 100);
  if (Math.abs(reais) >= 1000) return `${(reais / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}k`;
  return String(reais);
};

export async function render(raiz, _params, consulta) {
  const periodo = {
    inicio: consulta.inicio || diasAtrasISO(29),
    fim: consulta.fim || hojeISO(),
  };
  // Página de cada lista: vai para a URL junto com o período, para o F5 não perdê-la.
  const paginas = {
    repor: Number(consulta.repor) || 1,
    equipe: Number(consulta.equipe) || 1,
    abc: Number(consulta.abc) || 1,
    receber: Number(consulta.receber) || 1,
    parado: Number(consulta.parado) || 1,
  };
  let dias = DIAS_PARADO.includes(Number(consulta.dias)) ? Number(consulta.dias) : 90;
  const guardarNaUrl = () => {
    const naUrl = Object.fromEntries(Object.entries(paginas).map(([k, v]) => [k, v > 1 ? v : '']));
    trocarConsulta({ ...periodo, ...naUrl, dias: dias !== 90 ? dias : '' });
  };

  raiz.innerHTML = html`
    <div class="pagina">
      <div class="pagina__topo">
        <div>
          <h1>Relatórios</h1>
          <p class="texto-suave">Faturamento, custo, despesas e o que sobrou no período.</p>
        </div>
        <div class="pagina__acoes">
          ${ATALHOS.map(
            (a) => html`<button class="botao botao--neutro botao--pequeno" data-atalho="${a.chave}">${a.texto}</button>`,
          )}
        </div>
      </div>

      <div class="filtros">
        <label class="campo">
          <span>De</span>
          <input data-inicio type="date" value="${periodo.inicio}" />
        </label>
        <label class="campo">
          <span>Até</span>
          <input data-fim type="date" value="${periodo.fim}" />
        </label>
      </div>

      <div data-conteudo></div>
      <div data-equipe></div>
      <div data-abc></div>
      <div data-receber></div>
      <div data-repor></div>
      <div data-valor></div>
      <div data-parado></div>
    </div>
  `;

  const area = raiz.querySelector('[data-conteudo]');
  const secao = (nome) => raiz.querySelector(`[data-${nome}]`);

  /** Liga uma lista paginada: `desenhar(area, pagina, aoMudarPagina)`. */
  const lista = (nome, desenhar) => {
    const recarregar = () => {
      guardarNaUrl();
      return desenhar(secao(nome), paginas[nome], (p) => {
        paginas[nome] = p;
        recarregar();
      });
    };
    return recarregar;
  };
  const carregarRepor = lista('repor', desenharRepor);
  const carregarEquipe = lista('equipe', (a, p, mudar) => desenharEquipe(a, periodo, p, mudar));
  const carregarAbc = lista('abc', (a, p, mudar) => desenharCurvaAbc(a, periodo, p, mudar));
  const carregarReceber = lista('receber', (a, p, mudar) => desenharRecebiveis(a, periodo, p, mudar));
  const carregarValor = () => desenharValorEstoque(secao('valor'));
  function carregarParado() {
    guardarNaUrl();
    return desenharEstoqueParado(secao('parado'), dias, paginas.parado, (mudou) => {
      paginas.parado = mudou.pagina;
      dias = mudou.dias;
      carregarParado();
    });
  }

  /** Datas novas: o resumo e as listas do período recomeçam da primeira página. */
  function carregarPeriodo() {
    paginas.equipe = 1;
    paginas.abc = 1;
    paginas.receber = 1;
    return Promise.all([carregar(), carregarEquipe(), carregarAbc(), carregarReceber()]);
  }

  async function carregar() {
    area.innerHTML = carregando('Somando o período…');
    guardarNaUrl();
    try {
      const [resumo, porDia, maisVendidos, porCategoria] = await Promise.all([
        api.get('/relatorios/resumo', periodo),
        api.get('/relatorios/vendas-por-dia', periodo),
        api.get('/relatorios/mais-vendidos', { ...periodo, limite: 10 }),
        api.get('/relatorios/despesas-por-categoria', periodo),
      ]);
      desenhar({ resumo, porDia, maisVendidos, porCategoria });
    } catch (erro) {
      area.innerHTML = erroBloco(erro.textoAmigavel);
    }
  }

  function desenhar({ resumo, porDia, maisVendidos, porCategoria }) {
    area.innerHTML = html`
      ${cartoesDoResumo(resumo)}

      <div class="cartao" style="margin-bottom:16px">
        <div class="cartao__topo">
          <h2>Vendas por dia</h2>
          <span class="texto-fraco">${formatarData(resumo.inicio)} a ${formatarData(resumo.fim)}</span>
        </div>
        <div class="cartao__corpo">
          ${porDia.length
            ? barrasPorDia(
                porDia.map((d) => ({
                  rotulo: formatarData(d.data).slice(0, 5),
                  valor: paraCentavos(d.faturamento),
                  dica: `${formatarData(d.data)}: ${formatar(paraCentavos(d.faturamento))} em ${plural(d.quantidade_vendas, 'venda', 'vendas')}`,
                })),
                reaisCurto,
              )
            : cru('<p class="texto-suave centro">Nenhuma venda no período.</p>')}
        </div>
      </div>

      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:16px">
        <div class="cartao">
          <div class="cartao__topo"><h2>Peças mais vendidas</h2></div>
          ${maisVendidos.length
            ? cru(html`
                <div class="tabela-rolagem" style="border:0;box-shadow:none;border-radius:0">
                  <table>
                    <thead>
                      <tr>
                        <th>Peça</th>
                        <th class="direita">Qtd</th>
                        <th class="direita">Faturou</th>
                        <th class="direita">Lucro</th>
                      </tr>
                    </thead>
                    <tbody>
                      ${maisVendidos.map(
                        (m) => html`
                          <tr>
                            <td>
                              <span class="celula-principal">${m.produto}</span>
                              <span class="celula-secundaria">${grade(m.tamanho, m.cor)}</span>
                            </td>
                            <td class="direita dinheiro">${numero(m.quantidade)}</td>
                            <td class="direita dinheiro">${formatar(paraCentavos(m.faturamento))}</td>
                            <td class="direita dinheiro positivo">${formatar(paraCentavos(m.lucro_bruto))}</td>
                          </tr>
                        `,
                      )}
                    </tbody>
                  </table>
                </div>
              `)
            : cru('<div class="cartao__corpo"><p class="texto-suave">Nenhuma venda no período.</p></div>')}
        </div>

        <div class="cartao">
          <div class="cartao__topo"><h2>Para onde o dinheiro foi</h2></div>
          <div class="cartao__corpo">
            ${porCategoria.length
              ? proporcoes(
                  porCategoria.map((c) => ({
                    rotulo: c.categoria,
                    valor: paraCentavos(c.total),
                    texto: formatar(paraCentavos(c.total)),
                    nota: `${formatarPercentual(c.percentual)} das despesas · ${plural(c.quantidade, 'lançamento', 'lançamentos')}`,
                  })),
                )
              : cru('<p class="texto-suave">Nenhuma despesa lançada no período.</p>')}
          </div>
        </div>
      </div>
    `;
  }

  raiz.querySelectorAll('[data-atalho]').forEach((botao) =>
    botao.addEventListener('click', () => {
      const atalho = ATALHOS.find((a) => a.chave === botao.dataset.atalho);
      periodo.inicio = atalho.inicio();
      periodo.fim = hojeISO();
      raiz.querySelector('[data-inicio]').value = periodo.inicio;
      raiz.querySelector('[data-fim]').value = periodo.fim;
      carregarPeriodo();
    }),
  );
  raiz.querySelector('[data-inicio]').addEventListener('change', (e) => {
    periodo.inicio = e.target.value;
    carregarPeriodo();
  });
  raiz.querySelector('[data-fim]').addEventListener('change', (e) => {
    periodo.fim = e.target.value;
    carregarPeriodo();
  });

  // Repor, valor e parado não dependem do período: carregam uma vez, ao lado do resto.
  // As listas do período abrem na página que estava na URL (por isso não `carregarPeriodo`).
  await Promise.all([
    carregar(),
    carregarEquipe(),
    carregarAbc(),
    carregarReceber(),
    carregarRepor(),
    carregarValor(),
    carregarParado(),
  ]);
}
