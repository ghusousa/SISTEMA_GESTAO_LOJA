/**
 * O modal do convite do celular-leitor (ADR-43): o QR, o código grande, o caminho no app
 * e a contagem dos 5 min. Quem decide quando abrir e fechar é `leitor-celular.js`; aqui
 * só se desenha e se conta o tempo.
 */

import { baseDaApi } from './api.js';
import { formatarCodigo, montarConvite } from './leitor-remoto.js';
import { desenharQr } from './qr.js';
import { avisarErro, html, modal } from './ui.js';

/**
 * Abre o modal com o convite de `primeiro` (`{ p, venceEm }`, venceEm no relógio desta
 * máquina). "Gerar outro" chama `gerarOutro()`, que devolve o próximo `{ p, venceEm }` (ou
 * `null`, se a sessão saiu no meio).
 *
 * Devolve o controle: `fechar()` (o celular aceitou), `vencer()` (o servidor disse que o
 * código venceu), `naTela()` (o roteador tira o modal do documento ao trocar de rota sem
 * fechá-lo — quem abriu confere) e `fechou`, a promessa que resolve quando o modal fecha
 * (aceite, ✕, Esc, clique fora, ou `fechar()`).
 */
export function mostrarConvite({ primeiro, gerarOutro }) {
  let relogio = null;
  let controle = null;

  const fechou = modal({
    titulo: 'Celular como leitor',
    largura: '440px',
    render: () => html`
      <div class="leitor-celular">
        <div class="leitor-celular__qr" data-qr></div>
        <p class="texto-suave">ou digite este código no celular</p>
        <strong class="leitor-celular__codigo" data-codigo></strong>
        <p class="leitor-celular__passos">
          No app: <b>Mais → Leitor do computador → Ler o QR do computador</b>
        </p>
        <p class="leitor-celular__prazo" data-prazo aria-live="polite"></p>
        <div class="modal__acoes">
          <button class="botao botao--neutro" type="button" data-outro>Gerar outro</button>
        </div>
      </div>
    `,
    aoAbrir(corpo, fechar) {
      const qr = corpo.querySelector('[data-qr]');
      const prazo = corpo.querySelector('[data-prazo]');
      const outro = corpo.querySelector('[data-outro]');
      let venceEm = 0;
      let aberto = true;

      const vencer = () => {
        clearInterval(relogio);
        if (!aberto) return;
        qr.classList.add('is-vencido');
        prazo.classList.add('is-vencido');
        prazo.textContent = 'Este código venceu. Gere outro.';
        outro.focus();
      };
      const contar = () => {
        const restante = Math.max(0, Math.ceil((venceEm - Date.now()) / 1000));
        if (restante === 0) {
          vencer();
          return;
        }
        const segundos = String(restante % 60).padStart(2, '0');
        prazo.textContent = `Vale por mais ${Math.floor(restante / 60)}:${segundos}`;
      };
      const pintar = ({ p, venceEm: quando }) => {
        venceEm = quando;
        qr.classList.remove('is-vencido');
        prazo.classList.remove('is-vencido');
        // SVG montado pelo DOM; o texto do convite nunca vira marcação.
        qr.replaceChildren(
          desenharQr(montarConvite(p.codigo, baseDaApi()), {
            rotulo: 'QR para ligar o celular como leitor',
          }),
        );
        corpo.querySelector('[data-codigo]').textContent = formatarCodigo(p.codigo);
        clearInterval(relogio);
        relogio = setInterval(contar, 1000);
        contar();
      };

      outro.addEventListener('click', async () => {
        outro.disabled = true;
        try {
          const novo = await gerarOutro();
          if (aberto && novo) pintar(novo);
        } catch (erro) {
          avisarErro(erro);
        } finally {
          outro.disabled = false;
        }
      });

      controle = {
        fechar: () => fechar(undefined),
        vencer,
        naTela: () => corpo.isConnected,
        marcarFechado: () => {
          aberto = false;
        },
      };
      pintar(primeiro);
    },
  }).then(() => {
    clearInterval(relogio);
    controle?.marcarFechado();
  });

  // `modal` chama `aoAbrir` antes de devolver a promessa: o controle já existe aqui.
  return {
    fechar: () => controle?.fechar(),
    vencer: () => controle?.vencer(),
    naTela: () => !!controle?.naTela(),
    fechou,
  };
}
