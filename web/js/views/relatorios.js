/**
 * Relatórios do dono: o período inteiro numa tela só.
 *
 * A conta que importa é faturamento − custo da mercadoria − despesas = resultado. Tudo é
 * agregado pela API (o navegador nunca soma dez mil linhas), e o custo usado é o congelado
 * na venda, não o custo de hoje — senão uma remarcação de fornecedor reescreveria o lucro
 * do mês passado.
 */

import { api } from '../api.js';
import { formatar, formatarPercentual, paraCentavos } from '../dinheiro.js';
import { barrasPorDia, proporcoes } from '../grafico.js';
import { trocarConsulta } from '../router.js';
import {
  ajuda,
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
import { desenharRepor } from './relatorios-repor.js';

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
  // Página do "Precisa repor": vai para a URL junto com o período, para o F5 não perdê-la.
  let paginaRepor = Number(consulta.repor) || 1;
  const guardarNaUrl = () => trocarConsulta({ ...periodo, repor: paginaRepor > 1 ? paginaRepor : '' });

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
      <div data-repor></div>
    </div>
  `;

  const area = raiz.querySelector('[data-conteudo]');
  const areaRepor = raiz.querySelector('[data-repor]');

  function carregarRepor() {
    guardarNaUrl();
    return desenharRepor(areaRepor, paginaRepor, (p) => {
      paginaRepor = p;
      carregarRepor();
    });
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
    const resultado = paraCentavos(resumo.resultado);

    area.innerHTML = html`
      <div class="grade-cartoes">
        <div class="indicador indicador--destaque">
          <div class="indicador__rotulo">Faturamento ${ajuda('Tudo que foi vendido no período, inclusive o que saiu no fiado e ainda não foi recebido. Venda cancelada fica de fora.')}</div>
          <div class="indicador__valor dinheiro">${formatar(paraCentavos(resumo.faturamento))}</div>
          <div class="indicador__nota">
            ${plural(resumo.quantidade_vendas, 'venda', 'vendas')} ·
            ${plural(resumo.quantidade_pecas, 'peça', 'peças')}
          </div>
        </div>
        <div class="indicador">
          <div class="indicador__rotulo">Custo da mercadoria ${ajuda('O que você pagou ao fornecedor pelas peças que saíram. O custo fica congelado na venda: mudar o preço de compra hoje não mexe no lucro de ontem.')}</div>
          <div class="indicador__valor dinheiro">${formatar(paraCentavos(resumo.custo_mercadoria_vendida))}</div>
          <div class="indicador__nota">o que a loja pagou pelas peças vendidas</div>
        </div>
        <div class="indicador">
          <div class="indicador__rotulo">Lucro bruto ${ajuda('Faturamento menos o custo das peças, tirando as devoluções dos dois lados. Não é a subtração dos dois cartões acima, que mostram o período inteiro. As despesas ficam de fora.')}</div>
          <div class="indicador__valor dinheiro">${formatar(paraCentavos(resumo.lucro_bruto))}</div>
          <div class="indicador__nota">margem de ${formatarPercentual(resumo.margem_bruta_pct)}</div>
        </div>
        <div class="indicador">
          <div class="indicador__rotulo">Despesas</div>
          <div class="indicador__valor dinheiro">${formatar(paraCentavos(resumo.despesas))}</div>
          <div class="indicador__nota">lançadas no período</div>
        </div>
        <div class="indicador">
          <div class="indicador__rotulo">Resultado</div>
          <div class="indicador__valor dinheiro ${cru(resultado < 0 ? 'negativo' : 'positivo')}">
            ${formatar(resultado)}
          </div>
          <div class="indicador__nota">lucro bruto menos despesas</div>
        </div>
        <div class="indicador">
          <div class="indicador__rotulo">Ticket médio ${ajuda('Quanto cada venda trouxe, em média: o faturamento dividido pelo número de vendas do período.')}</div>
          <div class="indicador__valor dinheiro">${formatar(paraCentavos(resumo.ticket_medio))}</div>
          <div class="indicador__nota">
            ${resumo.vendas_canceladas
              ? `${plural(resumo.vendas_canceladas, 'venda cancelada', 'vendas canceladas')} fora da conta`
              : 'nenhuma venda cancelada'}
          </div>
        </div>
      </div>

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
      carregar();
    }),
  );
  raiz.querySelector('[data-inicio]').addEventListener('change', (e) => {
    periodo.inicio = e.target.value;
    carregar();
  });
  raiz.querySelector('[data-fim]').addEventListener('change', (e) => {
    periodo.fim = e.target.value;
    carregar();
  });

  // O "Precisa repor" não depende do período: carrega uma vez, ao lado do resto.
  await Promise.all([carregar(), carregarRepor()]);
}
