/**
 * Inventário: contagem física da loja.
 *
 * A pessoa anda com o leitor e bipa o que está na arara; cada bipada soma 1 à contagem
 * daquela peça. Peça com a etiqueta caída também precisa ser contada — senão a contagem
 * acusaria uma falta que não existe e o acerto tiraria do estoque uma peça que está na
 * arara. Por isso o mesmo campo aceita o nome (`js/busca-peca.js`). No fim, um envio só compara com o sistema e gera as movimentações das
 * diferenças — o que não foi contado não é mexido, porque contagem parcial de uma arara não
 * pode zerar o resto da loja.
 */

import { api, ErroApi } from '../api.js';
import { ligarBuscaDePeca } from '../busca-peca.js';
import { criarLeitor, manterFoco } from '../leitor.js';
import {
  aviso,
  avisarErro,
  confirmar,
  cru,
  grade,
  html,
  modal,
  numero,
  plural,
} from '../ui.js';

export function render(raiz) {
  /** @type {{variante_id:number, produto:string, tamanho:string, cor:string, codigo_barras:string, contado:number, saldo:number}[]} */
  let contagens = [];
  let enviando = false;

  raiz.innerHTML = html`
    <div class="pagina pagina--larga pdv">
      <div>
        <div class="pdv__leitura">
          <div class="pdv__campo">
            <label class="so-leitor" for="leitura-inventario">Código de barras ou nome da peça</label>
            <input id="leitura-inventario" data-leitor type="text" autocomplete="off"
              placeholder="Bipe a peça, ou digite o nome se a etiqueta caiu" />
            <span class="pdv__pisca">Leitor pronto</span>
          </div>
          <div class="busca-peca" data-busca hidden></div>
        </div>
        <div class="pdv__itens" data-itens></div>
      </div>

      <aside class="pdv__resumo">
        <h2 style="margin-bottom:6px">Contagem física</h2>
        <p class="texto-fraco">
          Só as peças bipadas são conferidas. O que você não contar fica exatamente como está.
        </p>

        <div class="pdv__linha">
          <span class="texto-suave">Peças contadas</span>
          <strong data-contadas>0</strong>
        </div>
        <div class="pdv__linha">
          <span class="texto-suave">Itens conferidos</span>
          <strong data-itens-conferidos>0</strong>
        </div>
        <div class="pdv__linha">
          <span class="texto-suave">Divergências</span>
          <strong data-divergencias>0</strong>
        </div>

        <label class="campo" style="margin-top:12px">
          <span>Observação <span class="campo__dica">fica no extrato</span></span>
          <input data-observacao maxlength="500" placeholder="Ex.: contagem da arara do fundo" />
        </label>

        <button class="botao botao--acao botao--largo botao--grande" data-fechar disabled>
          Fechar contagem
        </button>
        <button class="botao botao--neutro botao--largo botao--pequeno" data-limpar style="margin-top:8px" disabled>
          Descartar contagem
        </button>
      </aside>
    </div>
  `;

  const campo = raiz.querySelector('[data-leitor]');
  const areaItens = raiz.querySelector('[data-itens]');
  const botaoFechar = raiz.querySelector('[data-fechar]');
  const botaoLimpar = raiz.querySelector('[data-limpar]');

  /** Soma 1 à contagem. Aceita a resposta do bipe (`variante_id`) e a da busca (`id`). */
  function contar(peca) {
    const varianteId = peca.variante_id ?? peca.id;
    const existente = contagens.find((c) => c.variante_id === varianteId);
    if (existente) {
      existente.contado += 1;
      existente.saldo = peca.saldo;
    } else {
      contagens = [
        ...contagens,
        {
          variante_id: varianteId,
          produto: peca.produto,
          tamanho: peca.tamanho,
          cor: peca.cor,
          codigo_barras: peca.codigo_barras,
          contado: 1,
          saldo: peca.saldo,
        },
      ];
    }
    pintar();
  }

  async function lerCodigo(codigo) {
    try {
      contar(await api.get(`/variantes/codigo-barras/${encodeURIComponent(codigo)}`));
    } catch (erro) {
      if (erro instanceof ErroApi && erro.status === 404) {
        aviso(`Código ${codigo} não está cadastrado. Anote e cadastre depois.`, 'alerta');
      } else {
        avisarErro(erro);
      }
    }
  }

  function pintar() {
    const pecas = contagens.reduce((t, c) => t + c.contado, 0);
    const divergentes = contagens.filter((c) => c.contado !== c.saldo);

    areaItens.innerHTML = contagens.length
      ? html`
          <table>
            <thead>
              <tr>
                <th>Peça</th>
                <th class="direita">No sistema</th>
                <th class="centro">Contado</th>
                <th class="direita">Diferença</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              ${contagens.map(linha)}
            </tbody>
          </table>
        `
      : html`
          <div class="vazio" style="border:0;box-shadow:none">
            <p class="vazio__titulo">Comece a contar</p>
            <p class="texto-suave">
              Bipe cada peça da arara. Bipar de novo a mesma etiqueta soma mais uma unidade à contagem.
            </p>
          </div>
        `;

    areaItens.querySelectorAll('[data-menos]').forEach((b) =>
      b.addEventListener('click', () => mudar(Number(b.dataset.menos), -1)),
    );
    areaItens.querySelectorAll('[data-mais]').forEach((b) =>
      b.addEventListener('click', () => mudar(Number(b.dataset.mais), +1)),
    );
    areaItens.querySelectorAll('[data-tirar]').forEach((b) =>
      b.addEventListener('click', () => {
        contagens = contagens.filter((c) => c.variante_id !== Number(b.dataset.tirar));
        pintar();
      }),
    );

    raiz.querySelector('[data-contadas]').textContent = numero(pecas);
    raiz.querySelector('[data-itens-conferidos]').textContent = numero(contagens.length);
    raiz.querySelector('[data-divergencias]').textContent = numero(divergentes.length);
    botaoFechar.disabled = enviando || contagens.length === 0;
    botaoLimpar.disabled = contagens.length === 0;
  }

  function linha(c) {
    const diferenca = c.contado - c.saldo;
    return html`
      <tr>
        <td>
          <span class="celula-principal">${c.produto}</span>
          <span class="celula-secundaria">${grade(c.tamanho, c.cor)} · ${c.codigo_barras}</span>
        </td>
        <td class="direita dinheiro texto-suave">${numero(c.saldo)}</td>
        <td class="centro">
          <span class="qtd">
            <button data-menos="${c.variante_id}" aria-label="Tirar uma da contagem">−</button>
            <span>${numero(c.contado)}</span>
            <button data-mais="${c.variante_id}" aria-label="Somar uma à contagem">+</button>
          </span>
        </td>
        <td class="direita dinheiro celula-principal ${cru(diferenca === 0 ? 'texto-suave' : diferenca > 0 ? 'positivo' : 'negativo')}">
          ${diferenca === 0 ? 'confere' : `${diferenca > 0 ? '+' : '−'}${numero(Math.abs(diferenca))}`}
        </td>
        <td class="direita">
          <button class="botao-icone botao-icone--perigo" data-tirar="${c.variante_id}"
            aria-label="Tirar ${c.produto} da contagem">✕</button>
        </td>
      </tr>
    `;
  }

  function mudar(varianteId, delta) {
    contagens = contagens
      .map((c) => (c.variante_id === varianteId ? { ...c, contado: Math.max(0, c.contado + delta) } : c))
      .filter((c) => c.contado > 0 || c.saldo > 0);
    pintar();
  }

  async function fecharContagem() {
    if (enviando || !contagens.length) return;
    const divergentes = contagens.filter((c) => c.contado !== c.saldo);

    const certeza = await confirmar({
      titulo: 'Fechar a contagem',
      mensagem: divergentes.length
        ? `${plural(divergentes.length, 'peça tem', 'peças têm')} diferença e ${divergentes.length === 1 ? 'vai ser corrigida' : 'vão ser corrigidas'} no estoque. As outras ficam como estão.`
        : 'Nenhuma diferença encontrada. O inventário fica registrado como conferência.',
      confirmarTexto: 'Fechar contagem',
    });
    if (!certeza) return;

    enviando = true;
    botaoFechar.disabled = true;
    botaoFechar.innerHTML = cru('<span class="giro" aria-hidden="true"></span> Fechando…');
    try {
      const resultado = await api.post('/estoque/inventarios', {
        observacao: raiz.querySelector('[data-observacao]').value.trim() || null,
        contagens: contagens.map((c) => ({ variante_id: c.variante_id, quantidade_contada: c.contado })),
      });
      contagens = [];
      raiz.querySelector('[data-observacao]').value = '';
      leitor.esquecerUltimo();
      await mostrarResultado(resultado);
      campo.focus();
    } catch (erro) {
      avisarErro(erro);
    } finally {
      enviando = false;
      botaoFechar.textContent = 'Fechar contagem';
      pintar();
    }
  }

  botaoFechar.addEventListener('click', fecharContagem);
  botaoLimpar.addEventListener('click', async () => {
    if (!contagens.length) return;
    const certeza = await confirmar({
      titulo: 'Descartar contagem',
      mensagem: 'Tudo que foi contado se perde. O estoque não muda.',
      confirmarTexto: 'Descartar',
      perigo: true,
    });
    if (!certeza) return;
    contagens = [];
    leitor.esquecerUltimo();
    pintar();
    campo.focus();
  });

  const busca = ligarBuscaDePeca({
    campo,
    painel: raiz.querySelector('[data-busca]'),
    aoEscolher: contar,
  });
  // Mesma janela curta da entrada: 250ms só descartam a rajada dupla do próprio leitor.
  const leitor = criarLeitor({ aoLer: lerCodigo, repeticaoMs: 250, ignorarQuando: busca.aberta });
  leitor.ligar();
  const pararFoco = manterFoco(campo);
  pintar();

  return () => {
    leitor.desligar();
    busca.desligar();
    pararFoco();
  };
}

async function mostrarResultado(resultado) {
  await modal({
    titulo: 'Inventário registrado',
    largura: '560px',
    render: () => html`
      <div class="grade-cartoes" style="margin-bottom:12px">
        <div class="indicador">
          <div class="indicador__rotulo">Conferidas</div>
          <div class="indicador__valor">${numero(resultado.conferidas)}</div>
        </div>
        <div class="indicador">
          <div class="indicador__rotulo">Corrigidas</div>
          <div class="indicador__valor">${numero(resultado.ajustadas)}</div>
        </div>
        <div class="indicador">
          <div class="indicador__rotulo">Saldo líquido</div>
          <div class="indicador__valor ${cru(resultado.diferenca_total < 0 ? 'negativo' : 'positivo')}">
            ${resultado.diferenca_total > 0 ? '+' : ''}${numero(resultado.diferenca_total)}
          </div>
        </div>
      </div>

      ${resultado.diferencas.length
        ? cru(html`
            <div class="tabela-rolagem">
              <table>
                <thead>
                  <tr>
                    <th>Peça</th>
                    <th class="direita">Sistema</th>
                    <th class="direita">Contado</th>
                    <th class="direita">Diferença</th>
                  </tr>
                </thead>
                <tbody>
                  ${resultado.diferencas.map(
                    (d) => html`
                      <tr>
                        <td>
                          <span class="celula-principal">${d.produto}</span>
                          <span class="celula-secundaria">${grade(d.tamanho, d.cor)}</span>
                        </td>
                        <td class="direita dinheiro texto-suave">${numero(d.saldo_sistema)}</td>
                        <td class="direita dinheiro">${numero(d.quantidade_contada)}</td>
                        <td class="direita dinheiro celula-principal ${cru(d.diferenca < 0 ? 'negativo' : 'positivo')}">
                          ${d.diferenca > 0 ? '+' : '−'}${numero(Math.abs(d.diferenca))}
                        </td>
                      </tr>
                    `,
                  )}
                </tbody>
              </table>
            </div>
          `)
        : cru('<p class="texto-suave">Nenhuma diferença: a contagem bateu com o sistema.</p>')}

      <div class="modal__acoes">
        <button class="botao" data-ok>Entendido</button>
      </div>
    `,
    aoAbrir: (corpo, fechar) => {
      corpo.querySelector('[data-ok]').addEventListener('click', () => fechar(true));
      corpo.querySelector('[data-ok]').focus();
    },
  });
}
