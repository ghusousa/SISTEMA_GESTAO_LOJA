/**
 * Entrada de mercadoria: bipar-somar.
 *
 * Chega a sacola do fornecedor e a pessoa bipa peça por peça, inclusive repetido — bipar
 * duas vezes o mesmo código soma 2, não abre duas linhas. Só no fim, com a conferência
 * pronta, tudo vira uma entrada só na API.
 */

import { api, ErroApi } from '../api.js';
import { formatar, paraDecimalString, somar } from '../dinheiro.js';
import { criarLeitor, manterFoco } from '../leitor.js';
import { ir } from '../router.js';
import { ehAdmin, novoClientUuid } from '../store.js';
import {
  aviso,
  avisarErro,
  confirmar,
  cru,
  grade,
  html,
  ligarCampoDinheiro,
  numero,
  plural,
} from '../ui.js';

export function render(raiz) {
  const admin = ehAdmin();
  /** @type {{variante_id:number, produto:string, tamanho:string, cor:string, codigo_barras:string, quantidade:number, custo:number}[]} */
  let itens = [];
  let clientUuid = null;
  let enviando = false;

  raiz.innerHTML = html`
    <div class="pagina pagina--larga pdv">
      <div>
        <div class="pdv__leitura">
          <div class="pdv__campo">
            <label class="so-leitor" for="leitura-entrada">Código de barras</label>
            <input id="leitura-entrada" data-leitor type="text" autocomplete="off"
              placeholder="Bipe cada peça que chegou — repetir soma" />
            <span class="pdv__pisca">Leitor pronto</span>
          </div>
        </div>
        <div class="pdv__itens" data-itens></div>
      </div>

      <aside class="pdv__resumo">
        <h2 style="margin-bottom:12px">Entrada de mercadoria</h2>
        <label class="campo">
          <span>Fornecedor <span class="campo__dica">opcional</span></span>
          <input data-fornecedor maxlength="120" placeholder="Ex.: Malharia São Bento" />
        </label>
        <label class="campo">
          <span>Observação <span class="campo__dica">nota fiscal, pedido…</span></span>
          <input data-observacao maxlength="500" />
        </label>

        <div class="pdv__linha">
          <span class="texto-suave">Peças</span>
          <strong data-contagem>0</strong>
        </div>
        ${admin ? cru('<div class="pdv__linha"><span class="texto-suave">Custo total</span><span class="dinheiro" data-custo>R$ 0,00</span></div>') : ''}

        <button class="botao botao--acao botao--largo botao--grande" data-salvar style="margin-top:14px" disabled>
          Registrar entrada
        </button>
        <button class="botao botao--neutro botao--largo botao--pequeno" data-limpar style="margin-top:8px" disabled>
          Limpar conferência
        </button>

        <div class="pdv__atalhos">
          <span>Nada é gravado até você registrar a entrada.</span>
        </div>
      </aside>
    </div>
  `;

  const campo = raiz.querySelector('[data-leitor]');
  const areaItens = raiz.querySelector('[data-itens]');
  const botaoSalvar = raiz.querySelector('[data-salvar]');
  const botaoLimpar = raiz.querySelector('[data-limpar]');

  async function lerCodigo(codigo) {
    try {
      const peca = await api.get(`/variantes/codigo-barras/${encodeURIComponent(codigo)}`);
      const existente = itens.find((i) => i.variante_id === peca.variante_id);
      if (existente) {
        existente.quantidade += 1;
      } else {
        itens = [
          ...itens,
          {
            variante_id: peca.variante_id,
            produto: peca.produto,
            tamanho: peca.tamanho,
            cor: peca.cor,
            codigo_barras: peca.codigo_barras,
            quantidade: 1,
            custo: 0,
          },
        ];
      }
      pintar();
    } catch (erro) {
      if (erro instanceof ErroApi && erro.status === 404) {
        const cadastrar = await confirmar({
          titulo: 'Código não cadastrado',
          mensagem: `Nenhuma peça com o código ${codigo}. Quer cadastrar agora? A conferência atual será perdida.`,
          confirmarTexto: 'Cadastrar peça',
        });
        if (cadastrar) ir(`/produtos/novo?codigo=${encodeURIComponent(codigo)}`);
      } else {
        avisarErro(erro);
      }
    }
  }

  function pintar() {
    const pecas = somar(itens.map((i) => i.quantidade));

    areaItens.innerHTML = itens.length
      ? html`
          <table>
            <thead>
              <tr>
                <th>Peça</th>
                ${admin ? cru('<th class="direita">Custo unitário</th>') : ''}
                <th class="centro">Quantidade</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              ${itens.map(
                (item) => html`
                  <tr>
                    <td>
                      <span class="celula-principal">${item.produto}</span>
                      <span class="celula-secundaria">${grade(item.tamanho, item.cor)} · ${item.codigo_barras}</span>
                    </td>
                    ${admin
                      ? cru(html`
                          <td class="direita">
                            <input data-custo-de="${item.variante_id}" style="width:110px;text-align:right"
                              aria-label="Custo de ${item.produto}" />
                          </td>
                        `)
                      : ''}
                    <td class="centro">
                      <span class="qtd">
                        <button data-menos="${item.variante_id}" aria-label="Tirar uma">−</button>
                        <span>${numero(item.quantidade)}</span>
                        <button data-mais="${item.variante_id}" aria-label="Somar uma">+</button>
                      </span>
                    </td>
                    <td class="direita">
                      <button class="botao-icone botao-icone--perigo" data-tirar="${item.variante_id}"
                        aria-label="Tirar ${item.produto} da conferência">✕</button>
                    </td>
                  </tr>
                `,
              )}
            </tbody>
          </table>
        `
      : html`
          <div class="vazio" style="border:0;box-shadow:none">
            <p class="vazio__titulo">Bipe a mercadoria que chegou</p>
            <p class="texto-suave">
              Passe cada peça no leitor. Bipar o mesmo código de novo soma mais uma unidade.
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
        itens = itens.filter((i) => i.variante_id !== Number(b.dataset.tirar));
        pintar();
      }),
    );
    itens.forEach((item) => {
      const entrada = areaItens.querySelector(`[data-custo-de="${item.variante_id}"]`);
      if (entrada) ligarCampoDinheiro(entrada, item.custo, (valor) => {
        item.custo = valor;
        atualizarResumo();
      });
    });

    raiz.querySelector('[data-contagem]').textContent = numero(pecas);
    botaoSalvar.disabled = enviando || itens.length === 0;
    botaoLimpar.disabled = itens.length === 0;
    atualizarResumo();
  }

  function atualizarResumo() {
    const alvo = raiz.querySelector('[data-custo]');
    if (alvo) alvo.textContent = formatar(somar(itens.map((i) => i.custo * i.quantidade)));
  }

  function mudar(varianteId, delta) {
    itens = itens
      .map((i) => (i.variante_id === varianteId ? { ...i, quantidade: i.quantidade + delta } : i))
      .filter((i) => i.quantidade > 0);
    pintar();
  }

  async function salvar() {
    if (enviando || !itens.length) return;
    enviando = true;
    botaoSalvar.disabled = true;
    botaoSalvar.innerHTML = cru('<span class="giro" aria-hidden="true"></span> Registrando…');
    try {
      // Nasce aqui e sobrevive a uma repetição: se a resposta se perder, reenviar não dobra
      // o estoque da loja.
      clientUuid ||= novoClientUuid();
      const entrada = await api.post('/estoque/entradas', {
        client_uuid: clientUuid,
        fornecedor: raiz.querySelector('[data-fornecedor]').value.trim() || null,
        observacao: raiz.querySelector('[data-observacao]').value.trim() || null,
        itens: itens.map((i) => ({
          variante_id: i.variante_id,
          quantidade: i.quantidade,
          custo_unitario: i.custo > 0 ? paraDecimalString(i.custo) : null,
        })),
      });
      aviso(`Entrada registrada: ${plural(entrada.total_pecas, 'peça entrou', 'peças entraram')} no estoque.`);
      itens = [];
      clientUuid = null;
      leitor.esquecerUltimo();
      raiz.querySelector('[data-fornecedor]').value = '';
      raiz.querySelector('[data-observacao]').value = '';
      campo.focus();
    } catch (erro) {
      avisarErro(erro);
    } finally {
      enviando = false;
      botaoSalvar.textContent = 'Registrar entrada';
      pintar();
    }
  }

  botaoSalvar.addEventListener('click', salvar);
  botaoLimpar.addEventListener('click', async () => {
    if (!itens.length) return;
    const certeza = await confirmar({
      titulo: 'Limpar conferência',
      mensagem: 'Tudo que foi bipado sai da lista. Nada foi gravado ainda.',
      confirmarTexto: 'Limpar',
      perigo: true,
    });
    if (!certeza) return;
    itens = [];
    clientUuid = null;
    leitor.esquecerUltimo();
    pintar();
    campo.focus();
  });

  // Janela curta, ao contrário do PDV: bipar dez vezes a mesma etiqueta são dez peças na
  // sacola, e travar 1,2s por código atrapalharia a conferência. Os 250ms só descartam a
  // rajada dupla que o próprio leitor solta quando a etiqueta passa devagar — trocar de peça
  // na mão demora bem mais que isso.
  const leitor = criarLeitor({ aoLer: lerCodigo, repeticaoMs: 250 });
  leitor.ligar();
  const pararFoco = manterFoco(campo);
  pintar();

  return () => {
    leitor.desligar();
    pararFoco();
  };
}
