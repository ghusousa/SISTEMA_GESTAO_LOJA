/**
 * A loja: o nome que aparece no recibo e o ramo que decide as palavras das telas.
 *
 * A pergunta acontece na instalação, mas ela precisa existir aqui também — nome de loja
 * muda (o dono corrige um acento, a loja é rebatizada) e ninguém vai abrir terminal no
 * servidor por causa disso.
 *
 * Trocar o ramo NÃO mexe em dado nenhum: `Tamanho` e `Cor` são só os rótulos das duas
 * colunas de variação, e o que muda é o rótulo. Está escrito na tela porque, sem isso,
 * a pessoa não arrisca clicar.
 */

import { api } from '../api.js';
import { ajuda, carregando, cru, erroBloco, avisarErro, aviso, html } from '../ui.js';
import { definirLoja, loja } from '../loja.js';

export async function render(raiz) {
  raiz.innerHTML = carregando('Lendo a configuração da loja…');

  let config;
  let segmentos;
  try {
    [config, segmentos] = await Promise.all([
      api.get('/configuracao'),
      api.get('/configuracao/segmentos'),
    ]);
  } catch (erro) {
    raiz.innerHTML = erroBloco(erro?.message || 'Não foi possível ler a configuração.');
    return;
  }

  raiz.innerHTML = html`
    <div class="pagina">
      <div class="pagina__topo">
        <div>
          <h1>A loja</h1>
          <p class="texto-suave">
            O nome sai no recibo do cliente e na tela de entrada. O ramo troca as palavras
            do sistema.
          </p>
        </div>
      </div>

      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:16px">
        <div class="cartao">
          <div class="cartao__topo"><h2>Identificação</h2></div>
          <div class="cartao__corpo">
            <form data-form>
              <label class="campo">
                <span>Nome da loja</span>
                <input name="nome" value="${config.nome}" maxlength="120" required />
              </label>

              <label class="campo">
                <span>
                  Ramo
                  <span class="campo__dica">muda só as palavras, nunca os dados</span>
                </span>
                <select name="segmento">
                  ${segmentos.map(
                    (s) => html`
                      <option value="${s.valor}" ${cru(s.valor === config.segmento ? 'selected' : '')}>
                        ${s.rotulo} — ${s.eixo1} / ${s.eixo2}
                      </option>
                    `,
                  )}
                </select>
              </label>

              <p class="texto-fraco" data-previa>${previa(config.segmento, segmentos)}</p>

              <label class="campo">
                <span>CNPJ ou CPF ${ajuda('Sai impresso no recibo do cliente. Preencher não vira nota fiscal: o recibo continua sendo um comprovante da loja.')} <span class="campo__dica">opcional, sai no recibo</span></span>
                <input name="documento" value="${config.documento ?? ''}" maxlength="24" />
              </label>
              <label class="campo">
                <span>Telefone <span class="campo__dica">opcional, sai no recibo</span></span>
                <input name="telefone" value="${config.telefone ?? ''}" maxlength="32" />
              </label>
              <label class="campo">
                <span>Endereço <span class="campo__dica">opcional, sai no recibo</span></span>
                <input name="endereco" value="${config.endereco ?? ''}" maxlength="200" />
              </label>

              <button class="botao botao--largo" type="submit">Salvar</button>
            </form>
          </div>
        </div>

        <div class="cartao">
          <div class="cartao__topo"><h2>Como o recibo vai sair</h2></div>
          <div class="cartao__corpo">
            <div class="recibo" style="margin:0;box-shadow:none">
              <div class="recibo__cabecalho">
                <strong data-previa-nome>${config.nome}</strong>
                <span data-previa-doc>${config.documento ?? ''}</span>
                <span data-previa-end>${config.endereco ?? ''}</span>
                <span data-previa-tel>${config.telefone ?? ''}</span>
                <span>Venda #123 · Ana</span>
              </div>
              <div class="recibo__total">
                <span>Total</span>
                <span class="dinheiro">R$ 149,90</span>
              </div>
              <div class="recibo__rodape">Não é documento fiscal.</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  const form = raiz.querySelector('[data-form]');
  const seletor = form.querySelector('[name="segmento"]');

  // A prévia responde antes de salvar: é ela que dá coragem de trocar o ramo.
  seletor.addEventListener('change', () => {
    raiz.querySelector('[data-previa]').textContent = previa(seletor.value, segmentos);
  });
  for (const [campo, alvo] of [
    ['nome', '[data-previa-nome]'],
    ['documento', '[data-previa-doc]'],
    ['telefone', '[data-previa-tel]'],
    ['endereco', '[data-previa-end]'],
  ]) {
    form.querySelector(`[name="${campo}"]`).addEventListener('input', (e) => {
      raiz.querySelector(alvo).textContent = e.target.value;
    });
  }

  form.addEventListener('submit', async (evento) => {
    evento.preventDefault();
    const dados = new FormData(form);
    const nome = String(dados.get('nome')).trim();
    if (!nome) {
      aviso('A loja precisa de um nome.', 'alerta');
      return;
    }

    const botao = form.querySelector('button');
    botao.disabled = true;
    botao.innerHTML = cru('<span class="giro" aria-hidden="true"></span> Salvando…');
    try {
      const salvo = await api.patch('/configuracao', {
        nome,
        segmento: String(dados.get('segmento')),
        documento: String(dados.get('documento')).trim(),
        telefone: String(dados.get('telefone')).trim(),
        endereco: String(dados.get('endereco')).trim(),
      });
      // Atualiza cabeçalho, título da aba e rótulos sem obrigar a recarregar a página.
      definirLoja(salvo);
      aviso(`Pronto. A loja agora se chama ${salvo.nome}.`);
    } catch (erro) {
      avisarErro(erro);
    } finally {
      botao.disabled = false;
      botao.textContent = 'Salvar';
    }
  });
}

function previa(valor, segmentos) {
  const s = segmentos.find((x) => x.valor === valor);
  if (!s) return '';
  return `No cadastro, as duas variações vão se chamar "${s.eixo1}" e "${s.eixo2}". Nenhum produto muda.`;
}
