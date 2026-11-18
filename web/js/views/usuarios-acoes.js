/**
 * As duas ações de Usuários que mexem no acesso de outra pessoa: redefinir a senha e excluir
 * a conta. Moram fora de `usuarios.js` para a tela caber no tamanho de uma tela.
 *
 * Quem pode o quê continua sendo o servidor: gerente não mexe em dono (403), e ninguém se
 * exclui por aqui (409 — a própria conta é em Minha conta, com a senha). A tela só não
 * oferece o que seria recusado (`podeExcluirDaEquipe`).
 */

import { api } from '../api.js';
import { textosDaExclusao } from '../exclusao-de-conta.js';
import { aviso, avisarErro, confirmar, cru, html, modal } from '../ui.js';

/** Resolve `true` quando a senha foi redefinida. */
export async function redefinirSenha(usuario) {
  const nova = await modal({
    titulo: `Nova senha para ${usuario.nome}`,
    largura: '430px',
    render: () => html`
      <p class="texto-suave">
        A pessoa entra com a nova senha na próxima vez. As sessões abertas dela caem.
      </p>
      <label class="campo">
        <span>Nova senha <span class="campo__dica">mínimo de 8 caracteres</span></span>
        <input data-senha type="password" autocomplete="new-password" />
      </label>
      <div class="modal__acoes">
        <button class="botao botao--neutro" data-nao>Cancelar</button>
        <button class="botao" data-ok>Redefinir</button>
      </div>
    `,
    aoAbrir: (corpo, fechar) => {
      corpo.querySelector('[data-nao]').addEventListener('click', () => fechar(undefined));
      corpo.querySelector('[data-ok]').addEventListener('click', () => fechar(corpo.querySelector('[data-senha]').value));
    },
  });
  if (!nova) return false;
  if (nova.length < 8) {
    aviso('A senha precisa de pelo menos 8 caracteres.', 'alerta');
    return false;
  }

  const certeza = await confirmar({
    titulo: 'Confirmar troca de senha',
    mensagem: `${usuario.nome} vai precisar entrar de novo com a senha nova.`,
    confirmarTexto: 'Redefinir',
  });
  if (!certeza) return false;

  try {
    await api.patch(`/usuarios/${usuario.id}/senha`, { nova_senha: nova });
    aviso('Senha redefinida.');
    return true;
  } catch (erro) {
    avisarErro(erro);
    return false;
  }
}

/**
 * Excluir a conta de outra pessoa (ADR-45): diz o que some e o que fica, e só exclui com o
 * clique no botão vermelho. Resolve `true` quando a conta saiu.
 */
export function excluirConta(usuario) {
  const t = textosDaExclusao({ propria: false, nome: usuario.nome });
  return modal({
    titulo: `Excluir a conta de ${usuario.nome}`,
    largura: '500px',
    render: () => html`
      <p class="texto-suave" style="margin:0 0 4px"><strong>O que some</strong></p>
      <ul class="texto-suave" style="margin:0 0 12px;padding-left:18px">
        ${t.some.map((linha) => html`<li>${linha}</li>`)}
      </ul>
      <p class="texto-suave" style="margin:0 0 4px"><strong>O que fica</strong></p>
      <ul class="texto-suave" style="margin:0 0 12px;padding-left:18px">
        ${t.fica.map((linha) => html`<li>${linha}</li>`)}
      </ul>
      <p class="texto-suave">${t.fim}</p>
      <div class="modal__acoes">
        <button class="botao botao--neutro" data-nao>Cancelar</button>
        <button class="botao botao--perigo" data-sim>Excluir conta</button>
      </div>
    `,
    aoAbrir: (corpo, fechar, travar) => {
      const botao = corpo.querySelector('[data-sim]');
      const cancelar = corpo.querySelector('[data-nao]');
      cancelar.addEventListener('click', () => fechar(false));
      botao.addEventListener('click', async () => {
        botao.disabled = true;
        cancelar.disabled = true;
        botao.innerHTML = cru('<span class="giro" aria-hidden="true"></span> Excluindo…');
        // Com o pedido no ar o modal não fecha: fechado, a conta sumia e a lista não recarregava.
        travar(true);
        try {
          await api.delete(`/usuarios/${usuario.id}`);
          aviso(`Conta de ${usuario.nome} excluída.`);
          fechar(true);
        } catch (erro) {
          travar(false);
          avisarErro(erro);
          botao.disabled = false;
          cancelar.disabled = false;
          botao.textContent = 'Excluir conta';
        }
      });
      // Foco no Cancelar: Enter sem querer não exclui ninguém.
      corpo.querySelector('[data-nao]').focus();
    },
  }).then((excluiu) => excluiu === true);
}
