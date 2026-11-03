/**
 * Devolução: a cliente voltou com a peça.
 *
 * **Tela própria, não um modo do PDV.** O campo de leitura do PDV já tem dois significados
 * (bipe e nome); um terceiro seria venda registrada como devolução na primeira semana. E o
 * caminho começa diferente: aqui a pergunta é "de qual venda saiu esta peça?".
 *
 * O passo que faz a coisa funcionar é achar a venda **pela peça** (`GET /vendas?variante_id=`).
 * A cliente chega sem nota, três dias depois; sem esse filtro alguém teria que abrir venda
 * por venda de um sábado de quarenta. E quando o sistema atrapalha, a devolução não deixa
 * de acontecer — ela acontece por fora, como um ajuste de estoque e dinheiro saindo da
 * gaveta sem registro.
 *
 * Quem devolve vê a conta antes de confirmar: quanto volta, por qual forma. O servidor
 * decide os valores (ADR-4); a tela só mostra o que ele respondeu.
 */

import { api, ErroApi } from '../api.js';
import { ligarBuscaDePeca } from '../busca-peca.js';
import { formatar, paraCentavos } from '../dinheiro.js';
import { criarLeitor, manterFoco } from '../leitor.js';
import { ir } from '../router.js';
import { novoClientUuid } from '../store.js';
import {
  ajuda,
  aviso,
  avisarErro,
  confirmar,
  cru,
  diaNaLoja,
  grade,
  html,
  numero,
  plural,
} from '../ui.js';

export function render(raiz, _params, consulta) {
  /** Venda escolhida e o que já foi marcado para devolver. */
  let venda = null;
  /** @type {Map<number, {quantidade:number, voltarAoEstoque:boolean}>} */
  let marcados = new Map();
  let enviando = false;
  // O uuid nasce com a devolução que está sendo montada, não na hora de enviar. Se a
  // resposta se perder no caminho (timeout, 502) e a vendedora tentar de novo, o servidor
  // reconhece o mesmo uuid e responde a MESMA devolução — em vez de devolver a peça duas
  // vezes e tirar o dinheiro duas vezes da gaveta. Mesmo cuidado do PDV e da entrada.
  // E morre com ela: gravou, ou trocou de venda, é outra devolução e outro uuid (ver
  // `abrirVenda` e `mostrarComprovante`).
  let clientUuid = novoClientUuid();

  raiz.innerHTML = html`
    <div class="pagina pagina--larga">
      <div class="pagina__topo">
        <div>
          <h1>Devolução</h1>
          <p class="texto-suave">
            Ache a venda pela peça, escolha o que está voltando e confirme. A peça volta ao
            estoque e o valor volta pela mesma forma que foi paga.
          </p>
        </div>
      </div>

      <div class="pdv__leitura">
        <div class="pdv__campo">
          <label class="so-leitor" for="leitura-devolucao">Código de barras ou nome da peça</label>
          <input id="leitura-devolucao" data-leitor type="text" autocomplete="off"
            placeholder="Bipe a etiqueta da peça devolvida, ou digite o nome" />
          <span class="pdv__pisca">Leitor pronto</span>
        </div>
        <div class="busca-peca" data-busca hidden></div>
      </div>

      <div data-area></div>
    </div>
  `;

  const campo = raiz.querySelector('[data-leitor]');
  const area = raiz.querySelector('[data-area]');

  /* ------------------------------------------------------- achar a venda */

  async function procurarVendas(varianteId, rotulo) {
    area.innerHTML = '<div class="carregando">Procurando as vendas desta peça…</div>';
    try {
      const { items } = await api.get('/vendas', { variante_id: varianteId, size: 20 });
      if (!items.length) {
        area.innerHTML = html`
          <div class="vazio">
            <p class="vazio__titulo">Nenhuma venda com ${rotulo}</p>
            <p class="texto-suave">
              Esta peça não saiu por nenhuma venda registrada. Se ela chegou de outro jeito,
              o caminho é a correção de estoque, não a devolução.
            </p>
          </div>
        `;
        return;
      }
      area.innerHTML = html`
        <div class="cartao">
          <div class="cartao__topo">
            <h2>Vendas com ${rotulo}</h2>
            <span class="texto-fraco">${plural(items.length, 'venda', 'vendas')}</span>
          </div>
          <table>
            <thead>
              <tr><th>Venda</th><th>Quando</th><th>Vendedora</th><th class="direita">Total</th><th></th></tr>
            </thead>
            <tbody>
              ${items.map(
                (v) => html`
                  <tr>
                    <td>#${v.id}</td>
                    <td>${diaNaLoja(v.vendida_em)}</td>
                    <td>${v.vendedor}</td>
                    <td class="direita dinheiro">${formatar(paraCentavos(v.total))}</td>
                    <td class="direita">
                      ${v.status === 'CANCELADA'
                        ? cru('<span class="etiqueta">cancelada</span>')
                        : cru(html`<button class="botao botao--pequeno" data-abrir="${v.id}">Devolver desta</button>`)}
                    </td>
                  </tr>
                `,
              )}
            </tbody>
          </table>
        </div>
      `;
      area.querySelectorAll('[data-abrir]').forEach((b) =>
        b.addEventListener('click', () => void abrirVenda(Number(b.dataset.abrir))),
      );
    } catch (erro) {
      avisarErro(erro);
    }
  }

  async function lerCodigo(codigo) {
    try {
      const peca = await api.get(`/variantes/codigo-barras/${encodeURIComponent(codigo)}`);
      await procurarVendas(peca.variante_id, `${peca.produto} ${grade(peca.tamanho, peca.cor)}`);
    } catch (erro) {
      if (erro instanceof ErroApi && erro.status === 404) {
        aviso(`Código ${codigo} não está cadastrado.`, 'alerta');
      } else {
        avisarErro(erro);
      }
    }
  }

  /* -------------------------------------------------- escolher o que volta */

  async function abrirVenda(vendaId) {
    area.innerHTML = '<div class="carregando">Abrindo a venda…</div>';
    try {
      const aberta = await api.get(`/vendas/${vendaId}`);
      // Outra venda é outra devolução. Reabrir a MESMA (a resposta se perdeu e a vendedora
      // bipou de novo) mantém o uuid: é aí que o replay do servidor evita devolver duas vezes.
      if (aberta.id !== venda?.id) clientUuid = novoClientUuid();
      venda = aberta;
      marcados = new Map();
      pintarVenda();
    } catch (erro) {
      avisarErro(erro);
    }
  }

  function disponivel(item) {
    return item.quantidade - (item.quantidade_devolvida || 0);
  }

  function pintarVenda() {
    const podeDevolver = venda.itens.some((i) => disponivel(i) > 0);
    area.innerHTML = html`
      <div class="cartao">
        <div class="cartao__topo">
          <h2>Venda #${venda.id} · ${diaNaLoja(venda.vendida_em)}</h2>
          <a class="botao botao--fantasma botao--pequeno" href="#/vendas/${venda.id}">Ver a venda</a>
        </div>
        ${podeDevolver
          ? cru(html`
              <table>
                <thead>
                  <tr>
                    <th>Peça</th>
                    <th class="centro">Levou</th>
                    <th class="centro">Já voltou</th>
                    <th class="centro">Devolver agora</th>
                    <th class="centro">
                      Volta ao estoque? ${ajuda('Marcada, a peça volta para a arara e pode ser ' +
                        'vendida de novo. Peça com defeito fica desmarcada: a cliente recebe o valor, ' +
                        'e a peça não volta para a venda.')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  ${venda.itens.map(
                    (item) => html`
                      <tr>
                        <td>
                          <span class="celula-principal">${item.produto}</span>
                          <span class="celula-secundaria">${grade(item.tamanho, item.cor)} · ${formatar(paraCentavos(item.preco_unitario))}</span>
                        </td>
                        <td class="centro">${numero(item.quantidade)}</td>
                        <td class="centro">${numero(item.quantidade_devolvida || 0)}</td>
                        <td class="centro">
                          <input type="number" min="0" max="${disponivel(item)}" step="1" value="0"
                            style="width:70px;text-align:center"
                            data-qtd="${item.id}" ${disponivel(item) ? '' : 'disabled'}
                            aria-label="Quantas de ${item.produto} estão voltando" />
                        </td>
                        <td class="centro">
                          <input type="checkbox" checked data-estoque="${item.id}"
                            ${disponivel(item) ? '' : 'disabled'}
                            aria-label="A peça ${item.produto} volta ao estoque" />
                        </td>
                      </tr>
                    `,
                  )}
                </tbody>
              </table>
              <div class="cartao__corpo">
                <label class="campo">
                  <span>Motivo <span class="campo__dica">fica no histórico</span></span>
                  <input data-motivo maxlength="500" placeholder="Não serviu, defeito, arrependimento…" />
                </label>
                <button class="botao botao--acao botao--grande" data-confirmar disabled>
                  Confirmar devolução
                </button>
                <p class="texto-fraco" style="margin-top:8px">
                  O valor volta pela mesma forma que entrou. O que não puder voltar em
                  dinheiro sai como vale de troca.
                  ${ajuda('Se a venda teve desconto, volta o que a cliente pagou por esta peça, ' +
                    'não o preço da etiqueta. Confirmada, a devolução não se desfaz.')}
                </p>
              </div>
            `)
          : cru(
              '<div class="cartao__corpo"><p class="texto-suave">' +
                'Todas as peças desta venda já voltaram.</p></div>',
            )}
      </div>
    `;

    const botao = area.querySelector('[data-confirmar]');
    const recalcular = () => {
      marcados = new Map();
      area.querySelectorAll('[data-qtd]').forEach((campoQtd) => {
        const id = Number(campoQtd.dataset.qtd);
        const q = Math.max(0, Math.floor(Number(campoQtd.value) || 0));
        if (q > 0) {
          marcados.set(id, {
            quantidade: q,
            voltarAoEstoque: area.querySelector(`[data-estoque="${id}"]`).checked,
          });
        }
      });
      if (botao) botao.disabled = marcados.size === 0 || enviando;
    };
    area.querySelectorAll('[data-qtd]').forEach((c) => c.addEventListener('input', recalcular));
    area.querySelectorAll('[data-estoque]').forEach((c) => c.addEventListener('change', recalcular));
    botao?.addEventListener('click', confirmarDevolucao);
  }

  /* ------------------------------------------------------------ confirmar */

  async function confirmarDevolucao() {
    if (enviando || !marcados.size) return;
    const pecas = [...marcados.values()].reduce((t, m) => t + m.quantidade, 0);
    const certeza = await confirmar({
      titulo: 'Confirmar devolução',
      mensagem: `${plural(pecas, 'peça volta', 'peças voltam')} da venda #${venda.id}. O estoque e o dinheiro são ajustados na hora.`,
      confirmarTexto: 'Devolver',
    });
    if (!certeza) return;

    enviando = true;
    const botao = area.querySelector('[data-confirmar]');
    if (botao) {
      botao.disabled = true;
      botao.innerHTML = cru('<span class="giro" aria-hidden="true"></span> Devolvendo…');
    }
    try {
      const devolucao = await api.post(`/vendas/${venda.id}/devolucoes`, {
        client_uuid: clientUuid,
        motivo: area.querySelector('[data-motivo]')?.value.trim() || null,
        itens: [...marcados.entries()].map(([item_id, m]) => ({
          item_id,
          quantidade: m.quantidade,
          voltar_ao_estoque: m.voltarAoEstoque,
        })),
      });
      mostrarComprovante(devolucao);
    } catch (erro) {
      avisarErro(erro);
      enviando = false;
      pintarVenda();
    }
  }

  function mostrarComprovante(devolucao) {
    enviando = false;
    // Gravada, o uuid já cumpriu o papel. O leitor continua ligado (e com foco) embaixo do
    // comprovante: a vendedora bipa a peça da próxima cliente sem passar por "Devolver outra
    // peça", e com o uuid antigo o servidor responderia a devolução ANTERIOR como replay —
    // a nova não seria gravada, e o dinheiro sairia da gaveta sem registro.
    clientUuid = novoClientUuid();
    const vale = devolucao.pagamentos.find((p) => p.codigo_vale);
    area.innerHTML = html`
      <div class="cartao">
        <div class="cartao__topo"><h2>Devolução registrada</h2></div>
        <div class="cartao__corpo">
          <p><strong class="dinheiro">${formatar(paraCentavos(devolucao.total))}</strong> voltaram para a
            cliente: ${ajuda('Dinheiro e PIX saem da gaveta agora. Débito e crédito voltam pela ' +
              'maquininha e caem na conta dela em alguns dias — não tire esse valor do caixa.')}</p>
          <ul>
            ${devolucao.pagamentos.map(
              (p) => html`
                <li>
                  ${formatar(paraCentavos(p.valor))} em <strong>${p.forma.toLowerCase()}</strong>
                  ${p.codigo_vale ? cru(html` — vale <strong>${p.codigo_vale}</strong>`) : ''}
                </li>
              `,
            )}
          </ul>
          ${vale
            ? cru(html`
                <p class="texto-suave">
                  Anote o vale <strong>${vale.codigo_vale}</strong> no papel e entregue à
                  cliente. Ele é aceito como forma de pagamento na próxima compra — é assim
                  que a troca acontece.
                  ${ajuda('O vale é ao portador e pode ser gasto em partes, em compras ' +
                    'diferentes. Ele não é dinheiro da gaveta: não entra na conferência do caixa.')}
                </p>
              `)
            : ''}
          <div class="pagina__acoes" style="margin-top:12px">
            <a class="botao botao--fantasma" href="#/vendas/${devolucao.venda_id}">Ver a venda</a>
            <button class="botao" data-outra>Devolver outra peça</button>
          </div>
        </div>
      </div>
    `;
    area.querySelector('[data-outra]')?.addEventListener('click', () => {
      venda = null;
      marcados = new Map();
      enviando = false;
      area.innerHTML = '';
      campo.focus();
    });
  }

  /* ---------------------------------------------------------------- ligar */

  const busca = ligarBuscaDePeca({
    campo,
    painel: raiz.querySelector('[data-busca]'),
    aoEscolher: (peca) =>
      void procurarVendas(peca.id, `${peca.produto} ${grade(peca.tamanho, peca.cor)}`),
  });
  const leitor = criarLeitor({ aoLer: lerCodigo, ignorarQuando: busca.aberta });
  leitor.ligar();
  const pararFoco = manterFoco(campo);

  if (consulta?.venda) void abrirVenda(Number(consulta.venda));

  return () => {
    leitor.desligar();
    busca.desligar();
    pararFoco();
  };
}
