/**
 * Cadastro de produto com a grade inteira de uma vez.
 *
 * Roupa não se cadastra peça a peça: chega uma camiseta em P, M, G e GG, mesmo preço, mesmo
 * custo. A tela nasce com os valores padrão em cima e os botões de tamanho geram as linhas
 * já preenchidas — sobra digitar o código de cada etiqueta.
 */

import { api } from '../api.js';
import { PODE, pode } from '../permissoes.js';
import { TIPOS_ACEITOS, enviarFoto } from '../foto.js';
import { paraDecimalString } from '../dinheiro.js';
import { ir } from '../router.js';
import { conferencia } from '../store.js';
import { aviso, avisarErro, cru, html, ligarCampoDinheiro, modal } from '../ui.js';

const TAMANHOS_RAPIDOS = ['PP', 'P', 'M', 'G', 'GG', 'XG'];

export async function render(raiz, _params, consulta) {
  // A vendedora cadastra a peça; o custo é preenchido depois pela dona, na edição — é o
  // que a SPEC diz e o que o app já fazia. Sem isto, o web pedia a ela um número que ela
  // não pode conferir depois (a API não devolve custo para quem não vê dinheiro), e um
  // erro de digitação só apareceria no lucro do mês.
  const veDinheiro = pode(PODE.VER_DINHEIRO);

  const codigoInicial = consulta.codigo || '';

  raiz.innerHTML = html`
    <div class="pagina">
      <div class="pagina__topo">
        <div>
          <a class="botao botao--fantasma botao--pequeno" href="#/produtos">← Produtos</a>
          <h1>Novo produto</h1>
          <p class="texto-suave">Preencha os dados, escolha os tamanhos e confira os códigos.</p>
        </div>
      </div>

      <div class="cartao" style="margin-bottom:16px">
        <div class="cartao__corpo">
          <div class="linha-campos">
            <label class="campo">
              <span>Nome do produto</span>
              <input data-nome placeholder="Ex.: Camiseta Básica Algodão" maxlength="120" />
            </label>
            <label class="campo">
              <span>Categoria</span>
              <span style="display:flex;gap:8px">
                <select data-categoria></select>
                ${pode(PODE.EDITAR_CATALOGO)
                  ? cru(
                      '<button class="botao botao--neutro botao--pequeno" data-nova-categoria ' +
                        'type="button" title="Criar categoria">+</button>',
                    )
                  : ''}
              </span>
            </label>
          </div>
          <label class="campo">
            <span>Descrição <span class="campo__dica">opcional</span></span>
            <input data-descricao maxlength="2000" placeholder="Tecido, modelagem, observações" />
          </label>

          <div class="campo">
            <span>Foto <span class="campo__dica">opcional</span></span>
            <div class="foto-escolha">
              <div class="foto-escolha__quadro" data-foto-quadro>
                <span class="foto-escolha__vazio" data-foto-vazio>sem foto</span>
                <img class="foto-escolha__img" data-foto-previa alt="" hidden />
              </div>
              <div>
                <input type="file" data-foto accept="${cru(TIPOS_ACEITOS)}" hidden />
                <button class="botao botao--neutro botao--pequeno" data-foto-escolher type="button">
                  Escolher imagem
                </button>
                <button class="botao botao--neutro botao--pequeno" data-foto-tirar type="button" hidden>
                  Remover
                </button>
                <p class="texto-fraco" style="margin:6px 0 0;font-size:13px">
                  A imagem é reduzida antes de subir. Ajuda a achar a peça na lista.
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="cartao" style="margin-bottom:16px">
        <div class="cartao__topo">
          <h2>Valores padrão da grade</h2>
          <button class="botao botao--neutro botao--pequeno" data-aplicar type="button">Aplicar a todas</button>
        </div>
        <div class="cartao__corpo">
          <div class="linha-campos">
            <label class="campo">
              <span>Preço de venda</span>
              <input data-padrao-venda inputmode="numeric" />
            </label>
            ${veDinheiro
              ? cru(html`
                  <label class="campo">
                    <span>Preço de custo</span>
                    <input data-padrao-custo inputmode="numeric" />
                  </label>
                `)
              : ''}
            <label class="campo">
              <span>Estoque mínimo</span>
              <input data-padrao-minimo type="number" min="0" step="1" value="2" />
            </label>
          </div>
        </div>
      </div>

      <div class="cartao">
        <div class="cartao__topo">
          <h2>Peças da grade</h2>
          <div class="pagina__acoes">
            ${TAMANHOS_RAPIDOS.map(
              (t) => html`<button class="botao botao--neutro botao--pequeno" data-tamanho="${t}" type="button">${t}</button>`,
            )}
            <button class="botao botao--neutro botao--pequeno" data-linha-livre type="button">Outro</button>
          </div>
        </div>
        <div class="tabela-rolagem" style="border:0;box-shadow:none;border-radius:0">
          <table>
            <thead>
              <tr>
                <th>Tamanho</th>
                <th>Cor</th>
                <th>Código de barras</th>
                <th class="direita">Venda</th>
                ${veDinheiro ? cru('<th class="direita">Custo</th>') : ''}
                <th class="direita">Entrada</th>
                <th class="direita">Mínimo</th>
                <th></th>
              </tr>
            </thead>
            <tbody data-linhas></tbody>
          </table>
        </div>
        <div class="cartao__corpo" data-sem-linhas>
          <p class="texto-suave centro">
            Clique nos tamanhos acima para montar a grade. Cada tamanho vira uma peça com código próprio.
          </p>
        </div>
      </div>

      <div class="pagina__acoes" style="justify-content:flex-end;margin-top:16px">
        <a class="botao botao--neutro" href="#/produtos">Cancelar</a>
        <button class="botao botao--acao botao--grande" data-salvar type="button">Cadastrar produto</button>
      </div>
    </div>
  `;

  const corpoLinhas = raiz.querySelector('[data-linhas]');
  const avisoSemLinhas = raiz.querySelector('[data-sem-linhas]');
  const seletorCategoria = raiz.querySelector('[data-categoria]');

  const padraoVenda = ligarCampoDinheiro(raiz.querySelector('[data-padrao-venda]'), 0);
  const campoPadraoCusto = raiz.querySelector('[data-padrao-custo]');
  //: Sem a coluna, o custo é zero e a dona preenche depois. `valor()` mantém a mesma cara
  //: para o resto do arquivo não precisar saber quem está logado.
  const padraoCusto = campoPadraoCusto
    ? ligarCampoDinheiro(campoPadraoCusto, 0)
    : { valor: () => 0, definir: () => {} };
  const padraoMinimo = raiz.querySelector('[data-padrao-minimo]');

  /** Cada linha guarda os próprios campos de dinheiro para ler na hora de salvar. */
  const linhas = [];

  // A foto espera o produto existir: o upload é por id, e o id só nasce no POST.
  let fotoEscolhida = null;
  const campoFoto = raiz.querySelector('[data-foto]');
  const previaFoto = raiz.querySelector('[data-foto-previa]');
  const vazioFoto = raiz.querySelector('[data-foto-vazio]');
  const botaoRemoverFoto = raiz.querySelector('[data-foto-tirar]');
  let urlPrevia = null;

  function mostrarPrevia(arquivo) {
    if (urlPrevia) URL.revokeObjectURL(urlPrevia);
    urlPrevia = arquivo ? URL.createObjectURL(arquivo) : null;
    previaFoto.hidden = !arquivo;
    vazioFoto.hidden = !!arquivo;
    botaoRemoverFoto.hidden = !arquivo;
    if (urlPrevia) previaFoto.src = urlPrevia;
  }

  raiz.querySelector('[data-foto-escolher]').addEventListener('click', () => campoFoto.click());
  raiz.querySelector('[data-foto-quadro]').addEventListener('click', () => campoFoto.click());
  campoFoto.addEventListener('change', () => {
    fotoEscolhida = campoFoto.files?.[0] ?? null;
    mostrarPrevia(fotoEscolhida);
  });
  botaoRemoverFoto.addEventListener('click', (evento) => {
    evento.stopPropagation();
    fotoEscolhida = null;
    campoFoto.value = '';
    mostrarPrevia(null);
  });

  async function carregarCategorias(selecionar) {
    try {
      const { items } = await api.get('/categorias', { size: 100 });
      seletorCategoria.innerHTML = items.map((c) => html`<option value="${c.id}">${c.nome}</option>`).join('');
      if (selecionar) seletorCategoria.value = String(selecionar);
      if (!items.length) {
        seletorCategoria.innerHTML = '<option value="">Cadastre uma categoria</option>';
      }
    } catch (erro) {
      avisarErro(erro);
    }
  }

  function adicionarLinha(tamanho = '') {
    const tr = document.createElement('tr');
    tr.innerHTML = html`
      <td><input data-t value="${tamanho}" placeholder="P" maxlength="20" style="width:78px" /></td>
      <td><input data-c value="Única" maxlength="40" style="width:120px" /></td>
      <td>
        <span style="display:flex;gap:6px">
          <input data-cod maxlength="32" placeholder="Bipe ou gere" style="width:150px" />
          <button class="botao botao--neutro botao--pequeno" data-gerar type="button" title="Gerar código interno">#</button>
        </span>
      </td>
      <td><input data-v inputmode="numeric" style="width:96px;text-align:right" /></td>
      ${veDinheiro
        ? cru('<td><input data-cu inputmode="numeric" style="width:96px;text-align:right" /></td>')
        : ''}
      <td><input data-e type="number" min="0" step="1" value="0" style="width:80px;text-align:right" /></td>
      <td><input data-m type="number" min="0" step="1" style="width:80px;text-align:right" /></td>
      <td class="direita">
        <button class="botao-icone botao-icone--perigo" data-remover type="button" aria-label="Tirar esta peça">✕</button>
      </td>
    `;
    corpoLinhas.append(tr);

    const registro = {
      tr,
      venda: ligarCampoDinheiro(tr.querySelector('[data-v]'), padraoVenda.valor()),
      custo: (() => {
        const campo = tr.querySelector('[data-cu]');
        return campo
          ? ligarCampoDinheiro(campo, padraoCusto.valor())
          : { valor: () => 0, definir: () => {} };
      })(),
    };
    tr.querySelector('[data-m]').value = padraoMinimo.value || '0';
    linhas.push(registro);

    tr.querySelector('[data-remover]').addEventListener('click', () => {
      linhas.splice(linhas.indexOf(registro), 1);
      tr.remove();
      atualizarVazio();
    });
    tr.querySelector('[data-gerar]').addEventListener('click', async (e) => {
      e.currentTarget.disabled = true;
      try {
        const { codigo } = await api.post('/variantes/gerar-codigo-interno', {});
        tr.querySelector('[data-cod]').value = codigo;
      } catch (erro) {
        avisarErro(erro);
      } finally {
        e.currentTarget.disabled = false;
      }
    });

    atualizarVazio();
    return tr;
  }

  const atualizarVazio = () => {
    avisoSemLinhas.hidden = linhas.length > 0;
  };

  /* ------------------------------------------------------------------- ações */

  raiz.querySelectorAll('[data-tamanho]').forEach((b) =>
    b.addEventListener('click', () => adicionarLinha(b.dataset.tamanho).querySelector('[data-cod]').focus()),
  );
  raiz.querySelector('[data-linha-livre]').addEventListener('click', () => {
    adicionarLinha().querySelector('[data-t]').focus();
  });

  raiz.querySelector('[data-aplicar]').addEventListener('click', () => {
    linhas.forEach((l) => {
      l.venda.definir(padraoVenda.valor());
      l.custo.definir(padraoCusto.valor());
      l.tr.querySelector('[data-m]').value = padraoMinimo.value || '0';
    });
    aviso('Valores aplicados a toda a grade.');
  });

  raiz.querySelector('[data-nova-categoria]')?.addEventListener('click', async () => {
    const nome = await modal({
      titulo: 'Nova categoria',
      largura: '400px',
      render: () => html`
        <label class="campo">
          <span>Nome</span>
          <input data-nome placeholder="Ex.: Vestidos" maxlength="80" />
        </label>
        <div class="modal__acoes">
          <button class="botao botao--neutro" data-nao>Cancelar</button>
          <button class="botao" data-ok>Criar</button>
        </div>
      `,
      aoAbrir: (corpo, fechar) => {
        corpo.querySelector('[data-nao]').addEventListener('click', () => fechar(undefined));
        corpo.querySelector('[data-ok]').addEventListener('click', () => fechar(corpo.querySelector('[data-nome]').value.trim()));
      },
    });
    if (!nome) return;
    try {
      const criada = await api.post('/categorias', { nome });
      await carregarCategorias(criada.id);
      aviso(`Categoria "${criada.nome}" criada.`);
    } catch (erro) {
      avisarErro(erro);
    }
  });

  raiz.querySelector('[data-salvar]').addEventListener('click', salvar);

  /**
   * Quem veio da entrada de mercadoria volta para lá com a peça JÁ conferida.
   *
   * O caminho existe porque bipar uma etiqueta desconhecida no meio da sacola é rotina:
   * mandar a pessoa cadastrar e depois se virar para achar a peça de novo é o tipo de
   * volta que faz a conferência ser abandonada pela metade.
   */
  function voltarParaEntrada(produto) {
    const nova =
      produto.variantes.find((v) => v.codigo_barras === codigoInicial) || produto.variantes[0];
    if (nova) {
      const itens = conferencia.get().itens;
      const jaEsta = itens.some((i) => i.variante_id === nova.id);
      if (!jaEsta) {
        conferencia.set({
          itens: [
            ...itens,
            {
              variante_id: nova.id,
              produto: produto.nome,
              tamanho: nova.tamanho,
              cor: nova.cor,
              codigo_barras: nova.codigo_barras,
              preco_venda: nova.preco_venda,
              quantidade: 1,
              custo: 0,
            },
          ],
        });
      }
    }
    ir('/estoque/entrada');
  }

  async function salvar(evento) {
    const botao = evento.currentTarget;
    const nome = raiz.querySelector('[data-nome]').value.trim();
    const categoriaId = Number(seletorCategoria.value);

    if (nome.length < 2) return aviso('Dê um nome ao produto.', 'alerta');
    if (!categoriaId) return aviso('Escolha uma categoria.', 'alerta');
    if (!linhas.length) return aviso('Monte a grade: pelo menos uma peça.', 'alerta');

    const variantes = linhas.map((l) => ({
      tamanho: l.tr.querySelector('[data-t]').value.trim(),
      cor: l.tr.querySelector('[data-c]').value.trim() || 'Única',
      codigo_barras: l.tr.querySelector('[data-cod]').value.trim() || null,
      preco_venda: paraDecimalString(l.venda.valor()),
      preco_custo: paraDecimalString(l.custo.valor()),
      estoque_inicial: Number(l.tr.querySelector('[data-e]').value) || 0,
      estoque_minimo: Number(l.tr.querySelector('[data-m]').value) || 0,
    }));

    if (variantes.some((v) => !v.tamanho)) return aviso('Toda peça precisa de um tamanho.', 'alerta');
    if (variantes.some((v) => Number(v.preco_venda) <= 0))
      return aviso('Toda peça precisa de preço de venda.', 'alerta');

    botao.disabled = true;
    botao.innerHTML = cru('<span class="giro" aria-hidden="true"></span> Cadastrando…');
    try {
      const produto = await api.post('/produtos', {
        nome,
        categoria_id: categoriaId,
        descricao: raiz.querySelector('[data-descricao]').value.trim() || null,
        variantes,
      });
      if (fotoEscolhida) {
        // A peça já está cadastrada e vendável. Se a foto falhar, o cadastro fica de pé e
        // a pessoa tenta de novo pelo detalhe — desfazer o produto por causa de uma
        // imagem seria bem pior do que ficar sem ela.
        try {
          await enviarFoto(api, produto.id, fotoEscolhida);
        } catch (erroFoto) {
          aviso(`Peça cadastrada, mas a foto não subiu: ${erroFoto.message}`, 'alerta');
        }
      }
      aviso(`"${produto.nome}" cadastrado com ${produto.variantes.length} peças.`);
      if (consulta.voltar === 'entrada') {
        voltarParaEntrada(produto);
        return;
      }
      ir(`/produtos/${produto.id}`);
    } catch (erro) {
      avisarErro(erro);
      botao.disabled = false;
      botao.textContent = 'Cadastrar produto';
    }
  }

  await carregarCategorias();
  // Veio do PDV com um código que não existia: a primeira peça já nasce com ele.
  if (codigoInicial) {
    const linha = adicionarLinha();
    linha.querySelector('[data-cod]').value = codigoInicial;
    aviso(`Código ${codigoInicial} já preenchido na primeira peça.`);
  }
  raiz.querySelector('[data-nome]').focus();
}
