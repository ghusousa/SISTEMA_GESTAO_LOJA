/**
 * Backup para o Google Drive — a tela onde o dono liga isso sem abrir terminal.
 *
 * A parte incômoda é a autorização do Google: o rclone precisa de um OAuth que abre
 * navegador, e servidor de loja não tem navegador. A saída é o dono rodar
 * `rclone authorize "drive"` no PRÓPRIO computador (que tem navegador), autorizar lá, e
 * colar aqui o token que o comando imprime. Uma vez só, para sempre.
 *
 * O token vai para o banco e **nunca volta**: a rota não devolve o campo, nem para o dono.
 * Quem lê é o `backup.sh`, na máquina — a mesma separação do `atualizar.sh` (ADR-18).
 * A tela só sabe se existe ou não.
 *
 * Quem copia de verdade é o `backup.sh`; aqui é só configuração e o retrato de como foi a
 * última vez — que é o que faz o dono confiar ou desconfiar do backup.
 */

import { api } from '../api.js';
import { ajuda, aviso, avisarErro, carregando, cru, dataHora, erroBloco, etiqueta, html } from '../ui.js';

const COMANDO = 'rclone authorize "drive"';

/** Bytes -> "4,2 MB". O dono quer saber se a cópia tem tamanho de banco ou de arquivo vazio. */
function tamanho(bytes) {
  if (!bytes) return '—';
  const mb = bytes / 1024 / 1024;
  if (mb < 1) return `${Math.round(bytes / 1024)} KB`;
  return `${mb.toFixed(1).replace('.', ',')} MB`;
}

function situacao(c) {
  if (!c.configurado) return { texto: 'Conta do Google não conectada', tom: 'alerta' };
  if (!c.ativo) return { texto: 'Desligado', tom: 'info' };
  if (c.ultimo_ok === false) return { texto: 'A última cópia FALHOU', tom: 'perigo' };
  // Quem decide o atraso é o servidor (`atrasado`: passou de 2× o intervalo sem cópia
  // nova). Olhar só `ultimo_ok` dizia "Funcionando" com a cópia parada havia dias.
  if (c.atrasado) {
    return { texto: c.ultimo_em ? 'Atrasado' : 'Atrasado: nenhuma cópia ainda', tom: 'alerta' };
  }
  if (c.ultimo_ok === true) return { texto: 'Funcionando', tom: 'ok' };
  return { texto: 'Ligado, primeira cópia ainda não rodou', tom: 'info' };
}

export async function render(raiz) {
  raiz.innerHTML = carregando('Lendo a configuração do backup…');

  let c;
  try {
    c = await api.get('/backup');
  } catch (erro) {
    raiz.innerHTML = erroBloco(erro?.message || 'Não foi possível ler a configuração.');
    return;
  }

  const s = situacao(c);

  raiz.innerHTML = html`
    <div class="pagina">
      <div class="pagina__topo">
        <div>
          <h1>Backup na nuvem</h1>
          <p class="texto-suave">
            Uma cópia do banco inteiro sobe para o seu Google Drive, sozinha. Se este
            servidor morrer, a loja não morre junto.
          </p>
        </div>
      </div>

      <div class="cartao" style="margin-bottom:16px">
        <div class="cartao__topo">
          <h2>Situação</h2>
          ${cru(etiqueta(s.texto, s.tom))}
        </div>
        <div class="cartao__corpo">
          <div class="pagamento-linha">
            <strong>Última cópia</strong>
            <span>${c.ultimo_em ? dataHora(c.ultimo_em) : 'nenhuma ainda'}</span>
          </div>
          <div class="pagamento-linha">
            <strong>Tamanho</strong>
            <span>${tamanho(c.ultimo_bytes)}</span>
          </div>
          <div class="pagamento-linha">
            <strong>Cópias guardadas no Drive</strong>
            <span>${c.copias_na_nuvem ?? 0} de ${c.manter}</span>
          </div>
          ${c.ultimo_erro
            ? cru(html`
                <p class="texto-suave" style="margin-top:10px;color:var(--perigo)">
                  <strong>O que deu errado:</strong> ${c.ultimo_erro}
                </p>
              `)
            : ''}
          ${c.atrasado
            ? cru(html`
                <p class="texto-suave" style="margin-top:10px">
                  <strong>A cópia passou da hora.</strong> Ela deveria sair a cada
                  ${c.intervalo_min} min. Confira se o servidor está ligado e se a cópia
                  automática foi ativada nele; o <code>./diagnostico.sh</code> mostra o resto.
                </p>
              `)
            : ''}
        </div>
      </div>

      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:16px">
        <div class="cartao">
          <div class="cartao__topo"><h2>Conectar o Google Drive</h2></div>
          <div class="cartao__corpo">
            <p class="texto-suave">
              O servidor da loja não tem navegador, então a autorização é feita
              <strong>no seu computador</strong>. É uma vez só.
            </p>
            <ol class="texto-suave" style="padding-left:18px;margin:10px 0">
              <li>Instale o rclone no seu computador (<code>rclone.org/downloads</code>)</li>
              <li>Abra o Prompt de Comando e rode:</li>
            </ol>
            <pre class="codigo-copiar" style="margin:0 0 4px"><code>${COMANDO}</code></pre>
            <button class="botao botao--neutro botao--pequeno" data-copiar>Copiar comando</button>
            <ol class="texto-suave" style="padding-left:18px;margin:10px 0" start="3">
              <li>Ele abre o Google. Escolha a conta e autorize.</li>
              <li>Ele imprime um texto começando com <code>{</code>. Copie inteiro e cole abaixo.</li>
            </ol>

            <label class="campo">
              <span>
                Token do rclone
                ${cru(
                  c.configurado
                    ? '<span class="campo__dica">já conectado — só preencha para trocar de conta</span>'
                    : '<span class="campo__dica">cole o texto que começa com {</span>',
                )}
              </span>
              <textarea
                name="rclone_token"
                rows="4"
                placeholder='{"access_token":"...","refresh_token":"...","expiry":"..."}'
                style="font-family:ui-monospace,monospace;font-size:12px"
              ></textarea>
            </label>
            <p class="texto-fraco">
              Depois de salvo, este texto não aparece mais aqui — nem para você. É uma
              credencial: quem a tem escreve e apaga no seu Drive.
            </p>
          </div>
        </div>

        <div class="cartao">
          <div class="cartao__topo"><h2>Como funciona</h2></div>
          <div class="cartao__corpo">
            <form data-form>
              <label class="campo">
                <span>Pasta no Drive ${ajuda('A pasta do seu Drive onde as cópias ficam. Trocar de pasta deixa as cópias antigas para trás: a limpeza automática só cuida da pasta de agora.')}</span>
                <input name="pasta" value="${c.pasta}" maxlength="120" />
              </label>

              <label class="campo">
                <span>
                  De quantos em quantos minutos
                  ${ajuda('Se o servidor pifar, você perde no máximo o que foi vendido desde a última cópia. Intervalo mais curto guarda mais, e custa quase nada.')}
                  <span class="campo__dica">30 é o recomendado</span>
                </span>
                <input name="intervalo_min" type="number" min="5" max="1440" value="${c.intervalo_min}" />
              </label>

              <label class="campo">
                <span>
                  Quantas cópias guardar
                  <span class="campo__dica">ao gravar a próxima, a mais antiga é apagada</span>
                </span>
                <input name="manter" type="number" min="2" max="200" value="${c.manter}" />
              </label>

              <p class="texto-fraco" data-janela></p>

              <label class="campo" style="flex-direction:row;align-items:center;gap:10px">
                <input type="checkbox" name="ativo" ${cru(c.ativo ? 'checked' : '')} style="width:18px;height:18px" />
                <span style="margin:0">Backup ligado ${ajuda('Sem a conta do Google conectada ele não liga. Ligado, a cópia sobe sozinha no horário — ninguém precisa deixar esta tela aberta.')}</span>
              </label>

              <label class="campo" data-campo-senha hidden>
                <span>
                  Sua senha
                  <span class="campo__dica">trocar a conta ou a pasta pede a senha de novo</span>
                </span>
                <input name="senha_atual" type="password" autocomplete="current-password" />
              </label>

              <button class="botao botao--largo" type="submit">Salvar</button>
            </form>
          </div>
        </div>
      </div>

      <p class="texto-fraco" style="margin-top:16px">
        Falta um passo no servidor, uma vez só:
        <code>./backup.sh --nuvem-automatico</code> — é ele que ensina a máquina a conferir
        sozinha. Depois disso tudo se resolve por esta tela.
      </p>
    </div>
  `;

  const form = raiz.querySelector('[data-form]');
  const campoToken = raiz.querySelector('[name="rclone_token"]');
  const campoSenha = raiz.querySelector('[data-campo-senha]');

  // Trocar PARA ONDE o banco vai (outro token ou outra pasta, com uma conta já conectada)
  // pede a senha de novo: é o caminho de quem acha uma sessão do dono aberta no balcão e
  // desvia as cópias para o próprio Drive. O campo só aparece quando vai ser pedido.
  const mudaDestino = () =>
    c.configurado &&
    (String(campoToken.value || '').trim() !== '' || String(form.pasta.value).trim() !== c.pasta);
  const mostrarSenha = () => {
    campoSenha.hidden = !mudaDestino();
  };
  campoToken.addEventListener('input', mostrarSenha);
  form.pasta.addEventListener('input', mostrarSenha);

  // Quantas horas de história as cópias cobrem. É a conta que ninguém faz sozinho e que
  // muda a decisão: 10 cópias de 30 em 30 min são 5 horas — se o problema for percebido
  // só no dia seguinte, TODAS já estarão com ele dentro.
  function recalcularJanela() {
    const min = Number(form.intervalo_min.value) || 0;
    const n = Number(form.manter.value) || 0;
    const horas = (min * n) / 60;
    const alvo = raiz.querySelector('[data-janela]');
    if (!alvo || !horas) return;
    const quanto =
      horas >= 48
        ? `${Math.round(horas / 24)} dias`
        : `${horas.toFixed(horas < 10 ? 1 : 0).replace('.', ',')} horas`;
    alvo.textContent =
      `Com isso você consegue voltar até ${quanto} atrás. Se um problema passar desse ` +
      `tempo sem ser notado, todas as cópias já vão estar com ele dentro.`;
  }
  form.intervalo_min.addEventListener('input', recalcularJanela);
  form.manter.addEventListener('input', recalcularJanela);
  recalcularJanela();

  raiz.querySelector('[data-copiar]')?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(COMANDO);
      aviso('Comando copiado. Cole no Prompt de Comando do seu computador.');
    } catch {
      aviso('Não deu para copiar sozinho — selecione o comando e copie à mão.', 'alerta');
    }
  });

  form.addEventListener('submit', async (evento) => {
    evento.preventDefault();
    const dados = new FormData(form);
    const token = String(campoToken.value || '').trim();

    const corpo = {
      ativo: form.ativo.checked,
      pasta: String(dados.get('pasta')).trim(),
      intervalo_min: Number(dados.get('intervalo_min')),
      manter: Number(dados.get('manter')),
    };
    // Só manda o token quando há um novo: mandar vazio apagaria a conta conectada.
    if (token) corpo.rclone_token = token;
    if (!campoSenha.hidden) corpo.senha_atual = String(form.senha_atual.value);

    const botao = form.querySelector('button[type="submit"]');
    botao.disabled = true;
    botao.innerHTML = cru('<span class="giro" aria-hidden="true"></span> Salvando…');
    try {
      await api.put('/backup', corpo);
      aviso(corpo.ativo ? 'Backup ligado.' : 'Configuração salva.');
      render(raiz); // redesenha com a situação nova
    } catch (erro) {
      avisarErro(erro);
      if (erro?.detail?.campo === 'senha_atual') {
        campoSenha.hidden = false;
        form.senha_atual.value = '';
        form.senha_atual.focus();
      }
    } finally {
      botao.disabled = false;
      botao.textContent = 'Salvar';
    }
  });
}
