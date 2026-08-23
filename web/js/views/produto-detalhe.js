/**
 * Detalhe do produto: dados, foto e a grade de peças.
 *
 * É aqui que os preços mudam. Numa loja de roupas isso acontece toda semana (promoção,
 * remarcação, custo novo do fornecedor) e é a operação que mais pede teclado — por isso ela
 * ganhou tela no computador antes de qualquer outra coisa.
 */

import { ouvir } from '../tempo-real.js';
import { api } from '../api.js';
import { svgEan13 } from '../codigo-barras.js';
import { TIPOS_ACEITOS, enviarFoto } from '../foto.js';
import { formatar, paraCentavos, paraDecimalString } from '../dinheiro.js';
import { ir } from '../router.js';
import { PODE, pode } from '../permissoes.js';
import {
  aviso,
  avisarErro,
  carregando,
  confirmar,
  cru,
  erroBloco,
  etiqueta,
  grade,
  html,
  ligarCampoDinheiro,
  modal,
  numero,
  plural,
} from '../ui.js';
import { ajustarEstoque } from './ajuste.js';

export async function render(raiz, { id }) {
  raiz.innerHTML = `<div class="pagina">${carregando()}</div>`;
  const veDinheiro = pode(PODE.VER_DINHEIRO);

  async function carregar() {
    try {
      const produto = await api.get(`/produtos/${id}`);
      desenhar(produto);
    } catch (erro) {
      raiz.innerHTML = `<div class="pagina">${erroBloco(erro.textoAmigavel)}</div>`;
    }
  }

  function desenhar(produto) {
    const saldoBaixo = produto.variantes.filter((v) => v.saldo <= v.estoque_minimo).length;

    raiz.innerHTML = html`
      <div class="pagina">
        <div class="pagina__topo">
          <div>
            <a class="botao botao--fantasma botao--pequeno" href="#/produtos">← Produtos</a>
            <div class="foto-escolha" style="margin:8px 0">
              <div class="foto-escolha__quadro" data-foto-quadro title="Trocar a foto da peça">
                ${produto.foto_url
                  ? cru(html`<img class="foto-escolha__img" src="${produto.foto_url}" alt="Foto de ${produto.nome}" />`)
                  : cru('<span class="foto-escolha__vazio">sem foto</span>')}
              </div>
              <div>
                <input type="file" data-foto accept="${cru(TIPOS_ACEITOS)}" hidden />
                <button class="botao botao--neutro botao--pequeno" data-foto-trocar type="button">
                  ${produto.foto_url ? 'Trocar foto' : 'Adicionar foto'}
                </button>
                <p class="texto-fraco" style="margin:6px 0 0;font-size:13px">
                  A imagem é reduzida antes de subir.
                </p>
              </div>
            </div>
            <h1>${produto.nome}</h1>
            <p class="texto-suave">
              ${produto.categoria} · ${plural(produto.variantes.length, 'peça na grade', 'peças na grade')} ·
              ${plural(produto.saldo_total, 'unidade em estoque', 'unidades em estoque')}
            </p>
          </div>
          <div class="pagina__acoes">
            <a class="botao botao--neutro" href="#/produtos/${produto.id}/etiquetas">Imprimir etiquetas</a>
            ${veDinheiro ? cru('<button class="botao botao--neutro" data-editar>Editar produto</button>') : ''}
            <button class="botao" data-nova-peca>Adicionar peça</button>
          </div>
        </div>

        ${produto.descricao ? cru(html`<p class="texto-suave">${produto.descricao}</p>`) : ''}
        ${saldoBaixo
          ? cru(html`
              <p>${etiqueta(`${numero(saldoBaixo)} ${saldoBaixo === 1 ? 'peça no estoque mínimo' : 'peças no estoque mínimo'}`, 'alerta')}</p>
            `)
          : ''}

        <div class="tabela-rolagem" style="margin-top:14px">
          <table>
            <thead>
              <tr>
                <th>Peça</th>
                <th>Código de barras</th>
                <th class="direita">Preço de venda</th>
                ${veDinheiro ? cru('<th class="direita">Custo</th><th class="direita">Margem</th>') : ''}
                <th class="direita">Estoque</th>
                <th class="direita">Ações</th>
              </tr>
            </thead>
            <tbody>
              ${produto.variantes.map((v) => linha(v, produto))}
            </tbody>
          </table>
        </div>
      </div>
    `;

    const campoFoto = raiz.querySelector('[data-foto]');
  const abrirSeletor = () => campoFoto?.click();
  raiz.querySelector('[data-foto-trocar]')?.addEventListener('click', abrirSeletor);
  raiz.querySelector('[data-foto-quadro]')?.addEventListener('click', abrirSeletor);
  campoFoto?.addEventListener('change', async () => {
    const arquivo = campoFoto.files?.[0];
    if (!arquivo) return;
    campoFoto.value = '';
    try {
      await enviarFoto(api, produto.id, arquivo);
      aviso('Foto atualizada.');
      await carregar();
    } catch (erro) {
      avisarErro(erro);
    }
  });

  raiz.querySelector('[data-nova-peca]').addEventListener('click', () => novaPeca(produto));
    raiz.querySelector('[data-editar]')?.addEventListener('click', () => editarProduto(produto));

    raiz.querySelectorAll('[data-editar-peca]').forEach((b) =>
      b.addEventListener('click', () => {
        const v = produto.variantes.find((x) => x.id === Number(b.dataset.editarPeca));
        editarPeca(v, produto);
      }),
    );
    raiz.querySelectorAll('[data-ajustar]').forEach((b) =>
      b.addEventListener('click', async () => {
        const v = produto.variantes.find((x) => x.id === Number(b.dataset.ajustar));
        const mudou = await ajustarEstoque({ ...v, variante_id: v.id, produto: produto.nome });
        if (mudou) carregar();
      }),
    );
    raiz.querySelectorAll('[data-excluir-peca]').forEach((b) =>
      b.addEventListener('click', () => {
        const v = produto.variantes.find((x) => x.id === Number(b.dataset.excluirPeca));
        excluirPeca(v, produto);
      }),
    );
  }

  function linha(v, produto) {
    const venda = paraCentavos(v.preco_venda);
    const custo = veDinheiro ? paraCentavos(v.preco_custo) : 0;
    const margem = veDinheiro && venda > 0 ? Math.round(((venda - custo) / venda) * 100) : null;

    return html`
      <tr>
        <td class="celula-principal">${grade(v.tamanho, v.cor)}</td>
        <td>
          <span class="dinheiro">${v.codigo_barras}</span>
          <span class="celula-secundaria">${v.tipo_codigo === 'INTERNO' ? 'código interno' : 'etiqueta do fornecedor'}</span>
          ${(() => {
            // Ver a barra ao lado do número é o que permite conferir a olho que a
            // etiqueta colada na peça é a mesma do sistema. Código fora do padrão
            // EAN-13 (CODE-128 de fornecedor, por exemplo) não vira desenho.
            const barras = svgEan13(v.codigo_barras, { modulo: 0.26, altura: 8, texto: false });
            return barras ? cru(`<span class="barras-mini">${barras}</span>`) : '';
          })()}
        </td>
        <td class="direita dinheiro celula-principal">${formatar(venda)}</td>
        ${veDinheiro
          ? cru(html`
              <td class="direita dinheiro texto-suave">${formatar(custo)}</td>
              <td class="direita dinheiro ${cru(margem !== null && margem < 30 ? 'negativo' : '')}">
                ${margem === null ? '—' : `${numero(margem)}%`}
              </td>
            `)
          : ''}
        <td class="direita">
          ${v.saldo === 0
            ? etiqueta('Zerado', 'perigo')
            : v.saldo <= v.estoque_minimo
              ? etiqueta(`${numero(v.saldo)} · repor`, 'alerta')
              : cru(html`<span class="dinheiro">${numero(v.saldo)}</span>`)}
        </td>
        <td class="direita">
          <button class="botao-icone" data-editar-peca="${v.id}" title="Editar preços e código" aria-label="Editar ${grade(v.tamanho, v.cor)}">✏️</button>
          ${veDinheiro
            ? cru(html`
                <button class="botao-icone" data-ajustar="${v.id}" title="Ajustar estoque" aria-label="Ajustar estoque de ${grade(v.tamanho, v.cor)}">⚖️</button>
                <button class="botao-icone botao-icone--perigo" data-excluir-peca="${v.id}" title="Excluir peça" aria-label="Excluir ${grade(v.tamanho, v.cor)}">🗑️</button>
              `)
            : ''}
        </td>
      </tr>
    `;
  }

  /* ------------------------------------------------------------------ edições */

  async function editarPeca(v, produto) {
    const salvou = await modal({
      titulo: `${produto.nome} · ${grade(v.tamanho, v.cor)}`,
      largura: '480px',
      render: () => html`
        <div class="linha-campos">
          <label class="campo">
            <span>Tamanho</span>
            <input data-tamanho value="${v.tamanho}" maxlength="20" />
          </label>
          <label class="campo">
            <span>Cor</span>
            <input data-cor value="${v.cor}" maxlength="40" />
          </label>
        </div>
        <label class="campo">
          <span>Código de barras</span>
          <input data-codigo value="${v.codigo_barras}" maxlength="32" />
        </label>
        <div class="linha-campos">
          <label class="campo">
            <span>Preço de venda</span>
            <input data-venda inputmode="numeric" />
          </label>
          ${veDinheiro
            ? cru(html`
                <label class="campo">
                  <span>Preço de custo</span>
                  <input data-custo inputmode="numeric" />
                </label>
              `)
            : ''}
        </div>
        <label class="campo">
          <span>Estoque mínimo <span class="campo__dica">avisa quando chegar nesse número</span></span>
          <input data-minimo type="number" min="0" step="1" value="${v.estoque_minimo}" />
        </label>
        <div data-margem></div>
        <div class="modal__acoes">
          <button class="botao botao--neutro" data-nao>Cancelar</button>
          <button class="botao" data-ok>Salvar</button>
        </div>
      `,
      aoAbrir: (corpo, fechar) => {
        const areaMargem = corpo.querySelector('[data-margem]');
        const campoCusto = corpo.querySelector('[data-custo]');

        const mostrarMargem = () => {
          if (!veDinheiro || !campoCusto) return;
          const venda = dinheiroVenda.valor();
          const custo = dinheiroCusto.valor();
          if (!venda) {
            areaMargem.innerHTML = '';
            return;
          }
          const lucro = venda - custo;
          const pct = Math.round((lucro / venda) * 100);
          areaMargem.innerHTML = html`
            <div class="pagamento-linha">
              <strong>Lucro por peça</strong>
              <span class="dinheiro ${cru(lucro <= 0 ? 'negativo' : 'positivo')}">
                ${formatar(lucro)} · ${numero(pct)}%
              </span>
            </div>
          `;
        };

        const dinheiroVenda = ligarCampoDinheiro(corpo.querySelector('[data-venda]'), paraCentavos(v.preco_venda), mostrarMargem);
        const dinheiroCusto = veDinheiro
          ? ligarCampoDinheiro(campoCusto, paraCentavos(v.preco_custo), mostrarMargem)
          : { valor: () => 0 };
        mostrarMargem();

        corpo.querySelector('[data-nao]').addEventListener('click', () => fechar(false));
        corpo.querySelector('[data-ok]').addEventListener('click', async (e) => {
          const botao = e.currentTarget;
          const venda = dinheiroVenda.valor();
          if (venda <= 0) {
            aviso('O preço de venda precisa ser maior que zero.', 'alerta');
            return;
          }
          botao.disabled = true;
          const corpoEnvio = {
            tamanho: corpo.querySelector('[data-tamanho]').value.trim(),
            cor: corpo.querySelector('[data-cor]').value.trim(),
            codigo_barras: corpo.querySelector('[data-codigo]').value.trim(),
            preco_venda: paraDecimalString(venda),
            estoque_minimo: Number(corpo.querySelector('[data-minimo]').value) || 0,
          };
          if (veDinheiro) corpoEnvio.preco_custo = paraDecimalString(dinheiroCusto.valor());

          try {
            await api.patch(`/variantes/${v.id}`, corpoEnvio);
            aviso('Peça atualizada.');
            fechar(true);
          } catch (erro) {
            avisarErro(erro);
            botao.disabled = false;
          }
        });
      },
    });
    if (salvou) carregar();
  }

  async function novaPeca(produto) {
    const criou = await modal({
      titulo: `Nova peça em ${produto.nome}`,
      largura: '480px',
      render: () => html`
        <div class="linha-campos">
          <label class="campo">
            <span>Tamanho</span>
            <input data-tamanho placeholder="P, M, G, 38…" maxlength="20" />
          </label>
          <label class="campo">
            <span>Cor</span>
            <input data-cor value="Única" maxlength="40" />
          </label>
        </div>
        <label class="campo">
          <span>Código de barras <span class="campo__dica">bipe a etiqueta ou gere um interno</span></span>
          <input data-codigo maxlength="32" placeholder="Deixe em branco para gerar" />
        </label>
        <button class="botao botao--neutro botao--pequeno" data-gerar>Gerar código interno</button>
        <div class="linha-campos" style="margin-top:14px">
          <label class="campo">
            <span>Preço de venda</span>
            <input data-venda inputmode="numeric" />
          </label>
          <label class="campo">
            <span>Preço de custo</span>
            <input data-custo inputmode="numeric" />
          </label>
        </div>
        <div class="linha-campos">
          <label class="campo">
            <span>Estoque inicial</span>
            <input data-inicial type="number" min="0" step="1" value="0" />
          </label>
          <label class="campo">
            <span>Estoque mínimo</span>
            <input data-minimo type="number" min="0" step="1" value="0" />
          </label>
        </div>
        <div class="modal__acoes">
          <button class="botao botao--neutro" data-nao>Cancelar</button>
          <button class="botao" data-ok>Adicionar</button>
        </div>
      `,
      aoAbrir: (corpo, fechar) => {
        const campoCodigo = corpo.querySelector('[data-codigo]');
        const dinheiroVenda = ligarCampoDinheiro(corpo.querySelector('[data-venda]'), 0);
        const dinheiroCusto = ligarCampoDinheiro(corpo.querySelector('[data-custo]'), 0);

        corpo.querySelector('[data-gerar]').addEventListener('click', async (e) => {
          e.currentTarget.disabled = true;
          try {
            const { codigo } = await api.post('/variantes/gerar-codigo-interno', {});
            campoCodigo.value = codigo;
          } catch (erro) {
            avisarErro(erro);
          } finally {
            e.currentTarget.disabled = false;
          }
        });

        corpo.querySelector('[data-nao]').addEventListener('click', () => fechar(false));
        corpo.querySelector('[data-ok]').addEventListener('click', async (e) => {
          const botao = e.currentTarget;
          if (dinheiroVenda.valor() <= 0) {
            aviso('Informe o preço de venda.', 'alerta');
            return;
          }
          botao.disabled = true;
          try {
            await api.post(`/produtos/${produto.id}/variantes`, {
              tamanho: corpo.querySelector('[data-tamanho]').value.trim(),
              cor: corpo.querySelector('[data-cor]').value.trim() || 'Única',
              codigo_barras: campoCodigo.value.trim() || null,
              preco_venda: paraDecimalString(dinheiroVenda.valor()),
              preco_custo: paraDecimalString(dinheiroCusto.valor()),
              estoque_minimo: Number(corpo.querySelector('[data-minimo]').value) || 0,
              estoque_inicial: Number(corpo.querySelector('[data-inicial]').value) || 0,
            });
            aviso('Peça adicionada à grade.');
            fechar(true);
          } catch (erro) {
            avisarErro(erro);
            botao.disabled = false;
          }
        });
      },
    });
    if (criou) carregar();
  }

  async function editarProduto(produto) {
    const { items: categorias } = await api.get('/categorias', { size: 100 }).catch(() => ({ items: [] }));

    const salvou = await modal({
      titulo: 'Editar produto',
      largura: '480px',
      render: () => html`
        <label class="campo">
          <span>Nome</span>
          <input data-nome value="${produto.nome}" maxlength="120" />
        </label>
        <label class="campo">
          <span>Categoria</span>
          <select data-categoria>
            ${categorias.map(
              (c) => html`<option value="${c.id}" ${cru(c.id === produto.categoria_id ? 'selected' : '')}>${c.nome}</option>`,
            )}
          </select>
        </label>
        <label class="campo">
          <span>Descrição</span>
          <textarea data-descricao maxlength="2000">${produto.descricao || ''}</textarea>
        </label>
        <div class="modal__acoes">
          <button class="botao botao--perigo" data-excluir style="margin-right:auto">Excluir produto</button>
          <button class="botao botao--neutro" data-nao>Cancelar</button>
          <button class="botao" data-ok>Salvar</button>
        </div>
      `,
      aoAbrir: (corpo, fechar) => {
        corpo.querySelector('[data-nao]').addEventListener('click', () => fechar(false));
        corpo.querySelector('[data-excluir]').addEventListener('click', async () => {
          const certeza = await confirmar({
            titulo: 'Excluir produto',
            mensagem: `"${produto.nome}" sai do catálogo com todas as peças da grade. As vendas já registradas continuam intactas.`,
            confirmarTexto: 'Excluir',
            perigo: true,
          });
          if (!certeza) return;
          try {
            await api.delete(`/produtos/${produto.id}`);
            aviso('Produto excluído.');
            fechar('excluido');
          } catch (erro) {
            avisarErro(erro);
          }
        });
        corpo.querySelector('[data-ok]').addEventListener('click', async (e) => {
          e.currentTarget.disabled = true;
          try {
            await api.patch(`/produtos/${produto.id}`, {
              nome: corpo.querySelector('[data-nome]').value.trim(),
              categoria_id: Number(corpo.querySelector('[data-categoria]').value),
              descricao: corpo.querySelector('[data-descricao]').value.trim() || null,
            });
            aviso('Produto atualizado.');
            fechar(true);
          } catch (erro) {
            avisarErro(erro);
            e.currentTarget.disabled = false;
          }
        });
      },
    });

    if (salvou === 'excluido') ir('/produtos');
    else if (salvou) carregar();
  }

  async function excluirPeca(v, produto) {
    const certeza = await confirmar({
      titulo: 'Excluir peça da grade',
      mensagem: `${produto.nome} ${grade(v.tamanho, v.cor)} sai do catálogo e do PDV. O histórico de vendas não muda.`,
      confirmarTexto: 'Excluir',
      perigo: true,
    });
    if (!certeza) return;
    try {
      await api.delete(`/variantes/${v.id}`);
      aviso('Peça excluída.');
      carregar();
    } catch (erro) {
      avisarErro(erro);
    }
  }

  await carregar();

  // Alguém mexeu nisto de outro aparelho: a tela se refaz sozinha. O roteador
  // chama a função devolvida ao trocar de tela, e é ela que cancela a inscrição —
  // sem isso, telas antigas continuariam mandando recarregar o que saiu de cena.
  return ouvir(['catalogo', 'estoque', 'reconectado'], () => void carregar());
}
