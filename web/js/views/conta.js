/**
 * Minha conta: quem sou eu neste sistema, a troca da própria senha e a exclusão da própria
 * conta (ADR-45 — as lojas de app exigem que quem tem conta consiga excluí-la sozinho).
 */

import { api, encerrarSessaoLocal, sessaoContinua } from '../api.js';
import { depoisDaIncerta, recusaDaExclusao, textosDaExclusao } from '../exclusao-de-conta.js';
import { pararLeitorCelular } from '../leitor-celular.js';
import { ir } from '../router.js';
import { limparTudoDaSessao, sessao } from '../store.js';
import { resumoDoPapel, titulo } from '../permissoes.js';
import { ajuda, aviso, avisarErro, cru, diaNaLoja, etiqueta, html, modal } from '../ui.js';

export async function render(raiz) {
  const usuario = sessao.get().usuario;
  const oQuePode = resumoDoPapel(usuario.papel);

  raiz.innerHTML = html`
    <div class="pagina">
      <div class="pagina__topo">
        <div>
          <h1>Minha conta</h1>
          <p class="texto-suave">Seus dados de acesso a este sistema.</p>
        </div>
      </div>

      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px">
        <div class="cartao">
          <div class="cartao__topo"><h2>Quem está usando</h2></div>
          <div class="cartao__corpo">
            <div class="pagamento-linha">
              <strong>Nome</strong>
              <span>${usuario.nome}</span>
            </div>
            <div class="pagamento-linha">
              <strong>E-mail</strong>
              <span>${usuario.email}</span>
            </div>
            <div class="pagamento-linha">
              <strong>Papel ${ajuda('Decide o que você vê e faz no sistema. O seu próprio papel você não troca: quem mexe nisso é quem cuida da equipe, em Usuários.')}</strong>
              <span>${cru(etiqueta(titulo(usuario.papel), usuario.papel === 'ADMIN' ? 'info' : 'neutro'))}</span>
            </div>
            <div class="pagamento-linha">
              <strong>No sistema desde</strong>
              <span>${diaNaLoja(usuario.criado_em)}</span>
            </div>
            <p class="texto-fraco" style="margin-top:12px">O que seu acesso permite:</p>
            <ul class="texto-fraco" style="margin:4px 0 0;padding-left:18px">
              ${oQuePode.map((o) => html`<li>${o}</li>`)}
            </ul>
          </div>
        </div>

        <div class="cartao">
          <div class="cartao__topo"><h2>Trocar a senha</h2></div>
          <div class="cartao__corpo">
            <form data-form>
              <label class="campo">
                <span>Senha atual</span>
                <input type="password" name="atual" autocomplete="current-password" required />
              </label>
              <label class="campo">
                <span>Nova senha <span class="campo__dica">mínimo de 8 caracteres</span></span>
                <input type="password" name="nova" autocomplete="new-password" required minlength="8" />
              </label>
              <label class="campo">
                <span>Repita a nova senha</span>
                <input type="password" name="repete" autocomplete="new-password" required minlength="8" />
              </label>
              <p class="texto-fraco">
                Trocar a senha derruba as sessões abertas em outros aparelhos — inclusive o celular.
              </p>
              <button class="botao botao--largo" type="submit">Trocar senha</button>
            </form>
          </div>
        </div>

        <div class="cartao">
          <div class="cartao__topo"><h2>Excluir minha conta</h2></div>
          <div class="cartao__corpo">
            <p class="texto-suave">
              Apaga o seu acesso a este sistema, em todos os aparelhos. Antes de confirmar, você vê
              o que some e o que fica, e digita a sua senha.
            </p>
            ${usuario.papel === 'ADMIN'
              ? html`<p class="texto-fraco">
                  A loja não fica sem dono: se você é o único, passe antes o papel de dono a outra
                  pessoa em Usuários.
                </p>`
              : ''}
            <div class="recado recado--erro" data-recusa hidden></div>
            <button class="botao botao--perigo botao--largo" type="button" data-excluir>
              Excluir minha conta
            </button>
          </div>
        </div>
      </div>
    </div>
  `;

  const form = raiz.querySelector('[data-form]');
  form.addEventListener('submit', async (evento) => {
    evento.preventDefault();
    const dados = new FormData(form);
    const nova = String(dados.get('nova'));

    if (nova !== String(dados.get('repete'))) {
      aviso('As duas senhas novas não são iguais.', 'alerta');
      return;
    }
    if (nova.length < 8) {
      aviso('A nova senha precisa de pelo menos 8 caracteres.', 'alerta');
      return;
    }

    const botao = form.querySelector('button');
    botao.disabled = true;
    botao.innerHTML = cru('<span class="giro" aria-hidden="true"></span> Trocando…');
    try {
      await api.patch('/usuarios/me/senha', {
        senha_atual: String(dados.get('atual')),
        nova_senha: nova,
      });
      form.reset();
      aviso('Senha trocada. Use a nova da próxima vez que entrar.');
    } catch (erro) {
      avisarErro(erro);
    } finally {
      botao.disabled = false;
      botao.textContent = 'Trocar senha';
    }
  });

  const caixaRecusa = raiz.querySelector('[data-recusa]');
  // A tentativa anterior ficou sem resposta: na próxima, o 401 pode ser a conta que já saiu.
  const estado = { incerta: false };
  raiz.querySelector('[data-excluir]').addEventListener('click', async () => {
    caixaRecusa.hidden = true;
    const resultado = await pedirExclusao(estado);
    if (resultado === 'excluida') {
      // A mesma limpeza do Sair, sem falar com o servidor: ele já derrubou tudo, e um
      // logout agora daria 401 e o aviso de "sessão expirada". Carrinho e conferência não
      // sobram para quem entrar depois neste navegador, nem o leitor desta aba.
      limparTudoDaSessao();
      pararLeitorCelular();
      encerrarSessaoLocal();
      ir('/entrar?conta=excluida', true);
    } else if (resultado?.recusa) {
      caixaRecusa.textContent = resultado.recusa;
      caixaRecusa.hidden = false;
    }
  });
}

/**
 * Exclui a própria conta. Depois de uma tentativa sem resposta, o 401 não vira "sessão
 * expirada": a renovação desempata (`depoisDaIncerta`) — recusada, a conta já tinha saído.
 */
async function excluirAMinha(senha, estado) {
  if (!estado.incerta) return api.delete('/usuarios/me', { senha });
  try {
    await api.delete('/usuarios/me', { senha }, { semRenovar: true });
  } catch (falha) {
    if (falha?.status !== 401) throw falha;
    if (depoisDaIncerta(await sessaoContinua()) === 'pedir-de-novo') {
      await api.delete('/usuarios/me', { senha });
    }
  }
  return null;
}

/**
 * O que some, o que fica, a senha e o botão — um passo só, no modal. Resolve `'excluida'`,
 * `{ recusa }` (o dono único, a rede caída) ou `undefined` (cancelou). A senha errada fica
 * no próprio modal, embaixo do campo: é 422, e a sessão segue. Com o pedido no ar o modal
 * não fecha (Esc, ✕, clique fora): a resposta precisa de quem a leia.
 */
function pedirExclusao(estado) {
  const t = textosDaExclusao({ propria: true });
  return modal({
    titulo: 'Excluir minha conta',
    largura: '500px',
    render: () => html`
      <form data-form novalidate>
        <p class="texto-suave" style="margin:0 0 4px"><strong>O que some</strong></p>
        <ul class="texto-suave" style="margin:0 0 12px;padding-left:18px">
          ${t.some.map((linha) => html`<li>${linha}</li>`)}
        </ul>
        <p class="texto-suave" style="margin:0 0 4px"><strong>O que fica</strong></p>
        <ul class="texto-suave" style="margin:0 0 12px;padding-left:18px">
          ${t.fica.map((linha) => html`<li>${linha}</li>`)}
        </ul>
        <p class="texto-suave">${t.fim}</p>
        <label class="campo">
          <span>Sua senha <span class="campo__dica">confirma que é você</span></span>
          <input type="password" name="senha" autocomplete="current-password" required />
          <span class="campo__erro" data-erro hidden></span>
        </label>
        <div class="modal__acoes">
          <button type="button" class="botao botao--neutro" data-nao>Cancelar</button>
          <button type="submit" class="botao botao--perigo" data-sim>Excluir minha conta</button>
        </div>
      </form>
    `,
    aoAbrir: (corpo, fechar, travar) => {
      const form = corpo.querySelector('[data-form]');
      const campo = form.querySelector('[name=senha]');
      const erro = corpo.querySelector('[data-erro]');
      const botao = corpo.querySelector('[data-sim]');
      const mostrarErro = (texto) => {
        erro.textContent = texto;
        erro.hidden = false;
        campo.value = '';
        campo.focus();
      };
      const cancelar = corpo.querySelector('[data-nao]');
      cancelar.addEventListener('click', () => fechar(undefined));
      form.addEventListener('submit', async (evento) => {
        evento.preventDefault();
        if (!campo.value) {
          mostrarErro('Digite a sua senha para confirmar.');
          return;
        }
        erro.hidden = true;
        botao.disabled = true;
        cancelar.disabled = true;
        botao.innerHTML = cru('<span class="giro" aria-hidden="true"></span> Excluindo…');
        travar(true);
        try {
          await excluirAMinha(campo.value, estado);
          fechar('excluida');
        } catch (falha) {
          const recusa = recusaDaExclusao(falha);
          estado.incerta = Boolean(recusa.incerta);
          if (recusa.onde === 'senha') mostrarErro(recusa.texto);
          else fechar({ recusa: recusa.texto });
        } finally {
          travar(false);
          botao.disabled = false;
          cancelar.disabled = false;
          botao.textContent = 'Excluir minha conta';
        }
      });
      // O foco vai para a senha, não para o botão de perigo: Enter sem querer não exclui.
      campo.focus();
    },
  });
}
