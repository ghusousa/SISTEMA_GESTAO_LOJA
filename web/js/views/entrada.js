/**
 * Entrada de mercadoria: o que chegou vira saldo.
 *
 * **Dois jeitos de dizer o que chegou, no mesmo campo.** Bipar serve para a peça que já
 * tem a nossa etiqueta colada. Mas quando o código é interno — gerado aqui dentro — a
 * mercadoria que chega do fornecedor NÃO tem etiqueta nenhuma, e exigir bipada obrigaria
 * a imprimir e colar antes de conferir, peça por peça, para registrar o que já se sabe.
 * Por isso o mesmo campo aceita o nome: digitou letras, aparece a lista; bipou, entra
 * direto. Ver `js/busca-peca.js`.
 *
 * **A conferência mora no store.** Bipar trinta peças e travar na trinta-e-uma, que ainda
 * não está cadastrada, é rotina. Antes isso custava as trinta — e o que se aprende com
 * isso é a não cadastrar. Agora ir cadastrar e voltar não perde nada.
 *
 * Peça que nunca existiu não entra por aqui: ela nasce em Produtos → Cadastrar, que já
 * tem coluna de estoque inicial. Esta tela é da segunda vez em diante.
 *
 * Quem vê dinheiro pode lançar junto a nota do fornecedor (`nota-fornecedor.js`): valor e
 * vencimentos viram Contas a pagar na MESMA transação da entrada (ADR-40).
 */

import { api, ErroApi } from '../api.js';
import { ligarBuscaDePeca } from '../busca-peca.js';
import { formatar, paraDecimalString, somar } from '../dinheiro.js';
import { notaDepoisDoDuplicado, tirarOQueJaEntrou } from '../entrada-gravada.js';
import { criarLeitor, manterFoco } from '../leitor.js';
import { ir } from '../router.js';
import { conferencia, limparConferencia, novoClientUuid } from '../store.js';
import { PODE, pode } from '../permissoes.js';
import { MAX_POR_PECA, pintarConferencia } from '../tabela-conferencia.js';
import { ligarNotaFornecedor } from '../nota-fornecedor.js';
import { ajuda, aviso, avisarErro, confirmar, cru, html, ligarCampoDinheiro, plural } from '../ui.js';

export function render(raiz) {
  const veDinheiro = pode(PODE.VER_DINHEIRO);
  let enviando = false;

  const itens = () => conferencia.get().itens;
  const definir = (lista) => conferencia.set({ itens: lista });

  raiz.innerHTML = html`
    <div class="pagina pagina--larga pdv">
      <div>
        <div class="pdv__leitura">
          <div class="pdv__campo">
            <label class="so-leitor" for="leitura-entrada">Código de barras ou nome da peça</label>
            <input id="leitura-entrada" data-leitor type="text" autocomplete="off"
              placeholder="Bipe a etiqueta ou digite o nome da peça" />
            <span class="pdv__pisca">Leitor pronto</span>
          </div>
          <div class="busca-peca" data-busca hidden></div>
        </div>
        <div class="pdv__itens" data-itens></div>
      </div>

      <aside class="pdv__resumo">
        <h2 style="margin-bottom:6px">Entrada de mercadoria</h2>
        <p class="texto-fraco" style="margin-bottom:12px">
          <strong>Soma</strong> ao que já existe. É aqui que entra o que chegou do
          fornecedor. Peça que a loja nunca teve nasce em
          <a href="#/produtos/novo">Produtos &gt; Nova peça</a>.
        </p>
        <label class="campo">
          <span>Fornecedor ${ajuda('De quem veio a mercadoria. Fica guardado no extrato de cada peça, e é o que responde "quem me vendeu esta calça" quando ela volta com defeito.')} <span class="campo__dica">opcional</span></span>
          <input data-fornecedor maxlength="120" placeholder="Ex.: Malharia São Bento" />
        </label>
        <label class="campo">
          <span>Observação <span class="campo__dica">nota fiscal, pedido…</span></span>
          <input data-observacao maxlength="500" />
        </label>
        ${veDinheiro ? html`<div data-nota></div>` : ''}

        <div class="pdv__linha">
          <span class="texto-suave">Peças</span>
          <strong data-contagem>0</strong>
        </div>
        ${veDinheiro
          ? html`<div class="pdv__linha"><span class="texto-suave">Custo total
              ${ajuda('Soma do que você vai pagar ao fornecedor. O custo que digitar aqui passa a valer para a peça daqui em diante; o lucro das vendas já feitas não muda.')}</span><span
              class="dinheiro" data-custo>R$ 0,00</span></div>`
          : ''}

        <button class="botao botao--acao botao--largo botao--grande" data-salvar style="margin-top:14px" disabled>
          Registrar entrada
        </button>
        <button class="botao botao--neutro botao--largo botao--pequeno" data-limpar style="margin-top:8px" disabled>
          Limpar conferência
        </button>

        <div class="pdv__atalhos">
          <span>Nada é gravado até você registrar a entrada.</span>
          <span>Peça que nunca foi cadastrada nasce em <strong>Produtos → Cadastrar</strong>, já com estoque inicial.</span>
        </div>
      </aside>
    </div>
  `;

  const campo = raiz.querySelector('[data-leitor]');
  const painelBusca = raiz.querySelector('[data-busca]');
  const areaItens = raiz.querySelector('[data-itens]');
  const botaoSalvar = raiz.querySelector('[data-salvar]');
  const botaoLimpar = raiz.querySelector('[data-limpar]');
  const campoFornecedor = raiz.querySelector('[data-fornecedor]');
  const campoObservacao = raiz.querySelector('[data-observacao]');

  campoFornecedor.value = conferencia.get().fornecedor || '';
  campoObservacao.value = conferencia.get().observacao || '';
  campoFornecedor.addEventListener('input', () =>
    conferencia.set({ fornecedor: campoFornecedor.value }),
  );
  campoObservacao.addEventListener('input', () =>
    conferencia.set({ observacao: campoObservacao.value }),
  );
  const nota = veDinheiro
    ? ligarNotaFornecedor(raiz.querySelector('[data-nota]'), {
        inicial: conferencia.get().nota,
        aoMudar: (estado) => conferencia.set({ nota: estado }),
      })
    : null;

  /* ------------------------------------------------------------- somar peça */

  /** Aceita tanto a resposta do bipe (`variante_id`) quanto a da busca (`id`). */
  function somarPeca(peca, quantidade = 1) {
    const varianteId = peca.variante_id ?? peca.id;
    const existente = itens().find((i) => i.variante_id === varianteId);
    if (existente) {
      definir(
        itens().map((i) =>
          i.variante_id === varianteId
            ? { ...i, quantidade: Math.min(i.quantidade + quantidade, MAX_POR_PECA) }
            : i,
        ),
      );
    } else {
      definir([
        ...itens(),
        {
          variante_id: varianteId,
          produto: peca.produto,
          tamanho: peca.tamanho,
          cor: peca.cor,
          codigo_barras: peca.codigo_barras,
          preco_venda: peca.preco_venda,
          quantidade,
          custo: 0,
        },
      ]);
    }
    pintar();
  }

  async function lerCodigo(codigo) {
    try {
      somarPeca(await api.get(`/variantes/codigo-barras/${encodeURIComponent(codigo)}`));
    } catch (erro) {
      if (!(erro instanceof ErroApi) || erro.status !== 404) {
        avisarErro(erro);
        return;
      }
      const cadastrar = await confirmar({
        titulo: 'Peça ainda não cadastrada',
        mensagem: `Nada com o código ${codigo}. Quer cadastrar agora? A conferência atual fica guardada.`,
        confirmarTexto: 'Cadastrar peça',
      });
      if (cadastrar) ir(`/produtos/novo?codigo=${encodeURIComponent(codigo)}&voltar=entrada`);
      else campo.focus();
    }
  }

  /* ---------------------------------------------------------------- desenhar */

  function pintar() {
    const lista = itens();
    const total = pintarConferencia({
      area: areaItens,
      itens: lista,
      veDinheiro,
      aoMudar: (novos) => {
        definir(novos);
        pintar();
      },
      ligarCusto: (campo, item) =>
        ligarCampoDinheiro(campo, item.custo, (valor) => {
          item.custo = valor;
          atualizarResumo();
        }),
    });
    raiz.querySelector('[data-contagem]').textContent = total;
    botaoSalvar.disabled = enviando || lista.length === 0;
    botaoLimpar.disabled = lista.length === 0;
    atualizarResumo();
  }

  function atualizarResumo() {
    const alvo = raiz.querySelector('[data-custo]');
    if (alvo) alvo.textContent = formatar(somar(itens().map((i) => i.custo * i.quantidade)));
  }

  /* ----------------------------------------------------------------- gravar */

  async function salvar() {
    if (enviando || !itens().length) return;
    let notaApi = null;
    try {
      notaApi = nota?.paraApi() ?? null;
    } catch (erro) {
      avisarErro(erro);
      return;
    }
    enviando = true;
    botaoSalvar.disabled = true;
    botaoSalvar.innerHTML = cru('<span class="giro" aria-hidden="true"></span> Registrando…');
    const registrados = itens();
    try {
      // Nasce aqui e sobrevive a uma repetição: se a resposta se perder, reenviar não dobra
      // o estoque da loja.
      const clientUuid = conferencia.get().clientUuid || novoClientUuid();
      conferencia.set({ clientUuid });
      const entrada = await api.post('/estoque/entradas', {
        client_uuid: clientUuid,
        fornecedor: campoFornecedor.value.trim() || null,
        observacao: campoObservacao.value.trim() || null,
        itens: registrados.map((i) => ({
          variante_id: i.variante_id,
          quantidade: i.quantidade,
          custo_unitario: i.custo > 0 ? paraDecimalString(i.custo) : null,
        })),
        ...(notaApi ? { nota: notaApi } : {}),
      });
      limparConferencia();
      nota?.limpar();
      campoFornecedor.value = '';
      campoObservacao.value = '';
      leitor.esquecerUltimo();
      pintar();
      await ofereceEtiquetas(entrada, registrados);
      campo.focus();
    } catch (erro) {
      if (erro instanceof ErroApi && erro.status === 409 && erro.detail?.entrada_id) {
        await avisarEntradaJaGravada(erro, notaApi);
        return;
      }
      avisarErro(erro);
    } finally {
      enviando = false;
      botaoSalvar.textContent = 'Registrar entrada';
      pintar();
    }
  }

  /**
   * A chave desta conferência já gravou OUTRA entrada (resposta perdida, lista mudada
   * depois): o servidor recusa (ADR-2) e devolve os itens dela. O que ela gravou sai da
   * lista ANTES de a chave sair — só trocar a chave e reenviar tudo somaria de novo as
   * peças que já entraram (10 P + 7 M viravam +20 P). Fica o que falta registrar. A nota
   * idem: se a gravada já levou ESTA nota, reenviá-la dobraria Contas a pagar; se levou
   * outra (ou nenhuma), esta ainda não entrou e fica.
   */
  async function avisarEntradaJaGravada(erro, notaApi) {
    const resto = tirarOQueJaEntrou(itens(), erro.detail.itens || []);
    const { tirarNota, frase } = notaDepoisDoDuplicado(erro.detail, notaApi, resto.length > 0);
    definir(resto);
    if (tirarNota) nota?.limpar();
    conferencia.set({ clientUuid: null });
    pintar();
    const lista = resto.length
      ? 'Tirei da lista o que ela já gravou; confira e registre o que falta.'
      : 'Tudo o que estava na lista ela já tinha gravado.';
    const verExtrato = await confirmar({
      titulo: 'Esta entrada já foi gravada',
      mensagem: `${erro.message} ${lista}${frase ? ` ${frase}` : ''}`,
      confirmarTexto: 'Ver extrato',
    });
    if (verExtrato) ir('/estoque/extrato?tipo=ENTRADA');
    else campo.focus();
  }

  /**
   * Mercadoria que entra é mercadoria que precisa de etiqueta — e a quantidade certa é a
   * que ACABOU de chegar, não o saldo (que já inclui o que estava na arara).
   */
  async function ofereceEtiquetas(entrada, registrados) {
    const total = plural(entrada.total_pecas, 'peça entrou', 'peças entraram');
    const contas = entrada.contas_a_pagar
      ? ` ${plural(entrada.contas_a_pagar, 'parcela foi', 'parcelas foram')} para Contas a pagar.`
      : '';
    const imprimir = await confirmar({
      titulo: 'Entrada registrada',
      mensagem: `${total} no estoque.${contas} Imprimir as etiquetas destas peças agora?`,
      confirmarTexto: 'Imprimir etiquetas',
    });
    if (!imprimir) {
      aviso(`Entrada registrada: ${total} no estoque.`);
      return;
    }
    conferencia.set({ etiquetas: registrados });
    ir('/etiquetas');
  }

  botaoSalvar.addEventListener('click', salvar);
  botaoLimpar.addEventListener('click', async () => {
    if (!itens().length) return;
    const certeza = await confirmar({
      titulo: 'Limpar conferência',
      mensagem: 'Tudo que foi conferido sai da lista. Nada foi gravado ainda.',
      confirmarTexto: 'Limpar',
      perigo: true,
    });
    if (!certeza) return;
    limparConferencia();
    nota?.limpar();
    campoFornecedor.value = '';
    campoObservacao.value = '';
    leitor.esquecerUltimo();
    pintar();
    campo.focus();
  });

  const busca = ligarBuscaDePeca({
    campo,
    painel: painelBusca,
    aoEscolher: (peca) => somarPeca(peca),
  });

  // Janela curta, ao contrário do PDV: bipar dez vezes a mesma etiqueta são dez peças na
  // sacola, e travar 1,2s por código atrapalharia a conferência. Os 250ms só descartam a
  // rajada dupla que o próprio leitor solta quando a etiqueta passa devagar — trocar de peça
  // na mão demora bem mais que isso.
  const leitor = criarLeitor({
    aoLer: lerCodigo,
    repeticaoMs: 250,
    ignorarQuando: busca.aberta,
  });
  leitor.ligar();
  const pararFoco = manterFoco(campo);
  pintar();

  return () => {
    leitor.desligar();
    busca.desligar();
    pararFoco();
  };
}
