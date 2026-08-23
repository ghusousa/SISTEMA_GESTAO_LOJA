/** Tela de login. É a única que roda fora da moldura do sistema. */

import { entrar } from '../api.js';
import { ir } from '../router.js';
import { html, cru } from '../ui.js';
import { loja } from '../loja.js';

export function render(raiz) {
  raiz.innerHTML = html`
    <div class="entrada">
      <div class="entrada__caixa">
        <div class="entrada__marca">
          <span class="entrada__logo" aria-hidden="true">${loja().vocabulario?.icone ?? '🏪'}</span>
          <span>
            <h1 data-nome-loja>${loja().nome}</h1>
            <span class="texto-suave">Estoque, vendas e financeiro</span>
          </span>
        </div>

        <div data-erro hidden></div>

        <form data-form novalidate>
          <label class="campo">
            <span>E-mail</span>
            <input
              type="email"
              name="email"
              autocomplete="username"
              required
              placeholder="voce@sualoja.com.br"
            />
          </label>
          <label class="campo">
            <span>Senha</span>
            <input type="password" name="senha" autocomplete="current-password" required />
          </label>
          <button class="botao botao--largo botao--grande" type="submit" data-enviar>Entrar</button>
        </form>
      </div>
    </div>
  `;

  const form = raiz.querySelector('[data-form]');
  const botao = raiz.querySelector('[data-enviar]');
  const caixaErro = raiz.querySelector('[data-erro]');

  const mostrarErro = (texto) => {
    caixaErro.className = 'entrada__erro';
    caixaErro.textContent = texto;
    caixaErro.hidden = false;
  };

  form.addEventListener('submit', async (evento) => {
    evento.preventDefault();
    const dados = new FormData(form);
    const email = String(dados.get('email') || '').trim();
    const senha = String(dados.get('senha') || '');

    if (!email || !senha) {
      mostrarErro('Preencha o e-mail e a senha.');
      return;
    }

    caixaErro.hidden = true;
    botao.disabled = true;
    botao.innerHTML = cru('<span class="giro" aria-hidden="true"></span> Entrando…');

    try {
      await entrar(email, senha);
      ir('/pdv', true);
    } catch (erro) {
      mostrarErro(erro?.textoAmigavel || 'Não foi possível entrar. Tente de novo.');
      form.querySelector('[name=senha]').value = '';
      form.querySelector('[name=senha]').focus();
    } finally {
      botao.disabled = false;
      botao.textContent = 'Entrar';
    }
  });

  form.querySelector('[name=email]').focus();
}
