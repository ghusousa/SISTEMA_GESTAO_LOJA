/** Minha conta: quem sou eu neste sistema e a troca da própria senha. */

import { api } from '../api.js';
import { sessao } from '../store.js';
import { resumoDoPapel, titulo } from '../permissoes.js';
import { aviso, avisarErro, cru, data as formatarData, etiqueta, html } from '../ui.js';

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
              <strong>Papel</strong>
              <span>${cru(etiqueta(titulo(usuario.papel), usuario.papel === 'ADMIN' ? 'info' : 'neutro'))}</span>
            </div>
            <div class="pagamento-linha">
              <strong>No sistema desde</strong>
              <span>${formatarData(usuario.criado_em)}</span>
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
}
